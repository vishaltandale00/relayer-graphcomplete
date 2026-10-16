#![cfg(feature = "ladybug")]

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use relayer_graph_core::*;
use relayer_graph_server::{
    CreateInteractionResponse, ServerState, router, search_index::LadybugSearchIndex,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn interaction(app: &Router, thread: i64, planned: bool) -> CreateInteractionResponse {
    let (status, value) = request(
        app,
        "POST",
        "/api/control/interactions",
        "control",
        json!({"threadId":thread,"text":"Develop the launch proposal","livingPlan":planned}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    serde_json::from_value(value).unwrap()
}
async fn search(app: &Router, token: &str) -> Value {
    let (status,value)=request(app,"POST","/api/graph/search",token,json!({"queryContractVersion":1,"query":"MATCH (n:Content) WHERE n.kind = $kind RETURN n AS plan ORDER BY plan DESC LIMIT 8","parameters":{"kind":{"type":"string","value":"interaction-plan"}}})).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}
async fn publish(app: &Router, token: &str, key: &str, detail: &str) -> PlanPublication {
    let (status, value) = request(
        app,
        "POST",
        "/api/graph/plans",
        token,
        json!({"clientKey":key,"title":"Launch plan","detail":detail}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    serde_json::from_value(value).unwrap()
}
async fn response(writer: &GraphWriter, owner: NodeId, key: &str) -> (GraphNode, GraphLayer) {
    let node = writer
        .submit_node(&NodeDraft {
            client_key: format!("{key}-node"),
            kind: "concept".into(),
            icon: "search".into(),
            title: key.into(),
            detail: "Research remains pending a budget decision.".into(),
        })
        .await
        .unwrap();
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: format!("{key}-layer"),
            nodes: vec![node.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(
                vec![NodePlacement {
                    node_id: node.id,
                    x: 0.5,
                    y: 0.5,
                }],
                "default",
            )),
            size_justification: None,
            default_node_id: Some(node.id),
        })
        .await
        .unwrap();
    writer
        .add_action(&action(owner, None, Some(layer.id), "root-response"))
        .await
        .unwrap();
    (node, layer)
}
fn action(
    source: NodeId,
    source_layer: Option<LayerId>,
    target: Option<LayerId>,
    key: &str,
) -> ActionDraft {
    ActionDraft {
        client_key: key.into(),
        source_node_id: source,
        source_layer_id: source_layer,
        kind: ActionKind::Navigate,
        relation: Some(NavigateRelation::Expand),
        label: "View the work".into(),
        variant: Default::default(),
        icon: None,
        description: None,
        target_layer_id: target,
        interaction_text: None,
        reusable: None,
        input_action_ids: Vec::new(),
        input: None,
    }
}
async fn fixture(path: &std::path::Path) -> (GraphDatabase, Router) {
    let database = GraphDatabase::open(path).await.unwrap();
    let temporal = TemporalFeatureConfig {
        config_version: 1,
        schema_read: true,
        root_current_write: true,
        projection_ui: true,
        invoke_resolution: true,
        provider_recursion: true,
    };
    database.set_temporal_features(temporal).await.unwrap();
    let index = Arc::new(
        LadybugSearchIndex::open_reconciled(path, &database)
            .await
            .unwrap(),
    );
    let database = database.with_search_index(index.clone());
    let app = router(
        ServerState::new(database.clone(), "control")
            .with_temporal_features(temporal)
            .with_search_index(index),
    );
    (database, app)
}

#[tokio::test]
async fn running_plans_are_searchable_by_real_children_and_survive_return_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let (database, app) = fixture(&path).await;
    let parent = interaction(&app, 73, true).await;
    let writer = database.writer_for_subgraph(parent.node.id).await.unwrap();
    assert!(
        writer
            .interaction_input()
            .await
            .unwrap()
            .completion_contract
            .unwrap()
            .return_requirements
            .contains(&CompletionReturnRequirement::PlanContribution)
    );
    // Valid publications must remain discoverable through frozen query-v1,
    // including JSON expansion of escape-heavy input.
    for detail in ["x".repeat(20 * 1024), "\u{0001}".repeat(3 * 1024)] {
        let (status, value) = request(
            &app,
            "POST",
            "/api/graph/plans",
            &parent.graph_token,
            json!({"clientKey":"oversized","title":"Large plan","detail":detail}),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{value}");
        assert_eq!(value["error"]["code"], "plan_too_large");
    }
    let first=publish(&app,&parent.graph_token,"initial","Research: underway. Budget: waiting for user. Interface: compare options and ask for a budget.").await;
    assert_eq!(first.interaction_node_id, parent.node.id);
    let exact=publish(&app,&parent.graph_token,"initial","Research: underway. Budget: waiting for user. Interface: compare options and ask for a budget.").await;
    assert_eq!(first, exact);
    let (status, conflict) = request(
        &app,
        "POST",
        "/api/graph/plans",
        &parent.graph_token,
        json!({"clientKey":"initial","title":"Launch plan","detail":"Changed"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(conflict["error"]["code"], "idempotency_conflict");
    let (source, layer) = response(&writer, parent.node.id, "Research").await;
    let mut invoke = action(source.id, Some(layer.id), None, "research-call");
    invoke.kind = ActionKind::Invoke;
    invoke.relation = None;
    invoke.interaction_text = Some("Investigate launch options".into());
    invoke.reusable = Some(true);
    let callable = writer.add_action(&invoke).await.unwrap();
    let (child, _) = writer
        .prepare_recursive_invocation(callable.id, "child-one")
        .await
        .unwrap();
    let (sibling, _) = writer
        .prepare_recursive_invocation(callable.id, "child-two")
        .await
        .unwrap();
    let child_writer = database.writer_for_subgraph(child.id).await.unwrap();
    assert!(
        child_writer
            .interaction_input()
            .await
            .unwrap()
            .completion_contract
            .unwrap()
            .return_requirements
            .contains(&CompletionReturnRequirement::PlanContribution)
    );
    // Mint only a capability for the exact already-prepared invocation; no new plan snapshot.
    let (status, capability) = request(
        &app,
        "POST",
        "/api/control/capabilities",
        "control",
        json!({"nodeId":child.id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{capability}");
    let child_token = capability["graphToken"].as_str().unwrap();
    let found = search(&app, child_token).await;
    assert_eq!(
        found["rows"][0][0]["id"],
        format!("content:{}", first.node.id)
    );
    assert_eq!(
        writer.current_completion().await.unwrap().lifecycle,
        CompletionLifecycle::Active
    );
    let audit_pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    let observed: i64=sqlx::query_scalar("SELECT COUNT(*) FROM interaction_plan_reads WHERE interaction_node_id=?1 AND plan_node_id=?2")
        .bind(child.id.value()).bind(first.node.id.value()).fetch_one(&audit_pool).await.unwrap();
    assert_eq!(observed, 1);
    audit_pool.close().await;
    let (status, read) = request(
        &app,
        "GET",
        &format!("/api/graph/plans/{}", first.node.id),
        child_token,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{read}");
    let contribution = publish(
        &app,
        child_token,
        "research",
        "Research: options identified. Budget: waiting. Interface: comparison remains useful.",
    )
    .await;
    assert_eq!(contribution.read_plan_node_ids, vec![first.node.id]);
    // Reading the parent did not permit writing its plan node into ordinary response topology.
    assert!(
        child_writer
            .submit_layer(&LayerDraft {
                client_key: "leak".into(),
                nodes: vec![first.node.id],
                edges: vec![],
                layout: None,
                size_justification: None,
                default_node_id: None
            })
            .await
            .is_err()
    );
    assert!(
        child_writer
            .add_action(&action(first.node.id, None, Some(layer.id), "leak-action"))
            .await
            .is_err()
    );
    let foreign = interaction(&app, 74, true).await;
    assert!(
        search(&app, &foreign.graph_token).await["rows"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_ne!(
        request(
            &app,
            "GET",
            &format!("/api/graph/plans/{}", first.node.id),
            &foreign.graph_token,
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    writer.get_plan(contribution.node.id).await.unwrap();
    writer.publish_plan(&PlanDraft{client_key:"integrated".into(),title:"Launch direction".into(),detail:"Research complete; budget remains waiting. Interface: compare options and collect the budget decision.".into()}).await.unwrap();
    writer.complete(parent.node.id).await.unwrap();
    let sibling_writer = database.writer_for_subgraph(sibling.id).await.unwrap();
    let late = sibling_writer
        .publish_plan(&PlanDraft {
            client_key: "unchanged".into(),
            title: "Budget pending".into(),
            detail: "Reassessed: budget still awaits the user; no semantic transition.".into(),
        })
        .await
        .unwrap();
    assert_eq!(late.interaction_node_id, sibling.id);
    // Child can settle after parent, while honoring its independent analysis integration requirement.
    let (_, child_layer) = response(&child_writer, child.id, "Options").await;
    let mut integration = action(
        source.id,
        Some(layer.id),
        Some(child_layer.id),
        "integrated-options",
    );
    integration.relation = Some(NavigateRelation::Reference);
    child_writer.add_action(&integration).await.unwrap();
    child_writer.complete(child.id).await.unwrap();
    let snapshot = database
        .conversation_graph_snapshot(&[parent.node.id, child.id])
        .await
        .unwrap();
    let portable = serde_json::to_string(&snapshot).unwrap();
    assert!(!portable.contains("interaction-plan"));
    assert!(!portable.contains("Research: underway"));
    drop(sibling_writer);
    drop(child_writer);
    drop(writer);
    drop(app);
    database.close().await;
    let (reopened, reopened_app) = fixture(&path).await;
    let followup = interaction(&reopened_app, 73, true).await;
    let found = search(&reopened_app, &followup.graph_token).await;
    assert_eq!(found["rows"].as_array().unwrap().len(), 4);
    let followup_writer = reopened
        .writer_for_subgraph(followup.node.id)
        .await
        .unwrap();
    followup_writer.get_node(late.node.id).await.unwrap();
    let next = followup_writer
        .publish_plan(&PlanDraft {
            client_key: "after-answer".into(),
            title: "Budget supplied".into(),
            detail: "User selected a budget; next compare feasible rollout options.".into(),
        })
        .await
        .unwrap();
    assert_eq!(next.read_plan_node_ids.len(), 4);
    assert!(next.read_plan_node_ids.contains(&late.node.id));
    drop(followup_writer);
    drop(reopened_app);
    reopened.close().await;
}

#[tokio::test]
async fn return_is_atomic_checkpoints_survive_failure_and_legacy_preparations_stay_legacy() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let (database, app) = fixture(&path).await;
    let legacy = interaction(&app, 81, false).await;
    let planned = interaction(&app, 81, true).await;
    let writer = database.writer_for_subgraph(planned.node.id).await.unwrap();
    let (_, layer) = response(&writer, planned.node.id, "Answer").await;
    assert!(matches!(
        writer.complete(planned.node.id).await,
        Err(GraphError::Validation {
            code: "plan_contribution_required",
            ..
        })
    ));
    assert!(
        database
            .accepted_graph_closure(planned.node.id)
            .await
            .unwrap()
            .is_none()
    );
    let checkpoint = publish(
        &app,
        &planned.graph_token,
        "reassessment",
        "No prior plan; current goal remains awaiting a decision.",
    )
    .await;
    let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER fail_plan_return BEFORE UPDATE OF final_plan_node_id ON interaction_plan_policy BEGIN SELECT RAISE(ABORT,'injected plan association failure'); END").execute(&pool).await.unwrap();
    assert!(writer.complete(planned.node.id).await.is_err());
    assert_eq!(writer.current_completion().await.unwrap().head_revision, 0);
    assert!(
        database
            .accepted_graph_closure(planned.node.id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        search(&app, &legacy.graph_token).await["rows"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    sqlx::query("DROP TRIGGER fail_plan_return")
        .execute(&pool)
        .await
        .unwrap();
    writer.complete(planned.node.id).await.unwrap();
    assert!(
        writer
            .publish_plan(&PlanDraft {
                client_key: "after-return".into(),
                title: "Invalid".into(),
                detail: "Cannot publish after Return".into()
            })
            .await
            .is_err()
    );
    let associated: i64 = sqlx::query_scalar(
        "SELECT final_plan_node_id FROM interaction_plan_policy WHERE interaction_node_id=?1",
    )
    .bind(planned.node.id.value())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(associated, checkpoint.node.id.value());
    assert_eq!(
        database
            .current_completion(planned.node.id)
            .await
            .unwrap()
            .final_layer_id,
        Some(layer.id)
    );
    let legacy_writer = database.writer_for_subgraph(legacy.node.id).await.unwrap();
    assert!(
        !legacy_writer
            .interaction_input()
            .await
            .unwrap()
            .completion_contract
            .unwrap()
            .return_requirements
            .contains(&CompletionReturnRequirement::PlanContribution)
    );
    response(&legacy_writer, legacy.node.id, "Legacy").await;
    legacy_writer.complete(legacy.node.id).await.unwrap();
    let stopped = interaction(&app, 81, true).await;
    publish(
        &app,
        &stopped.graph_token,
        "pending",
        "Goal remains pending; not accomplished.",
    )
    .await;
    let stopped_writer = database.writer_for_subgraph(stopped.node.id).await.unwrap();
    stopped_writer
        .transition_current(
            0,
            "stop",
            CurrentTransition::Stop {
                reason: "cancelled_by_user".into(),
            },
        )
        .await
        .unwrap();
    assert!(
        stopped_writer
            .publish_plan(&PlanDraft {
                client_key: "after-stop".into(),
                title: "Invalid".into(),
                detail: "Cannot publish after Stop".into()
            })
            .await
            .is_err()
    );
    let later = interaction(&app, 81, true).await;
    assert_eq!(
        search(&app, &later.graph_token).await["rows"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_ne!(
        request(
            &app,
            "POST",
            "/api/graph/plans",
            &stopped.graph_token,
            json!({"clientKey":"late","title":"Invalid","detail":"Cannot publish after Stop"})
        )
        .await
        .0,
        StatusCode::OK
    );
    drop(stopped_writer);
    drop(legacy_writer);
    drop(writer);
    pool.close().await;
    drop(app);
    database.close().await;
}

#[tokio::test]
async fn bounded_plan_text_remains_discoverable_in_encoded_query_v1_results() {
    let directory = tempfile::tempdir().unwrap();
    let (database, app) = fixture(&directory.path().join("graph.db")).await;
    let current = interaction(&app, 82, true).await;
    for (index, detail) in ["x".repeat(7_900), "\u{0001}".repeat(1_300)]
        .iter()
        .enumerate()
    {
        let plan = publish(
            &app,
            &current.graph_token,
            &format!("bounded-{index}"),
            detail,
        )
        .await;
        let found = search(&app, &current.graph_token).await;
        assert!(serde_json::to_vec(&found).unwrap().len() <= 16_384);
        assert!(
            found
                .to_string()
                .contains(&format!("content:{}", plan.node.id.value()))
        );
    }
    drop(app);
    database.close().await;
}
