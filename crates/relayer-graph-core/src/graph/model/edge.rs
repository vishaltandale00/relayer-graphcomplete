use serde::{Deserialize, Serialize};

use crate::{EdgeId, GraphError, NodeId, RecordState};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub id: EdgeId,
    pub endpoints: [NodeId; 2],
    pub state: RecordState,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeDraft {
    pub client_key: String,
    pub endpoints: [NodeId; 2],
}

impl EdgeDraft {
    pub(crate) fn validate(&self) -> Result<[NodeId; 2], GraphError> {
        super::require_nonempty(&self.client_key, "clientKey")?;
        if self.endpoints[0] == self.endpoints[1] {
            return Err(GraphError::validation(
                "self_edge",
                "endpoints",
                "An edge must connect two different nodes. Choose a second node.",
            ));
        }
        let mut endpoints = self.endpoints;
        endpoints.sort_unstable();
        Ok(endpoints)
    }
}
