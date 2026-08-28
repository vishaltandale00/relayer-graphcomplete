use super::{
    AcceptedInteractionCompletion, Interaction, InteractionId, ProductService, ProjectId, Thread,
    ThreadId,
};
use crate::{
    approval::{
        ApprovalActor, ApprovalCorrelation, ApprovalDecision, ApprovalOutcome, ApprovalRequest,
        ApprovalResolution,
    },
    permissions::PermissionCatalog,
    runtime::{
        ApprovalEvent, ApprovalEventSnapshot, CompleteInteraction, PreparedInteraction,
        PreparedInvocation, RuntimeClient, RuntimeCompletion, RuntimeError,
    },
};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub(crate) const RECONCILIATION_PENDING_PREFIX: &str = "Canonical reconciliation pending:";
const LIVE_RECONCILIATION_ATTEMPTS: u64 = 4;

#[derive(Clone)]
pub(crate) struct InteractionExecutionService {
    product: ProductService,
    runtime: RuntimeClient,
    permission_catalog: PermissionCatalog,
    standalone_workspaces_directory: PathBuf,
    approval_decisions: Arc<Mutex<HashMap<String, ApprovalDecision>>>,
    execution_lease_reconciler: Option<crate::app_server::ExecutionLeaseReconciler>,
}

impl InteractionExecutionService {
    pub(crate) fn new(
        product: ProductService,
        runtime: RuntimeClient,
        permission_catalog: PermissionCatalog,
        standalone_workspaces_directory: PathBuf,
        approval_decisions: Arc<Mutex<HashMap<String, ApprovalDecision>>>,
        execution_lease_reconciler: Option<crate::app_server::ExecutionLeaseReconciler>,
    ) -> Self {
        Self {
            product,
            runtime,
            permission_catalog,
            standalone_workspaces_directory,
            approval_decisions,
            execution_lease_reconciler,
        }
    }

    pub(crate) async fn execute_prepared_interaction(
        &self,
        thread: Thread,
        interaction: Interaction,
        prepared: PreparedInteraction,
    ) {
        let execution = self;
        let runtime = &execution.runtime;
        let working_directory = match thread.project_id {
            Some(project_id) => match execution.product.project_path(project_id).await {
                Ok(path) => path,
                Err(error) => {
                    let message = match runtime.discard_prepared(prepared).await {
                        Ok(()) => error.to_string(),
                        Err(cleanup) => {
                            format!("{error}; capability cleanup also failed: {cleanup}")
                        }
                    };
                    record_background_failure(&execution.product, &thread, &interaction, message)
                        .await;
                    return;
                }
            },
            None => execution
                .standalone_workspaces_directory
                .join(thread.id.value().to_string())
                .to_string_lossy()
                .into_owned(),
        };
        let permission_profile = match execution
            .permission_catalog
            .profile(&thread.permission_profile_id)
        {
            Ok(profile) => profile,
            Err(error) => {
                let message = match runtime.discard_prepared(prepared).await {
                    Ok(()) => error.to_string(),
                    Err(cleanup) => format!("{error}; capability cleanup also failed: {cleanup}"),
                };
                record_background_failure(&execution.product, &thread, &interaction, message).await;
                return;
            }
        };
        let invocation = match execution
            .product
            .invocation_graph_source(interaction.id)
            .await
        {
            Ok(value) => {
                value.map(
                    |(source_interaction_node_id, source_action_id)| PreparedInvocation {
                        source_interaction_node_id,
                        source_action_id,
                    },
                )
            }
            Err(error) => {
                let message = match runtime.discard_prepared(prepared).await {
                    Ok(()) => error.to_string(),
                    Err(cleanup) => format!("{error}; capability cleanup also failed: {cleanup}"),
                };
                record_background_failure(&execution.product, &thread, &interaction, message).await;
                return;
            }
        };
        let (execution_model_plan, execution_model_selection) = match interaction
            .model_selection
            .as_ref()
        {
            Some(selection) => match execution
                .product
                .resolve_execution_model_plan(&thread.harness_configuration_name, selection)
                .await
            {
                Ok((plan, selection)) => (Some(plan), Some(selection)),
                Err(error) => {
                    if let Err(cleanup) = discard_model_preparation(runtime, prepared).await {
                        record_reconciliation_pending(execution, &thread, &interaction, &cleanup)
                            .await;
                        return;
                    }
                    record_pre_execution_model_failure_to_unsent(
                        execution,
                        &thread,
                        &interaction,
                        selection,
                        None,
                        None,
                        None,
                        "model_unavailable",
                        error.to_string(),
                    )
                    .await;
                    return;
                }
            },
            None => (None, None),
        };
        let harness_policy = match execution_model_selection.as_ref() {
            Some(_) => match execution
                .product
                .execution_harness_policy(&thread.harness_configuration_name)
                .await
            {
                Ok(policy) => Some(policy),
                Err(error) => {
                    if let Err(cleanup) = discard_model_preparation(runtime, prepared).await {
                        record_reconciliation_pending(execution, &thread, &interaction, &cleanup)
                            .await;
                        return;
                    }
                    record_pre_execution_model_failure_to_unsent(
                        execution,
                        &thread,
                        &interaction,
                        interaction
                            .model_selection
                            .as_ref()
                            .expect("execution route requires a selected model"),
                        execution_model_selection.as_ref(),
                        None,
                        None,
                        "model_unavailable",
                        error.to_string(),
                    )
                    .await;
                    return;
                }
            },
            None => None,
        };
        let durable_input = match execution.product.interaction_input(interaction.id).await {
            Ok(value) => value,
            Err(error) => {
                record_background_failure(
                    &execution.product,
                    &thread,
                    &interaction,
                    error.to_string(),
                )
                .await;
                return;
            }
        };
        let command = CompleteInteraction {
            project_id: thread.project_id.map(ProjectId::value),
            product_interaction_id: interaction.id.value(),
            thread_id: thread.id.value(),
            interaction_id: interaction.id.value(),
            text: &interaction.text,
            working_directory: &working_directory,
            harness_configuration_name: &thread.harness_configuration_name,
            permission_profile,
            model_selection: execution_model_selection.as_ref(),
            model_plan: execution_model_plan.as_ref(),
            attempt_admission_id: None,
            execution_lease_id: None,
            harness_policy: harness_policy.as_ref(),
            invocation,
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
        };
        let attempt_admission_id = execution_model_selection
            .as_ref()
            .map(|_| uuid::Uuid::new_v4().to_string());
        let command = CompleteInteraction {
            attempt_admission_id: attempt_admission_id.as_deref(),
            ..command
        };
        let admission = if execution_model_selection.is_some() {
            match runtime.admit_provider_execution(&command).await {
                Ok(admission) => Some(admission),
                Err(error) => {
                    if let Err(cleanup) = discard_model_preparation(runtime, prepared).await {
                        record_reconciliation_pending(execution, &thread, &interaction, &cleanup)
                            .await;
                        return;
                    }
                    let (failure_category, _, _) = error.attempt_failure();
                    record_pre_execution_model_failure_to_unsent(
                        execution,
                        &thread,
                        &interaction,
                        interaction
                            .model_selection
                            .as_ref()
                            .expect("provider admission requires a selected model"),
                        execution_model_selection.as_ref(),
                        harness_policy.as_ref(),
                        None,
                        failure_category,
                        error.safe_failure_message().into(),
                    )
                    .await;
                    return;
                }
            }
        } else {
            None
        };
        let attempt = if let (Some(selection), Some(admission)) =
            (execution_model_selection.as_ref(), admission.as_ref())
        {
            match execution
                .product
                .begin_interaction_attempt(super::BeginInteractionAttempt {
                    interaction_id: interaction.id,
                    attempt_admission_id: attempt_admission_id
                        .as_deref()
                        .expect("provider admission requires an attempt admission id")
                        .to_owned(),
                    harness_name: &thread.harness_configuration_name,
                    route: selection,
                    model_plan: execution_model_plan
                        .as_ref()
                        .expect("provider admission requires a model plan")
                        .clone(),
                    admitted_plan: admission.admitted_plan.clone(),
                    adapter_version: admission.adapter_implementation_version,
                    execution_lease_id: &admission.execution_lease_id,
                    expected_harness_policy: Some(
                        harness_policy
                            .as_ref()
                            .expect("provider admission requires a harness policy"),
                    ),
                })
                .await
            {
                Ok(attempt) => Some(attempt),
                Err(error) => {
                    let execution_lease_reconciled = runtime
                        .release_provider_execution(
                            thread.id.value(),
                            &admission.execution_lease_id,
                        )
                        .await
                        .is_ok();
                    if let Err(cleanup) = discard_model_preparation(runtime, prepared).await {
                        record_reconciliation_pending(execution, &thread, &interaction, &cleanup)
                            .await;
                        return;
                    }
                    let failed_receipt = super::BeginInteractionAttempt {
                        interaction_id: interaction.id,
                        attempt_admission_id: attempt_admission_id
                            .as_deref()
                            .expect("provider admission requires an attempt admission id")
                            .to_owned(),
                        harness_name: &thread.harness_configuration_name,
                        route: selection,
                        model_plan: execution_model_plan
                            .as_ref()
                            .expect("provider admission requires a model plan")
                            .clone(),
                        admitted_plan: admission.admitted_plan.clone(),
                        adapter_version: admission.adapter_implementation_version,
                        expected_harness_policy: Some(
                            harness_policy
                                .as_ref()
                                .expect("provider admission requires a harness policy"),
                        ),
                        execution_lease_id: &admission.execution_lease_id,
                    };
                    match execution
                        .product
                        .record_model_attempt_admission_failure(
                            failed_receipt,
                            "model_unavailable",
                            execution_lease_reconciled,
                        )
                        .await
                    {
                        Ok(attempt) if !execution_lease_reconciled => {
                            release_terminal_admission(execution, Some(attempt)).await;
                        }
                        Ok(_) => {}
                        Err(receipt_error) => {
                            record_background_failure(
                                &execution.product,
                                &thread,
                                &interaction,
                                format!(
                                    "attempt admission failed ({error}); failed receipt persistence also failed: {receipt_error}"
                                ),
                            )
                            .await;
                        }
                    }
                    return;
                }
            }
        } else {
            None
        };
        let command = CompleteInteraction {
            execution_lease_id: admission
                .as_ref()
                .map(|admission| admission.execution_lease_id.as_str()),
            ..command
        };
        let expected_invocation = invocation;
        let prepared_graph_node_id = prepared.graph_node_id;
        let completion = runtime.complete_prepared(&command, prepared);
        tokio::pin!(completion);
        let mut cursor = 0;
        let mut harness_session_id = None;
        let mut complete_call_id = None;
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let completion_result: Result<RuntimeCompletion, RuntimeError> = loop {
            tokio::select! {
                result = &mut completion => {
                    match runtime.approval_events(thread.id.value(), cursor).await {
                        Ok(snapshot) => {
                            if let Err(error) = persist_approval_snapshot(
                                execution,
                                thread.id,
                                interaction.id,
                                &mut cursor,
                                &mut harness_session_id,
                                &mut complete_call_id,
                                snapshot,
                            ).await {
                                break Err(RuntimeError::Protocol(error));
                            }
                            let acknowledgement = match runtime
                                .approval_events(thread.id.value(), cursor)
                                .await
                            {
                                Ok(snapshot) => snapshot,
                                Err(error) => break Err(RuntimeError::Protocol(format!(
                                    "could not acknowledge final approval event cursor: {error}"
                                ))),
                            };
                            match final_approval_acknowledgement(cursor, &acknowledgement) {
                                Ok(true) => {
                                    if let Err(error) = persist_approval_snapshot(
                                        execution,
                                        thread.id,
                                        interaction.id,
                                        &mut cursor,
                                        &mut harness_session_id,
                                        &mut complete_call_id,
                                        acknowledgement,
                                    ).await {
                                        break Err(RuntimeError::Protocol(error));
                                    }
                                }
                                Ok(false) => {}
                                Err(error) => break Err(RuntimeError::Protocol(error)),
                            }
                        }
                        Err(RuntimeError::Remote { status: 404, .. }) if harness_session_id.is_none() => {}
                        Err(error) => break Err(RuntimeError::Protocol(format!(
                            "could not perform final approval reconciliation: {error}"
                        ))),
                    }
                    break result;
                }
                _ = interval.tick() => {
                    match runtime.approval_events(thread.id.value(), cursor).await {
                        Ok(snapshot) => {
                            if let Err(error) = persist_approval_snapshot(
                                execution,
                                thread.id,
                                interaction.id,
                                &mut cursor,
                                &mut harness_session_id,
                                &mut complete_call_id,
                                snapshot,
                            ).await {
                                let cancellation = runtime.cancel_completion(thread.id.value()).await;
                                let cleanup = tokio::time::timeout(
                                    std::time::Duration::from_secs(2),
                                    &mut completion,
                                ).await;
                                let mut message = format!(
                                    "could not reconcile approval events for thread {}: {error}",
                                    thread.id
                                );
                                if let Err(cancel_error) = cancellation {
                                    message.push_str(&format!("; cancellation failed: {cancel_error}"));
                                }
                                if cleanup.is_err() {
                                    message.push_str("; runtime cleanup timed out");
                                }
                                break Err(RuntimeError::Protocol(message));
                            }
                        }
                        Err(RuntimeError::Remote { status: 404, .. }) if harness_session_id.is_none() => {}
                        Err(error) => {
                            eprintln!("could not poll approval events for thread {}: {error}", thread.id);
                        }
                    }
                }
            }
        };
        let aborted = match execution
        .product
        .abort_pending_approvals(
            Some(interaction.id),
            "Approval request was aborted because the harness completion ended without a terminal approval event.",
        )
        .await
    {
        Ok(count) => count,
        Err(error) => {
            record_background_failure(
                &execution.product,
                &thread,
                &interaction,
                error.to_string(),
            )
            .await;
            return;
        }
    };
        let completion_result = if aborted > 0 {
            Err(RuntimeError::Protocol(
                "harness completion ended with unresolved approval requests".into(),
            ))
        } else {
            completion_result
        };
        match completion_result {
            Ok(completion) => {
                if let Err(error) = verify_canonical_interaction(
                    runtime,
                    prepared_graph_node_id,
                    expected_invocation,
                    &completion.output,
                )
                .await
                {
                    record_reconciliation_pending(execution, &thread, &interaction, &error).await;
                    return;
                }
                if completion.permission_profile_id != thread.permission_profile_id {
                    let error = format!(
                        "runtime returned permission profile {} for thread pinned to {}",
                        completion.permission_profile_id, thread.permission_profile_id
                    );
                    if let Some(attempt) = attempt {
                        let terminalized = match execution
                            .product
                            .fail_interaction_completion_with_attempt(
                                crate::product::FailedInteractionCompletion {
                                    attempt_id: attempt,
                                    interaction_id: interaction.id,
                                    harness_configuration_name: &thread.harness_configuration_name,
                                    error: &error,
                                    outcome: "execution_failed",
                                    failure_category: "permission_receipt_mismatch",
                                    effect_boundary: "unknown",
                                    return_to_unsent: false,
                                    graph_node_id: None,
                                },
                            )
                            .await
                        {
                            Ok(()) => true,
                            Err(persistence_error) => {
                                eprintln!(
                                    "could not atomically reject attempt {attempt} with a mismatched permission receipt: {persistence_error}"
                                );
                                false
                            }
                        };
                        if terminalized {
                            release_terminal_admission(execution, Some(attempt)).await;
                        }
                    } else {
                        record_background_failure(&execution.product, &thread, &interaction, error)
                            .await;
                    }
                    return;
                }
                let accepted = AcceptedInteractionCompletion {
                    interaction_id: interaction.id,
                    graph_node_id: completion.graph_node_id,
                    harness_configuration_name: &completion.harness_configuration_name,
                    harness_configuration_digest: &completion.harness_configuration_digest,
                    effective_execution_digest: &completion.effective_execution_digest,
                    effective_permission_receipt: &completion.effective_permission_receipt,
                    output: &completion.output,
                };
                let result = match attempt {
                    Some(attempt) => {
                        execution
                            .product
                            .accept_interaction_completion_with_attempt(attempt, accepted)
                            .await
                    }
                    None => {
                        execution
                            .product
                            .accept_interaction_completion(accepted)
                            .await
                    }
                };
                if let Err(error) = result {
                    record_reconciliation_pending(
                        execution,
                        &thread,
                        &interaction,
                        &format!("could not persist accepted interaction: {error}"),
                    )
                    .await;
                } else {
                    release_terminal_admission(execution, attempt).await;
                }
            }
            Err(error) => {
                if let Err(invalidation_error) = runtime
                    .invalidate_node_capabilities(prepared_graph_node_id)
                    .await
                {
                    record_reconciliation_pending(
                    execution,
                    &thread,
                    &interaction,
                    &format!(
                        "runtime failed ({error}); node capability invalidation failed: {invalidation_error}"
                    ),
                )
                .await;
                    return;
                }
                let recovered_output =
                    wait_for_completion_output(runtime, prepared_graph_node_id, interaction.id)
                        .await;
                if let Ok(Some(output)) = recovered_output {
                    if let Err(verify_error) = verify_canonical_interaction(
                        runtime,
                        prepared_graph_node_id,
                        expected_invocation,
                        &output,
                    )
                    .await
                    {
                        record_reconciliation_pending(
                            execution,
                            &thread,
                            &interaction,
                            &format!("runtime failed ({error}); {verify_error}"),
                        )
                        .await;
                        return;
                    }
                    match execution.product.get_interaction(interaction.id).await {
                        Ok(bound) => {
                            let accepted = match (
                                bound.harness_configuration_name.as_deref(),
                                bound.harness_configuration_digest.as_deref(),
                                bound.effective_execution_digest.as_deref(),
                                bound.effective_permission_receipt.as_ref(),
                            ) {
                                (
                                    Some(name),
                                    Some(digest),
                                    Some(execution_digest),
                                    Some(receipt),
                                ) => {
                                    let accepted = AcceptedInteractionCompletion {
                                        interaction_id: interaction.id,
                                        graph_node_id: prepared_graph_node_id,
                                        harness_configuration_name: name,
                                        harness_configuration_digest: digest,
                                        effective_execution_digest: execution_digest,
                                        effective_permission_receipt: receipt,
                                        output: &output,
                                    };
                                    match attempt {
                                        Some(attempt) => {
                                            execution
                                                .product
                                                .accept_interaction_completion_with_attempt(
                                                    attempt, accepted,
                                                )
                                                .await
                                        }
                                        None => {
                                            execution
                                                .product
                                                .accept_interaction_completion(accepted)
                                                .await
                                        }
                                    }
                                }
                                _ => {
                                    eprintln!(
                                        "bound interaction {} lost its prepared execution receipt",
                                        interaction.id
                                    );
                                    return;
                                }
                            };
                            if let Err(persistence_error) = accepted {
                                record_reconciliation_pending(
                                    execution,
                                    &thread,
                                    &interaction,
                                    &persistence_error.to_string(),
                                )
                                .await;
                            } else {
                                release_terminal_admission(execution, attempt).await;
                            }
                            return;
                        }
                        Err(read_error) => {
                            eprintln!(
                                "could not read interaction {} after runtime response loss: {read_error}",
                                interaction.id
                            );
                            return;
                        }
                    }
                }
                match recovered_output {
                    Ok(None) => {
                        let (category, effect_boundary, model_related) = error.attempt_failure();
                        let error_message = error.safe_failure_message().to_owned();
                        let temporal_root = runtime.temporal_features().root_current_write;
                        if temporal_root {
                            let failure_operation = format!(
                                "root-provider-failure:{}",
                                attempt.unwrap_or(interaction.id.value())
                            );
                            if let Err(graph_error) = runtime
                                .fail_graph_completion(
                                    prepared_graph_node_id,
                                    &failure_operation,
                                    category,
                                )
                                .await
                            {
                                record_reconciliation_pending(
                                    execution,
                                    &thread,
                                    &interaction,
                                    &format!(
                                        "runtime failed ({error}); graph completion failure could not be committed: {graph_error}"
                                    ),
                                )
                                .await;
                                return;
                            }
                        }
                        if let Some(attempt) = attempt {
                            let result = execution
                                .product
                                .fail_interaction_completion_with_attempt(
                                    crate::product::FailedInteractionCompletion {
                                        attempt_id: attempt,
                                        interaction_id: interaction.id,
                                        harness_configuration_name: &thread
                                            .harness_configuration_name,
                                        error: &error_message,
                                        outcome: if model_related {
                                            "model_failed"
                                        } else {
                                            "execution_failed"
                                        },
                                        failure_category: category,
                                        effect_boundary,
                                        return_to_unsent: model_related && !temporal_root,
                                        graph_node_id: error.graph_node_id(),
                                    },
                                )
                                .await;
                            if result.is_ok() {
                                release_terminal_admission(execution, Some(attempt)).await;
                            } else if let Err(persistence_error) = result {
                                eprintln!(
                                    "could not atomically finalize failed attempt {attempt}: {persistence_error}"
                                );
                            }
                        } else if model_related && !temporal_root {
                            return_model_failure_to_unsent(
                                execution,
                                &thread,
                                &interaction,
                                error_message,
                            )
                            .await;
                        } else {
                            record_background_failure(
                                &execution.product,
                                &thread,
                                &interaction,
                                error_message,
                            )
                            .await;
                        }
                    }
                    Err(read_error) => {
                        record_reconciliation_pending(
                        execution,
                        &thread,
                        &interaction,
                        &format!(
                            "runtime failed ({error}); canonical output read failed: {read_error}"
                        ),
                    )
                    .await;
                    }
                    Ok(Some(_)) => unreachable!("accepted output returned above"),
                }
            }
        }
    }
}

async fn return_model_failure_to_unsent(
    execution: &InteractionExecutionService,
    thread: &Thread,
    interaction: &Interaction,
    error: String,
) {
    eprintln!(
        "interaction {} model execution failed; returning it to unsent while preserving any durable effects: {error}",
        interaction.id
    );
    if let Err(persistence_error) = execution
        .product
        .return_interaction_to_unsent(interaction.id, &thread.harness_configuration_name)
        .await
    {
        eprintln!(
            "could not return interaction {} to unsent: {persistence_error}; original failure: {error}",
            interaction.id
        );
    }
}

async fn verify_canonical_interaction(
    runtime: &crate::runtime::RuntimeClient,
    graph_node_id: i64,
    expected_invocation: Option<PreparedInvocation>,
    output: &Value,
) -> Result<(), String> {
    if output.get("nodeId").and_then(Value::as_i64) != Some(graph_node_id) {
        return Err(
            "completion output nodeId does not match the prepared graph interaction".into(),
        );
    }
    let mut attempt = 0_u64;
    let metadata = loop {
        match runtime.interaction_metadata(graph_node_id).await {
            Ok(metadata) => break metadata,
            Err(error) if attempt + 1 < LIVE_RECONCILIATION_ATTEMPTS => {
                attempt += 1;
                eprintln!(
                    "canonical metadata read failed for graph interaction {graph_node_id}: {error}; retrying"
                );
                tokio::time::sleep(std::time::Duration::from_millis((attempt * 25).min(1_000)))
                    .await;
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    if metadata.node_id != graph_node_id || metadata.invocation != expected_invocation {
        return Err("graph interaction lease provenance does not match product history".into());
    }
    Ok(())
}

async fn wait_for_completion_output(
    runtime: &crate::runtime::RuntimeClient,
    graph_node_id: i64,
    product_interaction_id: InteractionId,
) -> Result<Option<Value>, RuntimeError> {
    let mut attempt = 0_u64;
    loop {
        match runtime.completion_output(graph_node_id).await {
            Ok(output) => return Ok(output),
            Err(error) if attempt + 1 < LIVE_RECONCILIATION_ATTEMPTS => {
                attempt += 1;
                eprintln!(
                    "canonical output read failed for product interaction {product_interaction_id}: {error}; retrying"
                );
                tokio::time::sleep(std::time::Duration::from_millis((attempt * 25).min(1_000)))
                    .await;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn record_reconciliation_pending(
    execution: &InteractionExecutionService,
    thread: &Thread,
    interaction: &Interaction,
    error: &str,
) {
    let error = format!("{RECONCILIATION_PENDING_PREFIX} {error}");
    for attempt in 1..=LIVE_RECONCILIATION_ATTEMPTS {
        match execution
            .product
            .fail_interaction_completion(interaction.id, &thread.harness_configuration_name, &error)
            .await
        {
            Ok(_) => return,
            Err(persistence_error) if attempt < LIVE_RECONCILIATION_ATTEMPTS => {
                eprintln!(
                    "could not quarantine interaction {}: {persistence_error}; retrying",
                    interaction.id
                );
                tokio::time::sleep(std::time::Duration::from_millis(attempt * 25)).await;
            }
            Err(persistence_error) => {
                eprintln!(
                    "could not quarantine interaction {} after bounded retries: {persistence_error}; original failure: {error}",
                    interaction.id
                );
                return;
            }
        }
    }
}

async fn release_terminal_admission(
    execution: &InteractionExecutionService,
    attempt_id: Option<i64>,
) {
    let Some(attempt_id) = attempt_id else { return };
    if !crate::app_server::reconcile_terminal_execution_lease(
        &execution.product,
        &execution.runtime,
        attempt_id,
    )
    .await
        && let Some(reconciler) = &execution.execution_lease_reconciler
    {
        reconciler.schedule();
    }
}

#[allow(clippy::too_many_arguments)]
async fn record_pre_execution_model_failure_to_unsent(
    execution: &InteractionExecutionService,
    thread: &Thread,
    interaction: &Interaction,
    selection: &super::InteractionModelSelection,
    route: Option<&super::ExecutionModelSelection>,
    policy: Option<&super::ExecutionHarnessPolicy>,
    adapter_version: Option<u32>,
    failure_category: &str,
    error: String,
) {
    eprintln!(
        "interaction {} failed before model execution; preserving its immutable attempt receipt and returning it to unsent: {error}",
        interaction.id
    );
    if let Err(persistence_error) = execution
        .product
        .record_pre_execution_model_failure(super::PreExecutionModelFailure {
            interaction_id: interaction.id,
            harness_name: &thread.harness_configuration_name,
            selection,
            route,
            policy,
            adapter_version,
            failure_category,
        })
        .await
    {
        record_background_failure(
            &execution.product,
            thread,
            interaction,
            format!(
                "pre-execution model failure ({error}); attempt receipt persistence failed: {persistence_error}"
            ),
        )
        .await;
    }
}

async fn discard_model_preparation(
    runtime: &crate::runtime::RuntimeClient,
    prepared: PreparedInteraction,
) -> Result<(), String> {
    let graph_node_id = prepared.graph_node_id;
    match runtime.discard_prepared(prepared).await {
        Ok(()) => Ok(()),
        Err(discard_error) => runtime
            .invalidate_node_capabilities(graph_node_id)
            .await
            .map_err(|invalidation_error| {
                format!(
                    "model preparation cleanup failed ({discard_error}); node capability invalidation also failed: {invalidation_error}"
                )
            }),
    }
}

pub(crate) fn final_approval_acknowledgement(
    cursor: u64,
    snapshot: &ApprovalEventSnapshot,
) -> Result<bool, String> {
    if !snapshot.events.is_empty() || !snapshot.pending_requests.is_empty() {
        return Err("harness did not return an empty final approval acknowledgement".into());
    }
    if snapshot.latest_sequence == cursor {
        return Ok(true);
    }
    if cursor > 0 && snapshot.latest_sequence == 0 {
        return Ok(false);
    }
    Err("harness did not acknowledge the exact final approval event cursor".into())
}

async fn persist_approval_snapshot(
    execution: &InteractionExecutionService,
    thread_id: ThreadId,
    interaction_id: InteractionId,
    cursor: &mut u64,
    harness_session_id: &mut Option<String>,
    complete_call_id: &mut Option<String>,
    snapshot: ApprovalEventSnapshot,
) -> Result<(), String> {
    if snapshot.harness_session_id.trim().is_empty() {
        return Err("harness returned an empty approval session ID".into());
    }
    if let Some(previous) = harness_session_id.as_deref()
        && previous != snapshot.harness_session_id
    {
        return Err("harness approval session changed while completion was active".into());
    }
    *harness_session_id = Some(snapshot.harness_session_id.clone());
    for event in snapshot.events {
        if event.sequence() != *cursor + 1 {
            return Err(format!(
                "harness approval event sequence jumped from {} to {}",
                *cursor,
                event.sequence()
            ));
        }
        match event {
            ApprovalEvent::Requested { request, .. } => {
                validate_approval_correlation(
                    thread_id,
                    interaction_id,
                    &snapshot.harness_session_id,
                    complete_call_id,
                    &request.correlation,
                )?;
                execution
                    .product
                    .record_approval_request(&request)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            ApprovalEvent::Resolved { resolution, .. } => {
                validate_approval_correlation(
                    thread_id,
                    interaction_id,
                    &snapshot.harness_session_id,
                    complete_call_id,
                    &resolution.correlation,
                )?;
                validate_event_resolution_authority(execution, &resolution).await?;
                execution
                    .product
                    .record_approval_resolution(&resolution, true)
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        *cursor += 1;
    }
    if snapshot.latest_sequence != *cursor {
        return Err(format!(
            "harness approval event snapshot ended at {} but reported latest sequence {}",
            *cursor, snapshot.latest_sequence
        ));
    }
    for request in snapshot.pending_requests {
        validate_approval_correlation(
            thread_id,
            interaction_id,
            &snapshot.harness_session_id,
            complete_call_id,
            &request.correlation,
        )?;
        execution
            .product
            .record_approval_request(&request)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn validate_approval_correlation(
    thread_id: ThreadId,
    interaction_id: InteractionId,
    snapshot_session_id: &str,
    complete_call_id: &mut Option<String>,
    correlation: &ApprovalCorrelation,
) -> Result<(), String> {
    if correlation.thread_id != thread_id.value() {
        return Err("harness approval event belongs to a different thread".into());
    }
    if correlation.interaction_id != interaction_id.value() {
        return Err("harness approval event belongs to a different interaction".into());
    }
    if correlation.harness_session_id != snapshot_session_id {
        return Err("harness approval event belongs to a different live session".into());
    }
    if let Some(expected) = complete_call_id.as_deref() {
        if correlation.complete_call_id != expected {
            return Err("harness approval event belongs to a different completion call".into());
        }
    } else {
        *complete_call_id = Some(correlation.complete_call_id.clone());
    }
    Ok(())
}

pub(crate) fn validate_decision_resolution(
    request: &ApprovalRequest,
    decision: ApprovalDecision,
    resolution: &ApprovalResolution,
) -> Result<(), String> {
    if resolution.request_id != request.request_id || resolution.correlation != request.correlation
    {
        return Err("harness returned an approval resolution for a different request".into());
    }
    if resolution.actor != ApprovalActor::User || resolution.decision != Some(decision) {
        return Err("harness approval resolution did not match the user's decision".into());
    }
    let expected_outcome = match decision {
        ApprovalDecision::ApproveOnce | ApprovalDecision::ApproveAlways => {
            ApprovalOutcome::Approved
        }
        ApprovalDecision::Deny => ApprovalOutcome::Denied,
    };
    if resolution.outcome != expected_outcome || resolution.source_request_id.is_some() {
        return Err("harness approval resolution did not match the user's decision".into());
    }
    Ok(())
}

async fn validate_event_resolution_authority(
    execution: &InteractionExecutionService,
    resolution: &ApprovalResolution,
) -> Result<(), String> {
    if resolution.actor != ApprovalActor::User {
        return Ok(());
    }
    let stored = execution
        .product
        .get_approval(&resolution.request_id)
        .await
        .map_err(|error| error.to_string())?;
    if stored.resolution.as_ref() == Some(resolution) {
        return Ok(());
    }
    let decision = execution
        .approval_decisions
        .lock()
        .expect("approval decision lock poisoned")
        .get(&resolution.request_id)
        .copied()
        .ok_or_else(|| {
            "harness returned a user approval resolution without a product decision in flight"
                .to_owned()
        })?;
    validate_decision_resolution(&stored.request, decision, resolution)
}

pub(crate) async fn record_background_failure(
    product: &ProductService,
    thread: &Thread,
    interaction: &Interaction,
    error: String,
) {
    eprintln!(
        "interaction {} completion failed in the backend: {error}",
        interaction.id
    );
    match product
        .fail_interaction_completion(interaction.id, &thread.harness_configuration_name, &error)
        .await
    {
        Ok(true) => {}
        Ok(false) => eprintln!(
            "interaction {} became terminal before its failure could be recorded",
            interaction.id
        ),
        Err(persistence_error) => eprintln!(
            "could not persist failed interaction {}: {persistence_error}; original failure: {error}",
            interaction.id
        ),
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn http_transport_delegates_interaction_execution_to_product() {
        let api_source = include_str!("../api/threads.rs");
        let product_source = include_str!("execution.rs");
        assert!(!api_source.contains("async fn execute_prepared_interaction("));
        assert!(api_source.contains(".execute_prepared_interaction("));
        assert!(product_source.contains("pub(crate) async fn execute_prepared_interaction("));
        assert!(product_source.contains("admit_provider_execution"));
        assert!(product_source.contains("begin_interaction_attempt"));
        assert!(product_source.contains("complete_prepared"));
    }
}
