use crate::{
    api,
    permissions::PermissionCatalog,
    product::{Interaction, PreparedInteractionBinding, ProductService, ProjectId},
    runtime::RuntimeClient,
    storage::{CompletionExecutionRestartSettlement, SqliteProductStore},
};
use axum::Router;
use std::time::Duration;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Notify;

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
        let personal_presentation = if runtime.supports_personal_presentation() {
            storage
                .prepare_personal_presentation_pin(interaction.id, None, &startup_timestamp())
                .await
                .map_err(StartupReconciliationError::retryable)?
                .as_ref()
                .map(crate::runtime::PersonalPresentationExecution::from)
        } else {
            None
        };
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
                model_plan: None,
                attempt_admission_id: None,
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
                personal_presentation: personal_presentation.as_ref(),
                submitted_inputs: durable_input
                    .as_ref()
                    .map(|input| input.submitted_inputs.as_slice())
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
                input_children: &prepared.input_children,
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
        } else if let Some(durable_input) = durable_input.as_ref() {
            if durable_input.submitted_inputs.is_empty() {
                storage.recover_identified_interaction_submitted(
                    interaction.id,
                    "Identified interaction input was recovered after restart and is ready to resume.",
                ).await.map_err(StartupReconciliationError::retryable)?;
            } else {
                let harness = interaction
                    .harness_configuration_name
                    .as_deref()
                    .unwrap_or("unknown");
                if !storage
                    .fail_interrupted_submitted_input(
                        interaction.id,
                        harness,
                        "Submitted interaction input was interrupted before graph acceptance. The input draft was restored; send it again to create a new attempt.",
                    )
                    .await
                    .map_err(StartupReconciliationError::retryable)?
                {
                    return Err(StartupReconciliationError::deterministic(anyhow::anyhow!(
                        "could not terminally recover interrupted submitted input {}",
                        interaction.id
                    )));
                }
            }
        }
    }
    Ok(())
}

async fn reconcile_interrupted_recursive_completion_executions(
    storage: &SqliteProductStore,
    runtime: &RuntimeClient,
) -> anyhow::Result<usize> {
    let executions = storage
        .interrupted_recursive_completion_executions()
        .await?;
    let mut reconciled = 0;
    for execution in executions {
        let projection = runtime
            .current_projection_page(&[execution.graph_completion_id], 0, 1)
            .await?;
        let current = projection
            .states
            .into_iter()
            .find(|state| state.completion_id.value() == execution.graph_completion_id)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "canonical current is missing for launched recursive completion {}",
                    execution.graph_completion_id
                )
            })?;
        let settlement = match current.lifecycle {
            relayer_graph_core::CompletionLifecycle::Succeeded => {
                let output = runtime
                    .completion_output(execution.graph_completion_id)
                    .await?
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "succeeded recursive completion {} has no canonical output",
                            execution.graph_completion_id
                        )
                    })?;
                if output.get("nodeId").and_then(serde_json::Value::as_i64)
                    != Some(execution.graph_completion_id)
                {
                    anyhow::bail!(
                        "canonical output node mismatch for recursive completion {}",
                        execution.graph_completion_id
                    );
                }
                CompletionExecutionRestartSettlement::Accepted { output }
            }
            relayer_graph_core::CompletionLifecycle::Stopped
            | relayer_graph_core::CompletionLifecycle::Failed => {
                let safe_reason = current.safe_reason.ok_or_else(|| {
                    anyhow::anyhow!(
                        "terminal recursive completion {} has no safe reason",
                        execution.graph_completion_id
                    )
                })?;
                CompletionExecutionRestartSettlement::Failed { safe_reason }
            }
            relayer_graph_core::CompletionLifecycle::Active => {
                runtime
                    .fail_graph_completion(
                        execution.graph_completion_id,
                        &format!(
                            "completion-execution-restart:{}:{}",
                            execution.interaction_id, execution.graph_completion_id
                        ),
                        "application_restart",
                    )
                    .await?;
                CompletionExecutionRestartSettlement::Failed {
                    safe_reason: "application_restart".into(),
                }
            }
        };
        if storage
            .reconcile_completion_execution_on_restart(
                execution.interaction_id,
                &execution.permission_origin_digest,
                settlement,
                &startup_timestamp(),
            )
            .await?
        {
            reconciled += 1;
        }
    }
    Ok(reconciled)
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
    pub completion_broker_origin: Option<String>,
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
    execution_lease_reconciler: Option<ExecutionLeaseReconciler>,
    completion_broker_origin: Option<String>,
}

pub(crate) async fn reconcile_terminal_execution_lease(
    product: &ProductService,
    runtime: &RuntimeClient,
    attempt_id: i64,
) -> bool {
    let debt = match product.execution_lease_debt(attempt_id).await {
        Ok(Some(debt)) => debt,
        Ok(None) => return true,
        Err(error) => {
            eprintln!("could not read execution lease debt for attempt {attempt_id}: {error}");
            return false;
        }
    };
    if let Err(error) = runtime
        .release_provider_execution(debt.thread_id.value(), &debt.execution_lease_id)
        .await
    {
        eprintln!(
            "could not release terminal execution lease for attempt {}: {error}",
            debt.attempt_id
        );
        return false;
    }
    match product
        .acknowledge_execution_lease_reconciled(debt.attempt_id, &debt.execution_lease_id)
        .await
    {
        Ok(true) => true,
        Ok(false) => product
            .execution_lease_debt(debt.attempt_id)
            .await
            .is_ok_and(|remaining| remaining.is_none()),
        Err(error) => {
            eprintln!(
                "released execution lease but could not persist reconciliation for attempt {}: {error}",
                debt.attempt_id
            );
            false
        }
    }
}

#[derive(Clone)]
pub(crate) struct ExecutionLeaseReconciler {
    worker: CoalescedWorker,
}

#[derive(Clone)]
struct CoalescedWorker {
    wake: Arc<Notify>,
}

impl CoalescedWorker {
    fn start<F, Fut>(run: F) -> Self
    where
        F: FnOnce(Arc<Notify>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let wake = Arc::new(Notify::new());
        tokio::spawn(run(wake.clone()));
        Self { wake }
    }

    fn schedule(&self) {
        self.wake.notify_one();
    }
}

impl ExecutionLeaseReconciler {
    fn start(product: ProductService, runtime: RuntimeClient) -> Self {
        let worker = CoalescedWorker::start(move |worker_wake| async move {
            loop {
                worker_wake.notified().await;
                reconcile_execution_lease_debt(&product, &runtime, &worker_wake).await;
            }
        });
        Self { worker }
    }

    pub(crate) fn schedule(&self) {
        self.worker.schedule();
    }
}

async fn reconcile_execution_lease_debt(
    product: &ProductService,
    runtime: &RuntimeClient,
    wake: &Notify,
) {
    let mut retry_delay = Duration::from_millis(100);
    loop {
        let debts = match product.unreconciled_execution_lease_debts().await {
            Ok(debts) => debts,
            Err(error) => {
                eprintln!("could not enumerate unreconciled execution leases: {error}");
                tokio::select! {
                    _ = tokio::time::sleep(retry_delay) => {}
                    _ = wake.notified() => {}
                }
                retry_delay = (retry_delay * 2).min(Duration::from_secs(30));
                continue;
            }
        };
        if debts.is_empty() {
            return;
        }
        let mut unresolved = false;
        for debt in debts {
            unresolved |=
                !reconcile_terminal_execution_lease(product, runtime, debt.attempt_id).await;
        }
        if !unresolved {
            return;
        }
        tokio::select! {
            _ = tokio::time::sleep(retry_delay) => {}
            _ = wake.notified() => {}
        }
        retry_delay = (retry_delay * 2).min(Duration::from_secs(30));
    }
}

impl RelayerAppServer {
    pub async fn open(config: RelayerAppServerConfig) -> anyhow::Result<Self> {
        if config.read_only_control_token.as_deref() == Some(config.control_token.as_str()) {
            anyhow::bail!("read-only control token must be distinct from write authority");
        }
        let permission_catalog = PermissionCatalog::load(&config.permission_catalog).await?;
        let storage = SqliteProductStore::open(&config.database_path).await?;
        let runtime = match &config.runtime {
            Some(runtime) => {
                let mut client = RuntimeClient::open(
                    &runtime.graph_url,
                    &runtime.harness_url,
                    runtime.graph_control_token.clone(),
                    runtime.harness_control_token.clone(),
                    &runtime.harness_configurations,
                )
                .await?;
                client.detect_personal_presentation_support().await?;
                Some(client)
            }
            None => None,
        };
        if let Some(runtime) = &runtime
            && runtime.supports_personal_presentation()
        {
            let profile = storage.personal_presentation_profile().await?;
            for version in profile.versions {
                if version.retired {
                    continue;
                }
                let materialized = runtime
                    .ensure_personal_presentation_version(&version.version_key)
                    .await?;
                storage
                    .publish_personal_presentation_version(
                        &version.version_key,
                        materialized.interaction_node_id,
                        materialized.root_layer_id,
                        &materialized.output,
                        &startup_timestamp(),
                    )
                    .await?;
            }
        }
        let default_harness_configuration = config
            .runtime
            .as_ref()
            .map(|runtime| runtime.default_harness_configuration.clone())
            .unwrap_or_else(|| "codex-basic".into());
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
            let reconciled =
                reconcile_interrupted_recursive_completion_executions(&storage, runtime).await?;
            if reconciled > 0 {
                eprintln!(
                    "reconciled {reconciled} launched recursive completion(s) without provider replay"
                );
            }
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
                    let durable_input = storage.interaction_input(interaction.id).await?;
                    let has_submitted_inputs = durable_input
                        .as_ref()
                        .is_some_and(|input| !input.submitted_inputs.is_empty());
                    let context_only_identified = durable_input
                        .as_ref()
                        .is_some_and(|input| input.submitted_inputs.is_empty());
                    if error.is_retryable()
                        && !has_submitted_inputs
                        && (graph_lease_recoverable || context_only_identified)
                    {
                        if context_only_identified {
                            storage
                                .recover_identified_interaction_submitted(
                                    interaction.id,
                                    "Identified interaction startup reconciliation was interrupted transiently and is ready to resume.",
                                )
                                .await?;
                        }
                        // Strict invokes and context-only identified inputs have durable replay
                        // identities. Submitted child input is intentionally excluded: provider
                        // execution may already have produced effects, so its immutable attempt is
                        // failed and its draft restored instead of being replayed automatically.
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
                    if has_submitted_inputs {
                        let pending_error =
                            format!("{} {error}", crate::product::RECONCILIATION_PENDING_PREFIX);
                        if error.is_retryable() {
                            storage
                                .quarantine_interrupted_submitted_input(
                                    interaction.id,
                                    &harness,
                                    &pending_error,
                                )
                                .await?;
                        } else {
                            storage
                                .fail_interrupted_submitted_input(
                                    interaction.id,
                                    &harness,
                                    &format!(
                                        "Submitted interaction input could not be reconciled with canonical graph provenance: {error}. The input draft was restored; send it again only after resolving the provenance mismatch."
                                    ),
                                )
                                .await?;
                        }
                    } else {
                        storage
                            .fail_interaction_completion(
                                interaction.id,
                                &harness,
                                &format!(
                                    "{} {error}",
                                    crate::product::RECONCILIATION_PENDING_PREFIX
                                ),
                            )
                            .await?;
                    }
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
        let allow_harness_override = config
            .runtime
            .as_ref()
            .is_some_and(|runtime| runtime.allow_harness_override);
        let standalone_workspaces_directory = config
            .runtime
            .as_ref()
            .map(|runtime| runtime.standalone_workspaces_directory.clone())
            .unwrap_or_else(|| config.database_path.with_file_name("workspaces"));
        let product = ProductService::new(storage, runtime.is_some());
        let execution_lease_reconciler = runtime.clone().map(|runtime| {
            let reconciler = ExecutionLeaseReconciler::start(product.clone(), runtime);
            reconciler.schedule();
            reconciler
        });
        Ok(Self {
            product,
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
            execution_lease_reconciler,
            completion_broker_origin: config.completion_broker_origin,
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
                execution_lease_reconciler: self.execution_lease_reconciler.clone(),
                completion_broker_origin: self.completion_broker_origin.clone(),
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

#[cfg(test)]
mod execution_lease_reconciler_tests {
    use super::CoalescedWorker;
    use std::{
        collections::VecDeque,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        time::Duration,
    };
    use tokio::sync::Notify;

    #[tokio::test]
    async fn concurrent_outage_wakes_share_one_worker_and_later_debt_is_processed() {
        let debts = Arc::new(Mutex::new(VecDeque::from([1_u64])));
        let outage = Arc::new(AtomicBool::new(true));
        let worker_starts = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let releases = Arc::new(Mutex::new(Vec::new()));
        let completed = Arc::new(Notify::new());

        let worker = CoalescedWorker::start({
            let debts = debts.clone();
            let outage = outage.clone();
            let worker_starts = worker_starts.clone();
            let active = active.clone();
            let max_active = max_active.clone();
            let releases = releases.clone();
            let completed = completed.clone();
            move |wake| async move {
                worker_starts.fetch_add(1, Ordering::SeqCst);
                loop {
                    wake.notified().await;
                    let Some(debt) = debts.lock().expect("debt lock").front().copied() else {
                        continue;
                    };
                    let now_active = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now_active, Ordering::SeqCst);
                    releases.lock().expect("release lock").push(debt);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    if !outage.load(Ordering::SeqCst) {
                        debts.lock().expect("debt lock").pop_front();
                        completed.notify_one();
                    }
                }
            }
        });

        let schedules = (0..32).map(|_| {
            let worker = worker.clone();
            tokio::spawn(async move { worker.schedule() })
        });
        for schedule in schedules {
            schedule.await.expect("schedule task");
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(worker_starts.load(Ordering::SeqCst), 1);
        assert_eq!(max_active.load(Ordering::SeqCst), 1);

        outage.store(false, Ordering::SeqCst);
        worker.schedule();
        tokio::time::timeout(Duration::from_secs(1), completed.notified())
            .await
            .expect("first debt completion");
        debts.lock().expect("debt lock").push_back(2);
        worker.schedule();
        tokio::time::timeout(Duration::from_secs(1), completed.notified())
            .await
            .expect("later debt completion");

        assert_eq!(max_active.load(Ordering::SeqCst), 1);
        assert!(releases.lock().expect("release lock").contains(&2));
        assert!(debts.lock().expect("debt lock").is_empty());
    }
}
