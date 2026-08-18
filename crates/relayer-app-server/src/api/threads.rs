use super::{
    ApiState,
    auth::authorize,
    error::ApiError,
    types::{InteractionResponse, ThreadDetailResponse, ThreadResponse, ThreadViewResponse},
};
use crate::product::{CreateThreadCommand, ProjectId, ThreadId, ThreadView};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CreateThreadRequest {
    title: Option<String>,
    project_id: Option<i64>,
    initial_message: String,
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
    authorize(&state, &headers)?;
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
    authorize(&state, &headers)?;
    let project_id = request.project_id.map(ProjectId::try_from).transpose()?;
    let thread = state
        .product
        .create_thread(CreateThreadCommand {
            title: request.title,
            project_id,
            initial_message: request.initial_message,
        })
        .await?;
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
    authorize(&state, &headers)?;
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
    authorize(&state, &headers)?;
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
    authorize(&state, &headers)?;
    let interaction = state
        .product
        .create_interaction(ThreadId::try_from(id)?, &request.text)
        .await?;
    Ok((StatusCode::CREATED, Json(interaction.into())))
}
