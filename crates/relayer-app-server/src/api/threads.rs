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
    approval::{
        ApprovalActor, ApprovalCorrelation, ApprovalDecision, ApprovalDecisionSubmission,
        ApprovalOutcome, ApprovalReceipt, ApprovalRequest, ApprovalResolution,
    },
    product::{
        AcceptedInteractionCompletion, CreateThreadCommand, Interaction, InteractionContextIntent,
        InteractionId, InteractionModelSelection, InvokeActionOutcome, ModelFamilyId,
        PreparedInteractionBinding, ProjectId, ProviderId, Thread, ThreadId, ThreadView,
    },
    runtime::{
        ApprovalEvent, ApprovalEventSnapshot, CompleteInteraction, PreparedInteraction,
        PreparedInvocation, RuntimeCompletion, RuntimeError,
    },
};
use axum::{
    Json,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const RECONCILIATION_PENDING_PREFIX: &str = "Canonical reconciliation pending:";
const LIVE_RECONCILIATION_ATTEMPTS: u64 = 4;

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
    model_selection: Option<ModelSelectionRequest>,
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
    refresh_provider_catalog(
        &state,
        model_selection.as_ref().map(|model| &model.provider_id),
    )
    .await?;
    let thread = state
        .product
        .create_thread(CreateThreadCommand {
            title: request.title,
            project_id,
            initial_message: request.initial_message,
            harness_configuration_name,
            permission_profile_id,
            model_selection,
            allow_unselected_model,
        })
        .await?;
    let interaction = state
        .product
        .get_interaction(thread.root_interaction_id)
        .await?;
    start_interaction(&state, &thread, interaction).await?;
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
    let interactions = project_interactions(
        &state,
        std::mem::take(&mut detail.interactions),
        imported_thread,
        &stale,
    )
    .await?;
    let response = ThreadDetailResponse::from(detail).with_interactions(interactions);
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
    let has_durable_context = durable_input
        .as_ref()
        .is_some_and(|input| !input.contexts.is_empty());
    if (has_durable_context || imported_thread)
        && let (Some(runtime), Some(graph_node_id)) = (state.runtime.as_ref(), graph_node_id)
    {
        match runtime.interaction_input(graph_node_id).await {
            Ok(input) => {
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
                            Ok(())
                        }
                    }
                };
                if let Err(error) = projected {
                    eprintln!("could not project context for interaction {id}: {error}");
                }
            }
            Err(error) => eprintln!("could not project context for interaction {id}: {error}"),
        }
    }
    Ok(response)
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
    authorize_write(&state, &headers)?;
    let thread_id = ThreadId::try_from(id)?;
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
    let provider_id = model_selection
        .as_ref()
        .map(|model| model.provider_id.clone())
        .or_else(|| {
            thread_detail
                .interactions
                .last()
                .and_then(|interaction| interaction.model_selection.as_ref())
                .map(|model| model.provider_id.clone())
        });
    let thread = thread_detail.thread;
    let allow_unselected_model = privileged_model_less_thread
        || (state.allow_harness_override
            && state
                .product
                .harness_uses_configuration_model(&thread.harness_configuration_name)
                .await?);
    refresh_provider_catalog(&state, provider_id.as_ref()).await?;
    if !request.contexts.is_empty() && request.input_id.is_none() {
        eprintln!("rejected context-bearing interaction without a stable inputId");
        return Err(ApiError::internal(
            "Relayer could not send this message. Your draft was preserved.",
        ));
    }
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
                &request.text,
                &input_id,
                &request.contexts,
                model_selection.as_ref(),
                allow_unselected_model,
            )
            .await;
        match created {
            Err(crate::product::ProductError::Catalog(error)) => return Err(error.into()),
            Err(crate::product::ProductError::Storage(crate::storage::StorageError::Catalog(
                error,
            ))) => return Err(error.into()),
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
    let interaction = match start_interaction(&state, &thread, interaction).await {
        Ok(interaction) => interaction,
        Err(error) if !request.contexts.is_empty() => {
            let diagnostic = error.internal_diagnostic();
            eprintln!(
                "interaction context send {interaction_id} failed before graph binding: {diagnostic}"
            );
            if error.is_deterministic_input_failure()
                && let Err(cleanup) = state
                    .product
                    .discard_unbound_interaction_input(interaction_id)
                    .await
            {
                eprintln!(
                    "could not discard invalid interaction context send {interaction_id}: {cleanup}"
                );
            }
            return Err(ApiError::internal(
                "Relayer could not send this message. Your draft was preserved.",
            ));
        }
        Err(error) => return Err(error),
    };
    Ok((StatusCode::CREATED, Json(interaction.into())))
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
        if let Err(error) = start_interaction(&state, &thread, interaction.clone()).await {
            eprintln!(
                "could not resume recovered identified interaction {}: {}",
                interaction.id,
                error.message()
            );
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
    if metadata.node_id != graph_node_id
        || (metadata.invocation != expected && !legacy_unleased_invocation)
    {
        return Err(RuntimeError::Protocol(
            "graph interaction lease provenance does not match product history".into(),
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
        if outcome.interaction.completion_status == "not_started" {
            refresh_provider_catalog(
                state,
                outcome
                    .interaction
                    .model_selection
                    .as_ref()
                    .map(|model| &model.provider_id),
            )
            .await?;
        }
        return spawn_action_handoff(state.clone(), thread, outcome).await;
    }
    refresh_provider_catalog(
        state,
        source
            .model_selection
            .as_ref()
            .map(|model| &model.provider_id),
    )
    .await?;

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

async fn refresh_provider_catalog(
    state: &ApiState,
    provider_id: Option<&ProviderId>,
) -> Result<(), ApiError> {
    if let (Some(refresh), Some(provider_id)) = (&state.provider_catalog_refresh, provider_id) {
        refresh.refresh(provider_id).await?;
    }
    Ok(())
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
        record_background_failure(state, thread, &interaction, message.into()).await;
        return Err(ApiError::invalid(message));
    }
    let prepared = match prepare_and_claim_interaction(state, thread, &interaction).await {
        Ok(prepared) => prepared,
        Err(error) => {
            record_background_failure(state, thread, &interaction, error.message().to_owned())
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
        execute_prepared_interaction(state, thread, interaction, prepared).await;
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
) -> Result<Interaction, ApiError> {
    if state.runtime.is_none() {
        return Ok(interaction);
    }
    let prepared = match prepare_and_claim_interaction(state, thread, &interaction).await {
        Ok(prepared) => prepared,
        Err(error) => {
            record_background_failure(state, thread, &interaction, error.internal_diagnostic())
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
    let state = state.clone();
    let thread = thread.clone();
    tokio::spawn(async move {
        execute_prepared_interaction(state, thread, interaction, prepared).await;
    });
    Ok(running)
}

async fn prepare_and_claim_interaction(
    state: &ApiState,
    thread: &Thread,
    interaction: &Interaction,
) -> Result<Option<PreparedInteraction>, ApiError> {
    let Some(runtime) = &state.runtime else {
        return Ok(None);
    };
    let claimed_preparation = state
        .product
        .claim_interaction_preparing(interaction.id)
        .await?;
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
    if let Some(model_selection) = interaction.model_selection.as_ref()
        && let Err(error) = state
            .product
            .validate_execution_model_selection(&thread.harness_configuration_name, model_selection)
            .await
    {
        return Err(error.into());
    }
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
    let command = CompleteInteraction {
        project_id: thread.project_id.map(ProjectId::value),
        product_interaction_id: interaction.id.value(),
        thread_id: thread.id.value(),
        interaction_id: interaction.id.value(),
        text: &interaction.text,
        working_directory: &working_directory,
        harness_configuration_name: &thread.harness_configuration_name,
        permission_profile,
        model_selection: interaction.model_selection.as_ref(),
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
        let restored = if invocation.is_some() {
            state
                .product
                .restore_leased_interaction_submitted(interaction.id, &message)
                .await?
        } else if durable_input.is_some() {
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

async fn execute_prepared_interaction(
    state: ApiState,
    thread: Thread,
    interaction: Interaction,
    prepared: PreparedInteraction,
) {
    let Some(runtime) = &state.runtime else {
        return;
    };
    let working_directory = match thread.project_id {
        Some(project_id) => match state.product.project_path(project_id).await {
            Ok(path) => path,
            Err(error) => {
                let message = match runtime.discard_prepared(prepared).await {
                    Ok(()) => error.to_string(),
                    Err(cleanup) => format!("{error}; capability cleanup also failed: {cleanup}"),
                };
                record_background_failure(&state, &thread, &interaction, message).await;
                return;
            }
        },
        None => state
            .standalone_workspaces_directory
            .join(thread.id.value().to_string())
            .to_string_lossy()
            .into_owned(),
    };
    let permission_profile = match state
        .permission_catalog
        .profile(&thread.permission_profile_id)
    {
        Ok(profile) => profile,
        Err(error) => {
            let message = match runtime.discard_prepared(prepared).await {
                Ok(()) => error.to_string(),
                Err(cleanup) => format!("{error}; capability cleanup also failed: {cleanup}"),
            };
            record_background_failure(&state, &thread, &interaction, message).await;
            return;
        }
    };
    let invocation = match state.product.invocation_graph_source(interaction.id).await {
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
            record_background_failure(&state, &thread, &interaction, message).await;
            return;
        }
    };
    let durable_input = match state.product.interaction_input(interaction.id).await {
        Ok(value) => value,
        Err(error) => {
            record_background_failure(&state, &thread, &interaction, error.to_string()).await;
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
        model_selection: interaction.model_selection.as_ref(),
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
    let expected_invocation = invocation;
    let prepared_graph_node_id = prepared.graph_node_id;
    let completion = runtime.complete_prepared(&command, prepared);
    tokio::pin!(completion);
    let mut cursor = 0;
    let mut harness_session_id = None;
    let mut complete_call_id = None;
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let completion_result: Result<RuntimeCompletion, String> = loop {
        tokio::select! {
            result = &mut completion => {
                match runtime.approval_events(thread.id.value(), cursor).await {
                    Ok(snapshot) => {
                        if let Err(error) = persist_approval_snapshot(
                            &state,
                            thread.id,
                            interaction.id,
                            &mut cursor,
                            &mut harness_session_id,
                            &mut complete_call_id,
                            snapshot,
                        ).await {
                            break Err(error);
                        }
                        let acknowledgement = match runtime
                            .approval_events(thread.id.value(), cursor)
                            .await
                        {
                            Ok(snapshot) => snapshot,
                            Err(error) => break Err(format!(
                                "could not acknowledge final approval event cursor: {error}"
                            )),
                        };
                        match final_approval_acknowledgement(cursor, &acknowledgement) {
                            Ok(true) => {
                                if let Err(error) = persist_approval_snapshot(
                                    &state,
                                    thread.id,
                                    interaction.id,
                                    &mut cursor,
                                    &mut harness_session_id,
                                    &mut complete_call_id,
                                    acknowledgement,
                                ).await {
                                    break Err(error);
                                }
                            }
                            Ok(false) => {}
                            Err(error) => break Err(error),
                        }
                    }
                    Err(RuntimeError::Remote { status: 404, .. }) if harness_session_id.is_none() => {}
                    Err(error) => break Err(format!(
                        "could not perform final approval reconciliation: {error}"
                    )),
                }
                break result.map_err(|error| error.to_string());
            }
            _ = interval.tick() => {
                match runtime.approval_events(thread.id.value(), cursor).await {
                    Ok(snapshot) => {
                        if let Err(error) = persist_approval_snapshot(
                            &state,
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
                            break Err(message);
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
    let aborted = match state
        .product
        .abort_pending_approvals(
            Some(interaction.id),
            "Approval request was aborted because the harness completion ended without a terminal approval event.",
        )
        .await
    {
        Ok(count) => count,
        Err(error) => {
            record_background_failure(&state, &thread, &interaction, error.to_string()).await;
            return;
        }
    };
    let completion_result = if aborted > 0 {
        Err("harness completion ended with unresolved approval requests".into())
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
                record_reconciliation_pending(&state, &thread, &interaction, &error).await;
                return;
            }
            if completion.permission_profile_id != thread.permission_profile_id {
                record_background_failure(
                    &state,
                    &thread,
                    &interaction,
                    format!(
                        "runtime returned permission profile {} for thread pinned to {}",
                        completion.permission_profile_id, thread.permission_profile_id
                    ),
                )
                .await;
                return;
            }
            if let Err(error) = state
                .product
                .accept_interaction_completion(AcceptedInteractionCompletion {
                    interaction_id: interaction.id,
                    graph_node_id: completion.graph_node_id,
                    harness_configuration_name: &completion.harness_configuration_name,
                    harness_configuration_digest: &completion.harness_configuration_digest,
                    effective_execution_digest: &completion.effective_execution_digest,
                    effective_permission_receipt: &completion.effective_permission_receipt,
                    output: &completion.output,
                })
                .await
            {
                record_reconciliation_pending(
                    &state,
                    &thread,
                    &interaction,
                    &format!("could not persist accepted interaction: {error}"),
                )
                .await;
            }
        }
        Err(error) => {
            if let Err(invalidation_error) = runtime
                .invalidate_node_capabilities(prepared_graph_node_id)
                .await
            {
                record_reconciliation_pending(
                    &state,
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
                wait_for_completion_output(runtime, prepared_graph_node_id, interaction.id).await;
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
                        &state,
                        &thread,
                        &interaction,
                        &format!("runtime failed ({error}); {verify_error}"),
                    )
                    .await;
                    return;
                }
                match state.product.get_interaction(interaction.id).await {
                    Ok(bound) => {
                        let accepted = match (
                            bound.harness_configuration_name.as_deref(),
                            bound.harness_configuration_digest.as_deref(),
                            bound.effective_execution_digest.as_deref(),
                            bound.effective_permission_receipt.as_ref(),
                        ) {
                            (Some(name), Some(digest), Some(execution), Some(receipt)) => {
                                state
                                    .product
                                    .accept_interaction_completion(AcceptedInteractionCompletion {
                                        interaction_id: interaction.id,
                                        graph_node_id: prepared_graph_node_id,
                                        harness_configuration_name: name,
                                        harness_configuration_digest: digest,
                                        effective_execution_digest: execution,
                                        effective_permission_receipt: receipt,
                                        output: &output,
                                    })
                                    .await
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
                                &state,
                                &thread,
                                &interaction,
                                &persistence_error.to_string(),
                            )
                            .await;
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
                    record_background_failure(&state, &thread, &interaction, error.to_string())
                        .await;
                }
                Err(read_error) => {
                    record_reconciliation_pending(
                        &state,
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
    state: &ApiState,
    thread: &Thread,
    interaction: &Interaction,
    error: &str,
) {
    let error = format!("{RECONCILIATION_PENDING_PREFIX} {error}");
    for attempt in 1..=LIVE_RECONCILIATION_ATTEMPTS {
        match state
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

fn final_approval_acknowledgement(
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
    state: &ApiState,
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
                state
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
                validate_event_resolution_authority(state, &resolution).await?;
                state
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
        state
            .product
            .record_approval_request(&request)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn validate_approval_correlation(
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

fn validate_decision_resolution(
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
    state: &ApiState,
    resolution: &ApprovalResolution,
) -> Result<(), String> {
    if resolution.actor != ApprovalActor::User {
        return Ok(());
    }
    let stored = state
        .product
        .get_approval(&resolution.request_id)
        .await
        .map_err(|error| error.to_string())?;
    if stored.resolution.as_ref() == Some(resolution) {
        return Ok(());
    }
    let decision = state
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

async fn record_background_failure(
    state: &ApiState,
    thread: &Thread,
    interaction: &Interaction,
    error: String,
) {
    eprintln!(
        "interaction {} completion failed in the backend: {error}",
        interaction.id
    );
    match state
        .product
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
    use super::*;
    use crate::approval::ApprovalAction;

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
