use thiserror::Error;

#[derive(Debug, Error)]
pub enum GraphError {
    #[error("{message}")]
    Validation {
        code: &'static str,
        path: String,
        message: String,
    },
    #[error("not found: {0}")]
    NotFound(String),
    #[error("access denied: {0}")]
    Forbidden(String),
    #[error("graph storage failed: {0}")]
    Storage(#[from] sqlx::Error),
    #[error("graph migration failed: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("graph engine failed: {0}")]
    Internal(String),
}

impl GraphError {
    pub(crate) fn validation(
        code: &'static str,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::Validation {
            code,
            path: path.into(),
            message: message.into(),
        }
    }
}
