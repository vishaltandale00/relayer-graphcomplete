use serde::{Deserialize, Serialize};

use crate::{ActionId, GraphNode, LayerId, NodeId, RecordState};

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
    pub interaction: GraphNode,
    pub contexts: Vec<InteractionContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionContext {
    pub id: ActionId,
    #[serde(rename = "type")]
    pub type_id: String,
    pub source_node_id: NodeId,
    pub target_node: GraphNode,
    pub annotations: Vec<String>,
}
