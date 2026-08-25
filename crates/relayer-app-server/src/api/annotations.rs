use super::{AnnotationSession, ApiState, auth::authorize_read, error::ApiError};
use crate::product::{Annotation, AnnotationAnchor, MAX_ANNOTATION_SNAPSHOT_THREADS, ThreadId};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RegisterAnnotationSessionRequest {
    token: String,
    thread_ids: Vec<i64>,
    author_id: String,
    author_display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RevokeAnnotationSessionRequest {
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SnapshotAnnotationsRequest {
    thread_ids: Vec<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreateAnnotationRequest {
    anchor: AnnotationAnchor,
    comment: String,
    #[serde(default)]
    rating: Option<u8>,
    #[serde(default = "empty_object")]
    navigation_context: Value,
    #[serde(default)]
    evidence_refs: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReviseAnnotationRequest {
    expected_revision: i64,
    comment: String,
    #[serde(default)]
    rating: Option<u8>,
    #[serde(default = "empty_object")]
    navigation_context: Value,
    #[serde(default)]
    evidence_refs: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RetractAnnotationRequest {
    expected_revision: i64,
    #[serde(default = "empty_object")]
    navigation_context: Value,
    #[serde(default)]
    evidence_refs: Vec<String>,
}

#[derive(Serialize)]
pub(super) struct AnnotationsResponse {
    annotations: Vec<Annotation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AnnotationSnapshotResponse {
    schema_version: u32,
    kind: &'static str,
    thread_id: i64,
    exported_at: String,
    annotations_sha256: String,
    annotations: Vec<Annotation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadAnnotationSnapshot {
    thread_id: i64,
    annotations: Vec<Annotation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AnnotationSnapshotSetResponse {
    schema_version: u32,
    kind: &'static str,
    exported_at: String,
    annotations_sha256: String,
    threads: Vec<ThreadAnnotationSnapshot>,
}

pub(super) async fn register_session(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<RegisterAnnotationSessionRequest>,
) -> Result<StatusCode, ApiError> {
    if !state.annotations_enabled {
        return Err(ApiError::not_found("annotation sessions are unavailable"));
    }
    if !state.authenticator.is_control(&headers) {
        return Err(ApiError::unauthorized());
    }
    if request.token.len() < 32 || request.token.len() > 512 {
        return Err(ApiError::invalid(
            "annotation session token must contain 32 to 512 bytes",
        ));
    }
    let author_id = required_bounded(&request.author_id, "authorId", 256)?;
    let author_display_name =
        required_bounded(&request.author_display_name, "authorDisplayName", 256)?;
    if request.thread_ids.is_empty() || request.thread_ids.len() > 256 {
        return Err(ApiError::invalid(
            "annotation session must authorize 1 to 256 threads",
        ));
    }
    let mut thread_ids = HashSet::new();
    for raw_id in request.thread_ids {
        let thread_id = ThreadId::try_from(raw_id)?;
        state.product.get_thread(thread_id).await?;
        thread_ids.insert(raw_id);
    }
    let session = AnnotationSession {
        thread_ids,
        author_id,
        author_display_name,
    };
    state
        .annotation_sessions
        .lock()
        .expect("annotation session lock poisoned")
        .insert(request.token, session);
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn revoke_session(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<RevokeAnnotationSessionRequest>,
) -> Result<StatusCode, ApiError> {
    if !state.annotations_enabled {
        return Err(ApiError::not_found("annotation sessions are unavailable"));
    }
    if !state.authenticator.is_control(&headers) {
        return Err(ApiError::unauthorized());
    }
    if request.token.len() < 32 || request.token.len() > 512 {
        return Err(ApiError::invalid(
            "annotation session token must contain 32 to 512 bytes",
        ));
    }
    state
        .annotation_sessions
        .lock()
        .expect("annotation session lock poisoned")
        .remove(&request.token);
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn list(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(thread_id): Path<i64>,
) -> Result<Json<AnnotationsResponse>, ApiError> {
    let thread_id = ThreadId::try_from(thread_id)?;
    annotation_session(&state, &headers, thread_id)?;
    Ok(Json(AnnotationsResponse {
        annotations: state.product.list_annotations(thread_id).await?,
    }))
}

pub(super) async fn snapshot(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(thread_id): Path<i64>,
) -> Result<Json<AnnotationSnapshotResponse>, ApiError> {
    let thread_id = ThreadId::try_from(thread_id)?;
    annotation_session(&state, &headers, thread_id)?;
    let annotations = state.product.list_annotations(thread_id).await?;
    let material =
        serde_json::to_vec(&annotations).map_err(|error| ApiError::internal(&error.to_string()))?;
    Ok(Json(AnnotationSnapshotResponse {
        schema_version: 1,
        kind: "relayer_eval_annotation_snapshot",
        thread_id: thread_id.value(),
        exported_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is before unix epoch")
            .as_millis()
            .to_string(),
        annotations_sha256: format!("sha256:{:x}", Sha256::digest(material)),
        annotations,
    }))
}

pub(super) async fn snapshot_many(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<SnapshotAnnotationsRequest>,
) -> Result<Json<AnnotationSnapshotSetResponse>, ApiError> {
    let thread_ids = validate_snapshot_thread_ids(request.thread_ids)?;
    annotation_session_for_threads(&state, &headers, &thread_ids)?;
    let snapshots = state.product.snapshot_annotations(&thread_ids).await?;
    let threads = snapshots
        .into_iter()
        .map(|(thread_id, annotations)| ThreadAnnotationSnapshot {
            thread_id: thread_id.value(),
            annotations,
        })
        .collect::<Vec<_>>();
    let material =
        serde_json::to_vec(&threads).map_err(|error| ApiError::internal(&error.to_string()))?;
    Ok(Json(AnnotationSnapshotSetResponse {
        schema_version: 1,
        kind: "relayer_eval_annotation_snapshot_set",
        exported_at: timestamp(),
        annotations_sha256: format!("sha256:{:x}", Sha256::digest(material)),
        threads,
    }))
}

pub(super) async fn create(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(thread_id): Path<i64>,
    Json(request): Json<CreateAnnotationRequest>,
) -> Result<(StatusCode, Json<Annotation>), ApiError> {
    let thread_id = ThreadId::try_from(thread_id)?;
    let session = annotation_session(&state, &headers, thread_id)?;
    validate_anchor(&state, thread_id, &request.anchor).await?;
    let annotation = state
        .product
        .create_annotation(
            thread_id,
            request.anchor,
            &session.author_id,
            &session.author_display_name,
            &request.comment,
            request.rating,
            &request.navigation_context,
            &request.evidence_refs,
        )
        .await?;
    Ok((StatusCode::CREATED, Json(annotation)))
}

pub(super) async fn revise(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, annotation_id)): Path<(i64, i64)>,
    Json(request): Json<ReviseAnnotationRequest>,
) -> Result<Json<Annotation>, ApiError> {
    let thread_id = ThreadId::try_from(thread_id)?;
    let session = annotation_session(&state, &headers, thread_id)?;
    let annotation = state
        .product
        .revise_annotation(
            thread_id,
            annotation_id,
            request.expected_revision,
            &session.author_id,
            &session.author_display_name,
            &request.comment,
            request.rating,
            &request.navigation_context,
            &request.evidence_refs,
        )
        .await
        .map_err(map_annotation_error)?;
    Ok(Json(annotation))
}

pub(super) async fn retract(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, annotation_id)): Path<(i64, i64)>,
    Json(request): Json<RetractAnnotationRequest>,
) -> Result<Json<Annotation>, ApiError> {
    let thread_id = ThreadId::try_from(thread_id)?;
    let session = annotation_session(&state, &headers, thread_id)?;
    let annotation = state
        .product
        .retract_annotation(
            thread_id,
            annotation_id,
            request.expected_revision,
            &session.author_id,
            &session.author_display_name,
            &request.navigation_context,
            &request.evidence_refs,
        )
        .await
        .map_err(map_annotation_error)?;
    Ok(Json(annotation))
}

fn annotation_session(
    state: &ApiState,
    headers: &HeaderMap,
    thread_id: ThreadId,
) -> Result<AnnotationSession, ApiError> {
    // Annotation authority is an additive capability on a read-only product
    // session, not an alternative way to authenticate to the product server.
    authorize_read(state, headers)?;
    let token = state
        .authenticator
        .annotation_token(headers)
        .ok_or_else(ApiError::unauthorized)?;
    let sessions = state
        .annotation_sessions
        .lock()
        .expect("annotation session lock poisoned");
    let session = sessions.get(token).ok_or_else(ApiError::unauthorized)?;
    if !session.thread_ids.contains(&thread_id.value()) {
        return Err(ApiError::not_found(
            "thread is outside this annotation session",
        ));
    }
    Ok(session.clone())
}

fn annotation_session_for_threads(
    state: &ApiState,
    headers: &HeaderMap,
    thread_ids: &[ThreadId],
) -> Result<AnnotationSession, ApiError> {
    authorize_read(state, headers)?;
    let token = state
        .authenticator
        .annotation_token(headers)
        .ok_or_else(ApiError::unauthorized)?;
    let sessions = state
        .annotation_sessions
        .lock()
        .expect("annotation session lock poisoned");
    let session = sessions.get(token).ok_or_else(ApiError::unauthorized)?;
    let requested = thread_ids
        .iter()
        .map(|thread_id| thread_id.value())
        .collect::<HashSet<_>>();
    if requested != session.thread_ids {
        return Err(ApiError::not_found(
            "annotation snapshot thread IDs must exactly match this session's authorized threads",
        ));
    }
    Ok(session.clone())
}

fn validate_snapshot_thread_ids(raw_ids: Vec<i64>) -> Result<Vec<ThreadId>, ApiError> {
    if raw_ids.is_empty() || raw_ids.len() > MAX_ANNOTATION_SNAPSHOT_THREADS {
        return Err(ApiError::invalid(format!(
            "annotation snapshot must request 1 to {MAX_ANNOTATION_SNAPSHOT_THREADS} threads"
        )));
    }
    let mut seen = HashSet::with_capacity(raw_ids.len());
    raw_ids
        .into_iter()
        .map(|raw_id| {
            let thread_id = ThreadId::try_from(raw_id)?;
            if !seen.insert(raw_id) {
                return Err(ApiError::invalid(
                    "annotation snapshot thread IDs must be unique",
                ));
            }
            Ok(thread_id)
        })
        .collect()
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time is before unix epoch")
        .as_millis()
        .to_string()
}

async fn validate_anchor(
    state: &ApiState,
    thread_id: ThreadId,
    anchor: &AnnotationAnchor,
) -> Result<(), ApiError> {
    anchor.validate_ids().map_err(ApiError::invalid)?;
    let Some(interaction_id) = anchor.interaction_id() else {
        return Ok(());
    };
    let interaction_id = interaction_id?;
    let interaction = state.product.get_interaction(interaction_id).await?;
    if interaction.thread_id != thread_id {
        return Err(ApiError::invalid(
            "annotation interaction does not belong to this thread",
        ));
    }
    if matches!(anchor, AnnotationAnchor::Turn { .. }) {
        return Ok(());
    }
    if interaction.completion_status != "accepted" {
        return Err(ApiError::invalid(
            "graph subjects require an accepted interaction",
        ));
    }
    let graph_node_id = interaction
        .graph_node_id
        .ok_or_else(|| ApiError::invalid("accepted interaction has no graph identity"))?;
    let root_layer_id = interaction
        .completion_output
        .as_ref()
        .and_then(|output| output.pointer("/rootLayer/layer/id"))
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::invalid("accepted interaction has no resolved root layer"))?;
    let runtime = state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::invalid("GraphComplete runtime is unavailable"))?;
    let target_layer_id = match anchor {
        AnnotationAnchor::Layer { layer_id, .. }
        | AnnotationAnchor::Node { layer_id, .. }
        | AnnotationAnchor::Edge { layer_id, .. } => *layer_id,
        AnnotationAnchor::Action {
            presentation_layer_id,
            ..
        } => *presentation_layer_id,
        AnnotationAnchor::Thread | AnnotationAnchor::Turn { .. } => unreachable!(),
    };
    // Use GraphComplete's canonical accepted-closure read. Besides including
    // both expand and reference navigation, it resolves the complete fixed
    // output in one graph transaction instead of reconstructing authority
    // across a sequence of independently timed layer reads.
    let closure = runtime.accepted_graph_closure(graph_node_id).await?;
    if closure.node_id.value() != graph_node_id || closure.root_layer_id.value() != root_layer_id {
        return Err(ApiError::invalid(
            "accepted graph closure does not match the product interaction",
        ));
    }
    let layer = closure
        .layers
        .iter()
        .find(|resolved| resolved.layer.id.value() == target_layer_id)
        .ok_or_else(|| {
            ApiError::invalid("annotation layer is unreachable from this turn's accepted root")
        })?;
    match anchor {
        AnnotationAnchor::Layer { .. } => Ok(()),
        AnnotationAnchor::Node { node_id, .. }
            if layer.nodes.iter().any(|node| node.id.value() == *node_id) =>
        {
            Ok(())
        }
        AnnotationAnchor::Edge { edge_id, .. }
            if layer.edges.iter().any(|edge| edge.id.value() == *edge_id) =>
        {
            Ok(())
        }
        AnnotationAnchor::Action {
            source_layer_id,
            node_id,
            action_id,
            ..
        } => {
            let matches = layer.actions.iter().any(|action| {
                action.id.value() == *action_id
                    && action.source_node_id.value() == *node_id
                    && action.source_layer_id.map(|id| id.value()) == Some(*source_layer_id)
            });
            matches.then_some(()).ok_or_else(|| {
                ApiError::invalid(
                    "action is not an exact accepted member of the presentation layer",
                )
            })
        }
        _ => Err(ApiError::invalid(
            "annotation subject is not an accepted member of its layer",
        )),
    }
}

fn map_annotation_error(error: crate::product::ProductError) -> ApiError {
    match error {
        crate::product::ProductError::Storage(
            crate::storage::StorageError::AnnotationConflict(message),
        ) => ApiError::conflict("annotation_revision_conflict", message),
        other => other.into(),
    }
}

fn required_bounded(value: &str, field: &str, max: usize) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.len() > max {
        return Err(ApiError::invalid(format!(
            "{field} must contain 1 to {max} bytes"
        )));
    }
    Ok(value.to_owned())
}

fn empty_object() -> Value {
    json!({})
}
