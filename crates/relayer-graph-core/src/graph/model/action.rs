use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::{ActionId, GraphError, LayerId, NodeId, RecordState, ValidationIssue};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    Navigate,
    Invoke,
    Input,
    #[serde(rename = "interaction.context")]
    InteractionContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputControl {
    Text,
    SingleSelect,
    MultiSelect,
}

impl InputControl {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::SingleSelect => "single_select",
            Self::MultiSelect => "multi_select",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, GraphError> {
        match value {
            "text" => Ok(Self::Text),
            "single_select" => Ok(Self::SingleSelect),
            "multi_select" => Ok(Self::MultiSelect),
            other => Err(GraphError::Internal(format!(
                "unknown input control {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputOption {
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputAction {
    pub control: InputControl,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<InputOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_selections: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NavigateRelation {
    Expand,
    Reference,
}

impl NavigateRelation {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Expand => "expand",
            Self::Reference => "reference",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, GraphError> {
        match value {
            "expand" => Ok(Self::Expand),
            "reference" => Ok(Self::Reference),
            other => Err(GraphError::Internal(format!(
                "unknown navigate relation {other}"
            ))),
        }
    }
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
            Self::Input => "input",
            Self::InteractionContext => "interaction.context",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, GraphError> {
        match value {
            "navigate" => Ok(Self::Navigate),
            "invoke" => Ok(Self::Invoke),
            "input" => Ok(Self::Input),
            "interaction.context" => Ok(Self::InteractionContext),
            other => Err(GraphError::Internal(format!("unknown action kind {other}"))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphAction {
    pub id: ActionId,
    pub source_node_id: NodeId,
    pub source_layer_id: Option<LayerId>,
    pub kind: ActionKind,
    pub relation: Option<NavigateRelation>,
    pub label: String,
    pub variant: ActionVariant,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub target_layer_id: Option<LayerId>,
    pub interaction_text: Option<String>,
    #[serde(flatten)]
    pub input: Option<InputAction>,
    pub state: RecordState,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionDraft {
    pub client_key: String,
    pub source_node_id: NodeId,
    #[serde(default)]
    pub source_layer_id: Option<LayerId>,
    pub kind: ActionKind,
    #[serde(default)]
    pub relation: Option<NavigateRelation>,
    pub label: String,
    #[serde(default)]
    pub variant: ActionVariant,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub target_layer_id: Option<LayerId>,
    pub interaction_text: Option<String>,
    #[serde(default, flatten)]
    pub input: Option<InputAction>,
}

impl ActionDraft {
    pub(crate) fn validate_shape(&self) -> Result<Option<&'static str>, GraphError> {
        super::require_nonempty(&self.client_key, "clientKey")?;
        if self.client_key.contains('\0') {
            return Err(GraphError::validation(
                "reserved_action_client_key",
                "clientKey",
                "Action client keys cannot contain NUL characters, which are reserved for graph-control identities.",
            ));
        }
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
        let mut issues = Vec::new();
        if self.kind != ActionKind::Input && self.input.is_some() {
            issues.push(ValidationIssue::new(
                "input_action_payload_unexpected",
                "control",
                "Remove input control fields from a non-input action.",
            ));
        }
        match self.kind {
            ActionKind::Navigate => {
                if self.target_layer_id.is_none() {
                    issues.push(ValidationIssue::new(
                        "missing_target_layer",
                        "targetLayerId",
                        "A navigate action needs a target layer. Submit or select the layer, then retry with its target.",
                    ));
                }
                if self.interaction_text.is_some() {
                    issues.push(ValidationIssue::new(
                        "unexpected_interaction_text",
                        "interactionText",
                        "A navigate action opens a layer and cannot also start an interaction.",
                    ));
                }
                if self.relation.is_none() {
                    issues.push(ValidationIssue::new(
                        "missing_navigate_relation",
                        "relation",
                        "Choose relation=expand for deeper explanation or relation=reference for supporting evidence or context.",
                    ));
                }
            }
            ActionKind::Invoke => {
                if self
                    .interaction_text
                    .as_deref()
                    .is_none_or(|text| text.trim().is_empty())
                {
                    issues.push(ValidationIssue::new(
                        "missing_interaction_text",
                        "interactionText",
                        "An invoke action needs the user interaction text it will start.",
                    ));
                }
                if self.target_layer_id.is_some() {
                    issues.push(ValidationIssue::new(
                        "unexpected_target_layer",
                        "targetLayerId",
                        "An invoke action starts an interaction and does not point to a layer.",
                    ));
                }
                if self.relation.is_some() {
                    issues.push(ValidationIssue::new(
                        "unexpected_navigate_relation",
                        "relation",
                        "An invoke action starts an interaction and cannot have an expand or reference relation.",
                    ));
                }
            }
            ActionKind::Input => {
                if self.target_layer_id.is_some() {
                    issues.push(ValidationIssue::new(
                        "input_action_payload_unexpected",
                        "targetLayerId",
                        "Remove targetLayerId from an input action.",
                    ));
                }
                if self.relation.is_some() {
                    issues.push(ValidationIssue::new(
                        "input_action_payload_unexpected",
                        "relation",
                        "Remove relation from an input action.",
                    ));
                }
                if self.interaction_text.is_some() {
                    issues.push(ValidationIssue::new(
                        "input_action_payload_unexpected",
                        "interactionText",
                        "Remove interactionText from an input action.",
                    ));
                }
                let Some(input) = self.input.as_ref() else {
                    issues.push(ValidationIssue::new(
                        "input_action_control_unsupported",
                        "control",
                        "Use text, single_select, or multi_select.",
                    ));
                    if !issues.is_empty() {
                        return Err(GraphError::validation_issues(issues));
                    }
                    unreachable!();
                };
                validate_input_action(input, &mut issues);
            }
            ActionKind::InteractionContext => {
                return Err(GraphError::validation(
                    "control_only_action",
                    "kind",
                    "interaction.context actions are immutable input records created only by graph control.",
                ));
            }
        }
        if !issues.is_empty() {
            return Err(GraphError::validation_issues(issues));
        }
        Ok(canonical_icon)
    }
}

fn validate_input_action(input: &InputAction, issues: &mut Vec<ValidationIssue>) {
    if input.prompt.trim().is_empty() {
        issues.push(ValidationIssue::new(
            "input_action_prompt_required",
            "prompt",
            "Supply a non-whitespace prompt.",
        ));
    } else if input.prompt.len() > 2_000 {
        issues.push(ValidationIssue::new(
            "input_action_prompt_too_long",
            "prompt",
            "Shorten the UTF-8 prompt to 2,000 bytes.",
        ));
    }
    match input.control {
        InputControl::Text => {
            if !input.options.is_empty() {
                issues.push(ValidationIssue::new(
                    "input_action_options_unexpected",
                    "options",
                    "Remove options from a text action.",
                ));
            }
            if input.minimum_selections.is_some() {
                issues.push(ValidationIssue::new(
                    "input_action_minimum_unexpected",
                    "minimumSelections",
                    "Remove it unless the control is multi-select.",
                ));
            }
        }
        InputControl::SingleSelect | InputControl::MultiSelect => {
            if input.options.is_empty() {
                issues.push(ValidationIssue::new(
                    "input_action_options_required",
                    "options",
                    "Supply 1 through 50 options for a select.",
                ));
            } else if input.options.len() > 50 {
                issues.push(ValidationIssue::new(
                    "input_action_option_count",
                    "options",
                    "Keep the option count in 1..=50.",
                ));
            }
            let mut keys = std::collections::HashSet::new();
            for (index, option) in input.options.iter().enumerate() {
                if option.key.is_empty()
                    || option.key.trim() != option.key
                    || option.key.contains('\0')
                    || option.key.len() > 128
                {
                    issues.push(ValidationIssue::new(
                        "input_action_option_key_invalid",
                        format!("options[{index}].key"),
                        "Use a nonempty, trimmed, NUL-free key of at most 128 bytes.",
                    ));
                } else if !keys.insert(option.key.as_str()) {
                    issues.push(ValidationIssue::new(
                        "input_action_option_key_duplicate",
                        format!("options[{index}].key"),
                        "Give every option an exact unique key.",
                    ));
                }
                if option.label.trim().is_empty() {
                    issues.push(ValidationIssue::new(
                        "input_action_option_label_required",
                        format!("options[{index}].label"),
                        "Supply a non-whitespace label.",
                    ));
                } else if option.label.len() > 512 {
                    issues.push(ValidationIssue::new(
                        "input_action_option_label_too_long",
                        format!("options[{index}].label"),
                        "Shorten the UTF-8 label to 512 bytes.",
                    ));
                }
            }
            match (input.control, input.minimum_selections) {
                (InputControl::SingleSelect, Some(_)) => issues.push(ValidationIssue::new(
                    "input_action_minimum_unexpected",
                    "minimumSelections",
                    "Remove it unless the control is multi-select.",
                )),
                (InputControl::MultiSelect, Some(minimum))
                    if minimum == 0 || minimum > input.options.len() =>
                {
                    issues.push(ValidationIssue::new(
                        "input_action_minimum_invalid",
                        "minimumSelections",
                        "Use an integer in 1..=options.length.",
                    ));
                }
                _ => {}
            }
        }
    }
}
