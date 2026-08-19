use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::{ActionId, GraphError, LayerId, NodeId, RecordState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    Navigate,
    Invoke,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ActionVariant {
    Chip,
    #[default]
    Pill,
    Wide,
    Card,
    Unsupported(String),
}

impl ActionVariant {
    pub(crate) fn as_str(&self) -> &str {
        match self {
            Self::Chip => "chip",
            Self::Pill => "pill",
            Self::Wide => "wide",
            Self::Card => "card",
            Self::Unsupported(value) => value,
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, GraphError> {
        match value {
            "chip" => Ok(Self::Chip),
            "pill" => Ok(Self::Pill),
            "wide" => Ok(Self::Wide),
            "card" => Ok(Self::Card),
            other => Err(GraphError::Internal(format!(
                "unknown action variant {other}"
            ))),
        }
    }
}

impl Serialize for ActionVariant {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ActionVariant {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "chip" => Self::Chip,
            "pill" => Self::Pill,
            "wide" => Self::Wide,
            "card" => Self::Card,
            _ => Self::Unsupported(value),
        })
    }
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
    pub variant: ActionVariant,
    pub icon: Option<String>,
    pub description: Option<String>,
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
    #[serde(default)]
    pub variant: ActionVariant,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub target_layer_id: Option<LayerId>,
    pub interaction_text: Option<String>,
    #[serde(default)]
    pub response: bool,
}

impl ActionDraft {
    pub(crate) fn validate_shape(&self) -> Result<Option<&'static str>, GraphError> {
        super::require_nonempty(&self.client_key, "clientKey")?;
        super::require_nonempty(&self.label, "label")?;
        if matches!(self.variant, ActionVariant::Unsupported(_)) {
            return Err(GraphError::validation(
                "unsupported_action_variant",
                "variant",
                "Action variant must be one of: chip, pill, wide, card.",
            ));
        }
        let canonical_icon = self
            .icon
            .as_deref()
            .map(|icon| {
                super::resolve_icon_name(icon).ok_or_else(|| {
                    GraphError::validation(
                        "unsupported_icon",
                        "icon",
                        format!(
                            "Unsupported icon {:?}. Choose a name from the curated Relayer icon vocabulary: {}.",
                            icon,
                            super::RELAYER_ICON_NAMES.join(", ")
                        ),
                    )
                })
            })
            .transpose()?;
        match (&self.variant, self.description.as_deref()) {
            (ActionVariant::Card, Some(description)) if !description.trim().is_empty() => {}
            (ActionVariant::Card, _) => {
                return Err(GraphError::validation(
                    "missing_action_description",
                    "description",
                    "A card action needs supporting description text.",
                ));
            }
            (_, Some(_)) => {
                return Err(GraphError::validation(
                    "unexpected_action_description",
                    "description",
                    "Supporting description text is available only for card actions.",
                ));
            }
            (_, None) => {}
        }
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
        Ok(canonical_icon)
    }
}
