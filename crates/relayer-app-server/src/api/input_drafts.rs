use super::{ApiState, auth::authorize_write, error::ApiError};
use crate::product::{ActionInputDraft, ActionInputValue, ThreadId};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CommitActionInputRequest {
    occurrence: relayer_graph_core::PresentingInputOccurrence,
    value: ActionInputValue,
    expected_revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DetachActionInputQuery {
    expected_revision: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActionInputDraftResponse {
    thread_id: i64,
    revision: i64,
    attachments: Vec<ActionInputAttachmentResponse>,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionInputAttachmentResponse {
    occurrence: relayer_graph_core::PresentingInputOccurrence,
    source_node_id: i64,
    action: relayer_graph_core::InputAction,
    value: ActionInputValue,
    draft_revision: i64,
    committed_at: String,
}

impl From<ActionInputDraft> for ActionInputDraftResponse {
    fn from(draft: ActionInputDraft) -> Self {
        Self {
            thread_id: draft.thread_id.value(),
            revision: draft.revision,
            attachments: draft
                .attachments
                .into_iter()
                .map(|attachment| ActionInputAttachmentResponse {
                    occurrence: attachment.occurrence,
                    source_node_id: attachment.source_node_id,
                    action: attachment.action,
                    value: attachment.value,
                    draft_revision: attachment.draft_revision,
                    committed_at: attachment.committed_at,
                })
                .collect(),
            updated_at: draft.updated_at,
        }
    }
}

pub(super) async fn get(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(thread_id): Path<i64>,
) -> Result<Json<ActionInputDraftResponse>, ApiError> {
    authorize_write(&state, &headers)?;
    Ok(Json(
        state
            .product
            .action_input_draft(ThreadId::try_from(thread_id)?)
            .await?
            .into(),
    ))
}

pub(super) async fn commit(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(thread_id): Path<i64>,
    Json(request): Json<CommitActionInputRequest>,
) -> Result<Json<ActionInputDraftResponse>, ApiError> {
    authorize_write(&state, &headers)?;
    let runtime = state.runtime.as_ref().ok_or_else(|| {
        ApiError::internal("graph runtime is unavailable for input occurrence validation")
    })?;
    let action = runtime
        .canonical_input_action_occurrence(&request.occurrence)
        .await?;
    Ok(Json(
        state
            .product
            .commit_action_input_attachment(
                ThreadId::try_from(thread_id)?,
                &request.occurrence,
                &action,
                &request.value,
                request.expected_revision,
            )
            .await?
            .into(),
    ))
}

pub(super) async fn detach(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, presenting_interaction_node_id, presenting_layer_id, action_id)): Path<(
        i64,
        i64,
        i64,
        i64,
    )>,
    Query(query): Query<DetachActionInputQuery>,
) -> Result<Json<ActionInputDraftResponse>, ApiError> {
    authorize_write(&state, &headers)?;
    let occurrence = relayer_graph_core::PresentingInputOccurrence {
        presenting_interaction_node_id: relayer_graph_core::NodeId::new(
            presenting_interaction_node_id,
        )
        .ok_or_else(|| ApiError::invalid("presentingInteractionNodeId must be positive"))?,
        presenting_layer_id: relayer_graph_core::LayerId::new(presenting_layer_id)
            .ok_or_else(|| ApiError::invalid("presentingLayerId must be positive"))?,
        action_id: relayer_graph_core::ActionId::new(action_id)
            .ok_or_else(|| ApiError::invalid("actionId must be positive"))?,
    };
    Ok(Json(
        state
            .product
            .detach_action_input_attachment(
                ThreadId::try_from(thread_id)?,
                &occurrence,
                query.expected_revision,
            )
            .await?
            .into(),
    ))
}
