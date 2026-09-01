use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{ActionId, GraphNode, LayerId, NodeId, RecordState, SubmittedInput};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionContextTarget {
    pub node_id: NodeId,
    pub source_interaction_node_id: NodeId,
    pub source_layer_id: LayerId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionContextDraft {
    pub target: InteractionContextTarget,
    #[serde(default)]
    pub annotations: Vec<String>,
}

pub fn interaction_input_digest(
    text: &str,
    contexts: &[InteractionContextDraft],
) -> Result<String, serde_json::Error> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DigestInput<'a> {
        schema_version: u32,
        text: &'a str,
        contexts: &'a [InteractionContextDraft],
    }
    let bytes = serde_json::to_vec(&DigestInput {
        schema_version: 1,
        text,
        contexts,
    })?;
    Ok(format!("sha256:v1:{:x}", Sha256::digest(bytes)))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionContextAction {
    pub id: ActionId,
    #[serde(rename = "type")]
    pub type_id: String,
    pub source_node_id: NodeId,
    pub target: InteractionContextTarget,
    pub annotations: Vec<String>,
    pub state: RecordState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionInput {
    pub interaction: InteractionInputNode,
    pub contexts: Vec<InteractionContext>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub submitted_inputs: Vec<SubmittedInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionInputNode {
    pub id: NodeId,
    pub kind: String,
    pub icon: String,
    pub title: String,
    pub detail: String,
    pub state: RecordState,
}

impl From<GraphNode> for InteractionInputNode {
    fn from(node: GraphNode) -> Self {
        Self {
            id: node.id,
            kind: node.kind,
            icon: node.icon,
            title: node.title,
            detail: node.detail,
            state: node.state,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionContext {
    #[serde(rename = "type")]
    pub type_id: String,
    pub target_node: InteractionInputNode,
    pub annotations: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::InteractionInputNode;
    use crate::{ActionId, GraphNode, NodeId, RecordState};

    #[test]
    fn normalized_input_nodes_omit_invoke_lease_authority() {
        let normalized = InteractionInputNode::from(GraphNode {
            id: NodeId::new(1).unwrap(),
            leased_action_id: Some(ActionId::new(2).unwrap()),
            kind: "user-interaction".into(),
            icon: "user".into(),
            title: "Question".into(),
            detail: "Compare these".into(),
            authored_detail: None,
            state: RecordState::Accepted,
        });

        let value = serde_json::to_value(normalized).unwrap();
        assert!(value.get("leasedActionId").is_none());
        assert_eq!(value["detail"], "Compare these");
    }
}
