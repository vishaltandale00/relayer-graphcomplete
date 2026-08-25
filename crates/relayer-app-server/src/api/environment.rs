use super::{ApiState, auth::authorize_read, error::ApiError};
use crate::product::ProjectId;
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};

pub(super) async fn get(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<crate::environment::EnvironmentSnapshot>, ApiError> {
    authorize_read(&state, &headers)?;
    let project_id = ProjectId::try_from(id)?;
    let project_path = state.product.project_path(project_id).await?;
    Ok(Json(crate::environment::inspect(project_path.into()).await))
}
