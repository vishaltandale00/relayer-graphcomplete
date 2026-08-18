use super::{
    ApiState,
    auth::{authorize_read, authorize_write},
    error::ApiError,
    types::ProjectResponse,
};
use crate::product::CreateProjectCommand;
use axum::{Json, extract::State, http::HeaderMap, http::StatusCode};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CreateProjectRequest {
    path: String,
    name: Option<String>,
    #[serde(default)]
    reuse_existing: bool,
}

#[derive(Serialize)]
pub(super) struct ProjectsResponse {
    projects: Vec<ProjectResponse>,
}

pub(super) async fn list(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<ProjectsResponse>, ApiError> {
    authorize_read(&state, &headers)?;
    let projects = state
        .product
        .list_projects()
        .await?
        .into_iter()
        .map(Into::into)
        .collect();
    Ok(Json(ProjectsResponse { projects }))
}

pub(super) async fn create(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<CreateProjectRequest>,
) -> Result<(StatusCode, Json<ProjectResponse>), ApiError> {
    authorize_write(&state, &headers)?;
    let outcome = state
        .product
        .create_project(CreateProjectCommand {
            path: request.path,
            name: request.name,
            reuse_existing: request.reuse_existing,
        })
        .await?;
    let status = if outcome.created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(outcome.project.into())))
}
