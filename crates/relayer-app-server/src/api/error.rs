use super::types::ProjectResponse;
use crate::permissions::PermissionError;
use crate::product::{InvalidProductId, ProductError};
use crate::runtime::RuntimeError;
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

    pub(crate) fn read_only() -> Self {
        Self(
            StatusCode::FORBIDDEN,
            json!({ "code": "read_only_session", "error": "This Relayer session is read-only." }),
        )
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({ "code": "invalid_input", "error": message.into() }),
        )
    }

    pub(crate) fn internal(message: &str) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": message }),
        )
    }

    pub(crate) fn message(&self) -> &str {
        self.1
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown API error")
    }
}

impl From<RuntimeError> for ApiError {
    fn from(error: RuntimeError) -> Self {
        Self::internal(&error.to_string())
    }
}

impl From<PermissionError> for ApiError {
    fn from(error: PermissionError) -> Self {
        match error {
            PermissionError::Selection {
                code,
                profile_id,
                message,
            } => Self(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({ "code": code, "permissionProfileId": profile_id, "error": message }),
            ),
            other => Self::internal(&other.to_string()),
        }
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
