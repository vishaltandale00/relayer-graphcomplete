mod attached_navigation;
mod completion;
mod database;
mod import;
mod interaction_scope;
mod invocation;
pub(crate) mod model;
mod personal_presentation;
mod search_index;
mod writer;

#[cfg(feature = "crash-test-support")]
pub use completion::CompletionCrashPoint;
pub use completion::{
    AcceptedGraphClosure, AcceptedGraphPublication, CompletionOutput, ConversationGraphSnapshot,
    InvocationGraphSnapshot, current_transition_request_digest,
};
pub use database::{DEFAULT_IMPORT_INDEX_BUDGET, DEFAULT_SEARCH_INDEX_BUDGET, GraphDatabase};
pub use import::{
    IMPORTED_AUTHORED_DETAIL_OMITTED_NOTE, ImportedAcceptedView, ImportedAction,
    ImportedConversation, ImportedConversationReceipt, ImportedConversationStage,
    ImportedDetailAsset, ImportedEdge, ImportedEdgeEnd, ImportedEdgeRoute, ImportedInputSource,
    ImportedInteractionContext, ImportedInvokeOrigin, ImportedLayer, ImportedLayerLayout,
    ImportedNode, ImportedNodePlacement, ImportedResolvedLayer, ImportedSubmittedInput,
    ImportedTurn, ImportedTurnReceipt, ImportedVisualAssetContent, SkippedSubmittedInput,
};
pub use invocation::GraphInvocation;
pub use model::{
    AcceptedDetailAsset, AcceptedDetailAssetMetadata, ActionDraft, ActionId, ActionKind,
    ActionVariant, AuthoredDetailUpdate, CompletionContract, CompletionContractAnswer,
    CompletionContractContext, CompletionContractInput, CompletionInvocationReference,
    CompletionLifecycle, CompletionReturnRequirement, CompletionState, CurrentProjectionEvent,
    CurrentProjectionPage, CurrentTransition, CurrentTransitionReceipt, EDGE_SHAPES, EdgeDraft,
    EdgeEnd, EdgeId, EdgeRoute, GraphAction, GraphEdge, GraphLayer, GraphNode, InputAction,
    InputControl, InputOption, InteractionContext, InteractionContextAction,
    InteractionContextDraft, InteractionContextTarget, InteractionInput, InteractionInputChild,
    InteractionInputChildId, InteractionInputNode, InteractionInputPreparation,
    InteractionInvocation, InteractionPermission, InteractionPermissions, LayerDraft, LayerId,
    LayerLayout, LayoutPoint, MAX_EDGE_ROUTE_WAYPOINTS, NODE_SIDES, NavigateRelation, NodeDraft,
    NodeId, NodePlacement, PERSONAL_PRESENTATION_PROFILE_THREAD_ID, PreparedDetailAsset,
    PresentingInputOccurrence, ProjectId, RELAYER_ICON_ALIASES, RELAYER_ICON_CATALOG_JSON,
    RELAYER_ICON_NAMES, RecordState, ResolvedLayer, SubmittedInput, SubmittedInputDraft,
    SubmittedInputValue, TemporalFeatureConfig, ThreadId, interaction_input_authority_digest,
    interaction_input_digest, interaction_input_semantic_digest, is_supported_icon,
    map_authored_detail_actions, normalize_icon_name, resolve_icon_name,
};
pub use personal_presentation::{
    PersonalPresentationAttachment, PublishedPersonalPresentationVersion,
    ResolvedPersonalPresentation,
};
pub use search_index::{
    NoSearchIndex, SearchIndex, SearchIndexComponent, SearchIndexFuture, SearchIndexRebuildClosure,
    SearchIndexRebuildSnapshot, SearchIndexRevision, SearchIndexWrite, SearchTarget,
    publication_targets,
};
pub use writer::GraphWriter;

pub(crate) use interaction_scope::InteractionScope;
pub(crate) use model::{
    canonical_submitted_input_bytes, validate_authored_layout, validate_edge_route_ends,
};

pub use model::artifact;
pub use model::image_icon::{ImageIcon, image_icon};
pub use model::image_icon::{optional_wire as optional_icon_serde, wire as icon_serde};
