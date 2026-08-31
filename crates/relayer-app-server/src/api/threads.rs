use super::{
    ApiState,
    auth::{authorize_read, authorize_write},
    error::ApiError,
    types::{
        ActionInvocationResponse, InteractionResponse, ThreadDetailResponse, ThreadResponse,
        ThreadViewResponse,
    },
};
use crate::{
    approval::{ApprovalDecision, ApprovalDecisionSubmission, ApprovalReceipt},
    completion_broker::{CompletionBrokerGrant, CompletionBrokerLease},
    product::{
        AcceptedInteractionCompletion, CreateThreadCommand, Interaction, InteractionContextIntent,
        InteractionId, InteractionModelSelection, InvokeActionOutcome, ModelFamilyId,
        PreExecutionModelFailure, PreparedInteractionBinding, ProjectId, ProviderId,
        RECONCILIATION_PENDING_PREFIX, RetryInteractionCommand, Thread, ThreadId, ThreadView,
        record_background_failure, validate_decision_resolution,
    },
    runtime::{
        CompleteInteraction, PreparedInteraction, PreparedInvocation, RuntimeCompletionBroker,
        RuntimeError,
    },
    storage::{
        CompletionExecutionBinding, CompletionExecutionPhase, CompletionExecutionReserveOutcome,
    },
};
use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CreateThreadRequest {
    title: Option<String>,
    project_id: Option<i64>,
    initial_message: String,
    harness_id: Option<String>,
    harness_configuration_name: Option<String>,
    permission_profile_id: Option<String>,
    model_selection: Option<ModelSelectionRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CreateInteractionRequest {
    text: String,
    input_id: Option<String>,
    #[serde(default)]
    contexts: Vec<InteractionContextIntent>,
    #[serde(default)]
    context_confirmation_ids: Vec<String>,
    input_draft_revision: Option<i64>,
    model_selection: Option<ModelSelectionRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RetryInteractionRequest {
    attempt_id: i64,
    text: String,
    input_id: String,
    #[serde(default)]
    contexts: Vec<InteractionContextIntent>,
    #[serde(default)]
    context_confirmation_ids: Vec<String>,
    input_draft_revision: Option<i64>,
    model_selection: ModelSelectionRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelSelectionRequest {
    family_id: i64,
    provider_id: String,
    model_id: String,
}

#[derive(Serialize)]
pub(super) struct ThreadsResponse {
    threads: Vec<ThreadResponse>,
}

#[derive(Serialize)]
pub(super) struct InteractionsResponse {
    interactions: Vec<InteractionResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InvokeActionResponse {
    invocation: ActionInvocationResponse,
    interaction: InteractionResponse,
    created: bool,
}

#[derive(Serialize)]
pub(super) struct ApprovalDecisionResponse {
    approval: ApprovalReceipt,
}

struct ApprovalDecisionReservation {
    decisions:
        std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, ApprovalDecision>>>,
    request_id: String,
}

impl Drop for ApprovalDecisionReservation {
    fn drop(&mut self) {
        self.decisions
            .lock()
            .expect("approval decision lock poisoned")
            .remove(&self.request_id);
    }
}

pub(super) async fn decide_approval(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, interaction_id, request_id)): Path<(i64, i64, String)>,
    Json(submission): Json<ApprovalDecisionSubmission>,
) -> Result<Json<ApprovalDecisionResponse>, ApiError> {
    authorize_write(&state, &headers)?;
    let thread_id = ThreadId::try_from(thread_id)?;
    let interaction_id = InteractionId::try_from(interaction_id)?;
    let interaction = state.product.get_interaction(interaction_id).await?;
    if interaction.thread_id != thread_id {
        return Err(ApiError::invalid(
            "interaction does not belong to this thread",
        ));
    }
    let stored = state.product.get_approval(&request_id).await?;
    if stored.request.correlation.thread_id != thread_id.value()
        || stored.request.correlation.interaction_id != interaction_id.value()
    {
        return Err(ApiError::not_found(
            "approval request does not belong to this interaction",
        ));
    }
    if stored.resolution.is_some() {
        return Err(ApiError::conflict(
            "approval_already_resolved",
            "approval request already has a terminal resolution",
        ));
    }
    if interaction.completion_status != "waiting_for_approval" {
        return Err(ApiError::conflict(
            "approval_not_actionable",
            "interaction is not waiting for approval",
        ));
    }
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    let _reservation = {
        let mut decisions = state
            .approval_decisions
            .lock()
            .expect("approval decision lock poisoned");
        if decisions.contains_key(&request_id) {
            return Err(ApiError::conflict(
                "approval_decision_in_flight",
                "approval request already has a decision in flight",
            ));
        }
        decisions.insert(request_id.clone(), submission.decision);
        ApprovalDecisionReservation {
            decisions: state.approval_decisions.clone(),
            request_id: request_id.clone(),
        }
    };
    async {
        let resolution = runtime
            .decide_approval(thread_id.value(), &request_id, &submission)
            .await?;
        validate_decision_resolution(&stored.request, submission.decision, &resolution)
            .map_err(|error| ApiError::internal(&error))?;
        let approval = state
            .product
            .record_approval_resolution(&resolution, true)
            .await?;
        Ok(Json(ApprovalDecisionResponse { approval }))
    }
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActionDestinationResponse {
    action_id: i64,
    action_kind: String,
    target_layer_id: i64,
    thread_id: i64,
    interaction_id: i64,
    root_layer_id: i64,
}

pub(super) async fn list(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<ThreadsResponse>, ApiError> {
    authorize_read(&state, &headers)?;
    let threads = state
        .product
        .list_threads()
        .await?
        .into_iter()
        .map(Into::into)
        .collect();
    Ok(Json(ThreadsResponse { threads }))
}

pub(super) async fn create(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<CreateThreadRequest>,
) -> Result<(StatusCode, Json<ThreadViewResponse>), ApiError> {
    authorize_write(&state, &headers)?;
    let project_id = request.project_id.map(ProjectId::try_from).transpose()?;
    let privileged_raw_harness_override =
        state.allow_harness_override && request.harness_configuration_name.is_some();
    let harness_configuration_name = selected_harness_configuration(
        &state,
        request.harness_id.as_deref(),
        request.harness_configuration_name.as_deref(),
    )?;
    let model_selection = request
        .model_selection
        .map(InteractionModelSelection::try_from)
        .transpose()?;
    let permission_profile_id = selected_permission_profile(
        &state,
        &harness_configuration_name,
        request.permission_profile_id.as_deref(),
    )?;
    let allow_unselected_model = privileged_raw_harness_override
        || (state.allow_harness_override
            && state
                .product
                .harness_uses_configuration_model(&harness_configuration_name)
                .await?);
    let personal_presentation_version_key = match state.runtime.as_ref() {
        Some(runtime) if runtime.supports_personal_presentation() => runtime
            .personal_presentation_version_key(&harness_configuration_name)?
            .map(str::to_owned),
        _ => None,
    };
    if let Some(selection) = model_selection.as_ref() {
        state
            .product
            .validate_interaction_model_selection(&harness_configuration_name, selection)
            .await?;
    }
    let thread = state
        .product
        .create_thread(CreateThreadCommand {
            title: request.title,
            project_id,
            initial_message: request.initial_message,
            harness_configuration_name,
            personal_presentation_version_key,
            permission_profile_id,
            model_selection,
            allow_unselected_model,
        })
        .await?;
    let interaction = state
        .product
        .get_interaction(thread.root_interaction_id)
        .await?;
    start_interaction(&state, &thread, interaction, true).await?;
    Ok((
        StatusCode::CREATED,
        Json(
            ThreadView {
                thread,
                active: true,
            }
            .into(),
        ),
    ))
}

pub(super) async fn get(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<ThreadDetailResponse>, ApiError> {
    authorize_read(&state, &headers)?;
    let mut detail = state.product.get_thread(ThreadId::try_from(id)?).await?;
    let stale = refresh_accepted_outputs(
        &state.product,
        state.runtime.as_ref(),
        &mut detail.interactions,
        &detail.action_invocations,
    )
    .await;
    let imported_thread = detail.thread.imported;
    let mut completion_executions = std::collections::HashMap::new();
    for invocation in &detail.action_invocations {
        if let Some(execution) = state
            .product
            .completion_execution(invocation.result_interaction_id)
            .await?
        {
            completion_executions.insert(invocation.result_interaction_id.value(), execution);
        }
    }
    let interactions = project_interactions(
        &state,
        std::mem::take(&mut detail.interactions),
        imported_thread,
        &stale,
    )
    .await?;
    let response = ThreadDetailResponse::from(detail)
        .with_interactions(interactions)
        .with_completion_executions(completion_executions);
    Ok(Json(response))
}

pub(super) async fn export(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Response, ApiError> {
    authorize_write(&state, &headers)?;
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    let exported_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ApiError::internal("system time is before unix epoch"))?
        .as_millis()
        .to_string();
    let body = crate::conversation_export_service::build_conversation_export(
        &state.product,
        runtime,
        ThreadId::try_from(id)?,
        state.export_producer.clone(),
        exported_at,
    )
    .await?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_LENGTH, body.len())
        .body(Body::from(body))
        .map_err(|_| ApiError::internal("could not construct conversation export response"))
}

pub(super) async fn list_interactions(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<InteractionsResponse>, ApiError> {
    authorize_read(&state, &headers)?;
    let mut detail = state.product.get_thread(ThreadId::try_from(id)?).await?;
    let stale = refresh_accepted_outputs(
        &state.product,
        state.runtime.as_ref(),
        &mut detail.interactions,
        &detail.action_invocations,
    )
    .await;
    let imported_thread = detail.thread.imported;
    let interactions =
        project_interactions(&state, detail.interactions, imported_thread, &stale).await?;
    Ok(Json(InteractionsResponse { interactions }))
}

pub(super) async fn project_interaction(
    state: &ApiState,
    interaction: Interaction,
    imported_thread: bool,
    projection_stale: bool,
) -> Result<InteractionResponse, ApiError> {
    let id = interaction.id.value();
    let graph_node_id = interaction.graph_node_id;
    let mut response: InteractionResponse = interaction.into();
    if projection_stale {
        response.mark_projection_stale();
    }
    let durable_input = state
        .product
        .interaction_input(InteractionId::try_from(id)?)
        .await?;
    let submitted_evidence = state
        .product
        .submitted_input_evidence(InteractionId::try_from(id)?)
        .await?;
    let durable_submitted_inputs = submitted_evidence
        .iter()
        .map(|input| relayer_graph_core::SubmittedInput {
            action: input.action.clone(),
            value: input.value.clone(),
        })
        .collect::<Vec<_>>();
    response.set_submitted_inputs(durable_submitted_inputs.clone());
    let has_durable_context = durable_input
        .as_ref()
        .is_some_and(|input| !input.contexts.is_empty());
    let has_durable_submitted_inputs = !durable_submitted_inputs.is_empty();
    if has_durable_context || has_durable_submitted_inputs || imported_thread {
        let Some((runtime, graph_node_id)) = state.runtime.as_ref().zip(graph_node_id) else {
            if has_durable_context || has_durable_submitted_inputs {
                response.mark_projection_stale();
                eprintln!(
                    "could not project interaction input for interaction {id}: graph input is unavailable"
                );
            }
            return Ok(response);
        };
        match runtime.interaction_input(graph_node_id).await {
            Ok(input) => {
                if imported_thread {
                    response.set_submitted_inputs(input.submitted_inputs.clone());
                } else if !durable_submitted_inputs.is_empty()
                    && !submitted_input_semantic_multisets_match(
                        &input.submitted_inputs,
                        &durable_submitted_inputs,
                    )
                {
                    response.mark_projection_stale();
                    eprintln!(
                        "could not project submitted input for interaction {id}: product and graph semantic values diverged"
                    );
                }
                let projected = if input.contexts.is_empty() {
                    if has_durable_context {
                        Err("durable product contexts are missing from graph input")
                    } else {
                        Ok(())
                    }
                } else {
                    match runtime.interaction_context_actions(graph_node_id).await {
                        Ok(actions) if has_durable_context => response.set_contexts(
                            durable_input
                                .expect("durable context checked above")
                                .contexts,
                            input.contexts,
                            actions,
                        ),
                        Ok(actions) if imported_thread => {
                            response.set_imported_contexts(actions, input.contexts)
                        }
                        Ok(_) => Err("graph interaction contexts have no durable product intent"),
                        Err(error) => {
                            eprintln!(
                                "could not read context actions for interaction {id}: {error}"
                            );
                            Err("graph context actions are unavailable")
                        }
                    }
                };
                if let Err(error) = projected {
                    response.mark_projection_stale();
                    eprintln!("could not project context for interaction {id}: {error}");
                }
            }
            Err(error) => {
                response.mark_projection_stale();
                eprintln!("could not project context for interaction {id}: {error}");
            }
        }
    }
    Ok(response)
}

fn submitted_input_semantic_multisets_match(
    left: &[relayer_graph_core::SubmittedInput],
    right: &[relayer_graph_core::SubmittedInput],
) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let canonicalize = |inputs: &[relayer_graph_core::SubmittedInput]| {
        inputs
            .iter()
            .map(|input| serde_json::to_value(input).and_then(|value| serde_json::to_vec(&value)))
            .collect::<Result<Vec<_>, _>>()
    };
    let (Ok(mut left), Ok(mut right)) = (canonicalize(left), canonicalize(right)) else {
        return false;
    };
    left.sort_unstable();
    right.sort_unstable();
    left == right
}

async fn project_interactions(
    state: &ApiState,
    interactions: Vec<Interaction>,
    imported_thread: bool,
    stale: &std::collections::HashSet<i64>,
) -> Result<Vec<InteractionResponse>, ApiError> {
    let mut responses = Vec::with_capacity(interactions.len());
    for interaction in interactions {
        let is_stale = stale.contains(&interaction.id.value());
        responses.push(project_interaction(state, interaction, imported_thread, is_stale).await?);
    }
    Ok(responses)
}

pub(super) async fn create_interaction(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(request): Json<CreateInteractionRequest>,
) -> Result<(StatusCode, Json<InteractionResponse>), ApiError> {
    let operator = if state.authenticator.is_control(&headers) {
        authorize_write(&state, &headers)?;
        None
    } else if state.authenticator.input_operator_token(&headers).is_some() {
        Some(super::input_operator_sessions::authorize_thread(
            &state, &headers, id,
        )?)
    } else {
        authorize_write(&state, &headers)?;
        None
    };
    let thread_id = ThreadId::try_from(id)?;
    if let Some(operator) = operator.as_ref() {
        if !request.text.trim().is_empty()
            || request.model_selection.is_some()
            || !request.contexts.is_empty()
            || !request.context_confirmation_ids.is_empty()
            || request.input_id.is_none()
            || request.input_draft_revision.is_none()
        {
            return Err(ApiError::invalid(
                "input operator Send may submit only its scoped committed input draft",
            ));
        }
        let draft = state.product.action_input_draft(thread_id).await?;
        if draft.attachments.is_empty()
            || draft.attachments.iter().any(|attachment| {
                !operator
                    .occurrences
                    .contains(&super::input_operator_sessions::occurrence_key(
                        &attachment.occurrence,
                    ))
            })
        {
            return Err(ApiError::not_found(
                "input draft contains values outside this operator session",
            ));
        }
    }
    let thread_detail = state.product.get_thread(thread_id).await?;
    let privileged_model_less_thread = state.allow_harness_override
        && thread_detail
            .interactions
            .iter()
            .all(|interaction| interaction.model_selection.is_none());
    let model_selection = request
        .model_selection
        .map(InteractionModelSelection::try_from)
        .transpose()?;
    let thread = thread_detail.thread;
    let allow_unselected_model = privileged_model_less_thread
        || (state.allow_harness_override
            && state
                .product
                .harness_uses_configuration_model(&thread.harness_configuration_name)
                .await?);
    if let Some(selection) = model_selection.as_ref() {
        state
            .product
            .validate_interaction_model_selection(&thread.harness_configuration_name, selection)
            .await?;
    }
    if !request.context_confirmation_ids.is_empty() && request.contexts.is_empty() {
        return Err(ApiError::invalid(
            "contextConfirmationIds require at least one context",
        ));
    }
    if !request.contexts.is_empty() && request.input_id.is_none() {
        eprintln!("rejected context-bearing interaction without a stable inputId");
        return Err(ApiError::internal(
            "Relayer could not send this message. Your draft was preserved.",
        ));
    }
    let context_snapshots = canonical_context_snapshots(&state, &request.contexts)
        .await
        .map_err(context_snapshot_api_error)?;
    let identified = request.input_id.is_some() || !request.contexts.is_empty();
    let interaction = if identified {
        let input_id = request
            .input_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let created = state
            .product
            .create_identified_interaction(
                thread_id,
                crate::product::CreateIdentifiedInteractionCommand {
                    text: &request.text,
                    input_identity: &input_id,
                    contexts: &request.contexts,
                    context_snapshots: &context_snapshots,
                    context_confirmation_ids: &request.context_confirmation_ids,
                    input_draft_revision: request.input_draft_revision,
                    model_selection: model_selection.as_ref(),
                    allow_unselected_model,
                },
            )
            .await;
        match created {
            Err(crate::product::ProductError::Catalog(error)) => return Err(error.into()),
            Err(crate::product::ProductError::Storage(crate::storage::StorageError::Catalog(
                error,
            ))) => return Err(error.into()),
            Err(
                error @ crate::product::ProductError::Storage(
                    crate::storage::StorageError::ContextDraftConflict { .. },
                ),
            ) => return Err(error.into()),
            Err(error @ crate::product::ProductError::InputValidation { .. }) => {
                return Err(error.into());
            }
            Err(
                error @ crate::product::ProductError::Storage(
                    crate::storage::StorageError::ActionInputDraftConflict { .. },
                ),
            ) => return Err(error.into()),
            Err(error) if !request.contexts.is_empty() => {
                eprintln!(
                    "context-bearing interaction was rejected before graph preparation: {error}"
                );
                return Err(ApiError::internal(
                    "Relayer could not send this message. Your draft was preserved.",
                ));
            }
            Err(error) => return Err(error.into()),
            Ok(crate::storage::InteractionInputInsertOutcome::Created(interaction))
            | Ok(crate::storage::InteractionInputInsertOutcome::Existing(interaction)) => {
                interaction
            }
        }
    } else {
        state
            .product
            .create_interaction(
                thread_id,
                &request.text,
                model_selection.as_ref(),
                allow_unselected_model,
            )
            .await?
    };
    let interaction_id = interaction.id;
    let interaction = match start_interaction(&state, &thread, interaction, !identified).await {
        Ok(interaction) => interaction,
        Err(error) if identified => {
            let diagnostic = error.internal_diagnostic();
            eprintln!(
                "identified interaction {interaction_id} failed before graph binding: {diagnostic}"
            );
            if (error.is_deterministic_input_failure()
                || !request.context_confirmation_ids.is_empty())
                && let Err(cleanup) = state
                    .product
                    .discard_unbound_interaction_input(interaction_id)
                    .await
            {
                eprintln!(
                    "could not discard invalid identified interaction {interaction_id}: {cleanup}"
                );
            }
            if !request.contexts.is_empty() {
                return Err(ApiError::internal(
                    "Relayer could not send this message. Your draft was preserved.",
                ));
            }
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    Ok((StatusCode::CREATED, Json(interaction.into())))
}

pub(super) async fn retry_interaction(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, interaction_id)): Path<(i64, i64)>,
    Json(request): Json<RetryInteractionRequest>,
) -> Result<Json<InteractionResponse>, ApiError> {
    authorize_write(&state, &headers)?;
    if request.attempt_id <= 0 {
        return Err(ApiError::invalid("attemptId must be a positive integer"));
    }
    if state.runtime.is_none() {
        return Err(ApiError::invalid("GraphComplete runtime is unavailable"));
    }
    let thread_id = ThreadId::try_from(thread_id)?;
    let interaction_id = InteractionId::try_from(interaction_id)?;
    let thread = state.product.get_thread(thread_id).await?.thread;
    let existing = state.product.get_interaction(interaction_id).await?;
    if existing.thread_id != thread_id {
        return Err(ApiError::invalid(
            "interaction does not belong to this thread",
        ));
    }
    let model_selection = InteractionModelSelection::try_from(request.model_selection)?;
    let context_snapshots = canonical_context_snapshots(&state, &request.contexts)
        .await
        .map_err(context_snapshot_api_error)?;
    let claimed = state
        .product
        .claim_interaction_retry(
            interaction_id,
            RetryInteractionCommand {
                expected_attempt_id: request.attempt_id,
                text: &request.text,
                input_identity: &request.input_id,
                contexts: &request.contexts,
                context_snapshots: &context_snapshots,
                context_confirmation_ids: &request.context_confirmation_ids,
                input_draft_revision: request.input_draft_revision,
                model_selection: &model_selection,
                harness_configuration_name: &thread.harness_configuration_name,
            },
        )
        .await?;
    let interaction = state.product.get_interaction(interaction_id).await?;
    if claimed {
        let consumes_context_confirmations = !request.context_confirmation_ids.is_empty();
        let state = state.clone();
        let thread = thread.clone();
        let execution = interaction.clone();
        tokio::spawn(async move {
            match prepare_and_claim_interaction(&state, &thread, &execution, true, false).await {
                Ok(Some(prepared)) => {
                    state
                        .interaction_execution
                        .as_ref()
                        .expect("runtime-backed interaction execution service")
                        .execute_prepared_interaction(thread, execution, prepared)
                        .await;
                }
                Ok(None) => {}
                Err(error) => {
                    if consumes_context_confirmations {
                        let selection = execution
                            .model_selection
                            .as_ref()
                            .expect("a retry always has a validated model selection");
                        match state
                            .product
                            .record_pre_execution_model_failure(PreExecutionModelFailure {
                                interaction_id: execution.id,
                                harness_name: &thread.harness_configuration_name,
                                selection,
                                route: None,
                                policy: None,
                                adapter_version: None,
                                failure_category: "configuration",
                            })
                            .await
                        {
                            Ok(_) => return,
                            Err(persistence_error) => eprintln!(
                                "could not preserve retry preparation failure {} as an unsent attempt: {persistence_error}; falling back to a terminal failure",
                                execution.id,
                            ),
                        }
                    }
                    record_background_failure(
                        &state.product,
                        &thread,
                        &execution,
                        error.internal_diagnostic(),
                    )
                    .await;
                }
            }
        });
    }
    Ok(Json(interaction.into()))
}

async fn canonical_context_snapshots(
    state: &ApiState,
    contexts: &[InteractionContextIntent],
) -> Result<Vec<relayer_graph_core::InteractionInputNode>, ApiError> {
    if contexts.is_empty() {
        return Ok(Vec::new());
    }
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    let mut snapshots = Vec::with_capacity(contexts.len());
    for context in contexts {
        let target = relayer_graph_core::InteractionContextTarget {
            node_id: relayer_graph_core::NodeId::new(context.target.node_id)
                .ok_or_else(|| ApiError::invalid("context target nodeId must be positive"))?,
            source_interaction_node_id: relayer_graph_core::NodeId::new(
                context.target.source_interaction_node_id,
            )
            .ok_or_else(|| ApiError::invalid("context sourceInteractionNodeId must be positive"))?,
            source_layer_id: relayer_graph_core::LayerId::new(context.target.source_layer_id)
                .ok_or_else(|| ApiError::invalid("context sourceLayerId must be positive"))?,
        };
        snapshots.push(
            runtime
                .canonical_interaction_context_occurrence(&target)
                .await?,
        );
    }
    Ok(snapshots)
}

fn context_snapshot_api_error(error: ApiError) -> ApiError {
    if error.is_deterministic_input_failure() {
        return error;
    }
    eprintln!(
        "context-bearing interaction snapshot resolution failed: {}",
        error.internal_diagnostic()
    );
    ApiError::internal("Relayer could not send this message. Your draft was preserved.")
}

pub(crate) async fn resume_recovered_identified_interactions(state: ApiState) {
    let interactions = match state.product.interrupted_interactions().await {
        Ok(interactions) => interactions,
        Err(error) => {
            eprintln!("could not list recovered identified interactions: {error}");
            return;
        }
    };
    for interaction in interactions {
        if interaction.completion_status != "submitted" {
            continue;
        }
        let identified = match state.product.interaction_input(interaction.id).await {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(error) => {
                eprintln!(
                    "could not read recovered interaction {} input identity: {error}",
                    interaction.id
                );
                false
            }
        };
        if !identified {
            continue;
        }
        let thread = match state.product.get_thread(interaction.thread_id).await {
            Ok(detail) => detail.thread,
            Err(error) => {
                eprintln!(
                    "could not read recovered interaction {} thread: {error}",
                    interaction.id
                );
                continue;
            }
        };
        let consumes_context_confirmations = match state
            .product
            .interaction_consumes_context_confirmations(interaction.id)
            .await
        {
            Ok(consumes) => consumes,
            Err(error) => {
                eprintln!(
                    "could not inspect recovered interaction {} confirmation ownership: {error}",
                    interaction.id
                );
                false
            }
        };
        if let Err(error) = start_interaction(&state, &thread, interaction.clone(), false).await {
            eprintln!(
                "could not resume recovered identified interaction {}: {}",
                interaction.id,
                error.message()
            );
            if (error.is_deterministic_input_failure() || consumes_context_confirmations)
                && let Err(cleanup) = state
                    .product
                    .discard_unbound_interaction_input(interaction.id)
                    .await
            {
                eprintln!(
                    "could not discard recovered invalid interaction {}: {cleanup}",
                    interaction.id
                );
            }
        }
    }
}

pub(super) async fn get_layer(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, interaction_id, layer_id)): Path<(i64, i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    authorize_read(&state, &headers)?;
    let thread_id = ThreadId::try_from(thread_id)?;
    let interaction_id = InteractionId::try_from(interaction_id)?;
    let interaction = state.product.get_interaction(interaction_id).await?;
    if interaction.thread_id != thread_id {
        return Err(ApiError::invalid(
            "interaction does not belong to this thread",
        ));
    }
    let graph_node_id = interaction
        .graph_node_id
        .ok_or_else(|| ApiError::invalid("interaction has no accepted graph"))?;
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    Ok(Json(runtime.get_layer(graph_node_id, layer_id).await?))
}

pub(super) async fn get_input_children(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, interaction_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    authorize_read(&state, &headers)?;
    let thread_id = ThreadId::try_from(thread_id)?;
    let interaction_id = InteractionId::try_from(interaction_id)?;
    let interaction = state.product.get_interaction(interaction_id).await?;
    if interaction.thread_id != thread_id {
        return Err(ApiError::invalid(
            "interaction does not belong to this thread",
        ));
    }
    if let Some((runtime, graph_node_id)) = state.runtime.as_ref().zip(interaction.graph_node_id) {
        return Ok(Json(
            runtime.interaction_input_children(graph_node_id).await?,
        ));
    }
    let evidence = state
        .product
        .submitted_input_evidence(interaction_id)
        .await?;
    Ok(Json(serde_json::json!({
        "children": evidence.into_iter().map(|input| serde_json::json!({
            "presentingInteractionNodeId": input.occurrence.presenting_interaction_node_id,
            "presentingLayerId": input.occurrence.presenting_layer_id,
            "actionId": input.occurrence.action_id,
            "sourceNodeId": input.source_node_id,
            "action": input.action,
            "value": input.value,
            "attemptState": input.attempt_state,
        })).collect::<Vec<_>>()
    })))
}

pub(super) async fn get_action_destination(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, interaction_id, action_id)): Path<(i64, i64, i64)>,
) -> Result<Json<ActionDestinationResponse>, ApiError> {
    authorize_read(&state, &headers)?;
    let thread_id = ThreadId::try_from(thread_id)?;
    let interaction_id = InteractionId::try_from(interaction_id)?;
    let source = state.product.get_interaction(interaction_id).await?;
    if source.thread_id != thread_id {
        return Err(ApiError::invalid(
            "interaction does not belong to this thread",
        ));
    }
    if source.completion_status != "accepted" {
        return Err(ApiError::invalid(
            "action destinations require an accepted source interaction",
        ));
    }
    let source_graph_node_id = source
        .graph_node_id
        .ok_or_else(|| ApiError::invalid("interaction has no accepted graph"))?;
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    let action = runtime.get_action(source_graph_node_id, action_id).await?;
    let target_layer_id = action
        .target_layer_id
        .ok_or_else(|| ApiError::invalid("invoke action has not resolved to a destination"))?;
    if action.id != action_id || action.kind != "invoke" || action.state != "accepted" {
        return Err(ApiError::invalid(
            "action is not a resolved accepted invoke action for this interaction",
        ));
    }
    let layer_owner = runtime
        .get_layer_owner(source_graph_node_id, target_layer_id)
        .await?;
    if layer_owner.layer_id != target_layer_id {
        return Err(ApiError::internal(
            "GraphComplete returned a mismatched action destination layer",
        ));
    }
    let mut destination = state
        .product
        .get_interaction_by_graph_node_id(layer_owner.owner_interaction_node_id)
        .await?;
    if is_reconciliation_pending(&destination) {
        reconcile_quarantined_interaction(&state.product, runtime, &mut destination).await?;
    }
    if destination.completion_status != "accepted" {
        return Err(ApiError::invalid(
            "invoke action destination is not accepted",
        ));
    }
    let output = runtime
        .completion_output(layer_owner.owner_interaction_node_id)
        .await?
        .ok_or_else(|| ApiError::invalid("invoke action destination has no accepted output"))?;
    if output.get("nodeId").and_then(Value::as_i64) != Some(layer_owner.owner_interaction_node_id) {
        return Err(ApiError::internal(
            "GraphComplete returned output for a different destination interaction",
        ));
    }
    let root_layer_id = output
        .pointer("/rootLayer/layer/id")
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::internal("accepted destination output has no root layer"))?;
    if root_layer_id != target_layer_id {
        return Err(ApiError::internal(
            "invoke action target does not match its destination root layer",
        ));
    }
    Ok(Json(ActionDestinationResponse {
        action_id,
        action_kind: action.kind,
        target_layer_id,
        thread_id: destination.thread_id.value(),
        interaction_id: destination.id.value(),
        root_layer_id,
    }))
}

pub(super) async fn refresh_accepted_outputs(
    product: &crate::product::ProductService,
    runtime: Option<&crate::runtime::RuntimeClient>,
    interactions: &mut [Interaction],
    action_invocations: &[crate::product::ActionInvocation],
) -> std::collections::HashSet<i64> {
    let mut stale = std::collections::HashSet::new();
    let invoked_source_interaction_ids = action_invocations
        .iter()
        .map(|invocation| invocation.source_interaction_id.value())
        .collect::<std::collections::HashSet<_>>();
    let invoked_action_ids = action_invocations
        .iter()
        .map(|invocation| invocation.action_id)
        .collect::<std::collections::HashSet<_>>();
    for interaction in interactions {
        if is_reconciliation_pending(interaction) {
            match runtime {
                Some(runtime) => {
                    if reconcile_quarantined_interaction(product, runtime, interaction)
                        .await
                        .is_err()
                    {
                        stale.insert(interaction.id.value());
                    }
                }
                None => {
                    stale.insert(interaction.id.value());
                }
            }
        }
        let Some(graph_node_id) = interaction.graph_node_id else {
            continue;
        };
        if interaction.completion_status != "accepted" {
            continue;
        }
        if !invoked_source_interaction_ids.contains(&interaction.id.value())
            && !interaction
                .completion_output
                .as_ref()
                .is_some_and(|output| output_contains_invoke_action(output, &invoked_action_ids))
        {
            continue;
        }
        match runtime {
            Some(runtime) => match runtime.completion_output(graph_node_id).await {
                Ok(Some(output))
                    if output.get("nodeId").and_then(Value::as_i64) == Some(graph_node_id) =>
                {
                    interaction.completion_output = Some(output);
                }
                _ => {
                    stale.insert(interaction.id.value());
                }
            },
            None => {
                stale.insert(interaction.id.value());
            }
        }
    }
    stale
}

fn is_reconciliation_pending(interaction: &Interaction) -> bool {
    interaction.completion_status == "failed"
        && interaction
            .completion_error
            .as_deref()
            .is_some_and(|error| error.starts_with(RECONCILIATION_PENDING_PREFIX))
}

async fn reconcile_quarantined_interaction(
    product: &crate::product::ProductService,
    runtime: &crate::runtime::RuntimeClient,
    interaction: &mut Interaction,
) -> Result<(), RuntimeError> {
    let graph_node_id = interaction.graph_node_id.ok_or_else(|| {
        RuntimeError::Protocol("quarantined interaction has no graph binding".into())
    })?;
    runtime.invalidate_node_capabilities(graph_node_id).await?;
    let metadata = runtime.interaction_metadata(graph_node_id).await?;
    let durable_input = product
        .interaction_input(interaction.id)
        .await
        .map_err(|error| RuntimeError::Protocol(error.to_string()))?;
    let expected = product
        .invocation_graph_source(interaction.id)
        .await
        .map_err(|error| {
            RuntimeError::Protocol(format!(
                "cannot read product invocation provenance: {error}"
            ))
        })?;
    let expected =
        expected.map(
            |(source_interaction_node_id, source_action_id)| PreparedInvocation {
                source_interaction_node_id,
                source_action_id,
            },
        );
    let graph_lease_required = product
        .invocation_requires_graph_lease(interaction.id)
        .await
        .map_err(|error| RuntimeError::Protocol(error.to_string()))?;
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
        return Err(RuntimeError::Protocol(
            "graph interaction lease or input provenance does not match product history".into(),
        ));
    }
    let Some(output) = runtime.completion_output(graph_node_id).await? else {
        if legacy_unleased_invocation {
            const LEGACY_INTERRUPTED: &str = "Legacy action invocation ended without canonical graph acceptance. Its action remains unresolved.";
            if product
                .terminate_legacy_action_invocation(interaction.id, LEGACY_INTERRUPTED)
                .await
                .map_err(|error| RuntimeError::Protocol(error.to_string()))?
            {
                interaction.completion_error = Some(LEGACY_INTERRUPTED.into());
                return Ok(());
            }
        }
        if durable_input
            .as_ref()
            .is_some_and(|input| !input.submitted_inputs.is_empty())
        {
            const INTERRUPTED: &str = "Submitted interaction input was interrupted before graph acceptance. The input draft was restored; send it again to create a new attempt.";
            if product
                .finalize_quarantined_submitted_input_failure(interaction.id, INTERRUPTED)
                .await
                .map_err(|error| RuntimeError::Protocol(error.to_string()))?
            {
                *interaction = product
                    .get_interaction(interaction.id)
                    .await
                    .map_err(|error| RuntimeError::Protocol(error.to_string()))?;
                return Ok(());
            }
        }
        return Err(RuntimeError::Protocol(
            "canonical completion is not accepted yet".into(),
        ));
    };
    if output.get("nodeId").and_then(Value::as_i64) != Some(graph_node_id) {
        return Err(RuntimeError::Protocol(
            "canonical completion output node mismatch".into(),
        ));
    }
    if product
        .recover_interaction_accepted(interaction.id, &output)
        .await
        .map_err(|error| RuntimeError::Protocol(error.to_string()))?
    {
        interaction.completion_status = "accepted".into();
        interaction.completion_output = Some(output);
        interaction.completion_error = None;
        return Ok(());
    }
    let current = product
        .get_interaction(interaction.id)
        .await
        .map_err(|error| RuntimeError::Protocol(error.to_string()))?;
    if current.completion_status == "accepted"
        && current.graph_node_id == Some(graph_node_id)
        && current.completion_output.as_ref() == Some(&output)
    {
        *interaction = current;
        return Ok(());
    }
    Err(RuntimeError::Protocol(
        "product interaction changed before canonical promotion".into(),
    ))
}

fn output_contains_invoke_action(
    value: &Value,
    invoked_action_ids: &std::collections::HashSet<i64>,
) -> bool {
    match value {
        Value::Object(object) => {
            (object.get("kind").and_then(Value::as_str) == Some("invoke")
                && object
                    .get("id")
                    .and_then(Value::as_i64)
                    .is_some_and(|id| invoked_action_ids.contains(&id)))
                || object
                    .values()
                    .any(|value| output_contains_invoke_action(value, invoked_action_ids))
        }
        Value::Array(values) => values
            .iter()
            .any(|value| output_contains_invoke_action(value, invoked_action_ids)),
        _ => false,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CompletePreparedChildRequest {
    interaction_node: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompletePreparedChildResponse {
    completion_id: i64,
}

pub(super) async fn complete_prepared_child(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(input): Json<CompletePreparedChildRequest>,
) -> Result<(StatusCode, Json<CompletePreparedChildResponse>), ApiError> {
    if input.interaction_node < 1 {
        return Err(ApiError::invalid(
            "interactionNode must be a positive integer",
        ));
    }
    let grant = authorize_completion_broker(&state, &headers)?;
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    let metadata = runtime.interaction_metadata(input.interaction_node).await?;
    let invocation = metadata
        .invocation
        .filter(|invocation| invocation.source_interaction_node_id == grant.source_completion_id)
        .ok_or_else(|| {
            ApiError::invalid("prepared completion does not belong to this execution")
        })?;
    let action = runtime
        .get_action(grant.source_completion_id, invocation.source_action_id)
        .await?;
    if action.kind != "invoke" || action.state != "accepted" {
        return Err(ApiError::invalid(
            "prepared completion requires an accepted invoke action",
        ));
    }
    let interaction_text = action
        .interaction_text
        .as_deref()
        .ok_or_else(|| ApiError::invalid("invoke action has no interaction text"))?;
    let outcome = state
        .product
        .invoke_action_recursively(
            grant.source_interaction_id,
            invocation.source_action_id,
            interaction_text,
        )
        .await?;
    let thread = state.product.get_thread(grant.thread_id).await?.thread;
    if outcome.interaction.thread_id != thread.id {
        return Err(ApiError::invalid(
            "recursive completion changed its owning thread",
        ));
    }
    if let Some(existing) = state
        .product
        .completion_execution(outcome.interaction.id)
        .await?
    {
        if existing.graph_completion_id != input.interaction_node {
            return Err(ApiError::invalid(
                "recursive completion is already bound to a different graph identity",
            ));
        }
        if existing.phase != CompletionExecutionPhase::Reserved {
            return Ok((
                StatusCode::OK,
                Json(CompletePreparedChildResponse {
                    completion_id: existing.graph_completion_id,
                }),
            ));
        }
    }

    let prepared = match prepare_and_claim_interaction(
        &state,
        &thread,
        &outcome.interaction,
        false,
        true,
    )
    .await?
    {
        Some(prepared) => prepared,
        None => {
            for attempt in 0..10 {
                if let Some(existing) = state
                    .product
                    .completion_execution(outcome.interaction.id)
                    .await?
                {
                    if existing.graph_completion_id != input.interaction_node {
                        return Err(ApiError::invalid(
                            "recursive completion is already bound to a different graph identity",
                        ));
                    }
                    return Ok((
                        StatusCode::OK,
                        Json(CompletePreparedChildResponse {
                            completion_id: existing.graph_completion_id,
                        }),
                    ));
                }
                if attempt < 9 {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            }
            return Err(ApiError::invalid(
                "recursive completion preparation is already in progress",
            ));
        }
    };
    if prepared.graph_node_id != input.interaction_node {
        let prepared_id = prepared.graph_node_id;
        runtime.discard_prepared(prepared).await?;
        return Err(ApiError::invalid(format!(
            "prepared completion identity changed from {} to {prepared_id}",
            input.interaction_node
        )));
    }
    let permission_origin_digest =
        completion_permission_origin_digest(&prepared.effective_permission_receipt, invocation)?;
    let timestamp = completion_timestamp();
    let reserved = state
        .product
        .reserve_completion_execution(
            CompletionExecutionBinding {
                interaction_id: outcome.interaction.id,
                graph_completion_id: prepared.graph_node_id,
                harness_configuration_name: &prepared.harness_configuration_name,
                harness_configuration_digest: &prepared.harness_configuration_digest,
                model_execution_digest: &prepared.effective_execution_digest,
                permission_origin_digest: &permission_origin_digest,
            },
            &timestamp,
        )
        .await?;
    if !state
        .product
        .claim_completion_execution_launching(
            outcome.interaction.id,
            &permission_origin_digest,
            &timestamp,
        )
        .await?
    {
        let existing = match reserved {
            CompletionExecutionReserveOutcome::Created(execution)
            | CompletionExecutionReserveOutcome::Existing(execution) => execution,
        };
        return Ok((
            StatusCode::OK,
            Json(CompletePreparedChildResponse {
                completion_id: existing.graph_completion_id,
            }),
        ));
    }

    let prepared = match claim_and_activate_prepared_interaction(
        &state,
        &thread,
        &outcome.interaction,
        prepared,
        true,
        false,
    )
    .await
    {
        Ok(Some(prepared)) => prepared,
        Ok(None) => {
            let _ = state
                .product
                .settle_completion_execution(
                    outcome.interaction.id,
                    &permission_origin_digest,
                    None,
                    Some("activation_ownership_lost"),
                    &completion_timestamp(),
                )
                .await;
            return Err(ApiError::internal(
                "reserved recursive completion lost activation ownership",
            ));
        }
        Err(error) => {
            let _ = state
                .product
                .settle_completion_execution(
                    outcome.interaction.id,
                    &permission_origin_digest,
                    None,
                    Some("capability_activation_failed"),
                    &completion_timestamp(),
                )
                .await;
            return Err(error);
        }
    };

    let broker_url = runtime
        .agent_authored_complete_available(&prepared)
        .then(|| state.completion_brokers.url())
        .flatten();
    let child_broker_lease = broker_url.as_ref().map(|_| {
        state.completion_brokers.issue(CompletionBrokerGrant {
            thread_id: thread.id,
            source_interaction_id: outcome.interaction.id,
            source_completion_id: prepared.graph_node_id,
        })
    });
    let completion_broker =
        child_broker_lease
            .as_ref()
            .zip(broker_url.as_deref())
            .map(|(lease, url)| RuntimeCompletionBroker {
                url,
                token: lease.token(),
            });
    let started = runtime
        .start_invoked_completion(
            thread.id.value(),
            outcome.interaction.id.value(),
            &prepared,
            invocation,
            completion_broker,
        )
        .await;
    let started = match started {
        Ok(started) => started,
        Err(error) => {
            spawn_failed_recursive_start_cleanup(
                state.clone(),
                thread,
                outcome.interaction,
                prepared,
                permission_origin_digest,
            );
            return Err(error.into());
        }
    };
    let attachment_result = if let Some(attachment) = started.attachment.as_ref() {
        state
            .product
            .attach_completion_execution(
                outcome.interaction.id,
                &permission_origin_digest,
                &Value::Object(attachment.clone()),
                &completion_timestamp(),
            )
            .await
            .map(|_| ())
    } else {
        Ok(())
    };

    let child_thread_id = thread.id.value();
    let child_completion_id = prepared.graph_node_id;
    spawn_recursive_completion_observers(
        state.clone(),
        thread,
        outcome.interaction,
        prepared,
        permission_origin_digest,
        child_broker_lease,
    );
    if let Err(error) = attachment_result {
        let _ = runtime
            .cancel_invoked_completion(child_thread_id, child_completion_id)
            .await;
        let _ = runtime
            .fail_graph_completion(
                child_completion_id,
                &format!("recursive-attachment-persist:{child_completion_id}"),
                "provider_attachment_persist_failed",
            )
            .await;
        return Err(error.into());
    }
    Ok((
        StatusCode::CREATED,
        Json(CompletePreparedChildResponse {
            completion_id: started.completion_id,
        }),
    ))
}

fn spawn_failed_recursive_start_cleanup(
    state: ApiState,
    thread: Thread,
    interaction: Interaction,
    prepared: PreparedInteraction,
    permission_origin_digest: String,
) {
    tokio::spawn(async move {
        let completion_id = prepared.graph_node_id;
        let Some(runtime) = state.runtime.as_ref() else {
            return;
        };
        loop {
            match runtime
                .cancel_invoked_completion(thread.id.value(), completion_id)
                .await
            {
                Ok(_) => break,
                Err(error) => eprintln!(
                    "recursive completion {completion_id} start-failure cancellation retry: {error}"
                ),
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        loop {
            match runtime
                .fail_graph_completion(
                    completion_id,
                    &format!("recursive-provider-start:{}", interaction.id),
                    "provider_start_failed",
                )
                .await
            {
                Ok(_) => break,
                Err(error) => eprintln!(
                    "recursive completion {completion_id} start-failure graph retry: {error}"
                ),
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        loop {
            match state
                .product
                .finalize_completion_execution_failed(
                    interaction.id,
                    &permission_origin_digest,
                    &thread.harness_configuration_name,
                    "provider_start_failed",
                    &completion_timestamp(),
                )
                .await
            {
                Ok(_) => break,
                Err(error) => eprintln!(
                    "recursive completion {completion_id} start-failure settlement retry: {error}"
                ),
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        loop {
            match runtime.discard_prepared(prepared.clone()).await {
                Ok(_) => break,
                Err(error) => eprintln!(
                    "recursive completion {completion_id} start-failure discard retry: {error}"
                ),
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    });
}

pub(super) async fn completion_current(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(completion_id): Path<i64>,
) -> Result<Json<relayer_graph_core::CompletionState>, ApiError> {
    let grant = authorize_completion_broker(&state, &headers)?;
    authorize_child_completion(&state, grant, completion_id).await?;
    Ok(Json(
        state
            .runtime
            .as_ref()
            .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?
            .completion_current(completion_id)
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CompletionResultQuery {
    /// Revision the caller has already observed. The observation stays open past it.
    #[serde(default)]
    after_revision: Option<u64>,
}

pub(super) async fn completion_result(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(completion_id): Path<i64>,
    Query(query): Query<CompletionResultQuery>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let grant = authorize_completion_broker(&state, &headers)?;
    authorize_child_completion(&state, grant, completion_id).await?;
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    let mut current = runtime.completion_current(completion_id).await?;
    if let Some(after_revision) = query.after_revision
        && current.lifecycle == relayer_graph_core::CompletionLifecycle::Active
        && current.head_revision <= after_revision
        && state
            .completion_observations
            .hold(completion_id, after_revision)
            .await
    {
        current = runtime.completion_current(completion_id).await?;
    }
    match current.lifecycle {
        relayer_graph_core::CompletionLifecycle::Succeeded => {
            let output = runtime
                .completion_output(completion_id)
                .await?
                .ok_or_else(|| {
                    ApiError::internal("succeeded completion has no canonical output")
                })?;
            Ok((StatusCode::OK, Json(output["rootLayer"].clone())))
        }
        relayer_graph_core::CompletionLifecycle::Active => Ok((
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "current": current })),
        )),
        relayer_graph_core::CompletionLifecycle::Stopped
        | relayer_graph_core::CompletionLifecycle::Failed => Ok((
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "completionId": completion_id,
                "lifecycle": current.lifecycle,
                "reason": current.safe_reason,
                "current": current,
            })),
        )),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StopCompletionRequest {
    /// Caller-supplied context for its own record. The durable safe reason stays canonical.
    #[serde(default)]
    reason: Option<String>,
}

pub(super) async fn stop_completion(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(completion_id): Path<i64>,
    request: Option<Json<StopCompletionRequest>>,
) -> Result<Json<Value>, ApiError> {
    let grant = authorize_completion_broker(&state, &headers)?;
    let interaction = authorize_child_completion(&state, grant, completion_id).await?;
    let reason = request
        .and_then(|Json(body)| body.reason)
        .unwrap_or_default();
    if reason.len() > 200 || reason.chars().any(char::is_control) {
        return Err(ApiError::invalid(
            "stop reason must be at most 200 non-control characters",
        ));
    }
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    // Settle the durable current before cancelling the provider. Cancelling first lets the
    // provider-exit observer record `provider_exited_without_return` and win the race, and a
    // deliberately stopped child would then report `failed`.
    let stopped = runtime
        .stop_graph_completion(
            completion_id,
            &format!("completion-stop:{}:{completion_id}", interaction.id),
        )
        .await;
    let (lifecycle, revision) = match stopped {
        Ok(receipt) => (receipt.lifecycle, receipt.revision),
        // A racing child can settle between the parent's decision and this transition.
        // An already terminal completion is the outcome the caller asked for, not an error.
        Err(error) => {
            let current = runtime.completion_current(completion_id).await?;
            if current.lifecycle == relayer_graph_core::CompletionLifecycle::Active {
                return Err(error.into());
            }
            (current.lifecycle, current.head_revision)
        }
    };
    let cancelled = runtime
        .cancel_invoked_completion(interaction.thread_id.value(), completion_id)
        .await?;
    Ok(Json(serde_json::json!({
        "cancelled": cancelled,
        "completionId": completion_id,
        "lifecycle": lifecycle,
        "revision": revision,
        "reason": reason,
    })))
}

fn authorize_completion_broker(
    state: &ApiState,
    headers: &HeaderMap,
) -> Result<CompletionBrokerGrant, ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(ApiError::unauthorized)?;
    state
        .completion_brokers
        .resolve(token)
        .ok_or_else(ApiError::unauthorized)
}

async fn authorize_child_completion(
    state: &ApiState,
    grant: CompletionBrokerGrant,
    completion_id: i64,
) -> Result<Interaction, ApiError> {
    if completion_id < 1 {
        return Err(ApiError::invalid("completion ID must be positive"));
    }
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    let metadata = runtime.interaction_metadata(completion_id).await?;
    let invocation = metadata
        .invocation
        .filter(|invocation| invocation.source_interaction_node_id == grant.source_completion_id)
        .ok_or_else(|| ApiError::invalid("completion does not belong to this execution"))?;
    let outcome = state
        .product
        .get_action_invocation(grant.source_interaction_id, invocation.source_action_id)
        .await?
        .ok_or_else(|| ApiError::invalid("completion has no product invocation binding"))?;
    if outcome.interaction.graph_node_id != Some(completion_id) {
        return Err(ApiError::invalid(
            "completion graph identity does not match product history",
        ));
    }
    Ok(outcome.interaction)
}

fn completion_permission_origin_digest(
    permission_receipt: &Value,
    invocation: PreparedInvocation,
) -> Result<String, ApiError> {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "permissionReceipt": permission_receipt,
        "origin": {
            "kind": "invoke",
            "sourceCompletionId": invocation.source_interaction_node_id,
            "actionId": invocation.source_action_id,
        },
    }))
    .map_err(|error| ApiError::internal(&format!("cannot encode completion binding: {error}")))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn completion_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time is before unix epoch")
        .as_millis()
        .to_string()
}

fn spawn_recursive_completion_observers(
    state: ApiState,
    thread: Thread,
    interaction: Interaction,
    prepared: PreparedInteraction,
    permission_origin_digest: String,
    broker_lease: Option<CompletionBrokerLease>,
) {
    let semantic_state = state.clone();
    let semantic_thread = thread.clone();
    let semantic_interaction = interaction.clone();
    let harness_name = prepared.harness_configuration_name.clone();
    let harness_digest = prepared.harness_configuration_digest.clone();
    let execution_digest = prepared.effective_execution_digest.clone();
    let permission_receipt = prepared.effective_permission_receipt.clone();
    let completion_id = prepared.graph_node_id;
    let semantic_origin_digest = permission_origin_digest.clone();
    let supervision = semantic_state
        .completion_observations
        .supervise(completion_id);
    tokio::spawn(async move {
        let _supervision = supervision;
        let mut observation_failures = 0_u8;
        let mut projection_cursor = 0_u64;
        loop {
            let Some(runtime) = semantic_state.runtime.as_ref() else {
                return;
            };
            let observed = match runtime
                .observed_completion_projection(completion_id, projection_cursor)
                .await
            {
                Ok(page) => {
                    projection_cursor = page.cursor;
                    for event in &page.events {
                        semantic_state
                            .completion_observations
                            .publish(completion_id, event.into());
                    }
                    page.states
                        .into_iter()
                        .find(|state| state.completion_id.value() == completion_id)
                        .ok_or_else(|| {
                            RuntimeError::Protocol(format!(
                                "canonical current projection is missing for completion {completion_id}"
                            ))
                        })
                }
                Err(error) => Err(error),
            };
            match observed {
                Ok(current)
                    if current.lifecycle == relayer_graph_core::CompletionLifecycle::Active =>
                {
                    observation_failures = 0;
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                Ok(current)
                    if current.lifecycle == relayer_graph_core::CompletionLifecycle::Succeeded =>
                {
                    let output = loop {
                        match runtime.completion_output(completion_id).await {
                            Ok(Some(output)) => break output,
                            Ok(None) => eprintln!(
                                "recursive completion {completion_id} succeeded before its output receipt was readable"
                            ),
                            Err(error) => eprintln!(
                                "recursive completion {completion_id} output receipt read failed: {error}"
                            ),
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    };
                    let accepted = AcceptedInteractionCompletion {
                        interaction_id: semantic_interaction.id,
                        graph_node_id: completion_id,
                        harness_configuration_name: &harness_name,
                        harness_configuration_digest: &harness_digest,
                        effective_execution_digest: &execution_digest,
                        effective_permission_receipt: &permission_receipt,
                        output: &output,
                    };
                    match semantic_state
                        .product
                        .finalize_completion_execution_accepted(
                            accepted,
                            &semantic_origin_digest,
                            &completion_timestamp(),
                        )
                        .await
                    {
                        Ok(_) => return,
                        Err(error) => {
                            eprintln!(
                                "recursive completion {completion_id} accepted settlement failed: {error}"
                            );
                            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                        }
                    }
                }
                Ok(current) => {
                    let reason = current
                        .safe_reason
                        .as_deref()
                        .unwrap_or("completion_failed");
                    match semantic_state
                        .product
                        .finalize_completion_execution_failed(
                            semantic_interaction.id,
                            &semantic_origin_digest,
                            &semantic_thread.harness_configuration_name,
                            reason,
                            &completion_timestamp(),
                        )
                        .await
                    {
                        Ok(_) => return,
                        Err(error) => {
                            eprintln!(
                                "recursive completion {completion_id} failed settlement could not be projected: {error}"
                            );
                            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                        }
                    }
                }
                Err(error) => {
                    observation_failures += 1;
                    if observation_failures < 20 {
                        tokio::time::sleep(std::time::Duration::from_millis(
                            u64::from(observation_failures).min(10) * 100,
                        ))
                        .await;
                        continue;
                    }
                    let reason = "graph_observation_failed";
                    eprintln!(
                        "recursive completion {completion_id} could not be observed: {error}"
                    );
                    let _ = runtime
                        .cancel_invoked_completion(semantic_thread.id.value(), completion_id)
                        .await;
                    if let Err(transition_error) = runtime
                        .fail_graph_completion(
                            completion_id,
                            &format!("recursive-observation-failed:{}", semantic_interaction.id),
                            reason,
                        )
                        .await
                    {
                        eprintln!(
                            "recursive completion {completion_id} observation failure could not terminalize graph state: {transition_error}"
                        );
                        observation_failures = 0;
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    } else {
                        observation_failures = 0;
                    }
                    continue;
                }
            }
        }
    });

    tokio::spawn(async move {
        let _broker_lease = broker_lease;
        let runtime = state.runtime.as_ref().expect("recursive runtime");
        let provider = runtime
            .observe_invoked_completion(thread.id.value(), completion_id)
            .await;
        if provider.is_err()
            && runtime
                .completion_current(completion_id)
                .await
                .is_ok_and(|current| {
                    current.lifecycle == relayer_graph_core::CompletionLifecycle::Active
                })
        {
            let _ = runtime
                .fail_graph_completion(
                    completion_id,
                    &format!("recursive-provider-exit:{}", interaction.id),
                    "provider_exited_without_return",
                )
                .await;
        }
        let _ = runtime.discard_prepared(prepared).await;
    });
}

pub(super) async fn invoke_action(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, interaction_id, action_id)): Path<(i64, i64, i64)>,
) -> Result<(StatusCode, Json<InvokeActionResponse>), ApiError> {
    authorize_write(&state, &headers)?;
    let result = invoke_action_with_authority(&state, thread_id, interaction_id, action_id).await;
    if let Err(error) = &result {
        log_action_invocation_request_failure(thread_id, interaction_id, action_id, error);
    }
    result
}

async fn invoke_action_with_authority(
    state: &ApiState,
    thread_id: i64,
    interaction_id: i64,
    action_id: i64,
) -> Result<(StatusCode, Json<InvokeActionResponse>), ApiError> {
    let thread_id = ThreadId::try_from(thread_id)?;
    let source_interaction_id = InteractionId::try_from(interaction_id)?;
    if action_id <= 0 {
        return Err(ApiError::invalid("action ID must be a positive integer"));
    }
    let thread = state.product.get_thread(thread_id).await?.thread;
    let source = state.product.get_interaction(source_interaction_id).await?;
    if source.thread_id != thread_id {
        return Err(ApiError::invalid(
            "interaction does not belong to this thread",
        ));
    }
    if source.completion_status != "accepted" {
        return Err(ApiError::invalid(
            "actions can only be invoked from an accepted interaction",
        ));
    }
    let graph_node_id = source
        .graph_node_id
        .ok_or_else(|| ApiError::invalid("interaction has no accepted graph"))?;
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    let action = match runtime.get_action(graph_node_id, action_id).await {
        Ok(action) => action,
        Err(RuntimeError::Remote { status: 404, .. }) => {
            return Err(ApiError::invalid(
                "action is not part of this interaction's accepted graph",
            ));
        }
        Err(error) => return Err(error.into()),
    };
    if action.id != action_id || action.kind != "invoke" || action.state != "accepted" {
        return Err(ApiError::invalid(
            "action is not an accepted invoke action for this interaction",
        ));
    }
    let interaction_text = action
        .interaction_text
        .as_deref()
        .ok_or_else(|| ApiError::invalid("invoke action has no interaction text"))?
        .to_owned();
    if let Some(outcome) = state
        .product
        .get_action_invocation(source_interaction_id, action_id)
        .await?
    {
        return spawn_action_handoff(state.clone(), thread, outcome).await;
    }
    // One-shot invocation is a temporary UX simplification. The durable product record is
    // intentionally shaped so future retryable or repeatable action semantics can replace it.
    let owned_state = state.clone();
    let handoff = tokio::spawn(async move {
        let outcome = owned_state
            .product
            .invoke_action(source_interaction_id, action_id, &interaction_text)
            .await?;
        finish_action_handoff(&owned_state, &thread, outcome).await
    });
    await_action_handoff(handoff).await
}

async fn spawn_action_handoff(
    state: ApiState,
    thread: Thread,
    outcome: InvokeActionOutcome,
) -> Result<(StatusCode, Json<InvokeActionResponse>), ApiError> {
    let handoff =
        tokio::spawn(async move { finish_action_handoff(&state, &thread, outcome).await });
    await_action_handoff(handoff).await
}

async fn await_action_handoff(
    handoff: tokio::task::JoinHandle<Result<(StatusCode, Json<InvokeActionResponse>), ApiError>>,
) -> Result<(StatusCode, Json<InvokeActionResponse>), ApiError> {
    handoff.await.map_err(|error| {
        ApiError::internal(&format!(
            "action invocation backend handoff stopped unexpectedly: {error}"
        ))
    })?
}

async fn finish_action_handoff(
    state: &ApiState,
    thread: &Thread,
    outcome: InvokeActionOutcome,
) -> Result<(StatusCode, Json<InvokeActionResponse>), ApiError> {
    let status = if outcome.created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    let owning_thread = if outcome.interaction.thread_id == thread.id {
        thread.clone()
    } else {
        state
            .product
            .get_thread(outcome.interaction.thread_id)
            .await?
            .thread
    };
    let recoverable_invoke = outcome.interaction.completion_status == "submitted";
    let interaction =
        if outcome.interaction.completion_status == "not_started" || recoverable_invoke {
            claim_and_start_action_interaction(state, &owning_thread, outcome.interaction).await?
        } else {
            outcome.interaction
        };
    Ok((
        status,
        Json(InvokeActionResponse {
            invocation: outcome.invocation.into(),
            interaction: interaction.into(),
            created: outcome.created,
        }),
    ))
}

async fn claim_and_start_action_interaction(
    state: &ApiState,
    thread: &Thread,
    interaction: Interaction,
) -> Result<Interaction, ApiError> {
    if state.runtime.is_none() {
        let message = "GraphComplete runtime is unavailable";
        record_background_failure(&state.product, thread, &interaction, message.into()).await;
        return Err(ApiError::invalid(message));
    }
    let prepared =
        match prepare_and_claim_interaction(state, thread, &interaction, false, false).await {
            Ok(prepared) => prepared,
            Err(error) => {
                record_background_failure(
                    &state.product,
                    thread,
                    &interaction,
                    error.message().to_owned(),
                )
                .await;
                return Err(error);
            }
        };
    let Some(prepared) = prepared else {
        return state
            .product
            .get_interaction(interaction.id)
            .await
            .map_err(Into::into);
    };
    let running = state.product.get_interaction(interaction.id).await?;

    // There is no await between the durable claim and spawning execution. Once this detached
    // handoff owns the interaction, losing the HTTP request cannot strand it as not_started.
    let state = state.clone();
    let thread = thread.clone();
    tokio::spawn(async move {
        state
            .interaction_execution
            .as_ref()
            .expect("runtime-backed interaction execution service")
            .execute_prepared_interaction(thread, interaction, prepared)
            .await;
    });
    Ok(running)
}

fn log_action_invocation_request_failure(
    thread_id: i64,
    source_interaction_id: i64,
    action_id: i64,
    error: &ApiError,
) {
    eprintln!(
        "{}",
        action_invocation_request_failure_message(
            thread_id,
            source_interaction_id,
            action_id,
            error,
        )
    );
}

fn action_invocation_request_failure_message(
    thread_id: i64,
    source_interaction_id: i64,
    action_id: i64,
    error: &ApiError,
) -> String {
    format!(
        "action invocation request failed before background completion: thread={thread_id} source_interaction={source_interaction_id} action={action_id}: {}",
        error.message()
    )
}

fn selected_harness_configuration(
    state: &ApiState,
    harness_id: Option<&str>,
    raw_configuration_name: Option<&str>,
) -> Result<String, ApiError> {
    if raw_configuration_name.is_some() && !state.allow_harness_override {
        return Err(ApiError::invalid(
            "harness configuration overrides are unavailable in Relayer",
        ));
    }
    if let (Some(harness_id), Some(raw_configuration_name)) = (harness_id, raw_configuration_name)
        && harness_id != raw_configuration_name
    {
        return Err(ApiError::invalid(
            "harnessId and harnessConfigurationName must identify the same harness",
        ));
    }
    let selected = raw_configuration_name
        .or(harness_id)
        .unwrap_or(&state.default_harness_configuration);
    if selected.trim().is_empty() {
        return Err(ApiError::invalid(
            "harnessConfigurationName must be non-empty",
        ));
    }
    if let Some(runtime) = &state.runtime
        && !runtime.has_configuration(selected)
    {
        return Err(ApiError::invalid(format!(
            "unknown harness configuration: {selected}"
        )));
    }
    Ok(selected.to_owned())
}

fn selected_permission_profile(
    state: &ApiState,
    harness_configuration_name: &str,
    requested: Option<&str>,
) -> Result<String, ApiError> {
    let selected = requested.unwrap_or_else(|| state.permission_catalog.default_profile());
    if selected.trim().is_empty() {
        return Err(ApiError::invalid("permissionProfileId must be non-empty"));
    }
    let resolved_id = match &state.runtime {
        Some(runtime) => state
            .permission_catalog
            .resolve(
                runtime.permission_bindings(harness_configuration_name)?,
                selected,
            )?
            .profile
            .id
            .as_str(),
        None => state.permission_catalog.profile(selected)?.id.as_str(),
    };
    Ok(resolved_id.to_owned())
}

async fn start_interaction(
    state: &ApiState,
    thread: &Thread,
    interaction: Interaction,
    record_deterministic_failure: bool,
) -> Result<Interaction, ApiError> {
    if state.runtime.is_none() {
        return Ok(interaction);
    }
    let prepared =
        match prepare_and_claim_interaction(state, thread, &interaction, false, false).await {
            Ok(prepared) => prepared,
            Err(error) => {
                if record_deterministic_failure || !error.is_deterministic_input_failure() {
                    record_background_failure(
                        &state.product,
                        thread,
                        &interaction,
                        error.internal_diagnostic(),
                    )
                    .await;
                }
                return Err(error);
            }
        };
    let Some(prepared) = prepared else {
        return state
            .product
            .get_interaction(interaction.id)
            .await
            .map_err(Into::into);
    };
    let running = state.product.get_interaction(interaction.id).await?;
    let state = state.clone();
    let thread = thread.clone();
    tokio::spawn(async move {
        state
            .interaction_execution
            .as_ref()
            .expect("runtime-backed interaction execution service")
            .execute_prepared_interaction(thread, interaction, prepared)
            .await;
    });
    Ok(running)
}

async fn prepare_and_claim_interaction(
    state: &ApiState,
    thread: &Thread,
    interaction: &Interaction,
    already_claimed_running: bool,
    defer_claim_and_activation: bool,
) -> Result<Option<PreparedInteraction>, ApiError> {
    let Some(runtime) = &state.runtime else {
        return Ok(None);
    };
    let claimed_preparation = if already_claimed_running {
        true
    } else {
        state
            .product
            .claim_interaction_preparing(interaction.id)
            .await?
    };
    if !claimed_preparation {
        let current = state.product.get_interaction(interaction.id).await?;
        let recoverable_input = current.completion_status == "submitted"
            && (state
                .product
                .invocation_graph_source(interaction.id)
                .await?
                .is_some()
                || state
                    .product
                    .interaction_input(interaction.id)
                    .await?
                    .is_some());
        if !recoverable_input {
            return Ok(None);
        }
    }
    if interaction.model_selection.is_none() && !state.allow_harness_override {
        match state
            .product
            .permits_unselected_action_execution(interaction.id)
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                return Err(ApiError::invalid("The interaction has no model selection."));
            }
            Err(error) => {
                return Err(error.into());
            }
        }
    }
    let execution_model_selection =
        if let Some(model_selection) = interaction.model_selection.as_ref() {
            Some(
                state
                    .product
                    .validate_execution_model_selection(
                        &thread.harness_configuration_name,
                        model_selection,
                    )
                    .await?,
            )
        } else {
            None
        };
    let harness_policy = if execution_model_selection.is_some() {
        Some(
            state
                .product
                .execution_harness_policy(&thread.harness_configuration_name)
                .await?,
        )
    } else {
        None
    };
    let working_directory = match thread.project_id {
        Some(project_id) => match state.product.project_path(project_id).await {
            Ok(path) => path,
            Err(error) => {
                return Err(error.into());
            }
        },
        None => state
            .standalone_workspaces_directory
            .join(thread.id.value().to_string())
            .to_string_lossy()
            .into_owned(),
    };
    if let Err(error) = tokio::fs::create_dir_all(&working_directory).await {
        return Err(ApiError::internal(&format!(
            "cannot create thread workspace: {error}"
        )));
    }
    let permission_profile = state
        .permission_catalog
        .profile(&thread.permission_profile_id)?;
    let invocation = state
        .product
        .invocation_graph_source(interaction.id)
        .await?
        .map(
            |(source_interaction_node_id, source_action_id)| PreparedInvocation {
                source_interaction_node_id,
                source_action_id,
            },
        );
    let durable_input = state.product.interaction_input(interaction.id).await?;
    let personal_presentation = if runtime.supports_personal_presentation() {
        state
            .product
            .prepare_personal_presentation_pin(interaction.id, None)
            .await?
            .as_ref()
            .map(crate::runtime::PersonalPresentationExecution::from)
    } else {
        None
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
        model_plan: None,
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
        personal_presentation: personal_presentation.as_ref(),
        submitted_inputs: durable_input
            .as_ref()
            .map(|input| input.submitted_inputs.as_slice())
            .unwrap_or(&[]),
    };
    let mut binding_attempt = 0;
    let prepared = loop {
        binding_attempt += 1;
        let prepared = match runtime.prepare(&command).await {
            Ok(prepared) => prepared,
            Err(error)
                if (invocation.is_some() || durable_input.is_some()) && binding_attempt > 1 =>
            {
                eprintln!(
                    "preserving submitted invoke interaction {} after idempotent graph preparation retry failed: {error}",
                    interaction.id
                );
                return Ok(None);
            }
            Err(
                error @ (RuntimeError::Http(_)
                | RuntimeError::ResponseDecode(_)
                | RuntimeError::Timeout(_)),
            ) if invocation.is_some() || durable_input.is_some() => {
                eprintln!(
                    "preserving submitted invoke interaction {} after graph preparation ended ambiguously: {error}",
                    interaction.id
                );
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        match state
            .product
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
            Ok(true) => break prepared,
            Ok(false) => {
                let current = state.product.get_interaction(interaction.id).await?;
                let matches_existing_binding = (invocation.is_some() || durable_input.is_some())
                    && current.completion_status == "submitted"
                    && current.graph_node_id == Some(prepared.graph_node_id)
                    && current.harness_configuration_name.as_deref()
                        == Some(prepared.harness_configuration_name.as_str())
                    && current.harness_configuration_digest.as_deref()
                        == Some(prepared.harness_configuration_digest.as_str())
                    && current.effective_execution_digest.as_deref()
                        == Some(prepared.effective_execution_digest.as_str())
                    && current.effective_permission_receipt.as_ref()
                        == Some(&prepared.effective_permission_receipt);
                if matches_existing_binding {
                    break prepared;
                }
                runtime.discard_prepared(prepared).await?;
                return Ok(None);
            }
            Err(error) if invocation.is_some() || durable_input.is_some() => {
                let cleanup = runtime.discard_prepared(prepared).await;
                if binding_attempt < 3 {
                    if let Err(cleanup) = cleanup {
                        eprintln!(
                            "could not revoke an unactivated invoke capability before binding retry: {cleanup}"
                        );
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(binding_attempt * 25))
                        .await;
                    continue;
                }
                eprintln!(
                    "preserving submitted invoke interaction {} for idempotent source-pair recovery after product binding failed: {error}{}",
                    interaction.id,
                    cleanup
                        .err()
                        .map(|cleanup| format!("; capability cleanup also failed: {cleanup}"))
                        .unwrap_or_default()
                );
                return Ok(None);
            }
            Err(error) => {
                return match runtime.discard_prepared(prepared).await {
                    Ok(()) => Err(error.into()),
                    Err(cleanup) => Err(ApiError::internal(&format!(
                        "could not bind prepared interaction: {error}; capability cleanup also failed: {cleanup}"
                    ))),
                };
            }
        }
    };
    if defer_claim_and_activation {
        return Ok(Some(prepared));
    }
    claim_and_activate_prepared_interaction(
        state,
        thread,
        interaction,
        prepared,
        invocation.is_some(),
        durable_input.is_some(),
    )
    .await
}

async fn claim_and_activate_prepared_interaction(
    state: &ApiState,
    thread: &Thread,
    interaction: &Interaction,
    prepared: PreparedInteraction,
    has_invocation: bool,
    has_durable_input: bool,
) -> Result<Option<PreparedInteraction>, ApiError> {
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    let claimed = state
        .product
        .claim_interaction_running(interaction.id, &thread.harness_configuration_name)
        .await;
    let claimed = match claimed {
        Ok(claimed) => claimed,
        Err(error) => {
            return match runtime.discard_prepared(prepared).await {
                Ok(()) => Err(error.into()),
                Err(cleanup) => Err(ApiError::internal(&format!(
                    "could not claim prepared interaction: {error}; capability cleanup also failed: {cleanup}"
                ))),
            };
        }
    };
    if !claimed {
        runtime.discard_prepared(prepared).await?;
        return Ok(None);
    }
    if let Err(error) = runtime.activate_prepared(&prepared).await {
        let retryable = error.is_retryable_startup_failure();
        let cleanup = runtime.discard_prepared(prepared).await;
        let message = format!(
            "Graph capability activation failed before execution: {error}{}",
            cleanup
                .as_ref()
                .err()
                .map(|cleanup| format!("; capability cleanup also failed: {cleanup}"))
                .unwrap_or_default()
        );
        let restored = if has_invocation {
            state
                .product
                .restore_leased_interaction_submitted(interaction.id, &message)
                .await?
        } else if has_durable_input {
            state
                .product
                .restore_identified_interaction_submitted(interaction.id, &message)
                .await?
        } else {
            false
        };
        if retryable && restored {
            eprintln!(
                "preserving submitted invoke interaction {} after retryable capability activation failure: {message}",
                interaction.id
            );
            return Ok(None);
        }
        return Err(match cleanup {
            Ok(()) => error.into(),
            Err(cleanup) => ApiError::internal(&format!(
                "{RECONCILIATION_PENDING_PREFIX} could not activate prepared interaction: {error}; capability cleanup also failed: {cleanup}"
            )),
        });
    }
    Ok(Some(prepared))
}

impl TryFrom<ModelSelectionRequest> for InteractionModelSelection {
    type Error = ApiError;

    fn try_from(request: ModelSelectionRequest) -> Result<Self, Self::Error> {
        Ok(Self {
            family_id: ModelFamilyId::try_from_value(request.family_id)?,
            provider_id: ProviderId::parse(request.provider_id)?,
            model_id: request.model_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        api::auth::DesktopSessionAuthenticator,
        approval::{
            ApprovalAction, ApprovalActor, ApprovalCorrelation, ApprovalOutcome, ApprovalRequest,
            ApprovalResolution,
        },
        completion_broker::{
            COMPLETION_OBSERVATION_HOLD, CompletionBrokerRegistry, CompletionObservations,
            ObservedRevision,
        },
        conversation_export::ExportProducer,
        product::{
            CreateThreadCommand, NodeContextDraftConfirmationService, ProductService,
            final_approval_acknowledgement, validate_approval_correlation,
        },
        runtime::{ApprovalEventSnapshot, RuntimeClient},
        storage::SqliteProductStore,
    };
    use axum::{Router, routing};
    use relayer_graph_core::{InputAction, InputControl, SubmittedInput, SubmittedInputValue};
    use std::{
        collections::HashMap,
        fs,
        path::Path,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::{SystemTime, UNIX_EPOCH},
    };

    /// One recursive child bound to its parent execution, with a controllable graph fake.
    struct BrokerFixture {
        state: ApiState,
        product: ProductService,
        thread: Thread,
        root: std::path::PathBuf,
        starts: Arc<AtomicUsize>,
        headers: HeaderMap,
        current: Arc<Mutex<Value>>,
        transitions: Arc<Mutex<Vec<Value>>>,
        cancellations: Arc<AtomicUsize>,
        _lease: CompletionBrokerLease,
        graph_task: tokio::task::JoinHandle<Result<(), std::io::Error>>,
        harness_task: tokio::task::JoinHandle<Result<(), std::io::Error>>,
    }

    impl BrokerFixture {
        fn finish(self) {
            self.graph_task.abort();
            self.harness_task.abort();
            fs::remove_dir_all(self.root).unwrap();
        }
    }

    fn child_current(lifecycle: &str, head_revision: u64) -> Value {
        serde_json::json!({
            "completionId":202,"lifecycle":lifecycle,"headRevision":head_revision,
            "currentLayerId":1,
            "finalLayerId":(lifecycle == "succeeded").then_some(1),
            "safeReason":null,
            "temporalFeatures":{"configVersion":1,"schemaRead":true,
                "rootCurrentWrite":true,"projectionUi":true,
                "invokeResolution":true,"providerRecursion":true}
        })
    }

    async fn broker_fixture(label: &str, lifecycle: &str) -> BrokerFixture {
        broker_fixture_with_options(label, lifecycle, true, true).await
    }

    async fn broker_fixture_with_complete_authority(
        label: &str,
        lifecycle: &str,
        agent_authored_complete: bool,
    ) -> BrokerFixture {
        broker_fixture_with_options(label, lifecycle, agent_authored_complete, true).await
    }

    async fn broker_fixture_with_options(
        label: &str,
        lifecycle: &str,
        agent_authored_complete: bool,
        valid_start_acknowledgement: bool,
    ) -> BrokerFixture {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "relayer-completion-broker-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("product.sqlite3");
        let catalog = root.join("catalog.json");
        fs::write(
            &catalog,
            serde_json::json!({"schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":"test","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},
                "complete":{"agentAuthored":agent_authored_complete},"settings":{}
            },"digest":"sha256:test"}]})
            .to_string(),
        )
        .unwrap();

        let storage = SqliteProductStore::open(&database).await.unwrap();
        let product = ProductService::new(storage, true);
        let thread = product
            .create_thread(CreateThreadCommand {
                title: None,
                project_id: None,
                initial_message: "Root".into(),
                harness_configuration_name: "test".into(),
                personal_presentation_version_key: None,
                permission_profile_id: "auto".into(),
                model_selection: None,
                allow_unselected_model: true,
            })
            .await
            .unwrap();
        let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", database.display()))
            .await
            .unwrap();
        sqlx::query(
            "UPDATE interactions SET graph_node_id=101,completion_status='accepted',completion_output_json=?1 WHERE id=?2",
        )
        .bind(
            serde_json::json!({
                "nodeId":101,
                "rootLayer":{"layer":{"id":1},"nodes":[],"edges":[],"actions":[{
                    "id":41,"kind":"invoke","interactionText":"Child work",
                    "state":"accepted","targetLayerId":null
                }]}
            })
            .to_string(),
        )
        .bind(thread.root_interaction_id.value())
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let current = Arc::new(Mutex::new(child_current(lifecycle, 1)));
        let transitions = Arc::new(Mutex::new(Vec::new()));
        let activation_database = database.clone();
        let read_current = current.clone();
        let projected_current = current.clone();
        let transitioned_current = current.clone();
        let recorded_transitions = transitions.clone();
        let graph = Router::new()
            .route(
                "/api/control/temporal-features",
                routing::get(|| async {
                    axum::Json(serde_json::json!({
                        "configVersion": 1,
                        "schemaRead": true,
                        "rootCurrentWrite": true,
                        "projectionUi": true,
                        "invokeResolution": true,
                        "providerRecursion": true
                    }))
                }),
            )
            .route(
                "/api/control/interactions",
                routing::post(|| async {
                    axum::Json(serde_json::json!({"node":{"id":202},"graphToken":""}))
                }),
            )
            .route(
                "/api/control/capabilities",
                routing::post(move |axum::Json(body): axum::Json<Value>| {
                    let database = activation_database.clone();
                    async move {
                        let pool =
                            sqlx::SqlitePool::connect(&format!("sqlite://{}", database.display()))
                                .await
                                .unwrap();
                        let phase: String = sqlx::query_scalar(
                            "SELECT phase FROM completion_executions WHERE graph_completion_id=202",
                        )
                        .fetch_one(&pool)
                        .await
                        .unwrap();
                        pool.close().await;
                        assert_eq!(phase, "launching");
                        axum::Json(serde_json::json!({"graphToken":body["graphToken"]}))
                    }
                })
                .delete(|| async { axum::Json(serde_json::json!({"revoked":true})) }),
            )
            .route(
                "/api/control/interactions/{id}",
                routing::get(
                    |axum::extract::Path(id): axum::extract::Path<i64>| async move {
                        axum::Json(serde_json::json!({
                            "nodeId":id,
                            "invocation":(id == 202).then(|| serde_json::json!({
                                "sourceInteractionNodeId":101,"sourceActionId":41
                            }))
                        }))
                    },
                ),
            )
            .route(
                "/api/control/interactions/101/actions/41",
                routing::get(|| async {
                    axum::Json(serde_json::json!({"action":{
                        "id":41,"kind":"invoke","interactionText":"Child work","state":"accepted"
                    }}))
                }),
            )
            .route(
                "/api/control/interactions/202/current",
                routing::get(move || {
                    let current = read_current.clone();
                    async move { axum::Json(current.lock().unwrap().clone()) }
                }),
            )
            .route(
                "/api/control/current-projections",
                routing::post(move || {
                    let current = projected_current.clone();
                    async move {
                        axum::Json(serde_json::json!({
                            "cursor":0,"hasMore":false,
                            "states":[current.lock().unwrap().clone()],"events":[]
                        }))
                    }
                }),
            )
            .route(
                "/api/control/interactions/202/current/receipts",
                routing::post(|| async {
                    (
                        StatusCode::NOT_FOUND,
                        axum::Json(
                            serde_json::json!({"error":{"code":"receipt_not_found","message":"none"}}),
                        ),
                    )
                }),
            )
            .route(
                "/api/control/interactions/202/current/transitions",
                routing::post(move |axum::Json(body): axum::Json<Value>| {
                    let current = transitioned_current.clone();
                    let recorded = recorded_transitions.clone();
                    async move {
                        let revision = body["expectedRevision"].as_u64().unwrap_or(0) + 1;
                        let lifecycle =
                            if body["transition"]["kind"] == "stop" { "stopped" } else { "failed" };
                        let reason = body["transition"]["reason"].clone();
                        recorded.lock().unwrap().push(body.clone());
                        {
                            let mut state = current.lock().unwrap();
                            state["lifecycle"] = lifecycle.into();
                            state["headRevision"] = revision.into();
                            state["safeReason"] = reason;
                        }
                        axum::Json(serde_json::json!({
                            "completionId":202,"revision":revision,"lifecycle":lifecycle,
                            "currentLayerId":1,"finalLayerId":null,
                            "operationKey":body["operationKey"],
                            "requestDigest":"sha256:test","snapshotDigest":"sha256:test",
                            "projectionSequence":revision
                        }))
                    }
                }),
            )
            .route(
                "/api/control/interactions/202/output",
                routing::get(|| async {
                    axum::Json(serde_json::json!({
                        "nodeId":202,
                        "rootLayer":{"layer":{"id":1},"nodes":[],"edges":[],"actions":[]}
                    }))
                }),
            );
        let starts = Arc::new(AtomicUsize::new(0));
        let cancellations = Arc::new(AtomicUsize::new(0));
        let observed_starts = starts.clone();
        let observed_cancellations = cancellations.clone();
        let harness = Router::new()
            .route(
                "/sessions/{id}/invoked-completions",
                routing::post(move |axum::Json(body): axum::Json<Value>| {
                    let starts = observed_starts.clone();
                    async move {
                        starts.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(body["capability"]["nodeId"], 202);
                        assert_eq!(
                            body["traceContext"]["productInteractionId"], 2,
                            "child trace attribution uses the product interaction, not graph identity"
                        );
                        let response = if valid_start_acknowledgement {
                            serde_json::json!({
                                "completionId":202,
                                "attachment":{"schemaVersion":1,"provider":"test"}
                            })
                        } else {
                            serde_json::json!({
                                "completionId":999,
                                "attachment":{"schemaVersion":1,"provider":"test"}
                            })
                        };
                        (StatusCode::CREATED, axum::Json(response))
                    }
                }),
            )
            .route(
                "/sessions/{id}/invoked-completions/202",
                routing::get(|| async { axum::Json(serde_json::json!({"settled":true})) }),
            )
            .route(
                "/sessions/{id}/cancel",
                routing::post(move || {
                    let cancellations = observed_cancellations.clone();
                    async move {
                        cancellations.fetch_add(1, Ordering::SeqCst);
                        axum::Json(serde_json::json!({"cancelled":true}))
                    }
                }),
            );
        let (graph_url, graph_task) = serve(graph).await;
        let (harness_url, harness_task) = serve(harness).await;
        let runtime = RuntimeClient::open(
            &graph_url,
            &harness_url,
            "graph-control".into(),
            "harness-control".into(),
            &catalog,
        )
        .await
        .unwrap();
        let permission_catalog = crate::permissions::PermissionCatalog::load(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../permissions/desktop.json"),
        )
        .await
        .unwrap();
        let invocation = PreparedInvocation {
            source_interaction_node_id: 101,
            source_action_id: 41,
        };
        let child = product
            .invoke_action_recursively(thread.root_interaction_id, 41, "Child work")
            .await
            .unwrap()
            .interaction;
        assert!(product.claim_interaction_preparing(child.id).await.unwrap());
        let working_directory = root.to_string_lossy().into_owned();
        let seeded = runtime
            .prepare(&CompleteInteraction {
                project_id: None,
                product_interaction_id: child.id.value(),
                thread_id: thread.id.value(),
                interaction_id: child.id.value(),
                text: &child.text,
                working_directory: &working_directory,
                harness_configuration_name: "test",
                permission_profile: permission_catalog.profile("auto").unwrap(),
                model_selection: None,
                model_plan: None,
                attempt_admission_id: None,
                execution_lease_id: None,
                harness_policy: None,
                invocation: Some(invocation),
                input_identity: None,
                input_digest: None,
                personal_presentation: None,
                contexts: &[],
                submitted_inputs: &[],
            })
            .await
            .unwrap();
        assert!(
            product
                .bind_prepared_interaction(PreparedInteractionBinding {
                    interaction_id: child.id,
                    graph_node_id: seeded.graph_node_id,
                    harness_configuration_name: &seeded.harness_configuration_name,
                    harness_configuration_digest: &seeded.harness_configuration_digest,
                    effective_execution_digest: &seeded.effective_execution_digest,
                    effective_permission_receipt: &seeded.effective_permission_receipt,
                    input_children: &seeded.input_children,
                })
                .await
                .unwrap()
        );
        let origin_digest =
            completion_permission_origin_digest(&seeded.effective_permission_receipt, invocation)
                .unwrap_or_else(|error| {
                    panic!("could not digest seeded origin: {}", error.message())
                });
        let reserved = product
            .reserve_completion_execution(
                CompletionExecutionBinding {
                    interaction_id: child.id,
                    graph_completion_id: seeded.graph_node_id,
                    harness_configuration_name: &seeded.harness_configuration_name,
                    harness_configuration_digest: &seeded.harness_configuration_digest,
                    model_execution_digest: &seeded.effective_execution_digest,
                    permission_origin_digest: &origin_digest,
                },
                "1",
            )
            .await
            .unwrap();
        assert!(matches!(
            reserved,
            CompletionExecutionReserveOutcome::Created(_)
        ));
        let completion_brokers = CompletionBrokerRegistry::new(Some("http://broker".into()));
        let lease = completion_brokers.issue(CompletionBrokerGrant {
            thread_id: thread.id,
            source_interaction_id: thread.root_interaction_id,
            source_completion_id: 101,
        });
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", lease.token()).parse().unwrap(),
        );
        let state = ApiState {
            product: product.clone(),
            authenticator: DesktopSessionAuthenticator::new("control", None),
            runtime: Some(runtime.clone()),
            interaction_execution: None,
            context_draft_confirmation: NodeContextDraftConfirmationService::new(
                product.clone(),
                Some(runtime),
            ),
            permission_catalog,
            default_harness_configuration: "test".into(),
            allow_harness_override: true,
            allow_conversation_import: false,
            standalone_workspaces_directory: root.join("workspaces"),
            export_producer: ExportProducer {
                desktop_version: "test".into(),
                build_commit: "test".into(),
                platform: "test".into(),
                architecture: "test".into(),
            },
            approval_decisions: Arc::new(Mutex::new(HashMap::new())),
            annotation_sessions: Arc::new(Mutex::new(HashMap::new())),
            input_operator_sessions: Arc::new(Mutex::new(HashMap::new())),
            annotations_enabled: false,
            environment_inspector: crate::environment::EnvironmentInspector::new(),
            completion_brokers,
            completion_observations: CompletionObservations::default(),
        };
        BrokerFixture {
            state,
            product,
            thread,
            root,
            starts,
            headers,
            current,
            transitions,
            cancellations,
            _lease: lease,
            graph_task,
            harness_task,
        }
    }

    #[tokio::test]
    async fn broker_exact_retries_launch_once_after_the_durable_fence() {
        let fixture = broker_fixture("retries", "succeeded").await;

        let first = complete_prepared_child(
            State(fixture.state.clone()),
            fixture.headers.clone(),
            Json(CompletePreparedChildRequest {
                interaction_node: 202,
            }),
        );
        let second = complete_prepared_child(
            State(fixture.state.clone()),
            fixture.headers.clone(),
            Json(CompletePreparedChildRequest {
                interaction_node: 202,
            }),
        );
        let (first, second) = tokio::join!(first, second);
        let first =
            first.unwrap_or_else(|error| panic!("first broker call failed: {}", error.message()));
        let second =
            second.unwrap_or_else(|error| panic!("second broker call failed: {}", error.message()));
        let statuses = [first.0, second.0];
        assert!(statuses.contains(&StatusCode::CREATED));
        for response in [&first.1.0, &second.1.0] {
            assert_eq!(
                serde_json::to_value(response).unwrap(),
                serde_json::json!({"completionId": 202}),
                "the agent-scoped broker must not disclose native provider attachment identity"
            );
        }
        assert_eq!(fixture.starts.load(Ordering::SeqCst), 1);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let child = fixture
                .product
                .get_action_invocation(fixture.thread.root_interaction_id, 41)
                .await
                .unwrap()
                .unwrap()
                .interaction;
            if child.completion_status == "accepted" {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        fixture.finish();
    }

    #[tokio::test]
    async fn child_launch_fails_before_provider_execution_when_its_configuration_disables_complete()
    {
        let fixture = broker_fixture_with_complete_authority("disabled", "active", false).await;

        let error = match complete_prepared_child(
            State(fixture.state.clone()),
            fixture.headers.clone(),
            Json(CompletePreparedChildRequest {
                interaction_node: 202,
            }),
        )
        .await
        {
            Ok(_) => panic!("disabled configuration launched an invoked completion"),
            Err(error) => error,
        };

        assert!(
            error
                .message()
                .contains("does not allow agent-authored Complete"),
            "unexpected error: {}",
            error.message()
        );
        assert_eq!(fixture.starts.load(Ordering::SeqCst), 0);
        fixture.finish();
    }

    #[tokio::test]
    async fn lost_start_acknowledgement_cancels_and_durably_fails_the_keyed_native_run() {
        let fixture = broker_fixture_with_options("lost-start-ack", "active", true, false).await;

        let error = match complete_prepared_child(
            State(fixture.state.clone()),
            fixture.headers.clone(),
            Json(CompletePreparedChildRequest {
                interaction_node: 202,
            }),
        )
        .await
        {
            Ok(_) => panic!("mismatched start acknowledgement must fail"),
            Err(error) => error,
        };
        assert!(
            error
                .message()
                .contains("different invoked completion identity"),
            "{}",
            error.message()
        );

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let child = fixture
                .product
                .get_action_invocation(fixture.thread.root_interaction_id, 41)
                .await
                .unwrap()
                .unwrap()
                .interaction;
            let execution = fixture
                .product
                .completion_execution(child.id)
                .await
                .unwrap()
                .unwrap();
            if fixture.cancellations.load(Ordering::SeqCst) == 1
                && child.completion_status == "failed"
                && execution.phase == CompletionExecutionPhase::Settled
                && execution.safe_reason.as_deref() == Some("provider_start_failed")
            {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(fixture.starts.load(Ordering::SeqCst), 1);
        fixture.finish();
    }

    #[tokio::test]
    async fn explicit_stop_settles_the_child_as_stopped_with_its_retained_current() {
        let fixture = broker_fixture("stop", "active").await;
        let _started = complete_prepared_child(
            State(fixture.state.clone()),
            fixture.headers.clone(),
            Json(CompletePreparedChildRequest {
                interaction_node: 202,
            }),
        )
        .await
        .unwrap_or_else(|error| panic!("broker call failed: {}", error.message()));

        let stopped = stop_completion(
            State(fixture.state.clone()),
            fixture.headers.clone(),
            Path(202),
            Some(Json(StopCompletionRequest {
                reason: Some("the parent no longer needs this branch".into()),
            })),
        )
        .await
        .unwrap_or_else(|error| panic!("stop failed: {}", error.message()))
        .0;

        assert_eq!(stopped["lifecycle"], "stopped");
        assert_eq!(stopped["cancelled"], true);
        assert_eq!(stopped["reason"], "the parent no longer needs this branch");
        assert_eq!(fixture.cancellations.load(Ordering::SeqCst), 1);
        let transitions = fixture.transitions.lock().unwrap().clone();
        assert_eq!(transitions.len(), 1, "one trusted stop transition");
        assert_eq!(transitions[0]["transition"]["kind"], "stop");
        assert_eq!(transitions[0]["transition"]["reason"], "cancelled_by_user");
        let retained = fixture.current.lock().unwrap().clone();
        assert_eq!(retained["lifecycle"], "stopped");
        assert_eq!(
            retained["currentLayerId"], 1,
            "stop retains the last current"
        );
        assert!(
            retained["finalLayerId"].is_null(),
            "stop fabricates no final layer"
        );
        fixture.finish();
    }

    #[tokio::test]
    async fn stopping_a_child_that_already_settled_reports_its_terminal_state() {
        let fixture = broker_fixture("stop-race", "succeeded").await;
        let _started = complete_prepared_child(
            State(fixture.state.clone()),
            fixture.headers.clone(),
            Json(CompletePreparedChildRequest {
                interaction_node: 202,
            }),
        )
        .await
        .unwrap_or_else(|error| panic!("broker call failed: {}", error.message()));

        let stopped = stop_completion(
            State(fixture.state.clone()),
            fixture.headers.clone(),
            Path(202),
            None,
        )
        .await
        .unwrap_or_else(|error| panic!("stop raced a settled child: {}", error.message()))
        .0;

        assert_eq!(stopped["lifecycle"], "succeeded");
        assert!(
            fixture.transitions.lock().unwrap().is_empty(),
            "a settled completion is never transitioned again"
        );
        fixture.finish();
    }

    #[tokio::test]
    async fn only_the_direct_parent_execution_may_stop_a_child() {
        let fixture = broker_fixture("stop-authority", "active").await;
        let _started = complete_prepared_child(
            State(fixture.state.clone()),
            fixture.headers.clone(),
            Json(CompletePreparedChildRequest {
                interaction_node: 202,
            }),
        )
        .await
        .unwrap_or_else(|error| panic!("broker call failed: {}", error.message()));
        // A grandchild or sibling execution holds a grant naming a different source completion.
        let foreign = fixture
            .state
            .completion_brokers
            .issue(CompletionBrokerGrant {
                thread_id: fixture.thread.id,
                source_interaction_id: fixture.thread.root_interaction_id,
                source_completion_id: 909,
            });
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", foreign.token()).parse().unwrap(),
        );

        let refused = stop_completion(State(fixture.state.clone()), headers, Path(202), None)
            .await
            .expect_err("a foreign execution must not stop this child");

        assert!(
            refused
                .message()
                .contains("does not belong to this execution"),
            "unexpected refusal: {}",
            refused.message()
        );
        assert!(fixture.transitions.lock().unwrap().is_empty());
        assert_eq!(fixture.cancellations.load(Ordering::SeqCst), 0);
        fixture.finish();
    }

    fn observed(
        lifecycle: relayer_graph_core::CompletionLifecycle,
        revision: u64,
    ) -> ObservedRevision {
        ObservedRevision {
            revision,
            lifecycle,
        }
    }

    #[tokio::test]
    async fn a_held_observation_answers_when_the_awaited_pointer_advances() {
        let observations = CompletionObservations::default();
        let _supervision = observations.supervise(202);
        observations.publish(
            202,
            observed(relayer_graph_core::CompletionLifecycle::Active, 2),
        );
        let publisher = observations.clone();
        tokio::spawn(async move {
            publisher.publish(
                202,
                observed(relayer_graph_core::CompletionLifecycle::Active, 3),
            );
        });

        assert!(observations.hold(202, 2).await);
    }

    #[tokio::test]
    async fn a_held_observation_answers_immediately_once_the_child_is_terminal() {
        let observations = CompletionObservations::default();
        let _supervision = observations.supervise(202);
        observations.publish(
            202,
            observed(relayer_graph_core::CompletionLifecycle::Stopped, 2),
        );

        assert!(observations.hold(202, 9).await);
    }

    #[tokio::test(start_paused = true)]
    async fn a_held_observation_releases_its_caller_when_the_hold_elapses() {
        let observations = CompletionObservations::default();
        let _supervision = observations.supervise(202);
        observations.publish(
            202,
            observed(relayer_graph_core::CompletionLifecycle::Active, 4),
        );
        let started = tokio::time::Instant::now();

        assert!(!observations.hold(202, 4).await);
        assert!(started.elapsed() >= COMPLETION_OBSERVATION_HOLD);
    }

    #[tokio::test(start_paused = true)]
    async fn a_supervised_completion_holds_before_its_first_projection_read() {
        let observations = CompletionObservations::default();
        let _supervision = observations.supervise(202);
        let started = tokio::time::Instant::now();

        // Nothing has been published yet. Answering now would put the awaiting execution
        // straight back on the wire with the same cursor, which is the loop we removed.
        assert!(!observations.hold(202, 0).await);
        assert!(started.elapsed() >= COMPLETION_OBSERVATION_HOLD);
    }

    #[tokio::test(start_paused = true)]
    async fn an_unsupervised_completion_holds_rather_than_inviting_a_request_loop() {
        let observations = CompletionObservations::default();
        let started = tokio::time::Instant::now();

        assert!(!observations.hold(202, 9).await);
        assert!(started.elapsed() >= COMPLETION_OBSERVATION_HOLD);
    }

    async fn serve(app: Router) -> (String, tokio::task::JoinHandle<Result<(), std::io::Error>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(axum::serve(listener, app).into_future());
        (format!("http://{address}/"), task)
    }

    #[test]
    fn submitted_input_projection_compares_semantic_multisets_not_occurrence_order() {
        let submitted = |prompt: &str, text: &str| SubmittedInput {
            action: InputAction {
                control: InputControl::Text,
                prompt: prompt.into(),
                options: vec![],
                minimum_selections: None,
                unsupported_fields: Default::default(),
            },
            value: SubmittedInputValue::Text { text: text.into() },
        };
        let first = submitted("Zulu prompt", "first value");
        let second = submitted("Alpha prompt", "second value");

        assert!(submitted_input_semantic_multisets_match(
            &[first.clone(), second.clone()],
            &[second.clone(), first.clone()],
        ));
        assert!(!submitted_input_semantic_multisets_match(
            &[first.clone(), second],
            &[first.clone(), first],
        ));
    }

    #[test]
    fn action_invocation_request_errors_include_identifiers_in_the_backend_log() {
        let error = ApiError::invalid("GraphComplete runtime is unavailable");

        assert_eq!(
            action_invocation_request_failure_message(4, 8, 15, &error),
            "action invocation request failed before background completion: thread=4 source_interaction=8 action=15: GraphComplete runtime is unavailable"
        );
    }

    #[test]
    fn product_decision_accepts_only_the_exact_user_resolution() {
        let request = approval_request();
        let submission = ApprovalDecisionSubmission {
            decision: ApprovalDecision::Deny,
            rationale: None,
        };
        let exact = ApprovalResolution {
            request_id: request.request_id.clone(),
            correlation: request.correlation.clone(),
            outcome: ApprovalOutcome::Denied,
            actor: ApprovalActor::User,
            resolved_at: "2026-08-20T12:01:00Z".into(),
            decision: Some(ApprovalDecision::Deny),
            rationale: None,
            source_request_id: None,
        };
        assert!(validate_decision_resolution(&request, submission.decision, &exact).is_ok());

        let widened = ApprovalResolution {
            outcome: ApprovalOutcome::Approved,
            decision: Some(ApprovalDecision::ApproveAlways),
            ..exact.clone()
        };
        assert!(validate_decision_resolution(&request, submission.decision, &widened).is_err());
        let other_request = ApprovalResolution {
            request_id: "request-2".into(),
            ..exact.clone()
        };
        assert!(
            validate_decision_resolution(&request, submission.decision, &other_request).is_err()
        );
        let grant = ApprovalResolution {
            outcome: ApprovalOutcome::Approved,
            actor: ApprovalActor::SessionGrant,
            decision: Some(ApprovalDecision::Deny),
            source_request_id: Some("request-0".into()),
            ..exact
        };
        assert!(validate_decision_resolution(&request, submission.decision, &grant).is_err());
    }

    #[test]
    fn approval_correlation_is_pinned_to_interaction_session_and_complete_call() {
        let request = approval_request();
        let thread_id = ThreadId::try_from(1).unwrap();
        let interaction_id = InteractionId::try_from(2).unwrap();
        let mut complete_call_id = None;
        assert!(
            validate_approval_correlation(
                thread_id,
                interaction_id,
                "session-1",
                &mut complete_call_id,
                &request.correlation,
            )
            .is_ok()
        );
        assert_eq!(complete_call_id.as_deref(), Some("complete-1"));

        for correlation in [
            ApprovalCorrelation {
                interaction_id: 3,
                ..request.correlation.clone()
            },
            ApprovalCorrelation {
                complete_call_id: "complete-2".into(),
                ..request.correlation.clone()
            },
            ApprovalCorrelation {
                harness_session_id: "session-2".into(),
                ..request.correlation.clone()
            },
        ] {
            assert!(
                validate_approval_correlation(
                    thread_id,
                    interaction_id,
                    "session-1",
                    &mut complete_call_id,
                    &correlation,
                )
                .is_err()
            );
        }
    }

    #[test]
    fn final_ack_accepts_an_exact_cursor_or_an_already_reset_epoch() {
        let exact = ApprovalEventSnapshot {
            harness_session_id: "session-1".into(),
            latest_sequence: 6,
            pending_requests: Vec::new(),
            events: Vec::new(),
        };
        assert_eq!(final_approval_acknowledgement(6, &exact), Ok(true));

        let reset = ApprovalEventSnapshot {
            latest_sequence: 0,
            ..exact.clone()
        };
        assert_eq!(final_approval_acknowledgement(6, &reset), Ok(false));

        let stale = ApprovalEventSnapshot {
            latest_sequence: 5,
            ..exact
        };
        assert!(final_approval_acknowledgement(6, &stale).is_err());
    }

    fn approval_request() -> ApprovalRequest {
        ApprovalRequest {
            request_id: "request-1".into(),
            correlation: ApprovalCorrelation {
                thread_id: 1,
                interaction_id: 2,
                complete_call_id: "complete-1".into(),
                harness_session_id: "session-1".into(),
            },
            title: "Run tests".into(),
            reason: "The harness needs approval".into(),
            action: ApprovalAction::Command {
                command: "npm test".into(),
                working_directory: "/workspace".into(),
            },
            scope_keys: vec!["command:npm test".into()],
            scope_description: "Run npm test".into(),
            created_at: "2026-08-20T12:00:00Z".into(),
            expires_at: None,
        }
    }
}
