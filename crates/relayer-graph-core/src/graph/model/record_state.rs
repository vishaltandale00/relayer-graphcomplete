use serde::{Deserialize, Serialize};

use crate::GraphError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordState {
    Draft,
    Accepted,
    Stopped,
}

impl RecordState {
    pub(crate) fn parse(value: &str) -> Result<Self, GraphError> {
        match value {
            "draft" => Ok(Self::Draft),
            "accepted" => Ok(Self::Accepted),
            "stopped" => Ok(Self::Stopped),
            other => Err(GraphError::Internal(format!(
                "unknown record state {other}"
            ))),
        }
    }
}
