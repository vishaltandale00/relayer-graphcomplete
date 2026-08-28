mod action;
mod context;
mod current;
mod edge;
mod icon;
mod ids;
mod layer;
mod node;
mod record_state;

pub use action::{ActionDraft, ActionKind, ActionVariant, GraphAction, NavigateRelation};
pub use context::{
    InteractionContext, InteractionContextAction, InteractionContextDraft,
    InteractionContextTarget, InteractionInput, InteractionInputNode, interaction_input_digest,
};
pub use current::{
    CompletionLifecycle, CompletionState, CurrentProjectionEvent, CurrentProjectionPage,
    CurrentTransition, CurrentTransitionReceipt, TemporalFeatureConfig,
};
pub use edge::{EdgeDraft, GraphEdge};
pub use icon::{
    RELAYER_ICON_ALIASES, RELAYER_ICON_NAMES, is_supported_icon, normalize_icon_name,
    resolve_icon_name,
};
pub use ids::{ActionId, EdgeId, LayerId, NodeId, ProjectId, ThreadId};
pub(crate) use layer::validate_authored_layout;
pub use layer::{GraphLayer, LayerDraft, LayerLayout, NodePlacement, ResolvedLayer};
pub use node::{GraphNode, InteractionInvocation, NodeDraft};
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
