mod action;
mod context;
mod current;
mod edge;
mod icon;
mod ids;
mod input;
mod layer;
mod node;
mod record_state;

pub use action::{
    ActionDraft, ActionKind, ActionVariant, GraphAction, InputAction, InputControl, InputOption,
    NavigateRelation, PresentingInputOccurrence,
};
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
pub use ids::{
    ActionId, EdgeId, InteractionInputChildId, LayerId, NodeId,
    PERSONAL_PRESENTATION_PROFILE_THREAD_ID, ProjectId, ThreadId,
};
pub(crate) use input::canonical_submitted_input_bytes;
pub use input::{
    InteractionInputChild, InteractionInputPreparation, SubmittedInput, SubmittedInputDraft,
    SubmittedInputValue, interaction_input_authority_digest, interaction_input_semantic_digest,
};
pub(crate) use layer::validate_authored_layout;
pub use layer::{GraphLayer, LayerDraft, LayerLayout, NodePlacement, ResolvedLayer};
pub(crate) use node::validate_authored_detail;
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
