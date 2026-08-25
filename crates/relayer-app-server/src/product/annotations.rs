use super::InteractionId;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const MAX_ANNOTATION_COMMENT_BYTES: usize = 16 * 1024;
pub(crate) const MAX_NAVIGATION_CONTEXT_BYTES: usize = 64 * 1024;
pub(crate) const MAX_EVIDENCE_REFS: usize = 20;
pub(crate) const MAX_EVIDENCE_REF_BYTES: usize = 512;
pub(crate) const MAX_ANNOTATION_SNAPSHOT_THREADS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AnnotationAnchor {
    Thread,
    Turn {
        interaction_id: i64,
    },
    Layer {
        interaction_id: i64,
        layer_id: i64,
    },
    Node {
        interaction_id: i64,
        layer_id: i64,
        node_id: i64,
    },
    Edge {
        interaction_id: i64,
        layer_id: i64,
        edge_id: i64,
    },
    Action {
        interaction_id: i64,
        presentation_layer_id: i64,
        source_layer_id: i64,
        node_id: i64,
        action_id: i64,
    },
}

impl AnnotationAnchor {
    pub(crate) fn interaction_id(&self) -> Option<Result<InteractionId, super::InvalidProductId>> {
        match self {
            Self::Thread => None,
            Self::Turn { interaction_id }
            | Self::Layer { interaction_id, .. }
            | Self::Node { interaction_id, .. }
            | Self::Edge { interaction_id, .. }
            | Self::Action { interaction_id, .. } => Some(InteractionId::try_from(*interaction_id)),
        }
    }

    pub(crate) fn validate_ids(&self) -> Result<(), String> {
        let positive = |value: i64, label: &str| {
            (value > 0)
                .then_some(())
                .ok_or_else(|| format!("{label} must be a positive integer"))
        };
        match self {
            Self::Thread => Ok(()),
            Self::Turn { interaction_id } => positive(*interaction_id, "interaction id"),
            Self::Layer {
                interaction_id,
                layer_id,
            } => {
                positive(*interaction_id, "interaction id")?;
                positive(*layer_id, "layer id")
            }
            Self::Node {
                interaction_id,
                layer_id,
                node_id,
            } => {
                positive(*interaction_id, "interaction id")?;
                positive(*layer_id, "layer id")?;
                positive(*node_id, "node id")
            }
            Self::Edge {
                interaction_id,
                layer_id,
                edge_id,
            } => {
                positive(*interaction_id, "interaction id")?;
                positive(*layer_id, "layer id")?;
                positive(*edge_id, "edge id")
            }
            Self::Action {
                interaction_id,
                presentation_layer_id,
                source_layer_id,
                node_id,
                action_id,
            } => {
                positive(*interaction_id, "interaction id")?;
                positive(*presentation_layer_id, "presentation layer id")?;
                positive(*source_layer_id, "source layer id")?;
                positive(*node_id, "node id")?;
                positive(*action_id, "action id")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Annotation {
    pub(crate) id: i64,
    pub(crate) thread_id: i64,
    pub(crate) anchor: AnnotationAnchor,
    pub(crate) created_at: String,
    pub(crate) latest_revision: i64,
    pub(crate) revisions: Vec<AnnotationRevision>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationRevision {
    pub(crate) revision: i64,
    pub(crate) author_id: String,
    pub(crate) author_display_name: String,
    pub(crate) comment: String,
    pub(crate) rating: Option<u8>,
    pub(crate) state: AnnotationState,
    pub(crate) navigation_context: Value,
    pub(crate) evidence_refs: Vec<String>,
    pub(crate) created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnnotationState {
    Active,
    Retracted,
}

impl AnnotationState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Retracted => "retracted",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "active" => Ok(Self::Active),
            "retracted" => Ok(Self::Retracted),
            _ => Err(format!("unsupported annotation state {value}")),
        }
    }
}

pub(crate) struct NewAnnotationRevision<'a> {
    pub(crate) author_id: &'a str,
    pub(crate) author_display_name: &'a str,
    pub(crate) comment: &'a str,
    pub(crate) rating: Option<u8>,
    pub(crate) state: AnnotationState,
    pub(crate) navigation_context: &'a Value,
    pub(crate) evidence_refs: &'a [String],
    pub(crate) created_at: &'a str,
}

pub(crate) fn validate_revision_content(
    comment: &str,
    rating: Option<u8>,
    state: AnnotationState,
    navigation_context: &Value,
    evidence_refs: &[String],
) -> Result<String, String> {
    let comment = comment.trim();
    if state == AnnotationState::Active && comment.is_empty() {
        return Err("comment must contain non-whitespace text".into());
    }
    if comment.len() > MAX_ANNOTATION_COMMENT_BYTES {
        return Err(format!(
            "comment exceeds {MAX_ANNOTATION_COMMENT_BYTES} bytes"
        ));
    }
    if rating.is_some_and(|rating| !(1..=4).contains(&rating)) {
        return Err("rating must be 1, 2, 3, 4, or null".into());
    }
    let navigation_bytes = serde_json::to_vec(navigation_context)
        .map_err(|error| format!("navigation context is invalid: {error}"))?;
    if navigation_bytes.len() > MAX_NAVIGATION_CONTEXT_BYTES {
        return Err(format!(
            "navigation context exceeds {MAX_NAVIGATION_CONTEXT_BYTES} bytes"
        ));
    }
    if evidence_refs.len() > MAX_EVIDENCE_REFS {
        return Err(format!(
            "no more than {MAX_EVIDENCE_REFS} evidence references are allowed"
        ));
    }
    if evidence_refs
        .iter()
        .any(|reference| reference.is_empty() || reference.len() > MAX_EVIDENCE_REF_BYTES)
    {
        return Err(format!(
            "evidence references must contain 1 to {MAX_EVIDENCE_REF_BYTES} bytes"
        ));
    }
    Ok(comment.to_owned())
}
