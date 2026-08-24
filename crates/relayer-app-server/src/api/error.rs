use super::types::ProjectResponse;
use crate::conversation_export_service::ConversationExportBuildError;
use crate::conversation_import_service::ConversationImportError;
use crate::permissions::PermissionError;
use crate::product::{CatalogError, InvalidProductId, ProductError};
use crate::provider_catalog_refresh::ProviderCatalogRefreshError;
use crate::runtime::RuntimeError;
use crate::storage::StorageError;
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

    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self(
            StatusCode::FORBIDDEN,
            json!({ "code": "forbidden", "error": message.into() }),
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

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self(
            StatusCode::NOT_FOUND,
            json!({ "code": "not_found", "error": message.into() }),
        )
    }

    pub(crate) fn conflict(code: &str, message: impl Into<String>) -> Self {
        Self(
            StatusCode::CONFLICT,
            json!({ "code": code, "error": message.into() }),
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
        match error {
            RuntimeError::Remote { status: 400, body } => Self(StatusCode::BAD_REQUEST, body),
            RuntimeError::Remote { status: 404, body } => Self(StatusCode::NOT_FOUND, body),
            RuntimeError::Remote { status: 409, body } => Self(StatusCode::CONFLICT, body),
            other => Self::internal(&other.to_string()),
        }
    }
}

impl From<ConversationExportBuildError> for ApiError {
    fn from(error: ConversationExportBuildError) -> Self {
        match error {
            ConversationExportBuildError::Product(error) => error.into(),
            other => Self::internal(&other.to_string()),
        }
    }
}

impl From<ConversationImportError> for ApiError {
    fn from(error: ConversationImportError) -> Self {
        match error {
            ConversationImportError::Read(error) => Self::invalid(error.to_string()),
            ConversationImportError::Product(error) => error.into(),
            ConversationImportError::Runtime(error) => error.into(),
            ConversationImportError::Input(message) => Self::invalid(message),
            ConversationImportError::Cleanup { operation, cleanup } => Self::internal(&format!(
                "conversation import failed: {operation}; cleanup failed: {cleanup}"
            )),
        }
    }
}

impl From<ProviderCatalogRefreshError> for ApiError {
    fn from(error: ProviderCatalogRefreshError) -> Self {
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({
                "code": "provider_catalog_refresh_failed",
                "error": error.to_string(),
            }),
        )
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
            ProductError::Catalog(error) | ProductError::Storage(StorageError::Catalog(error)) => {
                catalog_error(error)
            }
            ProductError::Storage(error) => Self::internal(&error.to_string()),
        }
    }
}

impl From<CatalogError> for ApiError {
    fn from(error: CatalogError) -> Self {
        catalog_error(error)
    }
}

fn catalog_error(error: CatalogError) -> ApiError {
    let (harness_id, family_id, provider_id, model_id) = error.selection_context();
    ApiError(
        StatusCode::UNPROCESSABLE_ENTITY,
        json!({
            "code": error.code(),
            "error": error.to_string(),
            "harnessId": harness_id,
            "familyId": family_id,
            "providerId": provider_id,
            "modelId": model_id,
        }),
    )
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}
