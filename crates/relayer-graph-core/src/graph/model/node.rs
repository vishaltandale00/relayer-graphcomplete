use serde::{Deserialize, Serialize};

use crate::{GraphError, NodeId, RecordState};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: NodeId,
    pub kind: String,
    pub icon: String,
    pub title: String,
    pub detail: String,
    pub state: RecordState,
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
    pub(crate) fn validate(&self) -> Result<(), GraphError> {
        super::require_nonempty(&self.client_key, "clientKey")?;
        super::require_nonempty(&self.kind, "kind")?;
        super::require_nonempty(&self.icon, "icon")?;
        super::require_nonempty(&self.title, "title")?;
        super::require_nonempty(&self.detail, "detail")
    }
}

fn default_kind() -> String {
    "concept".into()
}
