use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use relayer_graph_core::GraphDatabase;
use relayer_graph_server::{ServerState, router};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn create(app: &Router, thread: i64) -> Value {
    let response = app.clone().oneshot(Request::post("/api/control/interactions").header("authorization", "Bearer control").header("content-type", "application/json").body(Body::from(json!({"threadId":thread,"text":"Exact prior request","graphCapabilityProfile":{"search":"disabled"}}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

async fn read(app: &Router, path: &str, token: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::get(path)
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[tokio::test]
async fn historical_reads_use_scoped_capabilities_without_search_or_target_authority() {
    let graph = GraphDatabase::in_memory().await.unwrap();
    let app = router(ServerState::new(graph.clone(), "control"));
    let earlier = create(&app, 1).await;
    let current = create(&app, 1).await;
    let foreign = create(&app, 2).await;
    let token = current["graphToken"].as_str().unwrap();
    let (status, page) = read(&app, "/api/graph/history?limit=1", token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        page["entries"][0]["interactionNodeId"],
        earlier["node"]["id"]
    );
    let path = format!("/api/graph/nodes/{}/input", earlier["node"]["id"]);
    let (status, input) = read(&app, &path, token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        input["input"]["interaction"]["detail"],
        "Exact prior request"
    );
    assert_eq!(
        read(&app, &path, "control").await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        read(
            &app,
            &format!("/api/graph/nodes/{}/input", foreign["node"]["id"]),
            token
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        read(&app, "/api/graph/history?limit=51", token).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    graph
        .activate_completion_authority(
            relayer_graph_core::NodeId::new(current["node"]["id"].as_i64().unwrap()).unwrap(),
        )
        .await
        .unwrap();
    assert!(!read(&app, "/api/graph/history", token).await.0.is_success());
    assert!(!read(&app, &path, token).await.0.is_success());
}
