use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use relayer_graph_core::{
    ActionDraft, ActionId, ActionKind, CompletionOutput, EdgeDraft, GraphDatabase, GraphError,
    GraphNode, LayerDraft, LayerId, NodeDraft, NodeId, ProjectId, RecordState, ThreadId,
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

async fn health() -> Json<Value> {
    Json(json!({"ok": true, "service": "relayer-graph"}))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInteractionRequest {
    project_id: Option<ProjectId>,
    thread_id: ThreadId,
    text: String,
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
        .create_interaction(input.project_id, input.thread_id, &input.text)
        .await?;
    let graph_token = mint_capability(&state, interaction.id)?;
    Ok(Json(CreateInteractionResponse {
        node: interaction,
        graph_token,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemintCapabilityRequest {
    node_id: NodeId,
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
        graph_token: mint_capability(&state, input.node_id)?,
    }))
}

fn mint_capability(state: &ServerState, node_id: NodeId) -> Result<String, ApiError> {
    let graph_token = Uuid::new_v4().to_string();
    state
        .sessions
        .lock()
        .map_err(|_| ApiError::internal("session lock poisoned"))?
        .insert(graph_token.clone(), node_id);
    Ok(graph_token)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevokeCapabilityRequest {
    graph_token: String,
}

async fn revoke_capability(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<RevokeCapabilityRequest>,
) -> Result<Json<Value>, ApiError> {
    require_bearer(&headers, &state.control_token)?;
    let revoked = state
        .sessions
        .lock()
        .map_err(|_| ApiError::internal("session lock poisoned"))?
        .remove(&input.graph_token)
        .is_some();
    Ok(Json(json!({"revoked": revoked})))
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
                return Ok(Json(json!({"action": action})));
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
                json!({"error":{"code":code,"path":path,"message":message}}),
            ),
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
        let state = ServerState::new(graph, "control");
        let graph_token = mint_capability(&state, interaction.id).ok().unwrap();
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
                        r#"{{"clientKey":"older","sourceNodeId":{},"kind":"invoke","label":"Continue","interactionText":"Continue from here"}}"#,
                        interaction.id.value()
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
                        r#"{{"clientKey":"unsupported","sourceNodeId":{},"kind":"invoke","label":"Continue","variant":"banner","interactionText":"Continue from here"}}"#,
                        interaction.id.value()
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
        let invoke = writer
            .add_action(&ActionDraft {
                client_key: "continue".into(),
                source_node_id: answer.id,
                kind: ActionKind::Invoke,
                label: "Continue".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: None,
                interaction_text: Some("Continue from here".into()),
                response: false,
            })
            .await
            .unwrap();
        let layer = writer
            .submit_layer(&LayerDraft {
                client_key: "root".into(),
                nodes: vec![answer.id],
                edges: vec![],
            })
            .await
            .unwrap();
        writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: interaction.id,
                kind: ActionKind::Navigate,
                label: "Response".into(),
                variant: relayer_graph_core::ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: Some(layer.id),
                interaction_text: None,
                response: true,
            })
            .await
            .unwrap();
        writer.complete(interaction.id).await.unwrap();

        let state = ServerState::new(graph, "control");
        let graph_token = mint_capability(&state, interaction.id).ok().unwrap();
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
