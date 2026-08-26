use crate::{
    api,
    permissions::PermissionCatalog,
    product::{Interaction, PreparedInteractionBinding, ProductService, ProjectId},
    runtime::RuntimeClient,
    storage::SqliteProductStore,
};
use axum::Router;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
enum StartupReconciliationError {
    #[error("{0}")]
    Retryable(#[source] anyhow::Error),
    #[error("{0}")]
    Deterministic(#[source] anyhow::Error),
}

impl StartupReconciliationError {
    fn retryable(error: impl Into<anyhow::Error>) -> Self {
        Self::Retryable(error.into())
    }

    fn deterministic(error: impl Into<anyhow::Error>) -> Self {
        Self::Deterministic(error.into())
    }

    fn from_runtime(error: crate::runtime::RuntimeError) -> Self {
        if error.is_retryable_startup_failure() {
            Self::retryable(error)
        } else {
            Self::deterministic(error)
        }
    }

    fn is_retryable(&self) -> bool {
        matches!(self, Self::Retryable(_))
    }
}

pub struct RelayerRuntimeConfig {
    pub graph_url: String,
    pub harness_url: String,
    pub graph_control_token: String,
    pub harness_control_token: String,
    pub harness_configurations: PathBuf,
    pub default_harness_configuration: String,
    pub allow_harness_override: bool,
    pub standalone_workspaces_directory: PathBuf,
}

async fn reconcile_interrupted_interaction(
    storage: &SqliteProductStore,
    runtime: &RuntimeClient,
    permission_catalog: &PermissionCatalog,
    mut interaction: Interaction,
) -> Result<(), StartupReconciliationError> {
    let invocation = storage
        .invocation_graph_source(interaction.id)
        .await
        .map_err(StartupReconciliationError::retryable)?;
    let durable_input = storage
        .interaction_input(interaction.id)
        .await
        .map_err(StartupReconciliationError::retryable)?;
    if interaction.graph_node_id.is_none() && (invocation.is_some() || durable_input.is_some()) {
        if interaction.completion_status == "not_started"
            && !storage
                .claim_interaction_preparing(interaction.id)
                .await
                .map_err(StartupReconciliationError::retryable)?
        {
            return Err(StartupReconciliationError::deterministic(anyhow::anyhow!(
                "could not reserve interrupted interaction {}",
                interaction.id
            )));
        }
        let thread = storage
            .get_thread(interaction.thread_id)
            .await
            .map_err(StartupReconciliationError::retryable)?
            .ok_or_else(|| {
                StartupReconciliationError::deterministic(anyhow::anyhow!(
                    "missing thread for {}",
                    interaction.id
                ))
            })?;
        let permission = permission_catalog
            .profile(&thread.permission_profile_id)
            .map_err(StartupReconciliationError::deterministic)?;
        let execution_model_selection = match interaction.model_selection.as_ref() {
            Some(selection) => Some(
                storage
                    .validate_execution_model_selection(
                        &thread.harness_configuration_name,
                        selection,
                    )
                    .await
                    .map_err(StartupReconciliationError::deterministic)?,
            ),
            None => None,
        };
        let harness_policy = if execution_model_selection.is_some() {
            Some(
                storage
                    .load_execution_harness_policy(&thread.harness_configuration_name)
                    .await
                    .map_err(StartupReconciliationError::deterministic)?,
            )
        } else {
            None
        };
        let prepared_invocation =
            invocation.map(|(source_interaction_node_id, source_action_id)| {
                crate::runtime::PreparedInvocation {
                    source_interaction_node_id,
                    source_action_id,
                }
            });
        let prepared = runtime
            .prepare(&crate::runtime::CompleteInteraction {
                project_id: thread.project_id.map(ProjectId::value),
                product_interaction_id: interaction.id.value(),
                thread_id: thread.id.value(),
                interaction_id: interaction.id.value(),
                text: &interaction.text,
                working_directory: "",
                harness_configuration_name: &thread.harness_configuration_name,
                permission_profile: permission,
                model_selection: execution_model_selection.as_ref(),
                execution_lease_id: None,
                harness_policy: harness_policy.as_ref(),
                invocation: prepared_invocation,
                input_identity: durable_input
                    .as_ref()
                    .map(|input| input.input_identity.as_str()),
                input_digest: durable_input
                    .as_ref()
                    .map(|input| input.input_digest.as_str()),
                contexts: durable_input
                    .as_ref()
                    .map(|input| input.contexts.as_slice())
                    .unwrap_or(&[]),
            })
            .await
            .map_err(StartupReconciliationError::from_runtime)?;
        let bound = match storage
            .bind_prepared_interaction(PreparedInteractionBinding {
                interaction_id: interaction.id,
                graph_node_id: prepared.graph_node_id,
                harness_configuration_name: &prepared.harness_configuration_name,
                harness_configuration_digest: &prepared.harness_configuration_digest,
                effective_execution_digest: &prepared.effective_execution_digest,
                effective_permission_receipt: &prepared.effective_permission_receipt,
            })
            .await
        {
            Ok(bound) => bound,
            Err(error) => {
                let cleanup = runtime.discard_prepared(prepared).await;
                return Err(StartupReconciliationError::retryable(anyhow::anyhow!(
                    "startup binding failed: {error}{}",
                    cleanup
                        .err()
                        .map(|cleanup| format!("; capability cleanup also failed: {cleanup}"))
                        .unwrap_or_default()
                )));
            }
        };
        if !bound {
            return Err(StartupReconciliationError::deterministic(anyhow::anyhow!(
                "could not recover graph binding for {}",
                interaction.id
            )));
        }
        interaction.graph_node_id = Some(prepared.graph_node_id);
    }
    if let Some(graph_node_id) = interaction.graph_node_id {
        // Product never persists writer tokens. Invalidating by node closes the crash window
        // between durable binding and the normal token revocation path.
        runtime
            .invalidate_node_capabilities(graph_node_id)
            .await
            .map_err(StartupReconciliationError::from_runtime)?;
        let metadata = runtime
            .interaction_metadata(graph_node_id)
            .await
            .map_err(StartupReconciliationError::from_runtime)?;
        let expected = storage
            .invocation_graph_source(interaction.id)
            .await
            .map_err(StartupReconciliationError::retryable)?;
        let graph_lease_required = storage
            .invocation_requires_graph_lease(interaction.id)
            .await
            .map_err(StartupReconciliationError::retryable)?;
        let expected = expected.map(|(source_interaction_node_id, source_action_id)| {
            crate::runtime::PreparedInvocation {
                source_interaction_node_id,
                source_action_id,
            }
        });
        let legacy_unleased_invocation =
            !graph_lease_required && expected.is_some() && metadata.invocation.is_none();
        let expected_identity = durable_input
            .as_ref()
            .map(|input| input.input_identity.as_str());
        let expected_digest = durable_input
            .as_ref()
            .map(|input| input.input_digest.as_str());
        if metadata.node_id != graph_node_id
            || (metadata.invocation != expected && !legacy_unleased_invocation)
            || metadata.input_identity.as_deref() != expected_identity
            || metadata.input_digest.as_deref() != expected_digest
        {
            return Err(StartupReconciliationError::deterministic(anyhow::anyhow!(
                "bound graph interaction provenance mismatch for {}",
                interaction.id
            )));
        }
        if let Some(output) = runtime
            .completion_output(graph_node_id)
            .await
            .map_err(StartupReconciliationError::from_runtime)?
        {
            if output.get("nodeId").and_then(serde_json::Value::as_i64) != Some(graph_node_id) {
                return Err(StartupReconciliationError::deterministic(anyhow::anyhow!(
                    "canonical output node mismatch for interaction {}",
                    interaction.id
                )));
            }
            if !storage
                .recover_interaction_accepted(interaction.id, &output)
                .await
                .map_err(StartupReconciliationError::retryable)?
            {
                return Err(StartupReconciliationError::deterministic(anyhow::anyhow!(
                    "interaction {} changed during startup reconciliation",
                    interaction.id
                )));
            }
        } else if durable_input.is_some() {
            storage.recover_identified_interaction_submitted(
                interaction.id,
                "Identified interaction input was recovered after restart and is ready to resume.",
            ).await.map_err(StartupReconciliationError::retryable)?;
        }
    }
    Ok(())
}

pub struct RelayerAppServerConfig {
    pub database_path: PathBuf,
    pub web_directory: PathBuf,
    pub permission_catalog: PathBuf,
    pub control_token: String,
    pub read_only_control_token: Option<String>,
    pub runtime: Option<RelayerRuntimeConfig>,
    pub allow_conversation_import: bool,
    pub export_producer: crate::conversation_export::ExportProducer,
}

pub struct RelayerAppServer {
    product: ProductService,
    web_directory: PathBuf,
    control_token: String,
    read_only_control_token: Option<String>,
    runtime: Option<RuntimeClient>,
    permission_catalog: PermissionCatalog,
    default_harness_configuration: String,
    allow_harness_override: bool,
    allow_conversation_import: bool,
    standalone_workspaces_directory: PathBuf,
    export_producer: crate::conversation_export::ExportProducer,
}

impl RelayerAppServer {
    pub async fn open(config: RelayerAppServerConfig) -> anyhow::Result<Self> {
        if config.read_only_control_token.as_deref() == Some(config.control_token.as_str()) {
            anyhow::bail!("read-only control token must be distinct from write authority");
        }
        let permission_catalog = PermissionCatalog::load(&config.permission_catalog).await?;
        let storage = SqliteProductStore::open(&config.database_path).await?;
        let runtime = match &config.runtime {
            Some(runtime) => Some(
                RuntimeClient::open(
                    &runtime.graph_url,
                    &runtime.harness_url,
                    runtime.graph_control_token.clone(),
                    runtime.harness_control_token.clone(),
                    &runtime.harness_configurations,
                )
                .await?,
            ),
            None => None,
        };
        if config.allow_conversation_import {
            let runtime = runtime.as_ref().ok_or_else(|| {
                anyhow::anyhow!("conversation import requires the GraphComplete runtime")
            })?;
            for import_id in storage.staged_conversation_import_ids().await? {
                runtime.remove_imported_conversation(&import_id).await?;
                storage.remove_conversation_import(&import_id).await?;
            }
        }
        if let Some(runtime) = &runtime {
            for interaction in storage.interrupted_interactions().await? {
                if let Err(error) = reconcile_interrupted_interaction(
                    &storage,
                    runtime,
                    &permission_catalog,
                    interaction.clone(),
                )
                .await
                {
                    let graph_lease_recoverable = storage
                        .invocation_requires_graph_lease(interaction.id)
                        .await?;
                    let identified = storage.interaction_input(interaction.id).await?.is_some();
                    if error.is_retryable() && (graph_lease_recoverable || identified) {
                        if identified {
                            storage
                                .recover_identified_interaction_submitted(
                                    interaction.id,
                                    "Identified interaction startup reconciliation was interrupted transiently and is ready to resume.",
                                )
                                .await?;
                        }
                        // Strict invokes and identified inputs have durable replay identities.
                        // Preserve that recovery path here: the restart recovery passes below will
                        // abort any stale approval receipt, and identified interactions are
                        // normalized to `submitted` before the post-open resume pass. Quarantining
                        // would make the only interaction allowed to consume its identity terminal.
                        eprintln!(
                            "preserving interrupted recoverable interaction {} after transient startup reconciliation failure: {error}",
                            interaction.id
                        );
                        continue;
                    }
                    eprintln!(
                        "quarantining interrupted interaction {} after reconciliation failure: {error}",
                        interaction.id
                    );
                    let harness = storage
                        .get_thread(interaction.thread_id)
                        .await?
                        .map(|thread| thread.harness_configuration_name)
                        .or(interaction.harness_configuration_name.clone())
                        .unwrap_or_else(|| "unknown".into());
                    storage
                        .fail_interaction_completion(
                            interaction.id,
                            &harness,
                            &format!("{} {error}", crate::product::RECONCILIATION_PENDING_PREFIX),
                        )
                        .await?;
                }
            }
        }
        // Reconcile canonical graph acceptance before aborting approvals left open by the dead
        // harness session. A completion may have been accepted after the last product write; in
        // that case graph authority wins while the stale approval is still durably closed below.
        let interrupted_approvals = storage
            .abort_pending_approvals_on_restart(
                "Approval request was aborted because its harness session ended when Relayer stopped.",
                &startup_timestamp(),
            )
            .await?;
        if interrupted_approvals > 0 {
            eprintln!(
                "marked {interrupted_approvals} interrupted approval request(s) aborted during backend startup"
            );
        }
        let interrupted = storage
            .recover_interrupted_action_invocations(
                "Action invocation was interrupted before graph acceptance. Invoke the action again to resume its leased result.",
            )
            .await?;
        if interrupted > 0 {
            eprintln!(
                "reconciled {interrupted} interrupted action invocation result(s), preserving leased results for source-pair recovery"
            );
        }
        let interrupted = storage
            .recover_interrupted_interactions(
                "Interaction was interrupted when Relayer stopped. Send a follow-up to continue.",
                runtime.is_some(),
            )
            .await?;
        if interrupted > 0 {
            eprintln!(
                "marked {interrupted} interrupted ordinary interaction(s) failed during backend startup"
            );
        }
        let default_harness_configuration = config
            .runtime
            .as_ref()
            .map(|runtime| runtime.default_harness_configuration.clone())
            .unwrap_or_else(|| "codex-basic".into());
        let allow_harness_override = config
            .runtime
            .as_ref()
            .is_some_and(|runtime| runtime.allow_harness_override);
        let standalone_workspaces_directory = config
            .runtime
            .as_ref()
            .map(|runtime| runtime.standalone_workspaces_directory.clone())
            .unwrap_or_else(|| config.database_path.with_file_name("workspaces"));
        if let Some(runtime) = &runtime
            && !runtime.has_configuration(&default_harness_configuration)
        {
            anyhow::bail!(
                "default harness configuration is unavailable: {default_harness_configuration}"
            );
        }
        if let Some(runtime) = &runtime {
            let bindings = runtime.permission_bindings(&default_harness_configuration)?;
            if !permission_catalog
                .availability(Some(bindings))
                .iter()
                .any(|profile| profile.available)
            {
                anyhow::bail!(
                    "default harness configuration has no enabled permission profile: {default_harness_configuration}"
                );
            }
        }
        let runtime_harnesses = runtime
            .as_ref()
            .map(RuntimeClient::product_harnesses)
            .unwrap_or_default();
        storage
            .initialize_model_catalog(&default_harness_configuration, &runtime_harnesses)
            .await?;
        Ok(Self {
            product: ProductService::new(storage, runtime.is_some()),
            web_directory: config.web_directory,
            control_token: config.control_token,
            read_only_control_token: config.read_only_control_token,
            runtime,
            permission_catalog,
            default_harness_configuration,
            allow_harness_override,
            allow_conversation_import: config.allow_conversation_import,
            standalone_workspaces_directory,
            export_producer: config.export_producer,
        })
    }

    pub fn router(&self) -> Router {
        api::router(
            self.product.clone(),
            (
                self.control_token.clone(),
                self.read_only_control_token.clone(),
            ),
            self.web_directory.clone(),
            api::ApiRuntime {
                runtime: self.runtime.clone(),
                permission_catalog: self.permission_catalog.clone(),
                default_harness_configuration: self.default_harness_configuration.clone(),
                allow_harness_override: self.allow_harness_override,
                allow_conversation_import: self.allow_conversation_import,
                standalone_workspaces_directory: self.standalone_workspaces_directory.clone(),
                export_producer: self.export_producer.clone(),
            },
        )
    }
}

fn startup_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time is before unix epoch")
        .as_millis()
        .to_string()
}
