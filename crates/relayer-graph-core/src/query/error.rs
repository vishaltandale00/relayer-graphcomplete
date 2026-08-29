//! Query errors and the precedence between them.
//!
//! From `docs/graph-query-v1.md` section 10. The stages are ordered, and an
//! earlier stage wins even when a later failure also exists — which is why the
//! executor checks them in order rather than reporting whichever it noticed.

use serde::{Deserialize, Serialize};
use std::fmt;

/// The stage a query failed in. Ordering is the contract's precedence, so the
/// derived `Ord` is the precedence test.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryPhase {
    Envelope,
    Parse,
    Plan,
    Authorize,
    Execute,
    Normalize,
    Encode,
}

impl QueryPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Envelope => "envelope",
            Self::Parse => "parse",
            Self::Plan => "plan",
            Self::Authorize => "authorize",
            Self::Execute => "execute",
            Self::Normalize => "normalize",
            Self::Encode => "encode",
        }
    }
}

/// A stable v1 error code. Message wording may gain clarification; these may not
/// change without a contract version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryCode {
    InvalidRequest,
    UnsupportedQueryContractVersion,
    QueryBytesExceeded,
    QuerySyntaxInvalid,
    QueryConstructForbidden,
    QueryConstructUnsupported,
    UnknownLabel,
    UnknownRelationshipType,
    UnknownProperty,
    DynamicSchemaForbidden,
    QueryTypeMismatch,
    DuplicateOutputColumn,
    AstDepthExceeded,
    VariableLimitExceeded,
    PatternPartLimitExceeded,
    TraversalLimitExceeded,
    RowLimitExceeded,
    InaccessibleOrMissing,
    ScopeNotGranted,
    QueryCancelled,
    WallTimeExceeded,
    IntermediateRowsExceeded,
    InvalidEngineValue,
    IntegerOverflow,
    ResultRowTooLarge,
}

impl QueryCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::UnsupportedQueryContractVersion => "unsupported_query_contract_version",
            Self::QueryBytesExceeded => "query_bytes_exceeded",
            Self::QuerySyntaxInvalid => "query_syntax_invalid",
            Self::QueryConstructForbidden => "query_construct_forbidden",
            Self::QueryConstructUnsupported => "query_construct_unsupported",
            Self::UnknownLabel => "unknown_label",
            Self::UnknownRelationshipType => "unknown_relationship_type",
            Self::UnknownProperty => "unknown_property",
            Self::DynamicSchemaForbidden => "dynamic_schema_forbidden",
            Self::QueryTypeMismatch => "query_type_mismatch",
            Self::DuplicateOutputColumn => "duplicate_output_column",
            Self::AstDepthExceeded => "ast_depth_exceeded",
            Self::VariableLimitExceeded => "variable_limit_exceeded",
            Self::PatternPartLimitExceeded => "pattern_part_limit_exceeded",
            Self::TraversalLimitExceeded => "traversal_limit_exceeded",
            Self::RowLimitExceeded => "row_limit_exceeded",
            Self::InaccessibleOrMissing => "inaccessible_or_missing",
            Self::ScopeNotGranted => "scope_not_granted",
            Self::QueryCancelled => "query_cancelled",
            Self::WallTimeExceeded => "wall_time_exceeded",
            Self::IntermediateRowsExceeded => "intermediate_rows_exceeded",
            Self::InvalidEngineValue => "invalid_engine_value",
            Self::IntegerOverflow => "integer_overflow",
            Self::ResultRowTooLarge => "result_row_too_large",
        }
    }

    /// The stage this code belongs to. Codes and stages are fixed together, so a
    /// caller cannot report a parse code from the execute stage.
    pub fn phase(self) -> QueryPhase {
        match self {
            Self::InvalidRequest
            | Self::UnsupportedQueryContractVersion
            | Self::QueryBytesExceeded => QueryPhase::Envelope,
            Self::QuerySyntaxInvalid
            | Self::QueryConstructForbidden
            | Self::QueryConstructUnsupported => QueryPhase::Parse,
            Self::UnknownLabel
            | Self::UnknownRelationshipType
            | Self::UnknownProperty
            | Self::DynamicSchemaForbidden
            | Self::QueryTypeMismatch
            | Self::DuplicateOutputColumn
            | Self::AstDepthExceeded
            | Self::VariableLimitExceeded
            | Self::PatternPartLimitExceeded
            | Self::TraversalLimitExceeded
            | Self::RowLimitExceeded => QueryPhase::Plan,
            Self::InaccessibleOrMissing | Self::ScopeNotGranted => QueryPhase::Authorize,
            Self::QueryCancelled | Self::WallTimeExceeded | Self::IntermediateRowsExceeded => {
                QueryPhase::Execute
            }
            Self::InvalidEngineValue | Self::IntegerOverflow => QueryPhase::Normalize,
            Self::ResultRowTooLarge => QueryPhase::Encode,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryError {
    pub code: QueryCode,
    pub phase: QueryPhase,
    pub path: String,
    pub message: String,
}

impl QueryError {
    pub fn new(code: QueryCode, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code,
            phase: code.phase(),
            path: path.into(),
            message: message.into(),
        }
    }

    /// The error a caller should see when two are available. The contract says an
    /// earlier stage wins even when a later failure also exists.
    pub fn earlier(self, other: Self) -> Self {
        if other.phase < self.phase {
            other
        } else {
            self
        }
    }
}

impl fmt::Display for QueryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for QueryError {}
