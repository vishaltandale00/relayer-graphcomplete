use std::{
    path::Path,
    sync::{
        Arc, Barrier,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use relayer_graph_core::{
    ActionDraft, ActionKind, CompletionCrashPoint, GraphDatabase, LayerDraft, LayerId, LayerLayout,
    NavigateRelation, NodeDraft, NodePlacement, ProjectId, SearchTarget, TemporalFeatureConfig,
    ThreadId,
};
use relayer_graph_server::search_index::{
    LadybugSearchIndex, QueryCancellation, SearchTargetReadiness,
};
use relayer_graph_server::{CreateInteractionResponse, ServerState, router};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct Fixture {
    _directory: TempDir,
    graph: GraphDatabase,
    index: Arc<LadybugSearchIndex>,
    app: Router,
}

async fn fixture() -> Fixture {
    fixture_with_cancellation(None).await
}

async fn temporal_fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("graph.db");
    let sqlite = GraphDatabase::open(&database_path).await.unwrap();
    let temporal_features = TemporalFeatureConfig {
        schema_read: true,
        root_current_write: true,
        ..TemporalFeatureConfig::default()
    };
    sqlite
        .set_temporal_features(temporal_features)
        .await
        .unwrap();
    let index = Arc::new(
        LadybugSearchIndex::open_reconciled(Path::new(&database_path), &sqlite)
            .await
            .unwrap(),
    );
    let graph = sqlite.with_search_index(index.clone());
    let state = ServerState::new(graph.clone(), "control")
        .with_temporal_features(temporal_features)
        .with_search_index(index.clone());
    Fixture {
        _directory: directory,
        graph,
        index,
        app: router(state),
    }
}

async fn fixture_with_cancellation(cancellation: Option<QueryCancellation>) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("graph.db");
    let sqlite = GraphDatabase::open(&database_path).await.unwrap();
    let index = Arc::new(
        LadybugSearchIndex::open_reconciled(Path::new(&database_path), &sqlite)
            .await
            .unwrap(),
    );
    let graph = sqlite.with_search_index(index.clone());
    let mut state = ServerState::new(graph.clone(), "control").with_search_index(index.clone());
    if let Some(cancellation) = cancellation {
        state = state.with_contract_test_search_cancellation(cancellation);
    }
    let app = router(state);
    Fixture {
        _directory: directory,
        graph,
        index,
        app,
    }
}

async fn json_response(response: axum::response::Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn post(
    app: &Router,
    uri: &str,
    token: Option<&str>,
    body: impl Into<Body>,
) -> axum::response::Response {
    let mut request = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    app.clone()
        .oneshot(request.body(body.into()).unwrap())
        .await
        .unwrap()
}

async fn interaction(app: &Router, thread_id: i64) -> CreateInteractionResponse {
    interaction_with_profile(app, thread_id, Some("query-v1")).await
}

async fn interaction_with_profile(
    app: &Router,
    thread_id: i64,
    search_profile: Option<&str>,
) -> CreateInteractionResponse {
    let mut request = json!({
        "threadId": thread_id,
        "text": "Search this answer",
    });
    if let Some(search) = search_profile {
        request["graphCapabilityProfile"] = json!({ "search": search });
    }
    let response = post(
        app,
        "/api/control/interactions",
        Some("control"),
        Body::from(request.to_string()),
    )
    .await;
    let (status, body) = json_response(response).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_value(body).unwrap()
}

async fn project_interaction(
    app: &Router,
    project_id: i64,
    thread_id: i64,
) -> CreateInteractionResponse {
    let response = post(
        app,
        "/api/control/interactions",
        Some("control"),
        Body::from(
            json!({
                "projectId": project_id,
                "threadId": thread_id,
                "text": "Search this project",
                "graphCapabilityProfile": {"search": "query-v1"},
            })
            .to_string(),
        ),
    )
    .await;
    let (status, body) = json_response(response).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_value(body).unwrap()
}

#[tokio::test]
async fn disabled_capability_denies_valid_search_before_index_readiness_but_not_preflight() {
    let directory = tempfile::tempdir().unwrap();
    let graph = GraphDatabase::open(directory.path().join("graph.db"))
        .await
        .unwrap();
    let app = router(ServerState::new(graph, "control"));
    let interaction = interaction_with_profile(&app, 79, None).await;

    let denied = post(
        &app,
        "/api/graph/search",
        Some(&interaction.graph_token),
        query_body(json!({})),
    )
    .await;
    let (status, body) = json_response(denied).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "capability_not_granted");

    let malformed = post(
        &app,
        "/api/graph/search",
        Some(&interaction.graph_token),
        Body::from(
            json!({
                "queryContractVersion": 1,
                "query": "CREATE (n:Content)",
                "parameters": {},
                "budget": {},
            })
            .to_string(),
        ),
    )
    .await;
    let (status, body) = json_response(malformed).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "query_construct_forbidden");
}

#[tokio::test]
async fn disabled_authoring_capability_still_projects_for_a_later_enabled_turn() {
    let fixture = fixture().await;
    let author = interaction_with_profile(&fixture.app, 81, None).await;
    author_answer(&fixture.graph, &author).await;

    let submitted = post(
        &fixture.app,
        "/api/graph/submit",
        Some(&author.graph_token),
        Body::from(json!({"nodeId": author.node.id}).to_string()),
    )
    .await;
    assert_eq!(submitted.status(), StatusCode::OK);

    let denied = post(
        &fixture.app,
        "/api/graph/search",
        Some(&author.graph_token),
        query_body(json!({})),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);

    let reader = interaction_with_profile(&fixture.app, 81, Some("query-v1")).await;
    let searched = post(
        &fixture.app,
        "/api/graph/search",
        Some(&reader.graph_token),
        query_body(json!({})),
    )
    .await;
    let (status, body) = json_response(searched).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({
            "queryContractVersion": 1,
            "columns": ["title"],
            "rows": [[{"type":"string","value":"Searchable answer"}]],
            "truncated": false,
        })
    );
}

#[tokio::test]
async fn remint_is_idempotent_only_for_the_exact_capability_profile() {
    let fixture = fixture().await;
    let created = post(
        &fixture.app,
        "/api/control/interactions",
        Some("control"),
        Body::from(
            json!({
                "threadId": 80,
                "text": "Prepare without capability",
                "mintCapability": false,
            })
            .to_string(),
        ),
    )
    .await;
    let (status, body) = json_response(created).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let created: CreateInteractionResponse = serde_json::from_value(body).unwrap();
    let remint_body = json!({
        "nodeId": created.node.id,
        "graphToken": "fixed-profile-token",
        "graphCapabilityProfile": { "search": "disabled" },
    });
    for _ in 0..2 {
        let response = post(
            &fixture.app,
            "/api/control/capabilities",
            Some("control"),
            Body::from(remint_body.to_string()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    let conflict = post(
        &fixture.app,
        "/api/control/capabilities",
        Some("control"),
        Body::from(
            json!({
                "nodeId": created.node.id,
                "graphToken": "fixed-profile-token",
                "graphCapabilityProfile": { "search": "query-v1" },
            })
            .to_string(),
        ),
    )
    .await;
    let (status, body) = json_response(conflict).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "capability_token_conflict");
}

fn query_body(budget: Value) -> Body {
    query_body_for_target(None, budget)
}

fn query_body_for_target(target: Option<Value>, budget: Value) -> Body {
    let mut request = json!({
        "queryContractVersion": 1,
        "query": "MATCH (n:Content) WHERE n.title = $title RETURN n.title AS title",
        "parameters": {"title": {"type": "string", "value": "Searchable answer"}},
        "budget": budget,
    });
    if let Some(target) = target {
        request["target"] = target;
    }
    Body::from(request.to_string())
}

fn preflight_failures() -> Vec<(String, &'static str, &'static str)> {
    vec![
        (
            json!({
                "queryContractVersion": 2,
                "query": "MATCH (n:Content) RETURN n",
                "parameters": {},
                "budget": {},
            })
            .to_string(),
            "unsupported_query_contract_version",
            "envelope",
        ),
        (
            json!({
                "queryContractVersion": 1,
                "query": "",
                "parameters": {},
                "budget": {},
            })
            .to_string(),
            "invalid_request",
            "envelope",
        ),
        (
            json!({
                "queryContractVersion": 1,
                "query": "MATCH (n:Content) RETURN n",
                "parameters": {"not-an-identifier": {"type": "string", "value": "x"}},
                "budget": {},
            })
            .to_string(),
            "invalid_request",
            "envelope",
        ),
        (
            json!({
                "queryContractVersion": 1,
                "query": "MATCH (n:Content) RETURN n",
                "parameters": {},
                "budget": {"queryBytes": 1},
            })
            .to_string(),
            "query_bytes_exceeded",
            "envelope",
        ),
        (
            json!({
                "queryContractVersion": 1,
                "query": "CREATE (n:Content)",
                "parameters": {},
                "budget": {},
            })
            .to_string(),
            "query_construct_forbidden",
            "parse",
        ),
        (
            json!({
                "queryContractVersion": 1,
                "query": "MATCH (n:Unknown) RETURN n",
                "parameters": {},
                "budget": {},
            })
            .to_string(),
            "unknown_label",
            "plan",
        ),
    ]
}

async fn author_answer(graph: &GraphDatabase, interaction: &CreateInteractionResponse) -> LayerId {
    let writer = graph
        .writer_for_subgraph(interaction.node.id)
        .await
        .unwrap();
    let answer = writer
        .submit_node(&NodeDraft {
            client_key: "search-answer".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Searchable answer".into(),
            detail: "Published before the submit acknowledgement returns.".into(),
        })
        .await
        .unwrap();
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: "search-layer".into(),
            nodes: vec![answer.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(vec![NodePlacement {
                node_id: answer.id,
                x: 0.5,
                y: 0.5,
            }])),
            size_justification: None,
        })
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "search-response".into(),
            source_node_id: interaction.node.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(layer.id),
            interaction_text: None,
        })
        .await
        .unwrap();
    layer.id
}

#[tokio::test]
async fn submit_acknowledgement_is_immediately_searchable_through_the_public_route() {
    let fixture = fixture().await;
    let author = interaction(&fixture.app, 73).await;
    let reader = interaction(&fixture.app, 73).await;
    author_answer(&fixture.graph, &author).await;

    let submitted = post(
        &fixture.app,
        "/api/graph/submit",
        Some(&author.graph_token),
        Body::from(json!({"nodeId": author.node.id}).to_string()),
    )
    .await;
    assert_eq!(submitted.status(), StatusCode::OK);

    let terminal = post(
        &fixture.app,
        "/api/graph/search",
        Some(&author.graph_token),
        query_body(json!({})),
    )
    .await;
    let (status, body) = json_response(terminal).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "authority_generation_expired");

    let searched = post(
        &fixture.app,
        "/api/graph/search",
        Some(&reader.graph_token),
        query_body(json!({})),
    )
    .await;
    let (status, body) = json_response(searched).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({
            "queryContractVersion": 1,
            "columns": ["title"],
            "rows": [[{"type":"string","value":"Searchable answer"}]],
            "truncated": false,
        })
    );
}

#[tokio::test]
async fn store_ahead_of_rolled_back_sqlite_is_not_searchable_before_retry() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("graph.db");
    let sqlite = GraphDatabase::open(&database_path).await.unwrap();
    let index = Arc::new(
        LadybugSearchIndex::open_reconciled(&database_path, &sqlite)
            .await
            .unwrap(),
    );
    let crashed = Arc::new(AtomicBool::new(false));
    let crash_once = crashed.clone();
    let graph = sqlite
        .with_search_index(index.clone())
        .with_completion_crash_hook(Arc::new(move |point| {
            if point == CompletionCrashPoint::AfterSearchCommit
                && !crash_once.swap(true, Ordering::SeqCst)
            {
                panic!("deterministic failure after Ladybug commit");
            }
        }));
    let app = router(ServerState::new(graph.clone(), "control").with_search_index(index));
    let author = interaction(&app, 72).await;
    let reader = interaction(&app, 72).await;
    author_answer(&graph, &author).await;

    let crashing_app = app.clone();
    let author_token = author.graph_token.clone();
    let author_node_id = author.node.id;
    let submit = tokio::spawn(async move {
        post(
            &crashing_app,
            "/api/graph/submit",
            Some(&author_token),
            Body::from(json!({"nodeId": author_node_id}).to_string()),
        )
        .await
    });
    assert!(submit.await.unwrap_err().is_panic());
    assert!(crashed.load(Ordering::SeqCst));
    assert_eq!(
        graph
            .search_index_revision(SearchTarget::Thread(ThreadId::new(72).unwrap()))
            .await
            .unwrap(),
        None,
    );
    assert!(
        graph
            .accepted_graph_closure(author.node.id)
            .await
            .unwrap()
            .is_none()
    );

    let searched = post(
        &app,
        "/api/graph/search",
        Some(&reader.graph_token),
        query_body(json!({})),
    )
    .await;
    let (status, body) = json_response(searched).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "search_unavailable", "{body}");

    let retried = post(
        &app,
        "/api/graph/submit",
        Some(&author.graph_token),
        Body::from(json!({"nodeId": author.node.id}).to_string()),
    )
    .await;
    assert_eq!(retried.status(), StatusCode::OK);
    assert_eq!(
        graph
            .search_index_revision(SearchTarget::Thread(ThreadId::new(72).unwrap()))
            .await
            .unwrap()
            .map(|revision| revision.value()),
        Some(2),
    );
    let searched = post(
        &app,
        "/api/graph/search",
        Some(&reader.graph_token),
        query_body(json!({})),
    )
    .await;
    let (status, body) = json_response(searched).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["rows"].as_array().map(Vec::len), Some(1), "{body}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ladybug_commit_is_not_searchable_before_sqlite_acknowledgement() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("graph.db");
    let sqlite = GraphDatabase::open(&database_path).await.unwrap();
    let index = Arc::new(
        LadybugSearchIndex::open_reconciled(&database_path, &sqlite)
            .await
            .unwrap(),
    );
    let reached_commit = Arc::new(Barrier::new(2));
    let release_commit = Arc::new(Barrier::new(2));
    let hook_reached = reached_commit.clone();
    let hook_release = release_commit.clone();
    let graph = sqlite
        .with_search_index(index.clone())
        .with_completion_crash_hook(Arc::new(move |point| {
            if point == CompletionCrashPoint::AfterSearchCommit {
                hook_reached.wait();
                hook_release.wait();
            }
        }));
    let app = router(ServerState::new(graph.clone(), "control").with_search_index(index));
    let author = interaction(&app, 71).await;
    let reader = interaction(&app, 71).await;
    author_answer(&graph, &author).await;

    let submitting_app = app.clone();
    let author_token = author.graph_token.clone();
    let author_node_id = author.node.id;
    let submit = tokio::spawn(async move {
        post(
            &submitting_app,
            "/api/graph/submit",
            Some(&author_token),
            Body::from(json!({"nodeId": author_node_id}).to_string()),
        )
        .await
    });
    tokio::task::spawn_blocking(move || reached_commit.wait())
        .await
        .unwrap();

    let searched_during_commit = post(
        &app,
        "/api/graph/search",
        Some(&reader.graph_token),
        query_body(json!({})),
    )
    .await;
    let (status, body) = json_response(searched_during_commit).await;
    tokio::task::spawn_blocking(move || release_commit.wait())
        .await
        .unwrap();
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "search_unavailable", "{body}");

    assert_eq!(submit.await.unwrap().status(), StatusCode::OK);
    let searched_after_ack = post(
        &app,
        "/api/graph/search",
        Some(&reader.graph_token),
        query_body(json!({})),
    )
    .await;
    let (status, body) = json_response(searched_after_ack).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["rows"].as_array().map(Vec::len), Some(1), "{body}");
}

#[tokio::test]
async fn a_different_retry_cannot_confirm_an_orphaned_publication() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("graph.db");
    let sqlite = GraphDatabase::open(&database_path).await.unwrap();
    let index = Arc::new(
        LadybugSearchIndex::open_reconciled(&database_path, &sqlite)
            .await
            .unwrap(),
    );
    let crashed = Arc::new(AtomicBool::new(false));
    let crash_once = crashed.clone();
    let graph = sqlite
        .with_search_index(index.clone())
        .with_completion_crash_hook(Arc::new(move |point| {
            if point == CompletionCrashPoint::AfterSearchCommit
                && !crash_once.swap(true, Ordering::SeqCst)
            {
                panic!("deterministic failure after Ladybug commit");
            }
        }));
    let app = router(ServerState::new(graph.clone(), "control").with_search_index(index));
    let author = interaction(&app, 70).await;
    let reader = interaction(&app, 70).await;
    let orphaned_layer = author_answer(&graph, &author).await;

    let crashing_app = app.clone();
    let author_token = author.graph_token.clone();
    let author_node_id = author.node.id;
    let submit = tokio::spawn(async move {
        post(
            &crashing_app,
            "/api/graph/submit",
            Some(&author_token),
            Body::from(json!({"nodeId": author_node_id}).to_string()),
        )
        .await
    });
    assert!(submit.await.unwrap_err().is_panic());

    let writer = graph.writer_for_subgraph(author.node.id).await.unwrap();
    let replacement = writer
        .submit_node(&NodeDraft {
            client_key: "replacement-answer".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Replacement answer".into(),
            detail: "This is the only canonically accepted answer.".into(),
        })
        .await
        .unwrap();
    let replacement_layer = writer
        .submit_layer(&LayerDraft {
            client_key: "replacement-layer".into(),
            nodes: vec![replacement.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(vec![NodePlacement {
                node_id: replacement.id,
                x: 0.5,
                y: 0.5,
            }])),
            size_justification: None,
        })
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "search-response".into(),
            source_node_id: author.node.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Replacement".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(replacement_layer.id),
            interaction_text: None,
        })
        .await
        .unwrap();
    writer.discard_layer(orphaned_layer).await.unwrap();

    let different_submit = post(
        &app,
        "/api/graph/submit",
        Some(&author.graph_token),
        Body::from(json!({"nodeId": author.node.id}).to_string()),
    )
    .await;
    assert_eq!(different_submit.status(), StatusCode::INTERNAL_SERVER_ERROR);

    let searched = post(
        &app,
        "/api/graph/search",
        Some(&reader.graph_token),
        query_body(json!({})),
    )
    .await;
    let (status, body) = json_response(searched).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "search_unavailable", "{body}");
}

#[tokio::test]
async fn explicit_selectors_intersect_canonical_project_membership() {
    let fixture = fixture().await;
    let author_73 = project_interaction(&fixture.app, 41, 73).await;
    let author_74 = project_interaction(&fixture.app, 41, 74).await;
    for author in [&author_73, &author_74] {
        author_answer(&fixture.graph, author).await;
        let submitted = post(
            &fixture.app,
            "/api/graph/submit",
            Some(&author.graph_token),
            Body::from(json!({"nodeId": author.node.id}).to_string()),
        )
        .await;
        assert_eq!(submitted.status(), StatusCode::OK);
    }
    let reader = project_interaction(&fixture.app, 41, 73).await;

    for (target, expected_rows) in [
        (json!({"scope": "thread", "id": 73}), 1),
        (json!({"scope": "thread", "id": 74}), 1),
        (json!({"scope": "project", "id": 41}), 2),
    ] {
        let response = post(
            &fixture.app,
            "/api/graph/search",
            Some(&reader.graph_token),
            query_body_for_target(Some(target), json!({})),
        )
        .await;
        let (status, body) = json_response(response).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["rows"].as_array().map(Vec::len),
            Some(expected_rows),
            "{body}"
        );
    }

    fixture.index.set_contract_test_readiness(
        SearchTarget::Project(ProjectId::new(41).unwrap()),
        SearchTargetReadiness::Rebuilding,
    );
    for target in [
        None,
        Some(json!({"scope": "thread", "id": 74})),
        Some(json!({"scope": "project", "id": 41})),
    ] {
        let response = post(
            &fixture.app,
            "/api/graph/search",
            Some(&reader.graph_token),
            query_body_for_target(target, json!({})),
        )
        .await;
        let (status, body) = json_response(response).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["error"]["code"], "search_unavailable", "{body}");
    }
    fixture.index.set_contract_test_readiness(
        SearchTarget::Project(ProjectId::new(41).unwrap()),
        SearchTargetReadiness::Ready,
    );

    let mut denial_bodies = Vec::new();
    for target in [
        json!({"scope": "thread", "id": 75}),
        json!({"scope": "thread", "id": 999}),
        json!({"scope": "project", "id": 42}),
        json!({"scope": "project", "id": 999}),
    ] {
        let response = post(
            &fixture.app,
            "/api/graph/search",
            Some(&reader.graph_token),
            query_body_for_target(Some(target), json!({})),
        )
        .await;
        let (status, body) = json_response(response).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["error"]["code"], "inaccessible_or_missing", "{body}");
        assert_eq!(body["error"]["phase"], "authorize", "{body}");
        assert_eq!(body["error"]["path"], "target", "{body}");
        denial_bodies.push(body);
    }
    for body in &denial_bodies[1..] {
        assert_eq!(body, &denial_bodies[0]);
    }

    let standalone = interaction(&fixture.app, 90).await;
    let response = post(
        &fixture.app,
        "/api/graph/search",
        Some(&standalone.graph_token),
        query_body_for_target(Some(json!({"scope": "project", "id": 41})), json!({})),
    )
    .await;
    let (status, body) = json_response(response).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "scope_not_granted", "{body}");
    assert_eq!(body["error"]["phase"], "authorize", "{body}");
    assert_eq!(body["error"]["path"], "target.scope", "{body}");
}

#[tokio::test]
async fn project_backed_omitted_thread_query_survives_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("graph.db");
    {
        let sqlite = GraphDatabase::open(&database_path).await.unwrap();
        let index = Arc::new(
            LadybugSearchIndex::open_reconciled(&database_path, &sqlite)
                .await
                .unwrap(),
        );
        let graph = sqlite.with_search_index(index.clone());
        let app = router(ServerState::new(graph.clone(), "control").with_search_index(index));
        let author = project_interaction(&app, 41, 73).await;
        author_answer(&graph, &author).await;
        let submitted = post(
            &app,
            "/api/graph/submit",
            Some(&author.graph_token),
            Body::from(json!({"nodeId": author.node.id}).to_string()),
        )
        .await;
        assert_eq!(submitted.status(), StatusCode::OK);
    }

    let sqlite = GraphDatabase::open(&database_path).await.unwrap();
    let index = Arc::new(
        LadybugSearchIndex::open_reconciled(&database_path, &sqlite)
            .await
            .unwrap(),
    );
    index.wait_until_reconciled().await.unwrap();
    assert_eq!(
        index.target_readiness(SearchTarget::Project(ProjectId::new(41).unwrap())),
        SearchTargetReadiness::Ready,
    );
    let graph = sqlite.with_search_index(index.clone());
    let app = router(ServerState::new(graph, "control").with_search_index(index));
    let reader = project_interaction(&app, 41, 73).await;
    let response = post(
        &app,
        "/api/graph/search",
        Some(&reader.graph_token),
        query_body(json!({})),
    )
    .await;
    let (status, body) = json_response(response).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["rows"].as_array().map(Vec::len), Some(1), "{body}");
}

#[tokio::test]
async fn advance_acknowledgement_is_immediately_searchable_through_the_public_route() {
    let fixture = temporal_fixture().await;
    let interaction = interaction(&fixture.app, 74).await;
    let writer = fixture
        .graph
        .writer_for_subgraph(interaction.node.id)
        .await
        .unwrap();
    let answer = writer
        .submit_node(&NodeDraft {
            client_key: "working-search-answer".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Searchable answer".into(),
            detail: "Published by a non-terminal current advance.".into(),
        })
        .await
        .unwrap();
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: "working-search-layer".into(),
            nodes: vec![answer.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(vec![NodePlacement {
                node_id: answer.id,
                x: 0.5,
                y: 0.5,
            }])),
            size_justification: None,
        })
        .await
        .unwrap();

    let advanced = post(
        &fixture.app,
        "/api/graph/current/transitions",
        Some(&interaction.graph_token),
        Body::from(
            json!({
                "expectedRevision": 0,
                "operationKey": "advance-searchable-work",
                "transition": {"kind": "advance", "layerId": layer.id},
            })
            .to_string(),
        ),
    )
    .await;
    let (status, body) = json_response(advanced).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["revision"], 1);
    assert_eq!(body["lifecycle"], "active");

    let searched = post(
        &fixture.app,
        "/api/graph/search",
        Some(&interaction.graph_token),
        query_body(json!({})),
    )
    .await;
    let (status, body) = json_response(searched).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({
            "queryContractVersion": 1,
            "columns": ["title"],
            "rows": [[{"type":"string","value":"Searchable answer"}]],
            "truncated": false,
        })
    );
}

#[tokio::test]
async fn envelope_precedence_and_capability_revocation_are_non_oracular() {
    let fixture = fixture().await;
    let interaction = interaction(&fixture.app, 73).await;

    for forbidden in [
        r#"{"queryContractVersion":1,"projectId":41,"query":"broken"}"#,
        r#"{"queryContractVersion":1,"query":"a","query":"b"}"#,
        r#"{"queryContractVersion":1,"query":"unterminated""#,
    ] {
        let response = post(
            &fixture.app,
            "/api/graph/search",
            Some("revoked-or-invented"),
            Body::from(forbidden),
        )
        .await;
        let (status, body) = json_response(response).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["error"]["code"], "invalid_request");
        assert_eq!(body["error"]["phase"], "envelope");
        assert_eq!(body["error"]["path"], "request");
    }

    let invalid_target = post(
        &fixture.app,
        "/api/graph/search",
        Some("revoked-or-invented"),
        Body::from(
            r#"{"queryContractVersion":1,"target":{"scope":"thread","id":0},"query":"CREATE (n:Content)","parameters":{},"budget":{}}"#,
        ),
    )
    .await;
    let (status, body) = json_response(invalid_target).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "invalid_request");
    assert_eq!(body["error"]["phase"], "envelope");
    assert_eq!(body["error"]["path"], "target.id");

    let explicit_target_still_reaches_query_parsing = post(
        &fixture.app,
        "/api/graph/search",
        Some("revoked-or-invented"),
        Body::from(
            r#"{"queryContractVersion":1,"target":{"scope":"thread","id":73},"query":"CREATE (n:Content)","parameters":{},"budget":{}}"#,
        ),
    )
    .await;
    let (status, body) = json_response(explicit_target_still_reaches_query_parsing).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "query_construct_forbidden");
    assert_eq!(body["error"]["phase"], "parse");

    let missing = post(
        &fixture.app,
        "/api/graph/search",
        None,
        query_body(json!({})),
    )
    .await;
    assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);

    let invalid_query = post(
        &fixture.app,
        "/api/graph/search",
        Some(&interaction.graph_token),
        Body::from(
            json!({
                "queryContractVersion": 1,
                "query": "CREATE (n:Content)",
                "parameters": {},
                "budget": {},
            })
            .to_string(),
        ),
    )
    .await;
    let (status, body) = json_response(invalid_query).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "query_construct_forbidden");
    assert_eq!(body["error"]["phase"], "parse");
    assert_eq!(body["error"]["path"], "query");
    assert!(body["error"]["message"].is_string());

    let revoked = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/control/capabilities")
                .header("content-type", "application/json")
                .header("authorization", "Bearer control")
                .body(Body::from(
                    json!({"graphToken": interaction.graph_token}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::OK);

    for token in [
        Some(interaction.graph_token.as_str()),
        Some("invented-token"),
        None,
    ] {
        for (request, code, phase) in preflight_failures() {
            let response = post(
                &fixture.app,
                "/api/graph/search",
                token,
                Body::from(request),
            )
            .await;
            let (status, body) = json_response(response).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
            assert_eq!(body["error"]["code"], code, "{body}");
            assert_eq!(body["error"]["phase"], phase, "{body}");
        }
    }

    let denied = post(
        &fixture.app,
        "/api/graph/search",
        Some(&interaction.graph_token),
        query_body(json!({})),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn unavailable_targets_are_generic_and_a_cancelled_deadline_leaves_the_store_reusable() {
    let fixture = fixture().await;
    let author = interaction(&fixture.app, 73).await;
    let reader = interaction(&fixture.app, 73).await;
    author_answer(&fixture.graph, &author).await;
    fixture
        .graph
        .writer_for_subgraph(author.node.id)
        .await
        .unwrap()
        .complete(author.node.id)
        .await
        .unwrap();

    fixture.index.set_contract_test_readiness(
        SearchTarget::Thread(ThreadId::new(73).unwrap()),
        SearchTargetReadiness::Rebuilding,
    );
    let unavailable = post(
        &fixture.app,
        "/api/graph/search",
        Some(&reader.graph_token),
        query_body(json!({})),
    )
    .await;
    let (status, body) = json_response(unavailable).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        body,
        json!({"error":{"code":"search_unavailable","message":"Graph search is temporarily unavailable."}})
    );
    assert!(!body.to_string().contains("73"));
    assert!(!body.to_string().contains("rebuild"));

    fixture.index.set_contract_test_readiness(
        SearchTarget::Thread(ThreadId::new(73).unwrap()),
        SearchTargetReadiness::Ready,
    );
    let timed_out = post(
        &fixture.app,
        "/api/graph/search",
        Some(&reader.graph_token),
        query_body(json!({"wallTimeMs": 0})),
    )
    .await;
    let (status, body) = json_response(timed_out).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "wall_time_exceeded");

    let reused = post(
        &fixture.app,
        "/api/graph/search",
        Some(&reader.graph_token),
        query_body(json!({})),
    )
    .await;
    assert_eq!(reused.status(), StatusCode::OK);
}

#[tokio::test]
async fn missing_index_uses_the_same_generic_unavailable_boundary() {
    let graph = GraphDatabase::in_memory().await.unwrap();
    let app = router(ServerState::new(graph, "control"));
    let interaction = interaction(&app, 73).await;
    let response = post(
        &app,
        "/api/graph/search",
        Some(&interaction.graph_token),
        query_body(json!({})),
    )
    .await;
    let (status, body) = json_response(response).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "search_unavailable");

    for (request, code, phase) in preflight_failures() {
        let response = post(
            &app,
            "/api/graph/search",
            Some(&interaction.graph_token),
            Body::from(request),
        )
        .await;
        let (status, body) = json_response(response).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["error"]["code"], code, "{body}");
        assert_eq!(body["error"]["phase"], phase, "{body}");
    }
}

#[tokio::test]
async fn dropping_an_in_flight_http_request_cancels_its_job_and_reuses_the_store() {
    let cancellation = QueryCancellation::default();
    cancellation.hold_after_started_for_test();
    let fixture = fixture_with_cancellation(Some(cancellation.clone())).await;
    let author = interaction(&fixture.app, 73).await;
    let reader = interaction(&fixture.app, 73).await;
    author_answer(&fixture.graph, &author).await;
    fixture
        .graph
        .writer_for_subgraph(author.node.id)
        .await
        .unwrap()
        .complete(author.node.id)
        .await
        .unwrap();

    let app = fixture.app.clone();
    let token = reader.graph_token.clone();
    let in_flight = tokio::spawn(async move {
        post(
            &app,
            "/api/graph/search",
            Some(&token),
            query_body(json!({})),
        )
        .await
    });
    cancellation.wait_until_started().await;
    in_flight.abort();
    let _ = in_flight.await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while !cancellation.is_cancelled() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropping the HTTP request did not signal query cancellation");
    cancellation.release_after_started_for_test();

    let reused = tokio::time::timeout(
        Duration::from_secs(2),
        post(
            &fixture.app,
            "/api/graph/search",
            Some(&reader.graph_token),
            query_body(json!({})),
        ),
    )
    .await
    .expect("the cancelled Ladybug job did not release the shared store");
    assert_eq!(reused.status(), StatusCode::OK);
}
