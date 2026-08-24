use serde::{Deserialize, Serialize};

use crate::{ActionId, GraphError, NodeId, RecordState};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: NodeId,
    #[serde(default)]
    pub leased_action_id: Option<ActionId>,
    pub kind: String,
    pub icon: String,
    pub title: String,
    pub detail: String,
    pub state: RecordState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionInvocation {
    pub source_interaction_node_id: NodeId,
    pub source_action_id: ActionId,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDraft {
    pub client_key: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub icon: String,
    pub title: String,
    pub detail: String,
}

impl NodeDraft {
    pub(crate) fn validate(&self) -> Result<&'static str, GraphError> {
        super::require_nonempty(&self.client_key, "clientKey")?;
        super::require_nonempty(&self.kind, "kind")?;
        super::require_nonempty(&self.icon, "icon")?;
        super::require_nonempty(&self.title, "title")?;
        super::require_nonempty(&self.detail, "detail")?;
        super::resolve_icon_name(&self.icon)
            .ok_or_else(|| {
                GraphError::validation(
                    "unsupported_icon",
                    "icon",
                    format!(
                        "Unsupported icon {:?}. Choose a name from the curated Relayer icon vocabulary: {}.",
                        self.icon,
                        super::RELAYER_ICON_NAMES.join(", ")
                    ),
                )
            })
    }
}

fn default_kind() -> String {
    "concept".into()
}

#[cfg(test)]
mod tests {
    use super::GraphNode;

    #[test]
    fn legacy_node_payloads_default_missing_lease_identity() {
        let node: GraphNode = serde_json::from_str(
            r#"{
                "id": 1,
                "kind": "concept",
                "icon": "box",
                "title": "Legacy node",
                "detail": "Created before interaction leases",
                "state": "accepted"
            }"#,
        )
        .unwrap();

        assert_eq!(node.leased_action_id, None);
    }
}
