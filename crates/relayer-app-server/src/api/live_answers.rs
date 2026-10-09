use super::{
    ApiState,
    auth::{authorize_read, authorize_write},
    error::ApiError,
};
use crate::product::{Interaction, InteractionId, ThreadId};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use relayer_graph_core::LiveAnswerRequest;
use serde_json::{Value, json};

async fn target(
    state: &ApiState,
    thread_id: i64,
    interaction_id: i64,
) -> Result<Interaction, ApiError> {
    let interaction = state
        .product
        .get_interaction(InteractionId::try_from(interaction_id)?)
        .await?;
    if interaction.thread_id != ThreadId::try_from(thread_id)? {
        return Err(ApiError::invalid(
            "Completion does not belong to this thread.",
        ));
    }
    if state.product.is_agent_invoked_child(interaction.id).await? {
        return Err(ApiError::invalid(
            "Live answers currently require a human root completion.",
        ));
    }
    Ok(interaction)
}

pub(super) async fn get(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, interaction_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    authorize_read(&state, &headers)?;
    let interaction = target(&state, thread_id, interaction_id).await?;
    let node = interaction
        .graph_node_id
        .ok_or_else(|| ApiError::invalid("Completion has no graph."))?;
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::internal("Graph runtime is unavailable."))?;
    let mut page = serde_json::to_value(runtime.live_answers(node).await?)
        .map_err(|_| ApiError::internal("Invalid live-answer page."))?;
    page["attemptId"] = json!(interaction.latest_attempt.map(|attempt| attempt.id));
    Ok(Json(page))
}

pub(super) async fn answer(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, interaction_id)): Path<(i64, i64)>,
    Json(answer): Json<LiveAnswerRequest>,
) -> Result<Json<relayer_graph_core::LiveAnswer>, ApiError> {
    authorize_write(&state, &headers)?;
    let interaction = target(&state, thread_id, interaction_id).await?;
    if interaction
        .latest_attempt
        .as_ref()
        .map(|attempt| attempt.id)
        != Some(answer.attempt_id)
    {
        return Err(ApiError::conflict(
            "stale_live_attempt",
            "Reopen this completion before answering.",
        ));
    }
    let node = interaction
        .graph_node_id
        .ok_or_else(|| ApiError::invalid("Completion has no graph."))?;
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::internal("Graph runtime is unavailable."))?;
    // The graph is the sole durable receipt owner. Response loss is reconciled by
    // reading this page or retrying this exact key, never another interaction.
    Ok(Json(
        runtime.accept_live_answer(node, thread_id, &answer).await?,
    ))
}
