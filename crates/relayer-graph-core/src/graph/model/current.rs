use serde::{Deserialize, Serialize};

use super::{LayerId, NodeId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionLifecycle {
    Active,
    Succeeded,
    Stopped,
    Failed,
}

impl CompletionLifecycle {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Succeeded => "succeeded",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, crate::GraphError> {
        match value {
            "active" => Ok(Self::Active),
            "succeeded" => Ok(Self::Succeeded),
            "stopped" => Ok(Self::Stopped),
            "failed" => Ok(Self::Failed),
            _ => Err(crate::GraphError::Internal(format!(
                "database returned unknown completion lifecycle {value:?}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
// `rename_all` renames the variants; variant fields need `rename_all_fields`. Without it
// `advance` and `return` demand `layer_id` while every client on this API sends `layerId`.
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum CurrentTransition {
    Advance { layer_id: LayerId },
    Return { layer_id: LayerId },
    Stop { reason: String },
    Fail { reason: String },
}

impl CurrentTransition {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Advance { .. } => "advance",
            Self::Return { .. } => "return",
            Self::Stop { .. } => "stop",
            Self::Fail { .. } => "fail",
        }
    }

    pub(crate) fn lifecycle(&self) -> CompletionLifecycle {
        match self {
            Self::Advance { .. } => CompletionLifecycle::Active,
            Self::Return { .. } => CompletionLifecycle::Succeeded,
            Self::Stop { .. } => CompletionLifecycle::Stopped,
            Self::Fail { .. } => CompletionLifecycle::Failed,
        }
    }

    pub(crate) fn safe_reason(&self) -> Option<&str> {
        match self {
            Self::Stop { reason } | Self::Fail { reason } => Some(reason),
            Self::Advance { .. } | Self::Return { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionState {
    pub completion_id: NodeId,
    pub lifecycle: CompletionLifecycle,
    pub head_revision: u64,
    pub current_layer_id: Option<LayerId>,
    pub final_layer_id: Option<LayerId>,
    pub safe_reason: Option<String>,
    pub temporal_features: TemporalFeatureConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentTransitionReceipt {
    pub completion_id: NodeId,
    pub revision: u64,
    pub lifecycle: CompletionLifecycle,
    pub current_layer_id: Option<LayerId>,
    pub final_layer_id: Option<LayerId>,
    pub operation_key: String,
    pub request_digest: String,
    pub snapshot_digest: String,
    pub projection_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentProjectionEvent {
    pub sequence: u64,
    pub completion_id: NodeId,
    pub revision: u64,
    pub previous_revision: Option<u64>,
    pub lifecycle: CompletionLifecycle,
    pub current_layer_id: Option<LayerId>,
    pub final_layer_id: Option<LayerId>,
    pub safe_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentProjectionPage {
    pub cursor: u64,
    pub has_more: bool,
    pub states: Vec<CompletionState>,
    pub events: Vec<CurrentProjectionEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporalFeatureConfig {
    pub config_version: u32,
    pub schema_read: bool,
    pub root_current_write: bool,
    pub projection_ui: bool,
    pub invoke_resolution: bool,
    pub provider_recursion: bool,
}

impl Default for TemporalFeatureConfig {
    fn default() -> Self {
        Self {
            config_version: 1,
            schema_read: false,
            root_current_write: false,
            projection_ui: false,
            invoke_resolution: false,
            provider_recursion: false,
        }
    }
}
