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
    required_provider_adapter_id: Option<String>,
    title: Option<String>,
    project_id: Option<i64>,
    initial_message: String,
    working_directory: Option<String>,
    creation_request_id: Option<String>,
    expected_checkout: Option<crate::product::ExpectedCheckout>,
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
    // Compatibility inputs from older clients are never execution authority.
    #[serde(default = "family_selection_placeholder")]
    provider_id: String,
    #[serde(default)]
    model_id: String,
}

pub(super) fn family_selection_placeholder() -> String {
    "family-selection".into()
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

#[derive(Deserialize)]
pub(super) struct ArchiveRequest {
    archived: bool,
}

pub(super) async fn archived(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<ThreadsResponse>, ApiError> {
    authorize_read(&state, &headers)?;
    Ok(Json(ThreadsResponse {
        threads: state
            .product
            .list_archived_threads()
            .await?
            .into_iter()
            .map(Into::into)
            .collect(),
    }))
}

pub(super) async fn set_archived(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(request): Json<ArchiveRequest>,
) -> Result<Json<ThreadResponse>, ApiError> {
    authorize_write(&state, &headers)?;
    Ok(Json(
        state
            .product
            .set_thread_archived(ThreadId::try_from(id)?, request.archived)
            .await?
            .into(),
    ))
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
    let (thread, created) = state
        .product
        .create_thread_with_expected_checkout(
            CreateThreadCommand {
                required_provider_adapter_id: request.required_provider_adapter_id,
                icon_selection_eligible: !state.eval_mode,
                title: request.title,
                project_id,
                initial_message: request.initial_message,
                harness_configuration_name,
                personal_presentation_version_key,
                permission_profile_id,
                model_selection,
                allow_unselected_model,
            },
            request.working_directory.as_deref(),
            request.creation_request_id.as_deref(),
            request.expected_checkout.as_ref(),
        )
        .await?;
    if !created {
        state
            .product
            .restore_unstarted_thread_root(thread.id)
            .await?;
    }
    let interaction = state
        .product
        .get_interaction(thread.root_interaction_id)
        .await?;
    if created || interaction.completion_status == "not_started" {
        if let Some(expected) = request.expected_checkout.as_ref() {
            state
                .product
                .verify_expected_checkout(&thread, expected)
                .await?;
        }
        start_interaction(&state, &thread, interaction, true).await?;
    }
    Ok((
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
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
        state.interaction_execution.as_ref(),
        &mut detail.interactions,
        &detail.action_invocations,
        &std::collections::HashSet::from_iter(detail.thread.imported.then_some(detail.thread.id)),
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
    let compatibility = state
        .product
        .conversation_compatibility(detail.thread.id)
        .await?;
    let response = ThreadDetailResponse::from(detail)
        .with_conversation_compatibility(Some(compatibility))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ShareExportRequest {
    title: String,
}

pub(super) async fn share_export(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(request): Json<ShareExportRequest>,
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
    let body = crate::conversation_export_service::build_share_conversation_export(
        &state.product,
        runtime,
        ThreadId::try_from(id)?,
        state.export_producer.clone(),
        exported_at,
        &request.title,
    )
    .await?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_LENGTH, body.len())
        .body(Body::from(body))
        .map_err(|_| ApiError::internal("could not construct shared snapshot response"))
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
        state.interaction_execution.as_ref(),
        &mut detail.interactions,
        &detail.action_invocations,
        &std::collections::HashSet::from_iter(detail.thread.imported.then_some(detail.thread.id)),
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
    graph_deadline: tokio::time::Instant,
) -> Result<InteractionResponse, ApiError> {
    let id = interaction.id.value();
    let thread_id = interaction.thread_id;
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
    let mut context_projection_complete = true;
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
                    context_projection_complete = false;
                    response.mark_projection_stale();
                    eprintln!("could not project context for interaction {id}: {error}");
                }
            }
            Err(error) => {
                context_projection_complete = false;
                response.mark_projection_stale();
                eprintln!("could not project context for interaction {id}: {error}");
            }
        }
    }
    if !imported_thread
        && let Some((runtime, graph_id)) = state.runtime.as_ref().zip(graph_node_id)
        && runtime.interaction_graph_enabled()
    {
        let mut graph = super::interaction_graph::project_before(
            state,
            thread_id,
            graph_id,
            response.navigation_contexts(),
            graph_deadline,
        )
        .await;
        if !context_projection_complete {
            graph["complete"] = serde_json::json!(false);
        }
        response.set_interaction_graph(graph);
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
    let graph_deadline = super::interaction_graph::projection_deadline();
    let mut responses = Vec::with_capacity(interactions.len());
    for interaction in interactions {
        let is_stale = stale.contains(&interaction.id.value());
        responses.push(
            project_interaction(
                state,
                interaction,
                imported_thread,
                is_stale,
                graph_deadline,
            )
            .await?,
        );
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
    if request.input_draft_revision.is_some() && request.input_id.is_none() {
        return Err(ApiError::invalid("inputDraftRevision requires inputId"));
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
                                error: error.message(),
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DetailAssetQuery {
    layer_id: i64,
}

pub(super) async fn get_detail_asset(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, interaction_id, node_id, asset_id)): Path<(i64, i64, i64, String)>,
    Query(query): Query<DetailAssetQuery>,
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
    let layer: relayer_graph_core::ResolvedLayer =
        serde_json::from_value(runtime.get_layer(graph_node_id, query.layer_id).await?)
            .map_err(|_| ApiError::internal("GraphComplete returned an invalid layer"))?;
    let node_id = relayer_graph_core::NodeId::new(node_id)
        .ok_or_else(|| ApiError::invalid("invalid graph node id"))?;
    let source_icon = if node_id.value() == graph_node_id {
        runtime
            .completion_output(graph_node_id)
            .await?
            .is_some_and(|output| {
                output
                    .pointer("/rootAction/icon/kind")
                    .and_then(Value::as_str)
                    == Some("image")
                    && output
                        .pointer("/rootAction/icon/assetId")
                        .and_then(Value::as_str)
                        == Some(asset_id.as_str())
                    && output
                        .pointer("/rootAction/sourceNodeId")
                        .and_then(Value::as_i64)
                        == Some(graph_node_id)
            })
    } else {
        false
    };
    if layer.layer.id.value() != query.layer_id
        || !(source_icon
            || layer.nodes.iter().any(|node| {
                node.id == node_id && node.state == relayer_graph_core::RecordState::Accepted
            }))
    {
        return Err(ApiError::forbidden(
            "accepted icon owner does not belong to this presentation",
        ));
    }
    Ok(Json(
        runtime.get_detail_asset(node_id.value(), &asset_id).await?,
    ))
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
    let typed_resolution = action.kind == "navigate"
        && action.relation.as_deref() == Some("expand")
        && action
            .resolved_invoke_interaction_id
            .is_some_and(|id| id > 0)
        && action.interaction_text.is_none();
    if action.id != action_id
        || (action.kind != "invoke" && !typed_resolution)
        || action.state != "accepted"
    {
        return Err(ApiError::invalid(
            "action is not a resolved accepted invoke action for this interaction",
        ));
    }
    let layer_owner = runtime
        .get_layer_owner(source_graph_node_id, target_layer_id)
        .await?;
    if layer_owner.layer_id != target_layer_id
        || (typed_resolution
            && action.resolved_invoke_interaction_id != Some(layer_owner.owner_interaction_node_id))
    {
        return Err(ApiError::internal(
            "GraphComplete returned a mismatched action destination layer",
        ));
    }
    let mut destination = state
        .product
        .get_interaction_by_graph_node_id(layer_owner.owner_interaction_node_id)
        .await?;
    if is_reconciliation_pending(&destination) {
        reconcile_quarantined_interaction(
            &state.product,
            runtime,
            state.interaction_execution.as_ref(),
            &mut destination,
        )
        .await?;
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
    execution: Option<&crate::product::InteractionExecutionService>,
    interactions: &mut [Interaction],
    action_invocations: &[crate::product::ActionInvocation],
    imported_threads: &std::collections::HashSet<ThreadId>,
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
    let ids = interactions
        .iter()
        .filter(|i| i.completion_status == "accepted" && !imported_threads.contains(&i.thread_id))
        .filter_map(|i| i.graph_node_id)
        .collect::<Vec<_>>();
    let changed_roots = match runtime {
        Some(runtime) => match runtime.changed_accepted_roots(&ids).await {
            Ok(roots) => roots,
            Err(_) => {
                // Unknown canonical membership must not certify cached output as fresh.
                stale.extend(
                    interactions
                        .iter()
                        .filter(|i| ids.contains(&i.graph_node_id.unwrap_or(0)))
                        .map(|i| i.id.value()),
                );
                Default::default()
            }
        },
        None => Default::default(),
    };
    for interaction in interactions {
        if is_reconciliation_pending(interaction) {
            match runtime {
                Some(runtime) => {
                    if reconcile_quarantined_interaction(product, runtime, execution, interaction)
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
        if !changed_roots.contains(&graph_node_id)
            && !invoked_source_interaction_ids.contains(&interaction.id.value())
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

/// Settles a quarantined interaction from canonical graph state. Settling it also ends its
/// attempt, which turns the attempt's provider lease into debt, so the one worker that owns
/// that debt is woken rather than left until the next restart. The wake also follows a failed
/// settle, since its commit may have landed before a later read failed.
async fn reconcile_quarantined_interaction(
    product: &crate::product::ProductService,
    runtime: &crate::runtime::RuntimeClient,
    execution: Option<&crate::product::InteractionExecutionService>,
    interaction: &mut Interaction,
) -> Result<(), RuntimeError> {
    let settled = settle_quarantined_interaction(product, runtime, interaction).await;
    // Wake even when a read after the settling commit failed: the commit may already have
    // made durable lease debt, and later reads will not retry this path. A wake with no debt
    // does nothing.
    if let Some(execution) = execution {
        execution.schedule_execution_lease_reconciliation();
    }
    settled
}

async fn settle_quarantined_interaction(
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
    // The launch runs to its end even if the caller disconnects. Dropped midway, it would
    // leave a claimed child, and an admitted attempt with its leases, that nothing observes.
    tokio::spawn(launch_prepared_child(state, headers, input))
        .await
        .map_err(|error| {
            eprintln!("recursive child launch did not finish: {error}");
            ApiError::internal("recursive child launch did not finish")
        })?
}

async fn launch_prepared_child(
    state: ApiState,
    headers: HeaderMap,
    input: CompletePreparedChildRequest,
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
    if action.id == invocation.source_action_id
        && action.kind == "navigate"
        && action.state == "accepted"
        && action.relation.as_deref() == Some("expand")
        && action.target_layer_id.is_some()
        && action.interaction_text.is_none()
        && action.resolved_invoke_interaction_id == Some(input.interaction_node)
        && let Some(outcome) = state
            .product
            .get_action_invocation(grant.source_interaction_id, invocation.source_action_id)
            .await?
        && outcome.interaction.thread_id == grant.thread_id
        && let Some(existing) = state
            .product
            .completion_execution(outcome.interaction.id)
            .await?
        && existing.graph_completion_id == input.interaction_node
        && existing.phase != CompletionExecutionPhase::Reserved
    {
        return Ok((
            StatusCode::OK,
            Json(CompletePreparedChildResponse {
                completion_id: existing.graph_completion_id,
            }),
        ));
    }
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
    // The action's result belongs to a user's own invoke of it, made from an accepted source
    // whose agent is still unwinding. The product runs and settles that result; the broker
    // never launches it.
    if !outcome.invocation.agent_invoked {
        return Err(ApiError::conflict(
            "invocation_owned_by_user",
            "A user already invoked this action; its result is not a recursive completion.",
        ));
    }
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

    // Only the launch that claims the child's preparation may fail it after a refusal. A
    // concurrent duplicate that finds it claimed and fails on its own must not end a child the
    // claiming launch is still running.
    let claimed = state
        .product
        .claim_interaction_preparing(outcome.interaction.id)
        .await?;
    let refused = |state: &ApiState, thread: Thread, interaction: Interaction| {
        if claimed {
            spawn_refused_launch_cleanup(
                state.clone(),
                thread,
                interaction,
                input.interaction_node,
            );
        }
    };
    let prepared = match prepare_interaction(&state, &thread, &outcome.interaction, claimed).await {
        Ok(Preparation::Prepared { prepared, .. }) => *prepared,
        // This launch claimed the child and cannot tell whether its preparation happened, or
        // it failed outright. Nothing will launch the child, so it fails in both stores.
        Ok(Preparation::Ambiguous) => {
            refused(&state, thread, outcome.interaction);
            return Err(ApiError::internal(
                "recursive completion preparation did not finish",
            ));
        }
        Err(error) => {
            refused(&state, thread, outcome.interaction);
            return Err(error);
        }
        // Another launch owns the child, or it can no longer be prepared. A child that ended,
        // including one a refused launch's cleanup failed with no execution row, is reported
        // rather than launched again: the parent then observes its terminal current through
        // this same occurrence. The row is read again here, after ownership was lost.
        Ok(Preparation::NotOwned) => {
            for attempt in 0..10 {
                let current = state
                    .product
                    .get_interaction(outcome.interaction.id)
                    .await?;
                if matches!(
                    current.completion_status.as_str(),
                    "accepted" | "failed" | "stopped"
                ) {
                    if current.graph_node_id == Some(input.interaction_node) {
                        return Ok((
                            StatusCode::OK,
                            Json(CompletePreparedChildResponse {
                                completion_id: input.interaction_node,
                            }),
                        ));
                    }
                    return Err(ApiError::conflict(
                        "recursive_completion_ended",
                        "This recursive completion already ended.",
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
    // Reserving and claiming the launch can still fail, for example on a binding conflict.
    // This launch claimed the child, so a failure here fails it too.
    let reservation = async {
        let permission_origin_digest = completion_permission_origin_digest(
            &prepared.effective_permission_receipt,
            invocation,
        )?;
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
        let launch_claimed = state
            .product
            .claim_completion_execution_launching(
                outcome.interaction.id,
                &permission_origin_digest,
                &timestamp,
            )
            .await?;
        Ok::<_, ApiError>((permission_origin_digest, reserved, launch_claimed))
    }
    .await;
    let (permission_origin_digest, reserved, launch_claimed) = match reservation {
        Ok(reservation) => reservation,
        Err(error) => {
            refused(&state, thread, outcome.interaction);
            return Err(error);
        }
    };
    if !launch_claimed {
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

    // This launch owns the child from its launch claim on. An activation that fails, even
    // retryably, fails the child in both stores, as a failed start does: nothing else would
    // run it, so an awaiting parent and the thread would otherwise wait forever. The parent's
    // exact retry then reports the failed child.
    let activation = claim_and_activate_prepared_interaction(
        &state,
        &thread,
        &outcome.interaction,
        prepared.clone(),
        false,
        false,
    )
    .await;
    let prepared = match activation {
        Ok(Some(prepared)) => prepared,
        // The child's row was no longer claimable: its unfinished binding was cleared, as a
        // startup harness retirement does. Only this execution row settles; the next start
        // fails the child (known gap until then).
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
            return Err(ApiError::conflict(
                "recursive_launch_superseded",
                "Another launch already runs this recursive completion.",
            ));
        }
        Err(error) => {
            spawn_failed_recursive_start_cleanup(
                state.clone(),
                thread,
                outcome.interaction,
                prepared,
                permission_origin_digest,
                LaunchFailure::ActivationFailed,
                None,
            );
            return Err(error);
        }
    };
    let admission = match admit_recursive_child(
        &state,
        runtime,
        &thread,
        &outcome.interaction,
        &prepared,
    )
    .await
    {
        Ok(admission) => admission,
        Err(refusal) => {
            spawn_failed_recursive_start_cleanup(
                state.clone(),
                thread,
                outcome.interaction,
                prepared,
                permission_origin_digest,
                LaunchFailure::AdmissionRefused(refusal.reason),
                None,
            );
            return Err(refusal.error);
        }
    };
    let attempt_id = admission.as_ref().map(|admission| admission.attempt_id);

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
            admission
                .as_ref()
                .map(|admission| crate::runtime::InvokedCompletionAdmission {
                    model_plan: &admission.model_plan,
                    execution_lease_id: &admission.execution_lease_id,
                    attempt_admission_id: &admission.attempt_admission_id,
                }),
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
                LaunchFailure::StartFailed,
                attempt_id,
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
        attempt_id,
    );
    if let Err(error) = attachment_result {
        // Fail before cancelling, so the exit observer finds the current already terminal
        // and does not record the cancelled run as an exit without Return.
        let _ = runtime
            .fail_graph_completion(
                child_completion_id,
                &format!("recursive-attachment-persist:{child_completion_id}"),
                "provider_attachment_persist_failed",
            )
            .await;
        let _ = runtime
            .cancel_invoked_completion(child_thread_id, child_completion_id)
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

/// What a recursive child was admitted with, and the attempt that owns its leases.
struct RecursiveChildAdmission {
    model_plan: crate::product::ExecutionModelPlan,
    execution_lease_id: String,
    attempt_admission_id: String,
    attempt_id: i64,
}

/// Why a recursive child was not admitted: the graph failure reason its cleanup records.
struct RecursiveAdmissionRefusal {
    reason: &'static str,
    error: ApiError,
}

fn refused(reason: &'static str) -> impl FnOnce(ApiError) -> RecursiveAdmissionRefusal {
    move |error| RecursiveAdmissionRefusal { reason, error }
}

/// Admits a recursive child as a root turn is admitted. Its inherited selection resolves
/// to the family plan current at launch, the host leases every provider in that plan, and
/// the product records the running attempt that owns those leases until the child settles.
/// A child with no selection (from an accepted pre-selector source) runs on the thread's
/// pinned harness alone, as before.
async fn admit_recursive_child(
    state: &ApiState,
    runtime: &crate::runtime::RuntimeClient,
    thread: &Thread,
    interaction: &Interaction,
    prepared: &PreparedInteraction,
) -> Result<Option<RecursiveChildAdmission>, RecursiveAdmissionRefusal> {
    let Some(selection) = interaction.model_selection.as_ref() else {
        return Ok(None);
    };
    let (model_plan, route) = state
        .product
        .resolve_execution_model_plan(&thread.harness_configuration_name, selection)
        .await
        .map_err(|error| refused("model_unavailable")(error.into()))?;
    // The child runs under the policy it was prepared with: the host leases, the product
    // records the attempt, and every receipt names that one revision. If the harness's
    // configuration changed since, the child is refused before anything is leased.
    let harness_policy = prepared.harness_policy().ok_or_else(|| {
        refused("configuration")(ApiError::internal(
            "a recursive child with a model selection requires its harness policy",
        ))
    })?;
    let current_policy = state
        .product
        .execution_harness_policy(&thread.harness_configuration_name)
        .await
        .map_err(|error| refused("configuration")(error.into()))?;
    if &current_policy != harness_policy {
        return Err(refused("configuration")(ApiError::conflict(
            "harness_configuration_changed",
            "The harness configuration changed while this child was launching.",
        )));
    }
    let working_directory = thread_working_directory(state, thread)
        .await
        .map_err(refused("configuration"))?;
    let permission_profile = state
        .permission_catalog
        .profile(&thread.permission_profile_id)
        .map_err(|error| refused("configuration")(error.into()))?;
    let attempt_admission_id = uuid::Uuid::new_v4().to_string();
    let command = CompleteInteraction {
        thread_icon_selection_eligible: false,
        require_native_continuity: false,
        native_history_anchor: None,
        project_id: thread.project_id.map(ProjectId::value),
        product_interaction_id: interaction.id.value(),
        thread_id: thread.id.value(),
        interaction_id: interaction.id.value(),
        text: &interaction.text,
        working_directory: &working_directory,
        harness_configuration_name: &thread.harness_configuration_name,
        permission_profile,
        model_selection: Some(&route),
        model_plan: Some(&model_plan),
        attempt_admission_id: Some(&attempt_admission_id),
        execution_lease_id: None,
        harness_policy: Some(harness_policy),
        invocation: None,
        input_identity: None,
        input_digest: None,
        contexts: &[],
        personal_presentation: None,
        submitted_inputs: &[],
    };
    let admission = runtime
        .admit_invoked_execution(&command)
        .await
        .map_err(|error| RecursiveAdmissionRefusal {
            reason: error.completion_failure_reason(),
            error: error.into(),
        })?;
    let attempt = state
        .product
        .begin_interaction_attempt(crate::product::BeginInteractionAttempt {
            interaction_id: interaction.id,
            attempt_admission_id: attempt_admission_id.clone(),
            harness_name: &thread.harness_configuration_name,
            route: &route,
            model_plan: model_plan.clone(),
            admitted_plan: admission.admitted_plan.clone(),
            adapter_version: admission.adapter_implementation_version,
            expected_harness_policy: Some(harness_policy),
            execution_lease_id: &admission.execution_lease_id,
        })
        .await;
    let attempt_id = match attempt {
        Ok(attempt_id) => attempt_id,
        Err(error) => {
            // No attempt records these leases, so they are released here rather than as debt.
            let _ = runtime
                .release_provider_execution(thread.id.value(), &admission.execution_lease_id)
                .await;
            return Err(refused("execution")(error.into()));
        }
    };
    Ok(Some(RecursiveChildAdmission {
        model_plan,
        execution_lease_id: admission.execution_lease_id,
        attempt_admission_id,
        attempt_id,
    }))
}

/// Projects one terminal graph current into the recursive child's product rows,
/// and reports whether the product accepted it. A caller retries a refusal. The
/// child's attempt, and with it its leases, ends only once its provider run ends too.
async fn settle_terminal_recursive_child(
    state: &ApiState,
    runtime: &crate::runtime::RuntimeClient,
    interaction: &Interaction,
    thread: &Thread,
    prepared: &PreparedInteraction,
    permission_origin_digest: &str,
    current: &relayer_graph_core::CompletionState,
) -> bool {
    let completion_id = prepared.graph_node_id;
    let settled = if current.lifecycle == relayer_graph_core::CompletionLifecycle::Succeeded {
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
        state
            .product
            .finalize_completion_execution_accepted(
                AcceptedInteractionCompletion {
                    interaction_id: interaction.id,
                    graph_node_id: completion_id,
                    harness_configuration_name: &prepared.harness_configuration_name,
                    harness_configuration_digest: &prepared.harness_configuration_digest,
                    effective_execution_digest: &prepared.effective_execution_digest,
                    effective_permission_receipt: &prepared.effective_permission_receipt,
                    output: &output,
                },
                permission_origin_digest,
                &completion_timestamp(),
            )
            .await
            .map(|_| ())
    } else {
        state
            .product
            .finalize_completion_execution_failed(
                interaction.id,
                permission_origin_digest,
                &thread.harness_configuration_name,
                current
                    .safe_reason
                    .as_deref()
                    .unwrap_or("completion_failed"),
                &completion_timestamp(),
            )
            .await
            .map(|_| ())
    };
    match settled {
        Ok(()) => true,
        Err(error) => {
            eprintln!(
                "recursive completion {completion_id} {} settlement could not be projected: {error}",
                serde_json::to_value(current.lifecycle).unwrap_or_default()
            );
            false
        }
    }
}

/// How a recursive child's launch failed, which decides what its cleanup must undo.
#[derive(Clone, Copy, PartialEq, Eq)]
enum LaunchFailure {
    /// Its graph capability could not be activated, so nothing was admitted or started.
    ActivationFailed,
    /// Admission refused the child with this reason, so no provider run was ever started.
    AdmissionRefused(&'static str),
    /// The start was requested and reported failure; it may still have run.
    StartFailed,
}

impl LaunchFailure {
    fn reason(self) -> &'static str {
        match self {
            Self::ActivationFailed => "capability_activation_failed",
            Self::AdmissionRefused(reason) => reason,
            Self::StartFailed => "provider_start_failed",
        }
    }
}

/// Fails an agent's child whose broker launch was refused before any launch owned it: its
/// preparation, reservation or claim ended ambiguously, or failed, after the child was
/// claimed. The product row fails first, bound to the child's graph interaction, and then the
/// graph current. A launch past its claim owns the child instead, and this stops. Each step
/// is retried until it holds, as start-failure cleanup is.
fn spawn_refused_launch_cleanup(
    state: ApiState,
    thread: Thread,
    interaction: Interaction,
    completion_id: i64,
) {
    tokio::spawn(async move {
        let Some(runtime) = state.runtime.as_ref() else {
            return;
        };
        loop {
            match fail_refused_launch(&state, runtime, &thread, &interaction, completion_id).await {
                Ok(true) => return,
                Ok(false) => {}
                Err(error) => eprintln!(
                    "recursive completion {completion_id} refused-launch cleanup retry: {}",
                    error.message()
                ),
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    });
}

/// One pass of refused-launch cleanup. Returns whether it is finished. The product row is
/// failed first: that fences out a later launch, whose reservation and claim need the row
/// still `submitted`, and a user's invoke. Only then is the graph current failed, so a launch
/// that got past its claim first keeps its child.
async fn fail_refused_launch(
    state: &ApiState,
    runtime: &crate::runtime::RuntimeClient,
    thread: &Thread,
    interaction: &Interaction,
    completion_id: i64,
) -> Result<bool, ApiError> {
    if state
        .product
        .completion_execution(interaction.id)
        .await?
        .is_some_and(|execution| {
            matches!(
                execution.phase,
                CompletionExecutionPhase::Launching | CompletionExecutionPhase::Attached
            )
        })
    {
        return Ok(true);
    }
    let row = state.product.get_interaction(interaction.id).await?;
    let fenced = row.completion_status == "failed"
        && row.graph_node_id == Some(completion_id)
        && row.completion_error.as_deref() == Some("preparation_failed");
    if !fenced {
        if !matches!(row.completion_status.as_str(), "not_started" | "submitted") {
            return Ok(true);
        }
        let current = runtime.completion_current(completion_id).await?;
        let reason = match current.lifecycle {
            relayer_graph_core::CompletionLifecycle::Active => "preparation_failed".to_owned(),
            // Something ran and returned it; that path settles its product row.
            relayer_graph_core::CompletionLifecycle::Succeeded => return Ok(true),
            relayer_graph_core::CompletionLifecycle::Stopped
            | relayer_graph_core::CompletionLifecycle::Failed => current
                .safe_reason
                .clone()
                .unwrap_or_else(|| "preparation_failed".into()),
        };
        if !state
            .product
            .fail_unlaunched_recursive_child(
                interaction.id,
                completion_id,
                &thread.harness_configuration_name,
                &reason,
                current.lifecycle == relayer_graph_core::CompletionLifecycle::Active,
                &completion_timestamp(),
            )
            .await?
        {
            // A launch claimed it meanwhile, or the row is not an agent's child bound here.
            eprintln!(
                "recursive completion {completion_id} refused-launch cleanup left interaction {} to its owner",
                interaction.id
            );
            return Ok(true);
        }
        if current.lifecycle != relayer_graph_core::CompletionLifecycle::Active {
            return Ok(true);
        }
    }
    let current = runtime.completion_current(completion_id).await?;
    if current.lifecycle == relayer_graph_core::CompletionLifecycle::Active {
        if let Err(error) = runtime
            .fail_graph_completion(
                completion_id,
                &format!("recursive-launch-refused:{}", interaction.id),
                "preparation_failed",
            )
            .await
        {
            eprintln!("recursive completion {completion_id} refused-launch graph retry: {error}");
        }
        if runtime.completion_current(completion_id).await?.lifecycle
            == relayer_graph_core::CompletionLifecycle::Active
        {
            return Ok(false);
        }
    }
    state
        .product
        .confirm_refused_child_graph_failure(interaction.id)
        .await?;
    Ok(true)
}

fn spawn_failed_recursive_start_cleanup(
    state: ApiState,
    thread: Thread,
    interaction: Interaction,
    prepared: PreparedInteraction,
    permission_origin_digest: String,
    failure: LaunchFailure,
    attempt_id: Option<i64>,
) {
    tokio::spawn(async move {
        let completion_id = prepared.graph_node_id;
        let Some(runtime) = state.runtime.as_ref() else {
            return;
        };
        // The child fails and settles first, so an unreachable harness cannot hold its
        // result open. Another actor may terminate the current first: the parent's stop, or the
        // child's own Return when the start ran but its acknowledgement was lost.
        // Whatever terminal current the graph holds is what the product records.
        let current = loop {
            if let Err(error) = runtime
                .fail_graph_completion(
                    completion_id,
                    &format!("recursive-provider-start:{}", interaction.id),
                    failure.reason(),
                )
                .await
            {
                eprintln!(
                    "recursive completion {completion_id} start-failure graph retry: {error}"
                );
            }
            match runtime.completion_current(completion_id).await {
                Ok(current)
                    if current.lifecycle != relayer_graph_core::CompletionLifecycle::Active =>
                {
                    break current;
                }
                Ok(_) => {}
                Err(error) => eprintln!(
                    "recursive completion {completion_id} start-failure current read retry: {error}"
                ),
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        };
        while !settle_terminal_recursive_child(
            &state,
            runtime,
            &interaction,
            &thread,
            &prepared,
            &permission_origin_digest,
            &current,
        )
        .await
        {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        // Only a requested start can have left a run to cancel; a refused admission
        // started nothing. The cancel retries until the harness answers.
        if failure == LaunchFailure::StartFailed {
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
        }
        // A start that failed may still have run (its acknowledgement was lost), so the
        // attempt and its leases end only once the host no longer runs the child.
        if let Some(attempt_id) = attempt_id {
            let _ = await_provider_end(
                runtime,
                thread.id.value(),
                completion_id,
                PROVIDER_END_RETRY_STEP,
            )
            .await;
            end_child_attempt(&state, runtime, interaction.id, attempt_id).await;
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

pub(super) async fn stop_interaction(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, interaction_id)): Path<(i64, i64)>,
) -> Result<Json<InteractionResponse>, ApiError> {
    authorize_write(&state, &headers)?;
    if !super::state::stop_available(&state) {
        return Err(ApiError::invalid(
            "Stop is unavailable in the diagnostic compatibility runtime",
        ));
    }
    let thread_id = ThreadId::try_from(thread_id)?;
    let interaction_id = InteractionId::try_from(interaction_id)?;
    let interaction = state.product.get_interaction(interaction_id).await?;
    if interaction.thread_id != thread_id {
        return Err(ApiError::invalid(
            "Interaction does not belong to this thread",
        ));
    }
    if matches!(
        interaction.completion_status.as_str(),
        "accepted" | "stopped" | "failed"
    ) {
        return Ok(Json(interaction.into()));
    }
    state
        .product
        .request_interaction_stop(thread_id, interaction_id)
        .await?;
    Ok(Json(
        state.product.get_interaction(interaction_id).await?.into(),
    ))
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
    // A user's own invoke of the action owns its result; only an agent's child answers to
    // the broker, even while the source's agent still holds its grant.
    if !outcome.invocation.agent_invoked {
        return Err(ApiError::conflict(
            "invocation_owned_by_user",
            "A user invoked this action; its result is not a recursive completion.",
        ));
    }
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
    attempt_id: Option<i64>,
) {
    let semantic_state = state.clone();
    let semantic_thread = thread.clone();
    let semantic_interaction = interaction.clone();
    let semantic_prepared = prepared.clone();
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
                Ok(current) => {
                    if settle_terminal_recursive_child(
                        &semantic_state,
                        runtime,
                        &semantic_interaction,
                        &semantic_thread,
                        &semantic_prepared,
                        &semantic_origin_digest,
                        &current,
                    )
                    .await
                    {
                        return;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
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
                    // Fail before cancelling, as a stop does, so the exit observer does not
                    // record the cancelled run as an exit without Return.
                    let failed = runtime
                        .fail_graph_completion(
                            completion_id,
                            &format!("recursive-observation-failed:{}", semantic_interaction.id),
                            reason,
                        )
                        .await;
                    let _ = runtime
                        .cancel_invoked_completion(semantic_thread.id.value(), completion_id)
                        .await;
                    if let Err(transition_error) = failed {
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
        // A run that ends without Return is a failure, never success, however it ended.
        let _ = await_provider_end(
            runtime,
            thread.id.value(),
            completion_id,
            PROVIDER_END_RETRY_STEP,
        )
        .await;
        // Nothing else will end a current whose provider is gone, so this retries until
        // the current is terminal.
        loop {
            let failure = match runtime.completion_current(completion_id).await {
                Ok(current)
                    if current.lifecycle != relayer_graph_core::CompletionLifecycle::Active =>
                {
                    break;
                }
                Ok(_) => runtime
                    .fail_graph_completion(
                        completion_id,
                        &format!("recursive-provider-exit:{}", interaction.id),
                        "provider_exited_without_return",
                    )
                    .await
                    .err(),
                Err(error) => Some(error),
            };
            if let Some(error) = failure {
                eprintln!(
                    "recursive completion {completion_id} provider-exit failure retry: {error}"
                );
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        }
        if let Some(attempt_id) = attempt_id {
            end_child_attempt(&state, runtime, interaction.id, attempt_id).await;
        }
        let _ = runtime.discard_prepared(prepared).await;
    });
}

/// The first pause after the harness cannot be reached while a child runs. Each further
/// failure waits one step longer, up to ten steps.
const PROVIDER_END_RETRY_STEP: std::time::Duration = std::time::Duration::from_millis(100);

/// Consecutive unreachable observations after which the child is cancelled.
const PROVIDER_END_UNREACHABLE_LIMIT: u32 = 20;

/// Waits until the harness reports that a child's provider run has ended. The host answers
/// only when the run ends, so only its answer ends the wait. A timeout means the run is still
/// going. A request that never reached the host proves nothing, so it is retried. Once the
/// host has been unreachable for long enough, the child is cancelled, and the wait goes on,
/// cancelling again after each run of unreachable observations: only the host's answer to
/// an observation ends it. Until the host confirms the end, the child's attempt and
/// leases stay held: an unreachable host proves nothing about its provider. A child that is
/// already stopped or failed is cancelled again on every poll while it still runs.
async fn await_provider_end(
    runtime: &crate::runtime::RuntimeClient,
    thread_id: i64,
    completion_id: i64,
    retry_step: std::time::Duration,
) -> Result<Value, RuntimeError> {
    let mut unreachable = 0_u32;
    loop {
        match runtime
            .observe_invoked_completion(thread_id, completion_id)
            .await
        {
            // The host still runs the child, whether it said so or the wait timed out.
            Ok(observation) if observation["running"] == true => {
                unreachable = 0;
                cancel_if_terminal(runtime, thread_id, completion_id).await;
            }
            // Only an observation naming this child, and not saying it still runs, reports
            // its end; any other shape is retried rather than read as the provider exiting.
            Ok(observation) if observation["completionId"].as_i64() != Some(completion_id) => {
                unreachable += 1;
                tokio::time::sleep(retry_step * unreachable.min(10)).await;
            }
            Err(error) if error.is_timeout() => {
                unreachable = 0;
                cancel_if_terminal(runtime, thread_id, completion_id).await;
            }
            Err(error) if !error.is_host_answer() => {
                unreachable += 1;
                if unreachable >= PROVIDER_END_UNREACHABLE_LIMIT {
                    eprintln!(
                        "recursive completion {completion_id} provider could not be observed; cancelling it: {error}"
                    );
                    // A cancel's answer says nothing about the provider having exited: the host
                    // also answers false for a run it already aborted that is still unwinding.
                    // Only an observation answer ends the wait.
                    let _ = runtime
                        .cancel_invoked_completion(thread_id, completion_id)
                        .await;
                    unreachable = 0;
                    continue;
                }
                tokio::time::sleep(retry_step * unreachable.min(10)).await;
            }
            ended => return ended,
        }
    }
}

/// A child whose graph already stopped or failed has no work left, yet a cancel sent
/// once may have been lost. While the host still runs it, each poll cancels it again, so
/// its provider cannot keep working, and holding its leases, indefinitely.
async fn cancel_if_terminal(
    runtime: &crate::runtime::RuntimeClient,
    thread_id: i64,
    completion_id: i64,
) {
    let terminal = runtime
        .completion_current(completion_id)
        .await
        .is_ok_and(|current| {
            matches!(
                current.lifecycle,
                relayer_graph_core::CompletionLifecycle::Stopped
                    | relayer_graph_core::CompletionLifecycle::Failed
            )
        });
    if terminal {
        let _ = runtime
            .cancel_invoked_completion(thread_id, completion_id)
            .await;
    }
}

/// Ends a child's attempt once both its provider run has ended and its execution has
/// settled, then releases the attempt's leases. The harness host has already released the
/// access when the provider run ended; provider removal waits for the attempt to end.
async fn end_child_attempt(
    state: &ApiState,
    runtime: &crate::runtime::RuntimeClient,
    interaction_id: InteractionId,
    attempt_id: i64,
) {
    if !finish_child_attempt(&state.product, runtime, interaction_id, attempt_id).await
        && let Some(execution) = &state.interaction_execution
    {
        execution.schedule_execution_lease_reconciliation();
    }
}

/// Ends a settled child's attempt with the outcome its settlement decided, then releases
/// its leases. Returns whether the release completed; if not, the lease stays as debt.
async fn finish_child_attempt(
    product: &crate::product::ProductService,
    runtime: &crate::runtime::RuntimeClient,
    interaction_id: InteractionId,
    attempt_id: i64,
) -> bool {
    loop {
        match product
            .end_completion_execution_attempt(interaction_id, &completion_timestamp())
            .await
        {
            Ok(_) => break,
            Err(error) => eprintln!(
                "recursive completion attempt {attempt_id} waits for settlement before it ends: {error}"
            ),
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    crate::app_server::reconcile_terminal_execution_lease(product, runtime, attempt_id).await
}

/// Whether one immediate observation shows that a child's provider run has ended. Only the
/// host's answer naming the child and not saying it runs, or the host's refusal (a restarted
/// host knows no such run), counts as ended; a timeout, an unreachable host, or any other shape
/// proves nothing.
async fn provider_end_observed_now(
    runtime: &crate::runtime::RuntimeClient,
    thread_id: i64,
    completion_id: i64,
) -> bool {
    match runtime
        .probe_invoked_completion(thread_id, completion_id)
        .await
    {
        Ok(observation) => {
            observation["running"] != true
                && observation["completionId"].as_i64() == Some(completion_id)
        }
        Err(error) => !error.is_timeout() && error.is_host_answer(),
    }
}

/// How long startup waits, across all unwinding children together, before serving Desktop.
/// Desktop allows the app server ten seconds to become ready, so this stays well inside it.
const STARTUP_UNWINDING_BOUND: std::time::Duration = std::time::Duration::from_secs(3);

/// After the product server restarts, ends the attempt of each child that had settled while
/// its provider was still unwinding, once the harness confirms the run ended. Every child is
/// observed at once and concurrently. A child whose run already ended (a harness that
/// restarted with the server knows no such run) normally has its attempt ended, and its
/// leases released, before startup serves Desktop, so a provider removal finished at startup
/// does not wait on it. Startup waits for finding and finishing them at most
/// `STARTUP_UNWINDING_BOUND` in total; anything still running, unreported, or not yet read
/// keeps going in the background, and a child keeps its leases until its run ends.
pub(crate) async fn resume_unwinding_recursive_children(
    product: crate::product::ProductService,
    runtime: crate::runtime::RuntimeClient,
    reconciler: Option<crate::app_server::ExecutionLeaseReconciler>,
) {
    // Dropping the handle when the bound expires detaches the task; it is not cancelled.
    let resume = tokio::spawn(resume_unwinding_children_until_ended(
        product, runtime, reconciler,
    ));
    if tokio::time::timeout(STARTUP_UNWINDING_BOUND, resume)
        .await
        .is_err()
    {
        eprintln!(
            "recursive children still unwinding were not all resumed when startup continued; they finish in the background"
        );
    }
}

async fn resume_unwinding_children_until_ended(
    product: crate::product::ProductService,
    runtime: crate::runtime::RuntimeClient,
    reconciler: Option<crate::app_server::ExecutionLeaseReconciler>,
) {
    // Nothing else finds these children again until the next restart, so a failed read
    // is retried rather than abandoned.
    let unwinding = loop {
        match product.unwinding_recursive_attempts().await {
            Ok(unwinding) => break unwinding,
            Err(error) => eprintln!(
                "could not read recursive children still unwinding after restart; retrying: {error}"
            ),
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    };
    let mut children = tokio::task::JoinSet::new();
    for child in unwinding {
        let product = product.clone();
        let runtime = runtime.clone();
        let reconciler = reconciler.clone();
        children.spawn(async move {
            if !provider_end_observed_now(
                &runtime,
                child.thread_id.value(),
                child.graph_completion_id,
            )
            .await
            {
                let _ = await_provider_end(
                    &runtime,
                    child.thread_id.value(),
                    child.graph_completion_id,
                    PROVIDER_END_RETRY_STEP,
                )
                .await;
            }
            if !finish_child_attempt(&product, &runtime, child.interaction_id, child.attempt_id)
                .await
                && let Some(reconciler) = reconciler
            {
                reconciler.schedule();
            }
        });
    }
    while children.join_next().await.is_some() {}
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
    // A user's invoke never runs an agent's child on the product path: only its parent agent
    // launches or stops it, and startup or its launch cleanup ends it if it is stuck.
    let agent_child = state
        .product
        .is_agent_invoked_child(outcome.interaction.id)
        .await?;
    let interaction = if agent_child {
        outcome.interaction
    } else if outcome.interaction.completion_status == "not_started" || recoverable_invoke {
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

/// Existing folder scopes must remain available; only no-folder workspaces are created.
async fn thread_working_directory(state: &ApiState, thread: &Thread) -> Result<String, ApiError> {
    Ok(state
        .product
        .thread_directory(thread, &state.standalone_workspaces_directory)
        .await?)
}

/// How preparing an interaction's canonical graph identity ended.
enum Preparation {
    /// Prepared and durably bound; the caller claims and activates it.
    Prepared {
        prepared: Box<PreparedInteraction>,
        has_invocation: bool,
        has_durable_input: bool,
    },
    /// Another caller owns the interaction, or it can no longer be prepared.
    NotOwned,
    /// This call's graph preparation or product binding ended ambiguously, or the claimed
    /// interaction's durable binding conflicts with what the graph prepared. The interaction
    /// stays `submitted`, so the same graph interaction can be recovered idempotently.
    Ambiguous,
}

async fn prepare_and_claim_interaction(
    state: &ApiState,
    thread: &Thread,
    interaction: &Interaction,
    already_claimed_running: bool,
    defer_claim_and_activation: bool,
) -> Result<Option<PreparedInteraction>, ApiError> {
    let Preparation::Prepared {
        prepared,
        has_invocation,
        has_durable_input,
    } = prepare_interaction(state, thread, interaction, already_claimed_running).await?
    else {
        return Ok(None);
    };
    if defer_claim_and_activation {
        return Ok(Some(*prepared));
    }
    claim_and_activate_prepared_interaction(
        state,
        thread,
        interaction,
        *prepared,
        has_invocation,
        has_durable_input,
    )
    .await
}

async fn prepare_interaction(
    state: &ApiState,
    thread: &Thread,
    interaction: &Interaction,
    already_claimed_running: bool,
) -> Result<Preparation, ApiError> {
    let Some(runtime) = &state.runtime else {
        return Ok(Preparation::NotOwned);
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
            return Ok(Preparation::NotOwned);
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
    let working_directory = thread_working_directory(state, thread).await?;
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
        thread_icon_selection_eligible: false,
        require_native_continuity: false,
        native_history_anchor: None,
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
                return Ok(Preparation::Ambiguous);
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
                return Ok(Preparation::Ambiguous);
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
                // Still claimed but bound differently: nothing will prepare it again.
                if current.completion_status == "submitted" {
                    return Ok(Preparation::Ambiguous);
                }
                return Ok(Preparation::NotOwned);
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
                return Ok(Preparation::Ambiguous);
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
    Ok(Preparation::Prepared {
        prepared: Box::new(prepared),
        has_invocation: invocation.is_some(),
        has_durable_input: durable_input.is_some(),
    })
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

// The trace-replay adapter lives outside src: it is test code, not a packaged
// module, but it drives crate-private launch and cleanup functions.
#[cfg(test)]
#[path = "../../tests/support/completion_traces.rs"]
mod completion_traces;

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
    };

    /// One recursive child bound to its parent execution, with a controllable graph fake.
    struct BrokerFixture {
        state: ApiState,
        product: ProductService,
        thread: Thread,
        starts: Arc<AtomicUsize>,
        headers: HeaderMap,
        current: Arc<Mutex<Value>>,
        action: Arc<Mutex<Value>>,
        transitions: Arc<Mutex<Vec<Value>>>,
        cancellations: Arc<AtomicUsize>,
        start_held: Arc<std::sync::atomic::AtomicBool>,
        start_release: Arc<tokio::sync::Notify>,
        provider_exited: Arc<std::sync::atomic::AtomicBool>,
        transition_refusals: Arc<AtomicUsize>,
        _lease: CompletionBrokerLease,
        graph_task: tokio::task::JoinHandle<Result<(), std::io::Error>>,
        harness_task: tokio::task::JoinHandle<Result<(), std::io::Error>>,
        /// Declared last so every field holding the database drops before its directory.
        _root: tempfile::TempDir,
    }

    impl BrokerFixture {
        fn finish(self) {
            self.graph_task.abort();
            self.harness_task.abort();
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
        let root = tempfile::Builder::new()
            .prefix(&format!("relayer-completion-broker-{label}-"))
            .tempdir()
            .unwrap();
        let database = root.path().join("product.sqlite3");
        let catalog = root.path().join("catalog.json");
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
                required_provider_adapter_id: None,
                icon_selection_eligible: true,
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
        let transition_refusals = Arc::new(AtomicUsize::new(0));
        let refused_transitions = transition_refusals.clone();
        let action = Arc::new(Mutex::new(
            serde_json::json!({"id":41,"kind":"invoke","interactionText":"Child work","state":"accepted"}),
        ));
        let read_action = action.clone();
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
                routing::get(move || {
                    let action = read_action.clone();
                    async move { axum::Json(serde_json::json!({"action":action.lock().unwrap().clone()})) }
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
                    let refusals = refused_transitions.clone();
                    async move {
                        if refusals
                            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                                left.checked_sub(1)
                            })
                            .is_ok()
                        {
                            return (
                                StatusCode::SERVICE_UNAVAILABLE,
                                axum::Json(serde_json::json!({
                                    "error":{"code":"unavailable","message":"graph busy"}
                                })),
                            );
                        }
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
                        (
                            StatusCode::OK,
                            axum::Json(serde_json::json!({
                                "completionId":202,"revision":revision,"lifecycle":lifecycle,
                                "currentLayerId":1,"finalLayerId":null,
                                "operationKey":body["operationKey"],
                                "requestDigest":"sha256:test","snapshotDigest":"sha256:test",
                                "projectionSequence":revision
                            })),
                        )
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
        let start_held = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let start_release = Arc::new(tokio::sync::Notify::new());
        let held_start = start_held.clone();
        let released_start = start_release.clone();
        let observed_starts = starts.clone();
        let observed_cancellations = cancellations.clone();
        let run_cancellations = cancellations.clone();
        let run_current = current.clone();
        let provider_exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let run_exited = provider_exited.clone();
        let harness = Router::new()
            .route(
                "/sessions/{id}/invoked-completions",
                routing::post(move |axum::Json(body): axum::Json<Value>| {
                    let starts = observed_starts.clone();
                    let held = held_start.clone();
                    let release = released_start.clone();
                    async move {
                        starts.fetch_add(1, Ordering::SeqCst);
                        if held.load(Ordering::SeqCst) {
                            release.notified().await;
                        }
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
            // The host answers only when the child's run ends: once it is cancelled, once
            // its current is no longer active, or once the test ends it.
            .route(
                "/sessions/{id}/invoked-completions/202",
                routing::get(move || {
                    let cancellations = run_cancellations.clone();
                    let current = run_current.clone();
                    let exited = run_exited.clone();
                    async move {
                        while cancellations.load(Ordering::SeqCst) == 0
                            && !exited.load(Ordering::SeqCst)
                            && current.lock().unwrap()["lifecycle"] == "active"
                        {
                            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                        }
                        axum::Json(serde_json::json!({"completionId":202}))
                    }
                }),
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
        let working_directory = root.path().to_string_lossy().into_owned();
        let seeded = runtime
            .prepare(&CompleteInteraction {
                thread_icon_selection_eligible: false,
                require_native_continuity: false,
                native_history_anchor: None,
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
            eval_mode: false,
            allow_conversation_import: false,
            standalone_workspaces_directory: root.path().join("workspaces"),
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
            _root: root,
            starts,
            headers,
            current,
            action,
            transitions,
            cancellations,
            start_held,
            start_release,
            provider_exited,
            transition_refusals,
            _lease: lease,
            graph_task,
            harness_task,
        }
    }

    #[tokio::test]
    async fn thread_icon_api_creation_persists_normal_and_eval_eligibility() {
        let fixture = broker_fixture("thread-icon-mode", "active").await;
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "relayer_control=control".parse().unwrap());
        for eval_mode in [false, true] {
            let mut state = fixture.state.clone();
            state.eval_mode = eval_mode;
            state.runtime = None;
            state.interaction_execution = None;
            let (_, Json(response)) = create(
                State(state),
                headers.clone(),
                Json(CreateThreadRequest {
                    required_provider_adapter_id: None,
                    title: None,
                    project_id: None,
                    initial_message: "Choose an icon".into(),
                    working_directory: None,
                    creation_request_id: None,
                    expected_checkout: None,
                    harness_id: None,
                    harness_configuration_name: Some("test".into()),
                    permission_profile_id: Some("auto".into()),
                    model_selection: None,
                }),
            )
            .await
            .unwrap_or_else(|error| panic!("creation failed: {}", error.message()));
            let value = serde_json::to_value(response).unwrap();
            assert!(value["icon"].is_null());
            let thread = fixture
                .product
                .get_thread(ThreadId::try_from(value["id"].as_i64().unwrap()).unwrap())
                .await
                .unwrap()
                .thread;
            assert_eq!(thread.icon_selection_eligible, !eval_mode);
        }
        fixture.finish();
    }

    #[tokio::test]
    async fn a_run_that_ends_without_return_is_failed_through_graph_refusals() {
        let fixture = broker_fixture("exit-without-return", "active").await;
        let _started = complete_prepared_child(
            State(fixture.state.clone()),
            fixture.headers.clone(),
            Json(CompletePreparedChildRequest {
                interaction_node: 202,
            }),
        )
        .await
        .unwrap_or_else(|error| panic!("broker call failed: {}", error.message()));
        // The graph refuses the first transitions; the provider then ends without Return.
        fixture.transition_refusals.store(3, Ordering::SeqCst);
        fixture.provider_exited.store(true, Ordering::SeqCst);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let current = fixture.current.lock().unwrap().clone();
            if current["lifecycle"] == "failed" {
                assert_eq!(current["safeReason"], "provider_exited_without_return");
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "a run that ended without Return left its current {current}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(fixture.transition_refusals.load(Ordering::SeqCst), 0);
        fixture.finish();
    }

    #[tokio::test]
    async fn a_launch_whose_caller_disconnects_still_attaches_and_observes_the_child() {
        let fixture = broker_fixture("caller-disconnects", "active").await;
        fixture.start_held.store(true, Ordering::SeqCst);
        let call = complete_prepared_child(
            State(fixture.state.clone()),
            fixture.headers.clone(),
            Json(CompletePreparedChildRequest {
                interaction_node: 202,
            }),
        );
        // The broker's request goes away while the host is still starting the child.
        let dropped = tokio::time::timeout(std::time::Duration::from_millis(300), call).await;
        assert!(
            dropped.is_err(),
            "the start was held, so the call cannot finish"
        );
        assert_eq!(fixture.starts.load(Ordering::SeqCst), 1);
        fixture.start_release.notify_one();

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
            if execution.phase != CompletionExecutionPhase::Launching {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the started child was left launching with nothing observing it"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        fixture.finish();
    }

    #[tokio::test]
    async fn unrelated_offline_and_imported_outputs_keep_cached_freshness() {
        let fixture = broker_fixture("projection-boundary", "succeeded").await;
        let interaction = fixture
            .product
            .get_interaction(fixture.thread.root_interaction_id)
            .await
            .unwrap();
        let mut offline = vec![interaction.clone()];
        assert!(
            refresh_accepted_outputs(
                &fixture.product,
                None,
                None,
                &mut offline,
                &[],
                &Default::default()
            )
            .await
            .is_empty()
        );
        assert_eq!(offline[0].completion_output, interaction.completion_output);
        let mut imported = vec![interaction.clone()];
        assert!(
            refresh_accepted_outputs(
                &fixture.product,
                fixture.state.runtime.as_ref(),
                fixture.state.interaction_execution.as_ref(),
                &mut imported,
                &[],
                &std::collections::HashSet::from([fixture.thread.id])
            )
            .await
            .is_empty()
        );
        assert_eq!(imported[0].completion_output, interaction.completion_output);
        fixture.finish();
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

        *fixture.action.lock().unwrap() = serde_json::json!({
            "id":41,"kind":"navigate","relation":"expand","state":"accepted",
            "targetLayerId":1,"resolvedInvokeInteractionId":202
        });
        let retry = complete_prepared_child(
            State(fixture.state.clone()),
            fixture.headers.clone(),
            Json(CompletePreparedChildRequest {
                interaction_node: 202,
            }),
        )
        .await
        .unwrap_or_else(|error| panic!("converted replay failed: {}", error.message()));
        assert_eq!(retry.0, StatusCode::OK);
        assert_eq!(retry.1.0.completion_id, 202);
        fixture.action.lock().unwrap()["resolvedInvokeInteractionId"] = serde_json::json!(203);
        assert!(
            complete_prepared_child(
                State(fixture.state.clone()),
                fixture.headers.clone(),
                Json(CompletePreparedChildRequest {
                    interaction_node: 202
                })
            )
            .await
            .is_err()
        );
        assert_eq!(fixture.starts.load(Ordering::SeqCst), 1);

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
