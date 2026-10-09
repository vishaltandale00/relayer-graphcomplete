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
    pub eval_mode: bool,
    pub standalone_workspaces_directory: PathBuf,
}

async fn reconcile_interrupted_interaction(
    storage: &SqliteProductStore,
    runtime: &RuntimeClient,
    permission_catalog: &PermissionCatalog,
    mut interaction: Interaction,
) -> Result<(), StartupReconciliationError> {
    // An agent's child is recovered from its own invoke occurrence whatever its parent's
    // status: its parent may already have failed, and it still has to end.
    let agent_child = storage
        .is_agent_invoked_child(interaction.id)
        .await
        .map_err(StartupReconciliationError::retryable)?;
    let invocation = if agent_child {
        storage.invocation_graph_occurrence(interaction.id).await
    } else {
        storage.invocation_graph_source(interaction.id).await
    }
    .map_err(StartupReconciliationError::retryable)?;
    let durable_input = storage
        .interaction_input(interaction.id)
        .await
        .map_err(StartupReconciliationError::retryable)?;
    // An agent's child is only ever failed at startup, so its graph interaction is located
    // without the checks a new run needs: its saved model or harness policy may no longer
    // validate, and that must not keep its current active.
    if agent_child && interaction.graph_node_id.is_none() {
        let graph_node_id = locate_agent_child_node(storage, runtime, &interaction).await?;
        return fail_interrupted_recursive_child(storage, runtime, &interaction, graph_node_id)
            .await;
    }
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
                thread_icon_selection_eligible: false,
                require_native_continuity: false,
                native_history_anchor: None,
                fresh_native_session: None,
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
        // Provenance is the occurrence the result was created from, not whether that
        // occurrence could still authorize a new preparation.
        let expected = storage
            .invocation_graph_occurrence(interaction.id)
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
        } else if agent_child {
            fail_interrupted_recursive_child(storage, runtime, &interaction, graph_node_id).await?;
        } else if interaction.stop_requested {
            let current = runtime
                .completion_current(graph_node_id)
                .await
                .map_err(StartupReconciliationError::from_runtime)?;
            if current.lifecycle == relayer_graph_core::CompletionLifecycle::Succeeded {
                let output = runtime
                    .completion_output(graph_node_id)
                    .await
                    .map_err(StartupReconciliationError::from_runtime)?
                    .ok_or_else(|| {
                        StartupReconciliationError::retryable(anyhow::anyhow!(
                            "accepted output not yet readable"
                        ))
                    })?;
                if !storage
                    .recover_interaction_accepted(interaction.id, &output)
                    .await
                    .map_err(StartupReconciliationError::retryable)?
                {
                    return Err(StartupReconciliationError::retryable(anyhow::anyhow!(
                        "interaction changed during Stop recovery"
                    )));
                }
                return Ok(());
            }
            if current.lifecycle == relayer_graph_core::CompletionLifecycle::Active {
                runtime
                    .fail_graph_completion(
                        graph_node_id,
                        &format!("interrupted-product-stop:{}", interaction.id),
                        "application_restart",
                    )
                    .await
                    .map_err(StartupReconciliationError::from_runtime)?;
            }
            // The previous process is gone, but an interrupted Stop is not a
            // native terminal acknowledgment. Preserve the failure honestly and
            // never replay work the user asked to stop.
            storage
                .fail_interaction_completion(
                    interaction.id,
                    interaction
                        .harness_configuration_name
                        .as_deref()
                        .unwrap_or("unknown"),
                    "Stop was interrupted when Relayer restarted. Send a follow-up to continue.",
                )
                .await
                .map_err(StartupReconciliationError::retryable)?;
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

/// Restart never reattaches. An agent's child that no launched execution covers (its
/// launch had not reached `launching`, or a user's invoke ran it) is failed in both stores
/// with `application_restart`, keeping its retained current. A current that already ended
/// is projected with its own reason.
async fn fail_interrupted_recursive_child(
    storage: &SqliteProductStore,
    runtime: &RuntimeClient,
    interaction: &Interaction,
    graph_node_id: i64,
) -> Result<(), StartupReconciliationError> {
    let mut current = runtime
        .completion_current(graph_node_id)
        .await
        .map_err(StartupReconciliationError::from_runtime)?;
    if current.lifecycle == relayer_graph_core::CompletionLifecycle::Active {
        runtime
            .fail_graph_completion(
                graph_node_id,
                &format!("interrupted-recursive-child:{}", interaction.id),
                "application_restart",
            )
            .await
            .map_err(StartupReconciliationError::from_runtime)?;
        current = runtime
            .completion_current(graph_node_id)
            .await
            .map_err(StartupReconciliationError::from_runtime)?;
    }
    let reason = match current.lifecycle {
        relayer_graph_core::CompletionLifecycle::Stopped
        | relayer_graph_core::CompletionLifecycle::Failed => current
            .safe_reason
            .unwrap_or_else(|| "application_restart".into()),
        lifecycle => {
            return Err(StartupReconciliationError::retryable(anyhow::anyhow!(
                "interrupted recursive child {} is still {lifecycle:?}",
                interaction.id
            )));
        }
    };
    let harness = thread_harness(storage, interaction).await?;
    if !storage
        .fail_unlaunched_recursive_child(
            interaction.id,
            graph_node_id,
            &harness,
            &reason,
            true,
            false,
            &startup_timestamp(),
        )
        .await
        .map_err(StartupReconciliationError::retryable)?
    {
        return Err(StartupReconciliationError::deterministic(anyhow::anyhow!(
            "interrupted recursive child {} could not be failed",
            interaction.id
        )));
    }
    Ok(())
}

/// The harness a failed row records: its thread's, as ordinary failures record it.
async fn thread_harness(
    storage: &SqliteProductStore,
    interaction: &Interaction,
) -> Result<String, StartupReconciliationError> {
    Ok(storage
        .get_thread(interaction.thread_id)
        .await
        .map_err(StartupReconciliationError::retryable)?
        .map(|thread| thread.harness_configuration_name)
        .or_else(|| interaction.harness_configuration_name.clone())
        .unwrap_or_else(|| "unknown".into()))
}

/// Finds an unbound agent child's graph interaction through its invoke occurrence. The graph
/// keys the child by that occurrence, so this returns the node the parent prepared and
/// creates nothing new. It needs no live harness configuration or permission binding, which
/// may have changed since the child was created. No capability is minted, and nothing is bound.
async fn locate_agent_child_node(
    storage: &SqliteProductStore,
    runtime: &RuntimeClient,
    interaction: &Interaction,
) -> Result<i64, StartupReconciliationError> {
    let (source_interaction_node_id, source_action_id) = storage
        .invocation_graph_occurrence(interaction.id)
        .await
        .map_err(StartupReconciliationError::retryable)?
        .ok_or_else(|| {
            StartupReconciliationError::deterministic(anyhow::anyhow!(
                "agent child {} has no invoke occurrence",
                interaction.id
            ))
        })?;
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
    runtime
        .locate_invoked_interaction(
            thread.project_id.map(ProjectId::value),
            thread.id.value(),
            &interaction.text,
            crate::runtime::PreparedInvocation {
                source_interaction_node_id,
                source_action_id,
            },
        )
        .await
        .map_err(StartupReconciliationError::from_runtime)
}

/// How ending an agent's child after a failed reconciliation went.
enum ChildEnding {
    /// The child ended: in both stores, or only its product row when its graph interaction
    /// cannot be identified as its own.
    Ended,
    /// A transient failure; the child is kept and tried again.
    Retry(anyhow::Error),
}

/// Ends an agent's child whose startup reconciliation failed for good. Its current is failed
/// with `application_restart` when its graph interaction is known and carries the child's own
/// invoke occurrence, and then its product row; otherwise only the product row is quarantined.
/// A node whose provenance does not match is never failed: it may belong to something else.
/// A transient failure on the way keeps the child for a retry: the product row is never made
/// terminal while its graph current might still be active and its own.
async fn end_agent_child_after_failure(
    storage: &SqliteProductStore,
    runtime: &RuntimeClient,
    id: crate::product::InteractionId,
    error: &StartupReconciliationError,
) -> ChildEnding {
    match try_end_agent_child(storage, runtime, id, error).await {
        Ok(ending) => ending,
        Err(failure) => ChildEnding::Retry(failure),
    }
}

async fn try_end_agent_child(
    storage: &SqliteProductStore,
    runtime: &RuntimeClient,
    id: crate::product::InteractionId,
    error: &StartupReconciliationError,
) -> anyhow::Result<ChildEnding> {
    let Some(interaction) = storage.get_interaction(id).await? else {
        return Ok(ChildEnding::Ended);
    };
    let node = match interaction.graph_node_id {
        Some(node) => Some(node),
        None => match locate_agent_child_node(storage, runtime, &interaction).await {
            Ok(node) => Some(node),
            Err(failure) if failure.is_retryable() => {
                return Ok(ChildEnding::Retry(anyhow::anyhow!("{failure}")));
            }
            Err(_) => None,
        },
    };
    let occurrence = storage.invocation_graph_occurrence(id).await?;
    if let Some(node) = node {
        let metadata = match runtime.interaction_metadata(node).await {
            Ok(metadata) => Some(metadata),
            Err(failure) if failure.is_retryable_startup_failure() => {
                return Ok(ChildEnding::Retry(failure.into()));
            }
            Err(_) => None,
        };
        let provenance = metadata.and_then(|metadata| {
            metadata.invocation.map(|invocation| {
                (
                    invocation.source_interaction_node_id,
                    invocation.source_action_id,
                )
            })
        });
        if provenance.is_some() && provenance == occurrence {
            match fail_interrupted_recursive_child(storage, runtime, &interaction, node).await {
                Ok(()) => return Ok(ChildEnding::Ended),
                Err(failure) if failure.is_retryable() => {
                    return Ok(ChildEnding::Retry(anyhow::anyhow!("{failure}")));
                }
                Err(failure) => eprintln!(
                    "interrupted recursive child {id} could not be failed in both stores: {failure}"
                ),
            }
        }
    }
    eprintln!(
        "quarantining interrupted recursive child {id} after reconciliation failure: {error}"
    );
    let harness = thread_harness(storage, &interaction)
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    storage
        .fail_interaction_completion(
            id,
            &harness,
            &format!("{} {error}", crate::product::RECONCILIATION_PENDING_PREFIX),
        )
        .await?;
    Ok(ChildEnding::Ended)
}

pub(crate) async fn reconcile_interrupted_recursive_completion_executions(
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

/// Settles, in order, the work the previous process left interrupted: launched recursive
/// children, then every interrupted interaction, stale approvals, leased action results, and
/// ordinary running interactions. Nothing is replayed through a provider.
pub(crate) async fn reconcile_interrupted_work(
    storage: &SqliteProductStore,
    runtime: Option<&RuntimeClient>,
    permission_catalog: &PermissionCatalog,
) -> anyhow::Result<()> {
    // Agent children an older build left unmarked are marked first, so they are failed
    // below rather than held for a user's invoke.
    let marked = storage.mark_unrecorded_agent_children().await?;
    if marked > 0 {
        eprintln!("marked {marked} interrupted result(s) as agents' children");
    }
    let mut preserved_children = Vec::new();
    if let Some(runtime) = runtime {
        let reconciled =
            reconcile_interrupted_recursive_completion_executions(storage, runtime).await?;
        if reconciled > 0 {
            eprintln!(
                "reconciled {reconciled} launched recursive completion(s) without provider replay"
            );
        }
        for interaction in storage.interrupted_interactions().await? {
            if let Err(error) = reconcile_interrupted_interaction(
                storage,
                runtime,
                permission_catalog,
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
                if !interaction.stop_requested
                    && error.is_retryable()
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
                    if storage.is_agent_invoked_child(interaction.id).await? {
                        preserved_children.push(interaction.id);
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
                if storage.is_agent_invoked_child(interaction.id).await? {
                    if let ChildEnding::Retry(failure) =
                        end_agent_child_after_failure(storage, runtime, interaction.id, &error)
                            .await
                    {
                        eprintln!(
                            "keeping interrupted recursive child {} for a retry: {failure}",
                            interaction.id
                        );
                        preserved_children.push(interaction.id);
                    }
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
                    if !interaction.stop_requested
                        && error.is_retryable()
                        && interaction.graph_node_id.is_some()
                    {
                        storage
                            .quarantine_interrupted_submitted_input(
                                interaction.id,
                                &harness,
                                &pending_error,
                            )
                            .await?;
                    } else {
                        let message = if interaction.graph_node_id.is_none() {
                            format!(
                                "Submitted interaction input could not be bound to a canonical graph interaction during startup: {error}. The input draft was restored; send it again to create a new attempt."
                            )
                        } else {
                            format!(
                                "Submitted interaction input could not be reconciled with canonical graph provenance: {error}. The input draft was restored; send it again only after resolving the provenance mismatch."
                            )
                        };
                        storage
                            .fail_interrupted_submitted_input(interaction.id, &harness, &message)
                            .await?;
                    }
                } else {
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
    }
    if let Some(runtime) = runtime
        && !fail_refused_children_graph(storage, runtime).await
    {
        spawn_refused_children_retry(storage.clone(), runtime.clone());
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
    if let Some(runtime) = runtime
        && !preserved_children.is_empty()
    {
        spawn_interrupted_children_retry(
            storage.clone(),
            runtime.clone(),
            permission_catalog.clone(),
            preserved_children,
        );
    }
    Ok(())
}

/// Restart never reattaches, even when the graph could not be reached during startup: an
/// agent's child that startup preserved after a transient failure is reconciled again in the
/// background until it ends. Nothing else would end it before the next restart, since its
/// parent's execution is gone and a user's invoke does not run it.
/// The first pause before startup retries an interrupted child it kept; each later retry
/// waits twice as long, up to the cap. A summary is logged every few retries.
const INTERRUPTED_CHILD_RETRY_FIRST: Duration = Duration::from_millis(250);
const INTERRUPTED_CHILD_RETRY_CAP: Duration = Duration::from_secs(60);
const INTERRUPTED_CHILD_RETRY_LOG_EVERY: u32 = 10;

fn spawn_interrupted_children_retry(
    storage: SqliteProductStore,
    runtime: RuntimeClient,
    permission_catalog: PermissionCatalog,
    mut children: Vec<crate::product::InteractionId>,
) {
    tokio::spawn(async move {
        let mut delay = INTERRUPTED_CHILD_RETRY_FIRST;
        let mut round = 0_u32;
        while !children.is_empty() {
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(INTERRUPTED_CHILD_RETRY_CAP);
            round += 1;
            if round.is_multiple_of(INTERRUPTED_CHILD_RETRY_LOG_EVERY) {
                eprintln!(
                    "{} interrupted recursive child(ren) still waiting for the graph after {round} retries",
                    children.len()
                );
            }
            let mut pending = Vec::new();
            for id in children {
                let interaction = match storage.get_interaction(id).await {
                    Ok(Some(interaction)) => interaction,
                    Ok(None) => continue,
                    Err(error) => {
                        eprintln!("interrupted recursive child {id} retry read failed: {error}");
                        pending.push(id);
                        continue;
                    }
                };
                if !matches!(
                    interaction.completion_status.as_str(),
                    "not_started" | "submitted" | "running" | "waiting_for_approval"
                ) {
                    continue;
                }
                match reconcile_interrupted_interaction(
                    &storage,
                    &runtime,
                    &permission_catalog,
                    interaction,
                )
                .await
                {
                    Ok(()) => {}
                    Err(error) if error.is_retryable() => pending.push(id),
                    Err(error) => {
                        if let ChildEnding::Retry(failure) =
                            end_agent_child_after_failure(&storage, &runtime, id, &error).await
                        {
                            eprintln!(
                                "interrupted recursive child {id} could not be ended; retrying: {failure}"
                            );
                            pending.push(id);
                        }
                    }
                }
            }
            children = pending;
        }
    });
}

/// Finishes the graph half for agent children the refused-launch cleanup failed in the
/// product before a restart interrupted it. Only children still marked pending are read, and
/// each is unmarked once its current is confirmed terminal. A failure is logged; the next
/// start retries it.
async fn fail_refused_children_graph(
    storage: &SqliteProductStore,
    runtime: &RuntimeClient,
) -> bool {
    let children = match storage.refused_children_awaiting_graph_failure().await {
        Ok(children) => children,
        Err(error) => {
            eprintln!("could not read refused recursive children: {error}");
            return false;
        }
    };
    let mut finished = true;
    for (interaction_id, graph_node_id) in children {
        let current = match runtime.completion_current(graph_node_id).await {
            Ok(current) => current,
            Err(error) => {
                eprintln!(
                    "refused recursive child {interaction_id} current read failed; retrying: {error}"
                );
                finished = false;
                continue;
            }
        };
        if current.lifecycle == relayer_graph_core::CompletionLifecycle::Active
            && let Err(error) = runtime
                .fail_graph_completion(
                    graph_node_id,
                    &format!("recursive-launch-refused:{interaction_id}"),
                    "preparation_failed",
                )
                .await
        {
            eprintln!("refused recursive child {interaction_id} graph failure retry: {error}");
            finished = false;
            continue;
        }

        if let Err(error) = storage
            .confirm_refused_child_graph_failure(interaction_id)
            .await
        {
            eprintln!("refused recursive child {interaction_id} could not be unmarked: {error}");
            finished = false;
        }
    }
    finished
}

/// Retries the graph half of refused children in the background, with the same capped
/// backoff as interrupted children, until every marked child is confirmed terminal.
fn spawn_refused_children_retry(storage: SqliteProductStore, runtime: RuntimeClient) {
    tokio::spawn(async move {
        let mut delay = INTERRUPTED_CHILD_RETRY_FIRST;
        let mut round = 0_u32;
        loop {
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(INTERRUPTED_CHILD_RETRY_CAP);
            round += 1;
            if fail_refused_children_graph(&storage, &runtime).await {
                return;
            }
            if round.is_multiple_of(INTERRUPTED_CHILD_RETRY_LOG_EVERY) {
                eprintln!(
                    "refused recursive children still await their graph after {round} retries"
                );
            }
        }
    });
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
    eval_mode: bool,
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
    // Keep the debt read, provider release, and acknowledgement in one flight.
    // A competing caller leaves the debt unresolved for the existing retry worker.
    let Some(_guard) = product.try_begin_execution_lease_reconciliation(attempt_id) else {
        return false;
    };
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
        reconcile_interrupted_work(&storage, runtime.as_ref(), &permission_catalog).await?;
        let eval_mode = config
            .runtime
            .as_ref()
            .is_some_and(|runtime| runtime.eval_mode);
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
        if let Err(error) = product.consolidate_projects().await {
            eprintln!("project consolidation deferred: {error}");
        }
        let execution_lease_reconciler = runtime.clone().map(|runtime| {
            let reconciler = ExecutionLeaseReconciler::start(product.clone(), runtime);
            reconciler.schedule();
            reconciler
        });
        // Children the harness no longer runs end before the server serves Desktop, so its
        // startup removal finalize does not wait on them; the rest wait in the background.
        if let Some(runtime) = runtime.clone() {
            api::threads::resume_unwinding_recursive_children(
                product.clone(),
                runtime,
                execution_lease_reconciler.clone(),
            )
            .await;
        }
        Ok(Self {
            product,
            web_directory: config.web_directory,
            control_token: config.control_token,
            read_only_control_token: config.read_only_control_token,
            runtime,
            permission_catalog,
            default_harness_configuration,
            allow_harness_override,
            eval_mode,
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
                eval_mode: self.eval_mode,
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
