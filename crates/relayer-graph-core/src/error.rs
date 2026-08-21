use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub code: &'static str,
    pub path: String,
    pub message: String,
}

impl ValidationIssue {
    pub(crate) fn new(
        code: &'static str,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
pub enum GraphError {
    #[error("{message}")]
    Validation {
        code: &'static str,
        path: String,
        message: String,
    },
    #[error("{message}")]
    ValidationIssues {
        message: String,
        issues: Vec<ValidationIssue>,
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

    pub(crate) fn validation_issues(issues: Vec<ValidationIssue>) -> Self {
        debug_assert!(!issues.is_empty());
        let message = issues
            .iter()
            .map(|issue| issue.message.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        Self::ValidationIssues { message, issues }
    }
}
