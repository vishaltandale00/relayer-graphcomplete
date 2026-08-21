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
        AcceptedInteractionCompletion, CreateThreadCommand, Interaction, InteractionId,
        InteractionModelSelection, InvokeActionOutcome, ModelFamilyId, ProjectId, ProviderId,
        Thread, ThreadId, ThreadView,
    },
    runtime::{
        ApprovalEvent, ApprovalEventSnapshot, CompleteInteraction, RuntimeCompletion, RuntimeError,
    },
};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    Ok(Json(
        state
            .product
            .get_thread(ThreadId::try_from(id)?)
            .await?
            .into(),
    ))
}

pub(super) async fn list_interactions(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<InteractionsResponse>, ApiError> {
    authorize_read(&state, &headers)?;
    let interactions = state
        .product
        .list_interactions(ThreadId::try_from(id)?)
        .await?
        .into_iter()
        .map(Into::into)
        .collect();
    Ok(Json(InteractionsResponse { interactions }))
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
    let interaction = state
        .product
        .create_interaction(
            thread_id,
            &request.text,
            model_selection.as_ref(),
            allow_unselected_model,
        )
        .await?;
    let interaction = start_interaction(&state, &thread, interaction).await?;
    Ok((StatusCode::CREATED, Json(interaction.into())))
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
    let interaction = if outcome.interaction.completion_status == "not_started" {
        claim_and_start_action_interaction(state, thread, outcome.interaction).await?
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
    let claimed = state
        .product
        .claim_interaction_running(interaction.id, &thread.harness_configuration_name)
        .await?;
    if !claimed {
        return state
            .product
            .get_interaction(interaction.id)
            .await
            .map_err(Into::into);
    }

    let mut running = interaction.clone();
    running.completion_status = "running".into();
    running.harness_configuration_name = Some(thread.harness_configuration_name.clone());
    running.harness_configuration_digest = None;
    running.effective_execution_digest = None;
    running.effective_permission_receipt = None;
    running.completion_output = None;
    running.completion_error = None;

    // There is no await between the durable claim and spawning execution. Once this detached
    // handoff owns the interaction, losing the HTTP request cannot strand it as not_started.
    let state = state.clone();
    let thread = thread.clone();
    tokio::spawn(async move {
        execute_interaction(state, thread, interaction).await;
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
    state
        .product
        .mark_interaction_running(interaction.id, &thread.harness_configuration_name)
        .await?;
    let running = state.product.get_interaction(interaction.id).await?;
    let state = state.clone();
    let thread = thread.clone();
    tokio::spawn(async move {
        execute_interaction(state, thread, interaction).await;
    });
    Ok(running)
}

async fn execute_interaction(state: ApiState, thread: Thread, interaction: Interaction) {
    let Some(runtime) = &state.runtime else {
        return;
    };
    if interaction.model_selection.is_none() && !state.allow_harness_override {
        match state
            .product
            .permits_unselected_action_execution(interaction.id)
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                record_background_failure(
                    &state,
                    &thread,
                    &interaction,
                    "The interaction has no model selection.".into(),
                )
                .await;
                return;
            }
            Err(error) => {
                record_background_failure(&state, &thread, &interaction, error.to_string()).await;
                return;
            }
        }
    }
    if let Some(model_selection) = interaction.model_selection.as_ref()
        && let Err(error) = state
            .product
            .validate_execution_model_selection(&thread.harness_configuration_name, model_selection)
            .await
    {
        record_background_failure(&state, &thread, &interaction, error.to_string()).await;
        return;
    }
    let working_directory = match thread.project_id {
        Some(project_id) => match state.product.project_path(project_id).await {
            Ok(path) => path,
            Err(error) => {
                record_background_failure(&state, &thread, &interaction, error.to_string()).await;
                return;
            }
        },
        None => state
            .standalone_workspaces_directory
            .join(thread.id.value().to_string())
            .to_string_lossy()
            .into_owned(),
    };
    if let Err(error) = tokio::fs::create_dir_all(&working_directory).await {
        record_background_failure(
            &state,
            &thread,
            &interaction,
            format!("cannot create thread workspace: {error}"),
        )
        .await;
        return;
    }
    let permission_profile = match state
        .permission_catalog
        .profile(&thread.permission_profile_id)
    {
        Ok(profile) => profile,
        Err(error) => {
            record_background_failure(&state, &thread, &interaction, error.to_string()).await;
            return;
        }
    };
    let completion = runtime.complete(CompleteInteraction {
        project_id: thread.project_id.map(ProjectId::value),
        product_interaction_id: interaction.id.value(),
        thread_id: thread.id.value(),
        interaction_id: interaction.id.value(),
        text: &interaction.text,
        working_directory: &working_directory,
        harness_configuration_name: &thread.harness_configuration_name,
        permission_profile,
        model_selection: interaction.model_selection.as_ref(),
    });
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
                eprintln!(
                    "could not persist accepted interaction {}: {error}",
                    interaction.id
                );
            }
        }
        Err(error) => {
            record_background_failure(&state, &thread, &interaction, error.to_string()).await;
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
    if let Err(persistence_error) = state
        .product
        .fail_interaction_completion(interaction.id, &thread.harness_configuration_name, &error)
        .await
    {
        eprintln!(
            "could not persist failed interaction {}: {persistence_error}; original failure: {error}",
            interaction.id
        );
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
