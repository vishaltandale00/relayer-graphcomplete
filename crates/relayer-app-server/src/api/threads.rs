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
    product::{
        AcceptedInteractionCompletion, CreateThreadCommand, Interaction, InteractionId,
        InteractionModelSelection, InvokeActionOutcome, ModelFamilyId, ProjectId, ProviderId,
        Thread, ThreadId, ThreadView,
    },
    runtime::{CompleteInteraction, RuntimeError},
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
    match runtime
        .complete(CompleteInteraction {
            project_id: thread.project_id.map(ProjectId::value),
            product_interaction_id: interaction.id.value(),
            thread_id: thread.id.value(),
            text: &interaction.text,
            working_directory: &working_directory,
            harness_configuration_name: &thread.harness_configuration_name,
            permission_profile: match state
                .permission_catalog
                .profile(&thread.permission_profile_id)
            {
                Ok(profile) => profile,
                Err(error) => {
                    record_background_failure(&state, &thread, &interaction, error.to_string())
                        .await;
                    return;
                }
            },
            model_selection: interaction.model_selection.as_ref(),
        })
        .await
    {
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

    #[test]
    fn action_invocation_request_errors_include_identifiers_in_the_backend_log() {
        let error = ApiError::invalid("GraphComplete runtime is unavailable");

        assert_eq!(
            action_invocation_request_failure_message(4, 8, 15, &error),
            "action invocation request failed before background completion: thread=4 source_interaction=8 action=15: GraphComplete runtime is unavailable"
        );
    }
}
