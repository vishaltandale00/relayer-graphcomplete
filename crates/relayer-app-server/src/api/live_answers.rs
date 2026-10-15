use super::{
    ApiState,
    auth::{authorize_read, authorize_write},
    error::ApiError,
};
use crate::product::{Interaction, InteractionId, ThreadId};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use relayer_graph_core::LiveAnswerRequest;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Cursor {
    #[serde(default)]
    after_sequence: u64,
}

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
    Query(cursor): Query<Cursor>,
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
    let after = i64::try_from(cursor.after_sequence)
        .map_err(|_| ApiError::invalid("Invalid live-answer cursor."))?;
    let mut graph_page = runtime.live_answers_after(node, after).await?;
    let bound_attempt = active_attempt(&state, &interaction, graph_page.authority_epoch).await?;
    if bound_attempt.is_none() {
        graph_page.eligible_action_ids.clear();
    }
    let mut page = serde_json::to_value(graph_page)
        .map_err(|_| ApiError::internal("Invalid live-answer page."))?;
    page["attemptId"] = json!(bound_attempt);
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
    let node = interaction
        .graph_node_id
        .ok_or_else(|| ApiError::invalid("Completion has no graph."))?;
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::internal("Graph runtime is unavailable."))?;
    if active_attempt(&state, &interaction, answer.authority_epoch).await?
        != Some(answer.attempt_id)
    {
        // A historical exact-key retry can recover an already committed receipt, but
        // never admit a new answer using an unpaired or previous native attempt.
        let mut cursor = 0;
        loop {
            let page = runtime.live_answers_after(node, cursor).await?;
            if page.answers.iter().any(|receipt| {
                receipt.operation_key == answer.operation_key
                    && receipt.attempt_id == answer.attempt_id
                    && receipt.authority_epoch == answer.authority_epoch
            }) {
                break;
            }
            if page.answers.is_empty() || page.next_sequence <= cursor {
                return Err(ApiError::conflict(
                    "stale_live_attempt",
                    "Reopen this completion before answering.",
                ));
            }
            cursor = page.next_sequence;
        }
    }
    // The graph is the sole durable receipt owner. Response loss is reconciled by
    // reading this page or retrying this exact key, never another interaction.
    Ok(Json(
        runtime.accept_live_answer(node, thread_id, &answer).await?,
    ))
}

pub(super) async fn active_attempt(
    state: &ApiState,
    interaction: &Interaction,
    epoch: u64,
) -> Result<Option<i64>, ApiError> {
    let Some(attempt) = interaction.latest_attempt.as_ref().filter(|attempt| {
        interaction.completion_status == "running" && attempt.outcome == "running"
    }) else {
        return Ok(None);
    };
    Ok((state
        .product
        .live_answer_attempt_epoch(interaction.id, attempt.id)
        .await?
        == Some(epoch))
    .then_some(attempt.id))
}
