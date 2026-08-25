use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
