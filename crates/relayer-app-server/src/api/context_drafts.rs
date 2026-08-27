use super::{ApiState, auth::authorize_write, error::ApiError};
use crate::product::{
    InteractionContextTarget, NodeContextDraft, NodeContextDraftConfirmation, ThreadId,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SaveNodeContextDraftRequest {
    target: InteractionContextTarget,
    target_node: relayer_graph_core::InteractionInputNode,
    text: String,
    expected_revision: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResolveNodeContextDraftQuery {
    expected_revision: i64,
}

#[derive(Serialize)]
pub(super) struct NodeContextDraftsResponse {
    drafts: Vec<NodeContextDraftResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NodeContextDraftResponse {
    id: String,
    thread_id: i64,
    target: InteractionContextTarget,
    target_node: relayer_graph_core::InteractionInputNode,
    text: String,
    revision: i64,
    created_at: String,
    updated_at: String,
}

impl From<NodeContextDraft> for NodeContextDraftResponse {
    fn from(draft: NodeContextDraft) -> Self {
        Self {
            id: draft.id,
            thread_id: draft.thread_id.value(),
            target: draft.target,
            target_node: draft.target_node,
            text: draft.text,
            revision: draft.revision,
            created_at: draft.created_at,
            updated_at: draft.updated_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NodeContextDraftConfirmationResponse {
    draft_id: String,
    thread_id: i64,
    target: InteractionContextTarget,
    target_node: relayer_graph_core::InteractionInputNode,
    annotation: String,
    draft_revision: i64,
    confirmed_at: String,
}

impl From<NodeContextDraftConfirmation> for NodeContextDraftConfirmationResponse {
    fn from(confirmation: NodeContextDraftConfirmation) -> Self {
        Self {
            draft_id: confirmation.draft_id,
            thread_id: confirmation.thread_id.value(),
            target: confirmation.target,
            target_node: confirmation.target_node,
            annotation: confirmation.annotation,
            draft_revision: confirmation.draft_revision,
            confirmed_at: confirmation.confirmed_at,
        }
    }
}

pub(super) async fn list(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(thread_id): Path<i64>,
) -> Result<Json<NodeContextDraftsResponse>, ApiError> {
    authorize_write(&state, &headers)?;
    let drafts = state
        .product
        .node_context_drafts(ThreadId::try_from(thread_id)?)
        .await?;
    Ok(Json(NodeContextDraftsResponse {
        drafts: drafts.into_iter().map(Into::into).collect(),
    }))
}

pub(super) async fn save(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, draft_id)): Path<(i64, String)>,
    Json(request): Json<SaveNodeContextDraftRequest>,
) -> Result<Json<NodeContextDraftResponse>, ApiError> {
    authorize_write(&state, &headers)?;
    let draft = state
        .product
        .save_node_context_draft(
            ThreadId::try_from(thread_id)?,
            &draft_id,
            &request.target,
            &request.target_node,
            &request.text,
            request.expected_revision,
        )
        .await?;
    Ok(Json(draft.into()))
}

pub(super) async fn discard(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, draft_id)): Path<(i64, String)>,
    Query(query): Query<ResolveNodeContextDraftQuery>,
) -> Result<StatusCode, ApiError> {
    authorize_write(&state, &headers)?;
    let discarded = state
        .product
        .discard_node_context_draft(
            ThreadId::try_from(thread_id)?,
            &draft_id,
            query.expected_revision,
        )
        .await?;
    if !discarded {
        return Err(ApiError::not_found("node-context draft"));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn confirm(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, draft_id)): Path<(i64, String)>,
    Query(query): Query<ResolveNodeContextDraftQuery>,
) -> Result<Json<NodeContextDraftConfirmationResponse>, ApiError> {
    authorize_write(&state, &headers)?;
    let thread_id = ThreadId::try_from(thread_id)?;
    if let Some(confirmation) = state
        .product
        .node_context_draft_confirmation(thread_id, &draft_id, query.expected_revision)
        .await?
    {
        return Ok(Json(confirmation.into()));
    }
    let draft = state
        .product
        .node_context_draft(thread_id, &draft_id)
        .await?;
    if draft.text.trim().is_empty() {
        return Err(ApiError::invalid(
            "An annotation is required before this draft can be confirmed.",
        ));
    }
    let source = state
        .product
        .get_interaction_by_graph_node_id(draft.target.source_interaction_node_id)
        .await
        .map_err(|_| unavailable_target())?;
    if source.thread_id != thread_id || source.completion_status != "accepted" {
        return Err(unavailable_target());
    }
    let runtime = state.runtime.as_ref().ok_or_else(unavailable_target)?;
    let layer: relayer_graph_core::ResolvedLayer = runtime
        .get_layer(
            draft.target.source_interaction_node_id,
            draft.target.source_layer_id,
        )
        .await
        .map_err(|_| unavailable_target())
        .and_then(|value| serde_json::from_value(value).map_err(|_| unavailable_target()))?;
    let current_target = layer
        .nodes
        .into_iter()
        .find(|node| {
            node.id.value() == draft.target.node_id
                && node.state == relayer_graph_core::RecordState::Accepted
        })
        .map(relayer_graph_core::InteractionInputNode::from);
    if layer.layer.id.value() != draft.target.source_layer_id
        || layer.layer.state != relayer_graph_core::RecordState::Accepted
        || current_target.as_ref() != Some(&draft.target_node)
    {
        return Err(unavailable_target());
    }
    let confirmation = state
        .product
        .confirm_node_context_draft(thread_id, &draft_id, query.expected_revision)
        .await?;
    Ok(Json(confirmation.into()))
}

fn unavailable_target() -> ApiError {
    ApiError::conflict(
        "context_draft_target_unavailable",
        "The saved node occurrence is no longer available. The draft was preserved.",
    )
}
