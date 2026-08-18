use super::types::ProjectResponse;
use crate::product::{InvalidProductId, ProductError};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub(crate) struct ApiError(StatusCode, Value);

impl ApiError {
    pub(crate) fn unauthorized() -> Self {
        Self(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "A valid Relayer desktop session is required." }),
        )
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({ "code": "invalid_input", "error": message.into() }),
        )
    }

    fn internal(message: &str) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": message }),
        )
    }
}

impl From<InvalidProductId> for ApiError {
    fn from(error: InvalidProductId) -> Self {
        Self::invalid(error.to_string())
    }
}

impl From<ProductError> for ApiError {
    fn from(error: ProductError) -> Self {
        match error {
            ProductError::NotFound(message) => Self(
                StatusCode::NOT_FOUND,
                json!({ "error": format!("Not found: {message}") }),
            ),
            ProductError::Invalid(message) => Self::invalid(message),
            ProductError::ProjectExists(project) => Self(
                StatusCode::CONFLICT,
                json!({
                    "code": "project_exists",
                    "error": "This folder is already a Relayer project. Confirm before reusing it.",
                    "existingProject": ProjectResponse::from(project),
                }),
            ),
            ProductError::FolderUnavailable { path, reason } => Self(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({
                    "code": "folder_unavailable",
                    "error": "Relayer cannot access that folder. Choose it again or restore permission.",
                    "path": path,
                    "reason": reason,
                }),
            ),
            ProductError::Storage(error) => Self::internal(&error.to_string()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}
