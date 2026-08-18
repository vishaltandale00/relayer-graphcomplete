use super::{
    ApiState,
    auth::{authorize_read, authorize_write},
    error::ApiError,
    types::{InteractionResponse, ThreadDetailResponse, ThreadResponse, ThreadViewResponse},
};
use crate::{
    product::{
        CreateThreadCommand, Interaction, InteractionId, ProjectId, Thread, ThreadId, ThreadView,
    },
    runtime::CompleteInteraction,
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
    harness_configuration_name: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct CreateInteractionRequest {
    text: String,
}

#[derive(Serialize)]
pub(super) struct ThreadsResponse {
    threads: Vec<ThreadResponse>,
}

#[derive(Serialize)]
pub(super) struct InteractionsResponse {
    interactions: Vec<InteractionResponse>,
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
    let harness_configuration_name =
        selected_harness_configuration(&state, request.harness_configuration_name.as_deref())?;
    let thread = state
        .product
        .create_thread(CreateThreadCommand {
            title: request.title,
            project_id,
            initial_message: request.initial_message,
            harness_configuration_name,
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
    let thread = state.product.get_thread(thread_id).await?.thread;
    let interaction = state
        .product
        .create_interaction(thread_id, &request.text)
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

fn selected_harness_configuration(
    state: &ApiState,
    requested: Option<&str>,
) -> Result<String, ApiError> {
    if requested.is_some() && !state.allow_harness_override {
        return Err(ApiError::invalid(
            "harness configuration overrides are unavailable in Relayer",
        ));
    }
    let selected = requested.unwrap_or(&state.default_harness_configuration);
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
            thread_id: thread.id.value(),
            text: &interaction.text,
            working_directory: &working_directory,
            harness_configuration_name: &thread.harness_configuration_name,
        })
        .await
    {
        Ok(completion) => {
            if let Err(error) = state
                .product
                .accept_interaction_completion(
                    interaction.id,
                    completion.graph_node_id,
                    &completion.harness_configuration_name,
                    &completion.harness_configuration_digest,
                    &completion.output,
                )
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

async fn record_background_failure(
    state: &ApiState,
    thread: &Thread,
    interaction: &Interaction,
    error: String,
) {
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
