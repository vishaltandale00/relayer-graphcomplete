use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use relayer_graph_core::{
    ActionDraft, ActionId, ActionKind, CompletionOutput, EdgeDraft, GraphAction, GraphDatabase,
    GraphError, GraphNode, GraphWriter, ImportedConversationStage, ImportedTurn,
    InteractionInvocation, LayerDraft, LayerId, NodeDraft, NodeId, ProjectId, RecordState,
    ThreadId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Clone)]
pub struct ServerState {
    graph: GraphDatabase,
    sessions: Arc<Mutex<HashMap<String, NodeId>>>,
    control_token: Arc<str>,
}

impl ServerState {
    pub fn new(graph: GraphDatabase, control_token: impl Into<String>) -> Self {
        Self {
            graph,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            control_token: Arc::from(control_token.into()),
        }
    }
}

pub fn router(state: ServerState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/control/interactions", post(create_interaction))
        .route("/api/control/interactions/{id}", get(interaction_metadata))
        .route("/api/control/interactions/{id}/output", get(control_output))
        .route(
            "/api/control/interactions/{id}/layers/{layer_id}",
            get(control_layer),
        )
        .route(
            "/api/control/interactions/{id}/layers/{layer_id}/owner",
            get(control_layer_owner),
        )
        .route(
            "/api/control/interactions/{id}/actions/{action_id}",
            get(control_action),
        )
        .route(
            "/api/control/conversation-imports",
            axum::routing::delete(remove_imported_conversation),
        )
        .route(
            "/api/control/conversation-import-stages",
            post(begin_imported_conversation),
        )
        .route(
            "/api/control/conversation-import-stages/{import_id}/turns",
            post(stage_imported_turn).layer(DefaultBodyLimit::max(17 * 1024 * 1024)),
        )
        .route(
            "/api/control/conversation-import-stages/{import_id}/finalize",
            post(finalize_imported_conversation),
        )
        .route(
            "/api/control/interactions/{id}/accepted-closure",
            get(accepted_closure),
        )
        .route(
            "/api/control/capabilities",
            post(remint_capability).delete(revoke_capability),
        )
        .route("/api/graph/nodes", post(submit_node))
        .route("/api/graph/nodes/{id}", get(get_node))
        .route("/api/graph/nodes/{id}/neighbors", get(neighbors))
        .route("/api/graph/edges", post(create_edge))
        .route("/api/graph/layers", post(submit_layer))
        .route("/api/graph/layers/{id}", get(get_layer))
        .route("/api/graph/actions", post(add_action))
        .route("/api/graph/actions/{id}", get(get_action))
        .route("/api/graph/submit", post(submit_completion))
        .route("/api/graph/nodes/{id}/output", get(completion_output))
        .with_state(state)
}

async fn begin_imported_conversation(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<ImportedConversationStage>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    state.graph.begin_imported_conversation(&input).await?;
    Ok(Json(json!({"staged": true})))
}

async fn stage_imported_turn(
    State(state): State<ServerState>,
    Path(import_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ImportedTurn>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    state.graph.stage_imported_turn(&import_id, &input).await?;
    Ok(Json(json!({"staged": true})))
}

async fn finalize_imported_conversation(
    State(state): State<ServerState>,
    Path(import_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    Ok(Json(json!(
        state
            .graph
            .finalize_imported_conversation(&import_id)
            .await?
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveImportRequest {
    import_id: String,
}

async fn remove_imported_conversation(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<RemoveImportRequest>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    state
        .graph
        .remove_imported_conversation(&input.import_id)
        .await?;
    Ok(Json(json!({"removed": true})))
}

async fn accepted_closure(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<relayer_graph_core::AcceptedGraphClosure>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let closure = state.graph.accepted_graph_closure(id).await?.ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            json!({"error":{"code":"completion_not_found","message":"This node has no accepted completion output yet."}}),
        )
    })?;
    Ok(Json(closure))
}

async fn health() -> Json<Value> {
    Json(json!({"ok": true, "service": "relayer-graph"}))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInteractionRequest {
    project_id: Option<ProjectId>,
    thread_id: ThreadId,
    text: String,
    #[serde(default)]
    invocation: Option<InteractionInvocation>,
    #[serde(default = "default_mint_capability")]
    mint_capability: bool,
}

fn default_mint_capability() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInteractionResponse {
    pub node: GraphNode,
    pub graph_token: String,
}

async fn create_interaction(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<CreateInteractionRequest>,
) -> Result<Json<CreateInteractionResponse>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let interaction = state
        .graph
        .create_interaction_with_invocation(
            input.project_id,
            input.thread_id,
            &input.text,
            input.invocation,
        )
        .await?;
    let graph_token = input
        .mint_capability
        .then(|| mint_capability(&state, interaction.id, None))
        .transpose()?;
    Ok(Json(CreateInteractionResponse {
        node: interaction,
        graph_token: graph_token.unwrap_or_default(),
    }))
}

async fn interaction_metadata(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let invocation = state.graph.interaction_invocation(id).await?;
    Ok(Json(json!({ "nodeId": id, "invocation": invocation })))
}

async fn control_output(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<CompletionOutput>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let output = state.graph.writer_for_subgraph(id).await?.completion_output().await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, json!({"error":{"code":"completion_not_found","message":"This node has no accepted completion output yet."}})))?;
    Ok(Json(output))
}

async fn control_layer(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path((id, layer_id)): Path<(NodeId, LayerId)>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let layer = state
        .graph
        .writer_for_subgraph(id)
        .await?
        .get_layer(layer_id)
        .await?;
    Ok(Json(
        serde_json::to_value(layer).map_err(|error| ApiError::internal(&error.to_string()))?,
    ))
}

async fn control_layer_owner(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path((id, layer_id)): Path<(NodeId, LayerId)>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let owner_interaction_node_id = state
        .graph
        .writer_for_subgraph(id)
        .await?
        .get_layer_owner(layer_id)
        .await?;
    Ok(Json(json!({
        "layerId": layer_id,
        "ownerInteractionNodeId": owner_interaction_node_id,
    })))
}

async fn control_action(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path((id, action_id)): Path<(NodeId, ActionId)>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let writer = state.graph.writer_for_subgraph(id).await?;
    let action = accepted_action(&writer, action_id).await?;
    Ok(Json(json!({"action": action})))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemintCapabilityRequest {
    node_id: NodeId,
    #[serde(default)]
    graph_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemintCapabilityResponse {
    graph_token: String,
}

async fn remint_capability(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<RemintCapabilityRequest>,
) -> Result<Json<RemintCapabilityResponse>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    state.graph.writer_for_subgraph(input.node_id).await?;
    Ok(Json(RemintCapabilityResponse {
        graph_token: mint_capability(&state, input.node_id, input.graph_token)?,
    }))
}

fn mint_capability(
    state: &ServerState,
    node_id: NodeId,
    requested_token: Option<String>,
) -> Result<String, ApiError> {
    let graph_token = requested_token.unwrap_or_else(|| Uuid::new_v4().to_string());
    if graph_token.is_empty() {
        return Err(ApiError::invalid("graphToken must be non-empty"));
    }
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| ApiError::internal("session lock poisoned"))?;
    if let Some(active_node_id) = sessions.get(&graph_token) {
        if *active_node_id != node_id {
            return Err(ApiError::conflict(
                "capability_token_conflict",
                "graphToken is already bound to a different interaction",
            ));
        }
        return Ok(graph_token);
    }
    sessions.retain(|_, active_node_id| *active_node_id != node_id);
    sessions.insert(graph_token.clone(), node_id);
    Ok(graph_token)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevokeCapabilityRequest {
    #[serde(default)]
    graph_token: Option<String>,
    #[serde(default)]
    node_id: Option<NodeId>,
}

async fn revoke_capability(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<RevokeCapabilityRequest>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| ApiError::internal("session lock poisoned"))?;
    let revoked = match (input.graph_token, input.node_id) {
        (Some(graph_token), None) => sessions.remove(&graph_token).is_some() as usize,
        (None, Some(node_id)) => {
            let before = sessions.len();
            sessions.retain(|_, active_node_id| *active_node_id != node_id);
            before - sessions.len()
        }
        _ => {
            return Err(ApiError::invalid(
                "provide exactly one of graphToken or nodeId",
            ));
        }
    };
    Ok(Json(
        json!({"revoked": revoked > 0, "revokedCount": revoked}),
    ))
}

async fn submit_node(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<NodeDraft>,
) -> Result<Json<Value>, ApiError> {
    let node_id = session(&state, &headers)?;
    let node = state
        .graph
        .writer_for_subgraph(node_id)
        .await?
        .submit_node(&input)
        .await?;
    Ok(Json(json!({"node": node})))
}
async fn get_node(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<Value>, ApiError> {
    let node_id = session(&state, &headers)?;
    let node = state
        .graph
        .writer_for_subgraph(node_id)
        .await?
        .get_node(id)
        .await?;
    Ok(Json(json!({"node":node})))
}
async fn neighbors(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<Value>, ApiError> {
    let node_id = session(&state, &headers)?;
    let nodes = state
        .graph
        .writer_for_subgraph(node_id)
        .await?
        .neighbors(id)
        .await?;
    Ok(Json(json!({"nodes":nodes})))
}
async fn create_edge(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<EdgeDraft>,
) -> Result<Json<Value>, ApiError> {
    let node_id = session(&state, &headers)?;
    let edge = state
        .graph
        .writer_for_subgraph(node_id)
        .await?
        .create_edge(&input)
        .await?;
    Ok(Json(json!({"edge":edge})))
}
async fn submit_layer(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<LayerDraft>,
) -> Result<Json<Value>, ApiError> {
    let node_id = session(&state, &headers)?;
    let layer = state
        .graph
        .writer_for_subgraph(node_id)
        .await?
        .submit_layer(&input)
        .await?;
    Ok(Json(json!({"layer":layer})))
}
async fn get_layer(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<LayerId>,
) -> Result<Json<Value>, ApiError> {
    let node_id = session(&state, &headers)?;
    let layer = state
        .graph
        .writer_for_subgraph(node_id)
        .await?
        .get_layer(id)
        .await?;
    Ok(Json(json!(layer)))
}
async fn add_action(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<ActionDraft>,
) -> Result<Json<Value>, ApiError> {
    let node_id = session(&state, &headers)?;
    let action = state
        .graph
        .writer_for_subgraph(node_id)
        .await?
        .add_action(&input)
        .await?;
    Ok(Json(json!({"action":action})))
}
async fn get_action(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<ActionId>,
) -> Result<Json<Value>, ApiError> {
    let node_id = session(&state, &headers)?;
    let writer = state.graph.writer_for_subgraph(node_id).await?;
    let action = accepted_action(&writer, id).await?;
    Ok(Json(json!({"action": action})))
}

async fn accepted_action(writer: &GraphWriter, id: ActionId) -> Result<GraphAction, ApiError> {
    let output = writer.completion_output().await?.ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            json!({"error":{"code":"completion_not_found","message":"This node has no accepted completion output yet."}}),
        )
    })?;
    let mut layers = VecDeque::from([output.root_layer]);
    let mut visited = HashSet::new();
    while let Some(layer) = layers.pop_front() {
        if !visited.insert(layer.layer.id) {
            continue;
        }
        for action in layer.actions {
            if action.id == id && action.state == RecordState::Accepted {
                return Ok(action);
            }
            if action.kind == ActionKind::Navigate
                && action.state == RecordState::Accepted
                && let Some(target_layer_id) = action.target_layer_id
                && !visited.contains(&target_layer_id)
            {
                layers.push_back(writer.get_layer(target_layer_id).await?);
            }
        }
    }
    Err(ApiError(
        StatusCode::NOT_FOUND,
        json!({"error":{"code":"action_not_found","message":"This accepted completion does not contain that action."}}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteRequest {
    node_id: NodeId,
}
async fn submit_completion(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<CompleteRequest>,
) -> Result<Json<CompletionOutput>, ApiError> {
    let node_id = session(&state, &headers)?;
    let output = state
        .graph
        .writer_for_subgraph(node_id)
        .await?
        .complete(input.node_id)
        .await?;
    Ok(Json(output))
}
async fn completion_output(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<NodeId>,
) -> Result<Json<CompletionOutput>, ApiError> {
    let node_id = session(&state, &headers)?;
    if id != node_id {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            json!({"error":{"code":"forbidden","message":"This capability can only read its completion output."}}),
        ));
    }
    let output = state
        .graph
        .writer_for_subgraph(node_id)
        .await?
        .completion_output()
        .await?
        .ok_or_else(|| ApiError(
            StatusCode::NOT_FOUND,
            json!({"error":{"code":"completion_not_found","message":"This node has no accepted completion output yet."}}),
        ))?;
    Ok(Json(output))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
fn require_bearer(headers: &HeaderMap, expected: &str) -> Result<(), ApiError> {
    if bearer(headers) == Some(expected) {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::UNAUTHORIZED,
            json!({"error":{"code":"unauthorized","message":"A valid bearer token is required."}}),
        ))
    }
}
fn session(state: &ServerState, headers: &HeaderMap) -> Result<NodeId, ApiError> {
    let token = bearer(headers).ok_or_else(|| {
        ApiError(
            StatusCode::UNAUTHORIZED,
            json!({"error":{"code":"unauthorized","message":"A graph capability token is required."}}),
        )
    })?;
    state
        .sessions
        .lock()
        .map_err(|_| ApiError::internal("session lock poisoned"))?
        .get(token)
        .copied()
        .ok_or_else(|| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                json!({"error":{"code":"invalid_capability","message":"This graph capability is unknown or expired."}}),
            )
        })
}

pub struct ApiError(StatusCode, Value);
impl ApiError {
    fn invalid(message: &str) -> Self {
        Self(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"error":{"code":"invalid_request","message":message}}),
        )
    }

    fn conflict(code: &str, message: &str) -> Self {
        Self(
            StatusCode::CONFLICT,
            json!({"error":{"code":code,"message":message}}),
        )
    }

    fn internal(message: &str) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":{"code":"internal","message":message}}),
        )
    }
}
impl From<GraphError> for ApiError {
    fn from(error: GraphError) -> Self {
        match error {
            GraphError::Validation {
                code,
                path,
                message,
            } => Self(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"error":{"code":code,"path":path,"message":message,"issues":[{"code":code,"path":path,"message":message}]}}),
            ),
            GraphError::ValidationIssues { message, issues } => {
                let first = issues.first().expect("validation issues are non-empty");
                Self(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"error":{"code":first.code,"path":first.path,"message":message,"issues":issues}}),
                )
            }
            GraphError::NotFound(message) => Self(
                StatusCode::NOT_FOUND,
                json!({"error":{"code":"not_found","message":message}}),
            ),
            GraphError::Forbidden(message) => Self(
                StatusCode::FORBIDDEN,
                json!({"error":{"code":"forbidden","message":message}}),
            ),
            other => Self::internal(&other.to_string()),
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn staged_import_endpoints_require_control_authority_and_finalize_in_order() {
        let app = router(ServerState::new(
            GraphDatabase::in_memory().await.unwrap(),
            "control",
        ));
        let stage = serde_json::to_vec(&ImportedConversationStage {
            import_id: "import-stage-1".into(),
            source_sha256: "sha256:fixture".into(),
            project_id: None,
            thread_id: ThreadId::new(9001).unwrap(),
            created_at: "1770000000000".into(),
        })
        .unwrap();
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/conversation-import-stages")
                    .header("content-type", "application/json")
                    .body(Body::from(stage.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

        let started = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/conversation-import-stages")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(stage))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(started.status(), StatusCode::OK);

        let turn = serde_json::to_vec(&ImportedTurn {
            source_turn_id: "turn:1".into(),
            text: "Failed turn".into(),
            invoke_origin: None,
            accepted_view: None,
        })
        .unwrap();
        let staged = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/conversation-import-stages/import-stage-1/turns")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(turn))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(staged.status(), StatusCode::OK);

        let finalized = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/conversation-import-stages/import-stage-1/finalize")
                    .header("authorization", "Bearer control")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(finalized.status(), StatusCode::OK);
        let receipt: relayer_graph_core::ImportedConversationReceipt =
            serde_json::from_slice(&to_bytes(finalized.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(receipt.turns.len(), 1);
        assert_eq!(receipt.turns[0].source_turn_id, "turn:1");
    }

    #[tokio::test]
    async fn external_interaction_requires_control_token_and_mints_scoped_graph_token() {
        let state = ServerState::new(GraphDatabase::in_memory().await.unwrap(), "control");
        let app = router(state.clone());
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"projectId":41,"threadId":73,"text":"hello"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        let allowed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"projectId":41,"threadId":73,"text":"hello"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);
        let bytes = to_bytes(allowed.into_body(), usize::MAX).await.unwrap();
        let body: CreateInteractionResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(!body.graph_token.is_empty());
        assert!(body.node.id.value() > 0);
        assert_eq!(body.node.leased_action_id, None);

        let node_id = state
            .sessions
            .lock()
            .unwrap()
            .get(&body.graph_token)
            .unwrap()
            .to_owned();
        assert_eq!(node_id, body.node.id);
    }

    #[tokio::test]
    async fn product_can_bind_before_mint_and_invalidate_a_crash_surviving_node_token() {
        let state = ServerState::new(GraphDatabase::in_memory().await.unwrap(), "control");
        let app = router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"threadId":73,"text":"hello","mintCapability":false}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created: CreateInteractionResponse =
            serde_json::from_slice(&to_bytes(created.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert!(created.graph_token.is_empty());
        assert!(state.sessions.lock().unwrap().is_empty());

        let token = "product-chosen-crash-token";
        let minted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/capabilities")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(format!(
                        r#"{{"nodeId":{},"graphToken":"{token}"}}"#,
                        created.node.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(minted.status(), StatusCode::OK);

        let repeated = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/capabilities")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(format!(
                        r#"{{"nodeId":{},"graphToken":"{token}"}}"#,
                        created.node.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(repeated.status(), StatusCode::OK);

        let second = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"threadId":74,"text":"second","mintCapability":false}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let second: CreateInteractionResponse =
            serde_json::from_slice(&to_bytes(second.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        let conflict = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/capabilities")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(format!(
                        r#"{{"nodeId":{},"graphToken":"{token}"}}"#,
                        second.node.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        assert_eq!(
            state.sessions.lock().unwrap().get(token),
            Some(&created.node.id)
        );

        let invalidated = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/control/capabilities")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(format!(
                        r#"{{"nodeId":{}}}"#,
                        created.node.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalidated.status(), StatusCode::OK);
        let rejected = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/graph/nodes/{}", created.node.id.value()))
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn control_issues_and_replays_typed_invocation_leases_with_derived_neighbors() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let source_interaction = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "Source")
            .await
            .unwrap();
        let writer = graph
            .writer_for_subgraph(source_interaction.id)
            .await
            .unwrap();
        let source = writer
            .submit_node(&NodeDraft {
                client_key: "source".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Source".into(),
                detail: "Accepted source".into(),
            })
            .await
            .unwrap();
        let layer = writer
            .submit_layer(&LayerDraft {
                client_key: "root".into(),
                nodes: vec![source.id],
                edges: vec![],
                size_justification: None,
            })
            .await
            .unwrap();
        let invoke = writer
            .add_action(&ActionDraft {
                client_key: "continue".into(),
                source_node_id: source.id,
                source_layer_id: Some(layer.id),
                kind: ActionKind::Invoke,
                relation: None,
                label: "Continue".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: None,
                interaction_text: Some("Continue".into()),
            })
            .await
            .unwrap();
        writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: source_interaction.id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(relayer_graph_core::NavigateRelation::Expand),
                label: "Response".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: Some(layer.id),
                interaction_text: None,
            })
            .await
            .unwrap();
        writer.complete(source_interaction.id).await.unwrap();

        let app = router(ServerState::new(graph.clone(), "control"));
        let request_body = format!(
            r#"{{"projectId":41,"threadId":74,"text":"Result","invocation":{{"sourceInteractionNodeId":{},"sourceActionId":{}}}}}"#,
            source_interaction.id.value(),
            invoke.id.value()
        );
        let create = |body: String| {
            Request::builder()
                .method("POST")
                .uri("/api/control/interactions")
                .header("content-type", "application/json")
                .header("authorization", "Bearer control")
                .body(Body::from(body))
                .unwrap()
        };
        let first = app
            .clone()
            .oneshot(create(request_body.clone()))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first: CreateInteractionResponse =
            serde_json::from_slice(&to_bytes(first.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(first.node.leased_action_id, Some(invoke.id));

        let replay = app.clone().oneshot(create(request_body)).await.unwrap();
        assert_eq!(replay.status(), StatusCode::OK);
        let replay: CreateInteractionResponse =
            serde_json::from_slice(&to_bytes(replay.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(replay.node, first.node);

        let stale = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/graph/nodes/{}/neighbors",
                        first.node.id.value()
                    ))
                    .header("authorization", format!("Bearer {}", first.graph_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale.status(), StatusCode::UNAUTHORIZED);

        let neighbors = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/graph/nodes/{}/neighbors",
                        first.node.id.value()
                    ))
                    .header("authorization", format!("Bearer {}", replay.graph_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(neighbors.status(), StatusCode::OK);
        let neighbors: Value =
            serde_json::from_slice(&to_bytes(neighbors.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(neighbors["nodes"][0]["id"], source.id.value());

        let result_writer = graph.writer_for_subgraph(first.node.id).await.unwrap();
        let result_node = result_writer
            .submit_node(&NodeDraft {
                client_key: "result".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Result".into(),
                detail: "Accepted result".into(),
            })
            .await
            .unwrap();
        let result_layer = result_writer
            .submit_layer(&LayerDraft {
                client_key: "result-root".into(),
                nodes: vec![result_node.id],
                edges: vec![],
                size_justification: None,
            })
            .await
            .unwrap();
        result_writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: first.node.id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(relayer_graph_core::NavigateRelation::Expand),
                label: "Response".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: Some(result_layer.id),
                interaction_text: None,
            })
            .await
            .unwrap();
        let submitted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/submit")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {}", replay.graph_token))
                    .body(Body::from(format!(
                        r#"{{"nodeId":{}}}"#,
                        first.node.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(submitted.status(), StatusCode::OK);
        let submitted: CompletionOutput =
            serde_json::from_slice(&to_bytes(submitted.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(submitted.root_layer.layer.id, result_layer.id);
        let resolved = writer.completion_output().await.unwrap().unwrap();
        assert_eq!(
            resolved
                .root_layer
                .actions
                .iter()
                .find(|action| action.id == invoke.id)
                .unwrap()
                .target_layer_id,
            Some(result_layer.id)
        );
        let owner = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/control/interactions/{}/layers/{}/owner",
                        source_interaction.id.value(),
                        result_layer.id.value()
                    ))
                    .header("authorization", "Bearer control")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(owner.status(), StatusCode::OK);
        let owner: Value =
            serde_json::from_slice(&to_bytes(owner.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(owner["layerId"], result_layer.id.value());
        assert_eq!(owner["ownerInteractionNodeId"], first.node.id.value());

        let invalid = app
            .oneshot(create(format!(
                r#"{{"projectId":41,"threadId":74,"text":"Result","invocation":{{"sourceInteractionNodeId":{},"sourceActionId":0}}}}"#,
                source_interaction.id.value()
            )))
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn control_authority_can_remint_a_capability_after_server_restart() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let first_app = router(ServerState::new(graph.clone(), "control"));
        let created = first_app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"projectId":41,"threadId":73,"text":"hello"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created: CreateInteractionResponse =
            serde_json::from_slice(&to_bytes(created.into_body(), usize::MAX).await.unwrap())
                .unwrap();

        let restarted = router(ServerState::new(graph, "control"));
        let reminted = restarted
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/capabilities")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(format!(
                        r#"{{"nodeId":{}}}"#,
                        created.node.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reminted.status(), StatusCode::OK);
        let reminted: RemintCapabilityResponse =
            serde_json::from_slice(&to_bytes(reminted.into_body(), usize::MAX).await.unwrap())
                .unwrap();

        let readable = restarted
            .oneshot(
                Request::builder()
                    .uri(format!("/api/graph/nodes/{}", created.node.id.value()))
                    .header("authorization", format!("Bearer {}", reminted.graph_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(readable.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn control_authority_can_revoke_a_graph_capability() {
        let state = ServerState::new(GraphDatabase::in_memory().await.unwrap(), "control");
        let app = router(state);
        let created = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"projectId":41,"threadId":73,"text":"hello"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created: CreateInteractionResponse =
            serde_json::from_slice(&to_bytes(created.into_body(), usize::MAX).await.unwrap())
                .unwrap();

        let revoked = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/control/capabilities")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(format!(
                        r#"{{"graphToken":"{}"}}"#,
                        created.graph_token
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::OK);

        let denied = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/graph/nodes/{}", created.node.id.value()))
                    .header("authorization", format!("Bearer {}", created.graph_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn invalid_interaction_can_be_retried_with_the_same_external_ids() {
        let app = router(ServerState::new(
            GraphDatabase::in_memory().await.unwrap(),
            "control",
        ));
        let invalid = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(r#"{"projectId":41,"threadId":73,"text":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let retry = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"projectId":41,"threadId":73,"text":"valid"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn action_api_defaults_older_authors_and_returns_repairable_variant_errors() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let interaction = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "hello")
            .await
            .unwrap();
        let writer = graph.writer_for_subgraph(interaction.id).await.unwrap();
        let source = writer
            .submit_node(&NodeDraft {
                client_key: "source".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Source".into(),
                detail: "Source detail".into(),
            })
            .await
            .unwrap();
        let source_layer = writer
            .submit_layer(&LayerDraft {
                client_key: "source-layer".into(),
                nodes: vec![source.id],
                edges: vec![],
                size_justification: None,
            })
            .await
            .unwrap();
        let state = ServerState::new(graph, "control");
        let graph_token = mint_capability(&state, interaction.id, None).ok().unwrap();
        let app = router(state);

        let older = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/actions")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"clientKey":"older","sourceNodeId":{},"sourceLayerId":{},"kind":"invoke","label":"Continue","interactionText":"Continue from here"}}"#,
                        source.id.value(), source_layer.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(older.status(), StatusCode::OK);
        let older: Value =
            serde_json::from_slice(&to_bytes(older.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(older["action"]["variant"], "pill");
        assert!(older["action"]["icon"].is_null());
        assert!(older["action"]["description"].is_null());

        let unsupported = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/graph/actions")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::from(format!(
                        r#"{{"clientKey":"unsupported","sourceNodeId":{},"sourceLayerId":{},"kind":"invoke","label":"Continue","variant":"banner","interactionText":"Continue from here"}}"#,
                        source.id.value(), source_layer.id.value()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unsupported.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let unsupported: Value =
            serde_json::from_slice(&to_bytes(unsupported.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(unsupported["error"]["code"], "unsupported_action_variant");
        assert_eq!(unsupported["error"]["path"], "variant");
    }

    #[tokio::test]
    async fn action_read_is_scoped_to_the_source_interactions_accepted_closure() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let interaction = graph
            .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "hello")
            .await
            .unwrap();
        let writer = graph.writer_for_subgraph(interaction.id).await.unwrap();
        let answer = writer
            .submit_node(&NodeDraft {
                client_key: "answer".into(),
                kind: "concept".into(),
                icon: "compass".into(),
                title: "Answer".into(),
                detail: "Accepted detail".into(),
            })
            .await
            .unwrap();
        let layer = writer
            .submit_layer(&LayerDraft {
                client_key: "root".into(),
                nodes: vec![answer.id],
                edges: vec![],
                size_justification: None,
            })
            .await
            .unwrap();
        let invoke = writer
            .add_action(&ActionDraft {
                client_key: "continue".into(),
                source_node_id: answer.id,
                source_layer_id: Some(layer.id),
                kind: ActionKind::Invoke,
                relation: None,
                label: "Continue".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: None,
                interaction_text: Some("Continue from here".into()),
            })
            .await
            .unwrap();
        writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: interaction.id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(relayer_graph_core::NavigateRelation::Expand),
                label: "Response".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: Some(layer.id),
                interaction_text: None,
            })
            .await
            .unwrap();
        writer.complete(interaction.id).await.unwrap();

        let state = ServerState::new(graph, "control");
        let graph_token = mint_capability(&state, interaction.id, None).ok().unwrap();
        let app = router(state);
        let readable = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/graph/actions/{}", invoke.id.value()))
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(readable.status(), StatusCode::OK);
        let readable: Value =
            serde_json::from_slice(&to_bytes(readable.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(readable["action"]["id"], invoke.id.value());
        assert_eq!(readable["action"]["kind"], "invoke");

        let absent = app
            .oneshot(
                Request::builder()
                    .uri("/api/graph/actions/99999")
                    .header("authorization", format!("Bearer {graph_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(absent.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn product_identifiers_must_be_positive_and_project_is_optional() {
        let app = router(ServerState::new(
            GraphDatabase::in_memory().await.unwrap(),
            "control",
        ));
        let invalid = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"projectId":0,"threadId":73,"text":"invalid project"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let standalone = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/control/interactions")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer control")
                    .body(Body::from(
                        r#"{"threadId":73,"text":"standalone interaction"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(standalone.status(), StatusCode::OK);
    }
}
