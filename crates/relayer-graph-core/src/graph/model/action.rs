use serde::{Deserialize, Serialize};

use crate::{ActionId, GraphError, LayerId, NodeId, RecordState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    Navigate,
    Invoke,
}

impl ActionKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Navigate => "navigate",
            Self::Invoke => "invoke",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, GraphError> {
        match value {
            "navigate" => Ok(Self::Navigate),
            "invoke" => Ok(Self::Invoke),
            other => Err(GraphError::Internal(format!("unknown action kind {other}"))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphAction {
    pub id: ActionId,
    pub source_node_id: NodeId,
    pub kind: ActionKind,
    pub label: String,
    pub target_layer_id: Option<LayerId>,
    pub interaction_text: Option<String>,
    pub response: bool,
    pub state: RecordState,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionDraft {
    pub client_key: String,
    pub source_node_id: NodeId,
    pub kind: ActionKind,
    pub label: String,
    pub target_layer_id: Option<LayerId>,
    pub interaction_text: Option<String>,
    #[serde(default)]
    pub response: bool,
}

impl ActionDraft {
    pub(crate) fn validate_shape(&self) -> Result<(), GraphError> {
        super::require_nonempty(&self.client_key, "clientKey")?;
        super::require_nonempty(&self.label, "label")?;
        match self.kind {
            ActionKind::Navigate => {
                if self.target_layer_id.is_none() {
                    return Err(GraphError::validation(
                        "missing_target_layer",
                        "targetLayerId",
                        "A navigate action must point to a submitted draft layer.",
                    ));
                }
                if self.interaction_text.is_some() {
                    return Err(GraphError::validation(
                        "unexpected_interaction_text",
                        "interactionText",
                        "A navigate action opens a layer and cannot also start an interaction.",
                    ));
                }
            }
            ActionKind::Invoke => {
                if self
                    .interaction_text
                    .as_deref()
                    .is_none_or(|text| text.trim().is_empty())
                {
                    return Err(GraphError::validation(
                        "missing_interaction_text",
                        "interactionText",
                        "An invoke action needs the user interaction text it will start.",
                    ));
                }
                if self.target_layer_id.is_some() {
                    return Err(GraphError::validation(
                        "unexpected_target_layer",
                        "targetLayerId",
                        "An invoke action starts an interaction and does not point to a layer.",
                    ));
                }
                if self.response {
                    return Err(GraphError::validation(
                        "invalid_response_action",
                        "response",
                        "The completion response action must be a navigate action.",
                    ));
                }
            }
        }
        Ok(())
    }
}
