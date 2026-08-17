mod action;
mod edge;
mod ids;
mod layer;
mod node;
mod record_state;

pub use action::{ActionDraft, ActionKind, GraphAction};
pub use edge::{EdgeDraft, GraphEdge};
pub use ids::{ActionId, EdgeId, LayerId, NodeId, ProjectId, ThreadId};
pub use layer::{GraphLayer, LayerDraft, ResolvedLayer};
pub use node::{GraphNode, NodeDraft};
pub use record_state::RecordState;

pub(crate) use layer::{LayerCandidate, validate_connected};

pub(crate) fn require_nonempty(value: &str, path: &str) -> Result<(), crate::GraphError> {
    if value.trim().is_empty() {
        return Err(crate::GraphError::validation(
            "required",
            path,
            format!("{path} must not be empty."),
        ));
    }
    Ok(())
}
