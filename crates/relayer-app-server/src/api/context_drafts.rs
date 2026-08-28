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
    confirmations: Vec<NodeContextDraftConfirmationResponse>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdateNodeContextConfirmationRequest {
    annotation: String,
    expected_revision: i64,
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
    confirmation_revision: i64,
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
            confirmation_revision: confirmation.confirmation_revision,
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
    let (drafts, confirmations) = state
        .product
        .node_context_draft_state(ThreadId::try_from(thread_id)?)
        .await?;
    Ok(Json(NodeContextDraftsResponse {
        drafts: drafts.into_iter().map(Into::into).collect(),
        confirmations: confirmations.into_iter().map(Into::into).collect(),
    }))
}

pub(super) async fn update_confirmation(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, draft_id)): Path<(i64, String)>,
    Json(request): Json<UpdateNodeContextConfirmationRequest>,
) -> Result<Json<NodeContextDraftConfirmationResponse>, ApiError> {
    authorize_write(&state, &headers)?;
    let confirmation = state
        .product
        .update_pending_node_context_confirmation(
            ThreadId::try_from(thread_id)?,
            &draft_id,
            request.expected_revision,
            &request.annotation,
        )
        .await?;
    Ok(Json(confirmation.into()))
}

pub(super) async fn dismiss_confirmation(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, draft_id)): Path<(i64, String)>,
    Query(query): Query<ResolveNodeContextDraftQuery>,
) -> Result<StatusCode, ApiError> {
    authorize_write(&state, &headers)?;
    let dismissed = state
        .product
        .dismiss_pending_node_context_confirmation(
            ThreadId::try_from(thread_id)?,
            &draft_id,
            query.expected_revision,
        )
        .await?;
    if !dismissed {
        return Err(ApiError::not_found("pending node-context confirmation"));
    }
    Ok(StatusCode::NO_CONTENT)
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
    let confirmation = state
        .context_draft_confirmation
        .confirm(thread_id, &draft_id, query.expected_revision)
        .await?;
    Ok(Json(confirmation.into()))
}
