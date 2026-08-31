use super::{ApiState, InputOperatorSession, error::ApiError};
use crate::product::ThreadId;
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RegisterInputOperatorSessionRequest {
    token: String,
    thread_id: i64,
    occurrences: Vec<relayer_graph_core::PresentingInputOccurrence>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RevokeInputOperatorSessionRequest {
    token: String,
}

pub(super) async fn register_session(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<RegisterInputOperatorSessionRequest>,
) -> Result<StatusCode, ApiError> {
    if !state.annotations_enabled {
        return Err(ApiError::not_found(
            "input operator sessions are unavailable",
        ));
    }
    if !state.authenticator.is_control(&headers) {
        return Err(ApiError::unauthorized());
    }
    validate_token(&request.token)?;
    let thread_id = ThreadId::try_from(request.thread_id)?;
    state.product.get_thread(thread_id).await?;
    if request.occurrences.is_empty() || request.occurrences.len() > 256 {
        return Err(ApiError::invalid(
            "input operator session must authorize 1 to 256 occurrences",
        ));
    }
    let occurrence_count = request.occurrences.len();
    let occurrences = request
        .occurrences
        .into_iter()
        .map(|occurrence| occurrence_key(&occurrence))
        .collect::<HashSet<_>>();
    if occurrences.len() != occurrence_count {
        return Err(ApiError::invalid(
            "input operator occurrence scope contains duplicates",
        ));
    }
    state
        .input_operator_sessions
        .lock()
        .expect("input operator session lock poisoned")
        .insert(
            request.token,
            InputOperatorSession {
                thread_id: request.thread_id,
                occurrences,
            },
        );
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn revoke_session(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<RevokeInputOperatorSessionRequest>,
) -> Result<StatusCode, ApiError> {
    if !state.annotations_enabled {
        return Err(ApiError::not_found(
            "input operator sessions are unavailable",
        ));
    }
    if !state.authenticator.is_control(&headers) {
        return Err(ApiError::unauthorized());
    }
    validate_token(&request.token)?;
    state
        .input_operator_sessions
        .lock()
        .expect("input operator session lock poisoned")
        .remove(&request.token);
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) fn authorize_thread(
    state: &ApiState,
    headers: &HeaderMap,
    thread_id: i64,
) -> Result<InputOperatorSession, ApiError> {
    super::auth::authorize_read(state, headers)?;
    let token = state
        .authenticator
        .input_operator_token(headers)
        .ok_or_else(ApiError::unauthorized)?;
    let sessions = state
        .input_operator_sessions
        .lock()
        .expect("input operator session lock poisoned");
    let session = sessions.get(token).ok_or_else(ApiError::unauthorized)?;
    if session.thread_id != thread_id {
        return Err(ApiError::not_found(
            "thread is outside this input operator session",
        ));
    }
    Ok(session.clone())
}

pub(crate) fn authorize_occurrence(
    state: &ApiState,
    headers: &HeaderMap,
    thread_id: i64,
    occurrence: &relayer_graph_core::PresentingInputOccurrence,
) -> Result<InputOperatorSession, ApiError> {
    let session = authorize_thread(state, headers, thread_id)?;
    if !session.occurrences.contains(&occurrence_key(occurrence)) {
        return Err(ApiError::not_found(
            "input occurrence is outside this operator session",
        ));
    }
    Ok(session)
}

pub(crate) fn occurrence_key(
    occurrence: &relayer_graph_core::PresentingInputOccurrence,
) -> (i64, i64, i64) {
    (
        occurrence.presenting_interaction_node_id.value(),
        occurrence.presenting_layer_id.value(),
        occurrence.action_id.value(),
    )
}

fn validate_token(token: &str) -> Result<(), ApiError> {
    if token.len() < 32 || token.len() > 512 {
        return Err(ApiError::invalid(
            "input operator session token must contain 32 to 512 bytes",
        ));
    }
    Ok(())
}
