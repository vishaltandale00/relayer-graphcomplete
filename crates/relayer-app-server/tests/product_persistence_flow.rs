use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, Response, StatusCode},
    response::IntoResponse,
};
use relayer_app_server::conversation_export::{
    ConversationExportRecord, ExportCompletionStatus, ExportTurnOrigin, decode_export_jsonl,
};
use relayer_app_server::{
    CONTROL_COOKIE, RelayerAppServer, RelayerAppServerConfig, RelayerRuntimeConfig,
};
use relayer_graph_core::{
    ActionDraft, ActionKind, ActionVariant, GraphDatabase, LayerDraft, LayerLayout,
    NavigateRelation, NodeDraft, NodeId, NodePlacement, ProjectId as GraphProjectId,
    ThreadId as GraphThreadId,
};
use relayer_graph_server::ServerState as GraphServerState;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};
use tower::ServiceExt;
const ANNOTATION_COOKIE: &str = "relayer_annotation";
const INPUT_OPERATOR_COOKIE: &str = "relayer_input_operator";

#[tokio::test]
async fn eval_input_operator_session_is_server_scoped_to_one_thread_and_occurrence() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-input-operator-scope-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let seed_app = open_app(&database, &root).await;
    let first = response_json(
        seed_app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({
                    "initialMessage": "First thread"
                })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let second = response_json(
        seed_app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({
                    "initialMessage": "Second thread"
                })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let first_id = first["id"].as_i64().unwrap();
    let second_id = second["id"].as_i64().unwrap();
    drop(seed_app);
    let pool = sqlite_pool(&database).await;
    sqlx::query(
        "UPDATE interactions SET completion_status='failed',completion_error='fixture terminal state'",
    )
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
    let graph = Router::new()
        .route(
            "/api/control/input-action-occurrences/canonical",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| async move {
                assert_eq!(body["destinationThreadId"], first_id);
                assert_eq!(
                    body["occurrence"],
                    json!({
                        "presentingInteractionNodeId": 101,
                        "presentingLayerId": 201,
                        "actionId": 301
                    })
                );
                axum::Json(json!({
                    "id": 301,
                    "sourceNodeId": 401,
                    "sourceLayerId": 201,
                    "kind": "input",
                    "label": "Add constraint",
                    "variant": "pill",
                    "control": "text",
                    "prompt": "What constraint applies?",
                    "state": "accepted"
                }))
            }),
        )
        .route(
            "/api/control/interactions",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                let submitted_inputs = serde_json::from_value::<
                    Vec<relayer_graph_core::SubmittedInputDraft>,
                >(body["submittedInputs"].clone())
                .unwrap();
                let semantic_digest = relayer_graph_core::interaction_input_semantic_digest(
                    body["text"].as_str().unwrap(),
                    &submitted_inputs,
                )
                .unwrap();
                let submitted = &body["submittedInputs"][0];
                axum::Json(json!({
                    "node": {"id": 501},
                    "graphToken": "",
                    "inputIdentity": body["inputIdentity"],
                    "inputDigest": body["inputDigest"],
                    "inputChildren": [{
                        "id": "interaction-input-child:1",
                        "parentInteractionNodeId": 501,
                        "occurrence": {
                            "presentingInteractionNodeId": submitted["presentingInteractionNodeId"],
                            "presentingLayerId": submitted["presentingLayerId"],
                            "actionId": submitted["actionId"]
                        },
                        "sourceNodeId": 401,
                        "action": submitted["action"],
                        "value": submitted["value"],
                        "attemptKey": body["inputIdentity"],
                        "authorityDigest": body["inputDigest"],
                        "semanticDigest": semantic_digest
                    }]
                }))
            }),
        )
        .route(
            "/api/control/capabilities",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                axum::Json(json!({"graphToken": body["graphToken"]}))
            })
            .delete(|| async { axum::Json(json!({"revoked": true})) }),
        );
    let harness = Router::new()
        .route(
            "/sessions",
            axum::routing::post(|| async { (StatusCode::CREATED, axum::Json(json!({}))) }),
        )
        .route(
            "/sessions/{id}/complete",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                let node_id = body["graph"]["nodeId"].as_i64().unwrap();
                axum::Json(json!({
                    "output": {
                        "nodeId": node_id,
                        "rootLayer": {"layer": {"id": 1}, "nodes": [], "edges": [], "actions": []}
                    }
                }))
            }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(harness).await;
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion": 1,
            "configurations": [{
                "configuration": {
                    "schemaVersion": 1,
                    "name": "codex-basic",
                    "implementation": "test",
                    "implementationVersion": 1,
                    "permissionBindings": {"ask": {}, "auto": {}},
                    "settings": {}
                },
                "digest": "sha256:test"
            }]
        })
        .to_string(),
    )
    .unwrap();
    let app =
        open_app_with_runtime_allow_override(&database, &root, &catalog, &graph_url, &harness_url)
            .await;
    let token = "input-operator-session-token-000000000001";
    let occurrence = json!({
        "presentingInteractionNodeId": 101,
        "presentingLayerId": 201,
        "actionId": 301
    });
    let registered = app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/internal/input-operator-sessions",
            Some(json!({
                "token": token,
                "threadId": first_id,
                "occurrences": [occurrence]
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(registered.status(), StatusCode::NO_CONTENT);

    let allowed_read = app
        .clone()
        .oneshot(input_operator_request(
            "GET",
            &format!("/api/threads/{first_id}/input-draft"),
            None,
            token,
        ))
        .await
        .unwrap();
    assert_eq!(allowed_read.status(), StatusCode::OK);
    let cross_thread = app
        .clone()
        .oneshot(input_operator_request(
            "GET",
            &format!("/api/threads/{second_id}/input-draft"),
            None,
            token,
        ))
        .await
        .unwrap();
    assert_eq!(cross_thread.status(), StatusCode::NOT_FOUND);
    let generic_write = app
        .clone()
        .oneshot(input_operator_request(
            "POST",
            "/api/projects",
            Some(json!({ "path": root.join("forged"), "name": "forged" })),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(generic_write.status(), StatusCode::FORBIDDEN);
    let scoped_send_without_commit = app
        .clone()
        .oneshot(input_operator_request(
            "POST",
            &format!("/api/threads/{first_id}/interactions"),
            Some(json!({
                "text": "",
                "inputId": "operator-send-1",
                "inputDraftRevision": 0
            })),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(scoped_send_without_commit.status(), StatusCode::NOT_FOUND);
    let scoped_commit = app
        .clone()
        .oneshot(input_operator_request(
            "PUT",
            &format!("/api/threads/{first_id}/input-draft/attachments"),
            Some(json!({
                "occurrence": occurrence,
                "value": {"text": "Keep support load flat"},
                "expectedRevision": 0
            })),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(scoped_commit.status(), StatusCode::OK);
    assert_eq!(response_json(scoped_commit).await["revision"], 1);
    let scoped_send = app
        .clone()
        .oneshot(input_operator_request(
            "POST",
            &format!("/api/threads/{first_id}/interactions"),
            Some(json!({
                "text": "",
                "inputId": "operator-send-1",
                "inputDraftRevision": 1
            })),
            token,
        ))
        .await
        .unwrap();
    let scoped_send_status = scoped_send.status();
    let scoped_send = response_json(scoped_send).await;
    assert_eq!(scoped_send_status, StatusCode::CREATED, "{scoped_send}");
    assert_eq!(scoped_send["text"], "");
    let forged_occurrence = app
        .clone()
        .oneshot(input_operator_request(
            "PUT",
            &format!("/api/threads/{first_id}/input-draft/attachments"),
            Some(json!({
                "occurrence": {
                    "presentingInteractionNodeId": 101,
                    "presentingLayerId": 202,
                    "actionId": 301
                },
                "value": {"text": "forged"},
                "expectedRevision": 0
            })),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(forged_occurrence.status(), StatusCode::NOT_FOUND);

    let revoked = app
        .clone()
        .oneshot(api_request(
            "DELETE",
            "/api/internal/input-operator-sessions",
            Some(json!({ "token": token })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
    let after_revoke = app
        .oneshot(input_operator_request(
            "GET",
            &format!("/api/threads/{first_id}/input-draft"),
            None,
            token,
        ))
        .await
        .unwrap();
    assert_eq!(after_revoke.status(), StatusCode::UNAUTHORIZED);
    graph_task.abort();
    harness_task.abort();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn node_context_drafts_are_thread_scoped_and_survive_reopen() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-context-drafts-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    let thread = response_json(
        app.clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({ "initialMessage": "Explain the queue" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    let saved = response_json(
        app.clone()
            .oneshot(api_request(
                "PUT",
                &format!("/api/threads/{thread_id}/context-drafts/draft-incoming-queue"),
                Some(json!({
                    "target": {
                        "nodeId": 7,
                        "sourceInteractionNodeId": 3,
                        "sourceLayerId": 5
                    },
                    "targetNode": {
                        "id": 7,
                        "kind": "concept",
                        "icon": "list",
                        "title": "Incoming queue",
                        "detail": "Tasks wait here while workers are busy.",
                        "state": "accepted",
                        "workspacePath": "/private/secret",
                        "leaseId": "must-not-persist"
                    },
                    "text": "Call out FIFO ordering.",
                    "expectedRevision": null
                })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(saved["id"], "draft-incoming-queue");
    assert_eq!(saved["threadId"], thread_id);
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["targetNode"]["title"], "Incoming queue");
    assert!(saved["targetNode"].get("workspacePath").is_none());
    assert!(saved["targetNode"].get("leaseId").is_none());

    drop(app);
    let reopened = open_app(&database, &root).await;
    let drafts = response_json(
        reopened
            .oneshot(api_request(
                "GET",
                &format!("/api/threads/{thread_id}/context-drafts"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(drafts["drafts"].as_array().unwrap(), &[saved]);
}

#[tokio::test]
async fn node_context_draft_autosave_is_revisioned_and_idempotent() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-context-draft-revisions-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let app = open_app(&root.join("product.sqlite3"), &root).await;
    let thread = response_json(
        app.clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({ "initialMessage": "Explain the queue" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    let target = json!({
        "target": { "nodeId": 7, "sourceInteractionNodeId": 3, "sourceLayerId": 5 },
        "targetNode": {
            "id": 7, "kind": "concept", "icon": "list", "title": "Incoming queue",
            "detail": "Tasks wait here while workers are busy.", "state": "accepted"
        }
    });
    let save = |draft_id: &str, text: &str, expected_revision: Option<i64>| {
        let mut body = target.clone();
        body["text"] = json!(text);
        body["expectedRevision"] = json!(expected_revision);
        api_request(
            "PUT",
            &format!("/api/threads/{thread_id}/context-drafts/{draft_id}"),
            Some(body),
            true,
        )
    };
    let created = response_json(
        app.clone()
            .oneshot(save("draft-incoming", "First", None))
            .await
            .unwrap(),
    )
    .await;
    let create_replay = response_json(
        app.clone()
            .oneshot(save("draft-incoming", "First", None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(create_replay, created);
    let updated = response_json(
        app.clone()
            .oneshot(save("draft-incoming", "Second", Some(1)))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(updated["revision"], 2);
    assert_eq!(updated["text"], "Second");
    let replayed = response_json(
        app.clone()
            .oneshot(save("draft-incoming", "Second", Some(1)))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(replayed, updated);

    let stale = app
        .clone()
        .oneshot(save("draft-incoming", "Stale overwrite", Some(1)))
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(stale).await["code"],
        "context_draft_revision_conflict"
    );
    let duplicate_target = app
        .oneshot(save("different-draft", "Competing identity", None))
        .await
        .unwrap();
    assert_eq!(duplicate_target.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(duplicate_target).await["code"],
        "context_draft_target_conflict"
    );
}

#[tokio::test]
async fn discarding_a_node_context_draft_is_durable_and_replay_safe() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-context-draft-discard-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    let thread = response_json(
        app.clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({ "initialMessage": "Explain the queue" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    let body = json!({
        "target": { "nodeId": 7, "sourceInteractionNodeId": 3, "sourceLayerId": 5 },
        "targetNode": {
            "id": 7, "kind": "concept", "icon": "list", "title": "Incoming queue",
            "detail": "Tasks wait here while workers are busy.", "state": "accepted"
        },
        "text": "Call out FIFO ordering.", "expectedRevision": null
    });
    let draft_uri = format!("/api/threads/{thread_id}/context-drafts/draft-discard");
    response_json(
        app.clone()
            .oneshot(api_request("PUT", &draft_uri, Some(body.clone()), true))
            .await
            .unwrap(),
    )
    .await;
    let discarded = app
        .clone()
        .oneshot(api_request(
            "DELETE",
            &format!("{draft_uri}?expectedRevision=1"),
            None,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(discarded.status(), StatusCode::NO_CONTENT);

    drop(app);
    let reopened = open_app(&database, &root).await;
    let replay = reopened
        .clone()
        .oneshot(api_request(
            "DELETE",
            &format!("{draft_uri}?expectedRevision=1"),
            None,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::NO_CONTENT);
    let drafts = response_json(
        reopened
            .clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/threads/{thread_id}/context-drafts"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(drafts["drafts"], json!([]));
    let reused = reopened
        .oneshot(api_request("PUT", &draft_uri, Some(body), true))
        .await
        .unwrap();
    assert_eq!(reused.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(reused).await["code"],
        "context_draft_resolved"
    );
}

#[tokio::test]
async fn confirming_a_node_context_draft_revalidates_and_replays_one_annotation() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-context-draft-confirm-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let offline = open_app(&database, &root).await;
    let thread = response_json(
        offline
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({ "initialMessage": "Explain the queue" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    let draft_uri = format!("/api/threads/{thread_id}/context-drafts/draft-confirm");
    response_json(
        offline
            .clone()
            .oneshot(api_request(
                "PUT",
                &draft_uri,
                Some(json!({
                    "target": { "nodeId": 7, "sourceInteractionNodeId": 3, "sourceLayerId": 5 },
                    "targetNode": {
                        "id": 7, "kind": "concept", "icon": "list", "title": "Incoming queue",
                        "detail": "Tasks wait here while workers are busy.", "state": "accepted"
                    },
                    "text": "  Call out FIFO ordering.  ", "expectedRevision": null
                })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    drop(offline);
    let pool = sqlite_pool(&database).await;
    sqlx::query(
        "UPDATE interactions SET graph_node_id=3,completion_status='accepted' WHERE thread_id=?1 AND sequence=1",
    )
    .bind(thread_id)
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
    let graph = Router::new()
        .route(
            "/api/control/context-occurrences/canonical",
            axum::routing::post(|axum::Json(target): axum::Json<Value>| async move {
                match target["nodeId"].as_i64() {
                    Some(7) => axum::Json(json!({
                        "id": 7, "kind": "concept", "icon": "list", "title": "Incoming queue",
                        "detail": "Tasks wait here while workers are busy.", "state": "accepted"
                    }))
                    .into_response(),
                    Some(10) => axum::Json(json!({
                        "id": 10, "kind": "concept", "icon": "list", "title": "Changed queue",
                        "detail": "The accepted node changed unexpectedly.", "state": "accepted"
                    }))
                    .into_response(),
                    _ => (
                        StatusCode::UNPROCESSABLE_ENTITY,
                        axum::Json(json!({
                            "error": {
                                "code": "invalid_context_occurrence",
                                "path": "target",
                                "message": "not in the accepted source completion"
                            }
                        })),
                    )
                        .into_response(),
                }
            }),
        )
        .route(
            "/api/control/interactions/3/layers/6",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "layer": { "id": 6, "nodes": [9], "edges": [], "layout": null, "state": "accepted" },
                    "nodes": [{
                        "id": 9, "kind": "concept", "icon": "archive", "title": "Unreachable queue",
                        "detail": "This accepted layer is outside the source completion.", "state": "accepted"
                    }],
                    "edges": [], "actions": []
                }))
            }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(Router::new()).await;
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":"codex-basic","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},
                "modelCompatibility":[{"providerId":"codex"}],
                "executionAccessContracts":["managed-runtime@1"],"settings":{}
            },"digest":"sha256:test"}]
        })
        .to_string(),
    )
    .unwrap();
    let app =
        open_app_with_runtime_allow_override(&database, &root, &catalog, &graph_url, &harness_url)
            .await;
    let unavailable_uri = format!("/api/threads/{thread_id}/context-drafts/draft-unavailable");
    let unavailable_saved = app
        .clone()
        .oneshot(api_request(
            "PUT",
            &unavailable_uri,
            Some(json!({
                "target": { "nodeId": 8, "sourceInteractionNodeId": 3, "sourceLayerId": 5 },
                "targetNode": {
                    "id": 8, "kind": "concept", "icon": "archive", "title": "Removed queue",
                    "detail": "This occurrence disappeared.", "state": "accepted"
                },
                "text": "Preserve this recovery note.", "expectedRevision": null
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(unavailable_saved.status(), StatusCode::OK);
    let unavailable = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("{unavailable_uri}/confirm?expectedRevision=1"),
            None,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(unavailable.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(unavailable).await["code"],
        "context_draft_target_unavailable"
    );
    let preserved = response_json(
        app.clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/threads/{thread_id}/context-drafts"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert!(preserved["drafts"].as_array().unwrap().iter().any(|draft| {
        draft["id"] == "draft-unavailable" && draft["text"] == "Preserve this recovery note."
    }));
    let unreachable_uri = format!("/api/threads/{thread_id}/context-drafts/draft-unreachable");
    response_json(
        app.clone()
            .oneshot(api_request(
                "PUT",
                &unreachable_uri,
                Some(json!({
                    "target": { "nodeId": 9, "sourceInteractionNodeId": 3, "sourceLayerId": 6 },
                    "targetNode": {
                        "id": 9, "kind": "concept", "icon": "archive", "title": "Unreachable queue",
                        "detail": "This accepted layer is outside the source completion.", "state": "accepted"
                    },
                    "text": "Keep this unreachable note.", "expectedRevision": null
                })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let unreachable = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("{unreachable_uri}/confirm?expectedRevision=1"),
            None,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(unreachable.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(unreachable).await["code"],
        "context_draft_target_unavailable"
    );
    let changed_uri = format!("/api/threads/{thread_id}/context-drafts/draft-changed");
    response_json(
        app.clone()
            .oneshot(api_request(
                "PUT",
                &changed_uri,
                Some(json!({
                    "target": { "nodeId": 10, "sourceInteractionNodeId": 3, "sourceLayerId": 5 },
                    "targetNode": {
                        "id": 10, "kind": "concept", "icon": "list", "title": "Original queue",
                        "detail": "The snapshot saved when the editor opened.", "state": "accepted"
                    },
                    "text": "Keep this changed-node note.", "expectedRevision": null
                })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let changed = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("{changed_uri}/confirm?expectedRevision=1"),
            None,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(changed.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(changed).await["code"],
        "context_draft_target_unavailable"
    );
    let confirm_uri = format!("{draft_uri}/confirm?expectedRevision=1");
    let confirmed = response_json(
        app.clone()
            .oneshot(api_request("POST", &confirm_uri, None, true))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(confirmed["draftId"], "draft-confirm");
    assert_eq!(confirmed["annotation"], "Call out FIFO ordering.");
    assert_eq!(confirmed["target"]["nodeId"], 7);
    let duplicate_uri = format!("/api/threads/{thread_id}/context-drafts/draft-confirm-duplicate");
    response_json(
        app.clone()
            .oneshot(api_request(
                "PUT",
                &duplicate_uri,
                Some(json!({
                    "target": { "nodeId": 7, "sourceInteractionNodeId": 3, "sourceLayerId": 5 },
                    "targetNode": {
                        "id": 7, "kind": "concept", "icon": "list", "title": "Incoming queue",
                        "detail": "Tasks wait here while workers are busy.", "state": "accepted"
                    },
                    "text": "A duplicate attachment.", "expectedRevision": null
                })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let duplicate = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("{duplicate_uri}/confirm?expectedRevision=1"),
            None,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::OK);
    assert_eq!(
        response_json(duplicate).await["annotation"],
        "A duplicate attachment."
    );
    let dismissed_duplicate = app
        .clone()
        .oneshot(api_request(
            "DELETE",
            &format!(
                "/api/threads/{thread_id}/context-confirmations/draft-confirm-duplicate?expectedRevision=1"
            ),
            None,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(dismissed_duplicate.status(), StatusCode::NO_CONTENT);
    let other_occurrence_uri =
        format!("/api/threads/{thread_id}/context-drafts/draft-confirm-other-occurrence");
    response_json(
        app.clone()
            .oneshot(api_request(
                "PUT",
                &other_occurrence_uri,
                Some(json!({
                    "target": { "nodeId": 7, "sourceInteractionNodeId": 3, "sourceLayerId": 6 },
                    "targetNode": {
                        "id": 7, "kind": "concept", "icon": "list", "title": "Incoming queue",
                        "detail": "Tasks wait here while workers are busy.", "state": "accepted"
                    },
                    "text": "A conflicting occurrence.", "expectedRevision": null
                })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let other_occurrence = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("{other_occurrence_uri}/confirm?expectedRevision=1"),
            None,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(other_occurrence.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(other_occurrence).await["code"],
        "context_target_already_confirmed"
    );
    let discarded_other_occurrence = app
        .clone()
        .oneshot(api_request(
            "DELETE",
            &format!("{other_occurrence_uri}?expectedRevision=1"),
            None,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(discarded_other_occurrence.status(), StatusCode::NO_CONTENT);
    let edited = response_json(
        app.clone()
            .oneshot(api_request(
                "PUT",
                &format!("/api/threads/{thread_id}/context-confirmations/draft-confirm"),
                Some(json!({
                    "annotation":"Clarify the edited FIFO ordering.",
                    "expectedRevision":confirmed["confirmationRevision"]
                })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(edited["annotation"], "Clarify the edited FIFO ordering.");
    assert_eq!(edited["confirmationRevision"], 2);
    drop(app);

    let reopened = open_app(&database, &root).await;
    let replayed = response_json(
        reopened
            .clone()
            .oneshot(api_request("POST", &confirm_uri, None, true))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(replayed, edited);
    let drafts = response_json(
        reopened
            .clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/threads/{thread_id}/context-drafts"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(drafts["drafts"].as_array().unwrap().len(), 3);
    assert_eq!(drafts["confirmations"].as_array().unwrap(), &[edited]);
    assert!(
        drafts["drafts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|draft| { draft["id"] == "draft-unavailable" })
    );
    let dismissed = reopened
        .clone()
        .oneshot(api_request(
            "DELETE",
            &format!(
                "/api/threads/{thread_id}/context-confirmations/draft-confirm?expectedRevision=2"
            ),
            None,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(dismissed.status(), StatusCode::NO_CONTENT);
    let replay_after_dismiss = reopened
        .oneshot(api_request("POST", &confirm_uri, None, true))
        .await
        .unwrap();
    assert_eq!(replay_after_dismiss.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(replay_after_dismiss).await["code"],
        "context_draft_target_unavailable"
    );
    assert!(
        drafts["drafts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|draft| { draft["id"] == "draft-unreachable" })
    );
    graph_task.abort();
    harness_task.abort();
}

#[tokio::test]
async fn submitted_input_projection_ignores_order_but_rejects_missing_values() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-input-projection-multiset-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let seed_app = open_app(&database, &root).await;
    let thread = response_json(
        seed_app
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({ "initialMessage": "Project two inputs" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    let pool = sqlite_pool(&database).await;
    let interaction_id: i64 = sqlx::query_scalar(
        "SELECT id FROM interactions WHERE thread_id=?1 ORDER BY sequence LIMIT 1",
    )
    .bind(thread_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE interactions SET graph_node_id=501,completion_status='accepted',input_identity='projection-multiset',input_digest='sha256:projection-multiset' WHERE id=?1")
        .bind(interaction_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO interaction_submitted_input_attempts(interaction_id,thread_id,draft_revision,authority_digest,semantic_digest,state,graph_root_node_id,child_receipt_json,created_at,bound_at,finished_at) VALUES (?1,?2,1,'sha256:authority','sha256:semantic','accepted',501,'[]','1','2','3')")
        .bind(interaction_id)
        .bind(thread_id)
        .execute(&pool)
        .await
        .unwrap();
    for (action_id, prompt, text) in [
        (10_i64, "Zulu prompt", "first value"),
        (20_i64, "Alpha prompt", "second value"),
    ] {
        sqlx::query("INSERT INTO interaction_submitted_input_attachments(interaction_id,presenting_interaction_node_id,presenting_layer_id,action_id,source_node_id,action_json,value_json,committed_at) VALUES (?1,101,201,?2,401,?3,?4,'1')")
            .bind(interaction_id)
            .bind(action_id)
            .bind(json!({"control":"text","prompt":prompt}).to_string())
            .bind(json!({"text":text}).to_string())
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;

    let input_reads = Arc::new(AtomicUsize::new(0));
    let observed_input_reads = input_reads.clone();
    let graph = Router::new()
        .route(
            "/api/control/interactions/501/input",
            axum::routing::get(move || {
                let observed_input_reads = observed_input_reads.clone();
                async move {
                    let alpha = json!({
                        "action":{"control":"text","prompt":"Alpha prompt"},
                        "value":{"text":"second value"}
                    });
                    let zulu = json!({
                        "action":{"control":"text","prompt":"Zulu prompt"},
                        "value":{"text":"first value"}
                    });
                    let submitted_inputs = if observed_input_reads.fetch_add(1, Ordering::SeqCst) == 0 {
                        vec![alpha, zulu]
                    } else {
                        vec![alpha]
                    };
                    axum::Json(json!({
                        "interaction":{"id":501,"kind":"user-interaction","icon":"user","title":"Project two inputs","detail":"Project two inputs","state":"accepted"},
                        "contexts":[],
                        "submittedInputs":submitted_inputs
                    }))
                }
            }),
        )
        .route(
            "/api/control/interactions/501/context-actions",
            axum::routing::get(|| async {
                axum::Json(json!({"actions":[{
                    "id":88,"type":"interaction.context","sourceNodeId":501,
                    "target":{"nodeId":7,"sourceInteractionNodeId":3,"sourceLayerId":5},
                    "annotations":["raw note"],"state":"accepted"
                }]}))
            }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(Router::new()).await;
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion":1,
            "configurations":[{"configuration":{
                "schemaVersion":1,"name":"codex-basic","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"ask":{},"auto":{}},
                "settings":{}
            },"digest":"sha256:test"}]
        })
        .to_string(),
    )
    .unwrap();
    let app =
        open_app_with_runtime_allow_override(&database, &root, &catalog, &graph_url, &harness_url)
            .await;

    let fresh = response_json(
        app.clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/threads/{thread_id}/interactions"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(fresh["interactions"][0]["projectionFresh"], true);
    assert_eq!(
        fresh["interactions"][0]["submittedInputs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let missing = response_json(
        app.oneshot(api_request(
            "GET",
            &format!("/api/threads/{thread_id}/interactions"),
            None,
            true,
        ))
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(missing["interactions"][0]["projectionFresh"], false);
    assert_eq!(input_reads.load(Ordering::SeqCst), 2);
    graph_task.abort();
    harness_task.abort();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn input_draft_commit_sends_the_destination_product_graph_scope() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-input-draft-thread-scope-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let seed_app = open_app(&database, &root).await;
    let thread = response_json(
        seed_app
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({ "initialMessage": "Destination thread" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    seed_explicit_test_model_default(&database, thread_id).await;
    let boundary_seed_app = open_app(&database, &root).await;
    let max_thread = response_json(
        boundary_seed_app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({ "initialMessage": "Exactly 256 inputs" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let overflow_thread = response_json(
        boundary_seed_app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({ "initialMessage": "Reject 257 inputs" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let byte_overflow_thread = response_json(
        boundary_seed_app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({ "initialMessage": "Reject oversized portable inputs" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let redaction_overflow_thread = response_json(
        boundary_seed_app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({ "initialMessage": "Reject post-redaction portable inputs" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let context_overflow_thread = response_json(
        boundary_seed_app
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({ "initialMessage": "Reject oversized portable context snapshot" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let max_thread_id = max_thread["id"].as_i64().unwrap();
    let overflow_thread_id = overflow_thread["id"].as_i64().unwrap();
    let byte_overflow_thread_id = byte_overflow_thread["id"].as_i64().unwrap();
    let redaction_overflow_thread_id = redaction_overflow_thread["id"].as_i64().unwrap();
    let context_overflow_thread_id = context_overflow_thread["id"].as_i64().unwrap();
    seed_thread_with_current_test_model(&database, max_thread_id).await;
    seed_thread_with_current_test_model(&database, overflow_thread_id).await;
    seed_thread_with_current_test_model(&database, byte_overflow_thread_id).await;
    seed_thread_with_current_test_model(&database, redaction_overflow_thread_id).await;
    seed_thread_with_current_test_model(&database, context_overflow_thread_id).await;
    seed_action_input_draft_count(&database, max_thread_id, 256).await;
    seed_action_input_draft_count(&database, overflow_thread_id, 257).await;
    seed_action_input_draft_bytes(
        &database,
        byte_overflow_thread_id,
        9,
        relayer_app_server::conversation_export::MAX_JSONL_LINE_BYTES / 8,
    )
    .await;
    seed_action_input_draft_bytes(&database, context_overflow_thread_id, 4, 3 * 1024 * 1024).await;
    seed_thread_interactions_terminal(&database, context_overflow_thread_id).await;
    seed_project_path_expanding_action_input_draft(
        &database,
        redaction_overflow_thread_id,
        "/a",
        1_200_000,
    )
    .await;

    let observed = Arc::new(Mutex::new(None));
    let observed_request = observed.clone();
    let observed_interaction = Arc::new(Mutex::new(None));
    let observed_interaction_request = observed_interaction.clone();
    let graph = Router::new()
        .route(
            "/api/control/input-action-occurrences/canonical",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let observed_request = observed_request.clone();
                async move {
                    *observed_request.lock().unwrap() = Some(body.clone());
                    let action_id = body["occurrence"]["actionId"].as_i64().unwrap();
                    let mut action = json!({
                        "id": action_id,
                        "sourceNodeId": 401,
                        "sourceLayerId": 201,
                        "kind": "input",
                        "label": "Add constraint",
                        "variant": "pill",
                        "control": "text",
                        "prompt": "What constraint applies?",
                        "state": "accepted"
                    });
                    if action_id == 302 {
                        action["control"] = json!("multi_select");
                        action["prompt"] = json!("Which optional signals apply?");
                        action["options"] = json!([
                            {"key": "logs", "label": "Logs"},
                            {"key": "metrics", "label": "Metrics"}
                        ]);
                    } else if action_id == 303 {
                        action["control"] = json!("single_select");
                        action["prompt"] = json!("Which rollout applies?");
                        action["options"] = json!([
                            {"key": "canary", "label": "Canary"},
                            {"key": "full", "label": "Full rollout"}
                        ]);
                    }
                    axum::Json(action)
                }
            }),
        )
        .route(
            "/api/control/context-occurrences/canonical",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                axum::Json(json!({
                    "id": body["nodeId"],
                    "kind": "answer",
                    "icon": "document",
                    "title": "Large resolved context",
                    "detail": "c".repeat(relayer_app_server::conversation_export::MAX_STRING_BYTES),
                    "state": "accepted"
                }))
            }),
        )
        .route(
            "/api/control/interactions",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let observed_interaction_request = observed_interaction_request.clone();
                async move {
                    *observed_interaction_request.lock().unwrap() = Some(body.clone());
                    let submitted_inputs = serde_json::from_value::<
                        Vec<relayer_graph_core::SubmittedInputDraft>,
                    >(body["submittedInputs"].clone())
                    .unwrap();
                    let semantic_digest = relayer_graph_core::interaction_input_semantic_digest(
                        body["text"].as_str().unwrap(),
                        &submitted_inputs,
                    )
                    .unwrap();
                    let input_children = body["submittedInputs"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .enumerate()
                        .map(|(index, submitted)| {
                            let action_id = submitted["actionId"].as_i64().unwrap();
                            json!({
                                "id": format!("interaction-input-child:{}", index + 1),
                                "parentInteractionNodeId": 501,
                                "occurrence": {
                                    "presentingInteractionNodeId": submitted["presentingInteractionNodeId"],
                                    "presentingLayerId": submitted["presentingLayerId"],
                                    "actionId": action_id
                                },
                                "sourceNodeId": if action_id >= 3_000 { action_id + 1_000 } else { 401 },
                                "action": submitted["action"],
                                "value": submitted["value"],
                                "attemptKey": body["inputIdentity"],
                                "authorityDigest": body["inputDigest"],
                                "semanticDigest": semantic_digest
                            })
                        })
                        .collect::<Vec<_>>();
                    axum::Json(json!({
                        "node": {"id": 501},
                        "graphToken": "",
                        "inputIdentity": body["inputIdentity"],
                        "inputDigest": body["inputDigest"],
                        "inputChildren": input_children
                    }))
                }
            }),
        )
        .route(
            "/api/control/interactions/{id}/input",
            axum::routing::get(|axum::extract::Path(id): axum::extract::Path<i64>| async move {
                axum::Json(json!({
                    "interaction": {
                        "id": id,
                        "kind": "user-interaction",
                        "icon": "user",
                        "title": "Portable input boundary fixture",
                        "detail": "Portable input boundary fixture",
                        "state": "accepted"
                    },
                    "contexts": [],
                    "submittedInputs": []
                }))
            }),
        )
        .route(
            "/api/control/interactions/{id}/context-actions",
            axum::routing::get(|| async { axum::Json(json!({"actions": []})) }),
        )
        .route(
            "/api/control/capabilities",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                axum::Json(json!({"graphToken": body["graphToken"]}))
            })
            .delete(|| async { axum::Json(json!({"revoked": true})) }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(Router::new()).await;
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion": 1,
            "configurations": [{
                "configuration": {
                    "schemaVersion": 1, "name": "codex-basic", "implementation": "test",
                    "implementationVersion": 1, "permissionBindings": {"ask": {}, "auto": {}},
                    "modelCompatibility": [{"providerId": "codex"}],
                    "executionAccessContracts": ["managed-runtime@1"],
                    "settings": {}
                },
                "digest": "sha256:test"
            }]
        })
        .to_string(),
    )
    .unwrap();
    let app = open_app_with_runtime(&database, &root, &catalog, &graph_url, &harness_url).await;
    let max_send = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{max_thread_id}/interactions"),
            Some(json!({
                "text": "Accept the portable maximum",
                "inputId": "portable-input-maximum",
                "inputDraftRevision": 256
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(max_send.status(), StatusCode::CREATED);
    assert_eq!(
        observed_interaction.lock().unwrap().as_ref().unwrap()["submittedInputs"]
            .as_array()
            .unwrap()
            .len(),
        256
    );
    let overflow_send = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{overflow_thread_id}/interactions"),
            Some(json!({
                "text": "Reject one over the portable maximum",
                "inputId": "portable-input-overflow",
                "inputDraftRevision": 257
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(overflow_send.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let overflow_send = response_json(overflow_send).await;
    assert_eq!(overflow_send["code"], "submitted_input_limit_exceeded");
    assert_eq!(overflow_send["path"], "submittedInputs");
    let byte_overflow_send = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{byte_overflow_thread_id}/interactions"),
            Some(json!({
                "text": "Reject oversized portable inputs",
                "inputId": "portable-input-byte-overflow",
                "inputDraftRevision": 9
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(
        byte_overflow_send.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let byte_overflow_send = response_json(byte_overflow_send).await;
    assert_eq!(byte_overflow_send["code"], "submitted_input_limit_exceeded");
    assert_eq!(byte_overflow_send["path"], "submittedInputs");
    let redaction_overflow_send = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{redaction_overflow_thread_id}/interactions"),
            Some(json!({
                "text": "Reject input that expands during portable redaction",
                "inputId": "portable-input-redaction-overflow",
                "inputDraftRevision": 1
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(
        redaction_overflow_send.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let redaction_overflow_send = response_json(redaction_overflow_send).await;
    assert_eq!(
        redaction_overflow_send["code"],
        "submitted_input_limit_exceeded"
    );
    assert_eq!(redaction_overflow_send["path"], "submittedInputs");
    let context_overflow_send = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{context_overflow_thread_id}/interactions"),
            Some(json!({
                "text": "Use the attached resolved context",
                "inputId": "portable-context-snapshot-overflow",
                "inputDraftRevision": 4,
                "contexts": [{
                    "target": {
                        "nodeId": 9001,
                        "sourceInteractionNodeId": 9002,
                        "sourceLayerId": 9003
                    },
                    "annotations": ["Use the full target snapshot"]
                }]
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(
        context_overflow_send.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let context_overflow_send = response_json(context_overflow_send).await;
    assert_eq!(
        context_overflow_send["code"],
        "submitted_input_limit_exceeded"
    );
    assert_eq!(context_overflow_send["path"], "submittedInputs");
    let context_export_after_rejected_send = app
        .clone()
        .oneshot(api_request(
            "GET",
            &format!("/api/threads/{context_overflow_thread_id}/export"),
            None,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(context_export_after_rejected_send.status(), StatusCode::OK);
    let context_export_after_rejected_send = to_bytes(
        context_export_after_rejected_send.into_body(),
        relayer_app_server::conversation_export::MAX_JSONL_LINE_BYTES,
    )
    .await
    .unwrap();
    assert_eq!(
        decode_export_jsonl(&context_export_after_rejected_send)
            .unwrap()
            .len(),
        2
    );
    let export_after_rejected_send = app
        .clone()
        .oneshot(api_request(
            "GET",
            &format!("/api/threads/{redaction_overflow_thread_id}/export"),
            None,
            true,
        ))
        .await
        .unwrap();
    let export_status = export_after_rejected_send.status();
    let export_after_rejected_send = to_bytes(
        export_after_rejected_send.into_body(),
        relayer_app_server::conversation_export::MAX_JSONL_LINE_BYTES,
    )
    .await
    .unwrap();
    assert_eq!(
        export_status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&export_after_rejected_send)
    );
    assert_eq!(
        decode_export_jsonl(&export_after_rejected_send)
            .unwrap()
            .len(),
        2
    );
    let pool = sqlite_pool(&database).await;
    let preserved_revision: i64 =
        sqlx::query_scalar("SELECT revision FROM action_input_drafts WHERE thread_id=?1")
            .bind(overflow_thread_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let preserved_attachments: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM action_input_attachments WHERE thread_id=?1")
            .bind(overflow_thread_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(preserved_revision, 257);
    assert_eq!(preserved_attachments, 257);
    let overflow_interactions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM interactions WHERE thread_id=?1")
            .bind(overflow_thread_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(overflow_interactions, 1);
    let byte_overflow_preserved: (i64, i64, i64) = sqlx::query_as(
        "SELECT draft.revision,
                (SELECT COUNT(*) FROM action_input_attachments attachment WHERE attachment.thread_id=draft.thread_id),
                (SELECT COUNT(*) FROM interactions interaction WHERE interaction.thread_id=draft.thread_id)
         FROM action_input_drafts draft WHERE draft.thread_id=?1",
    )
    .bind(byte_overflow_thread_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(byte_overflow_preserved, (9, 9, 1));
    pool.close().await;
    let occurrence = json!({
        "presentingInteractionNodeId": 101,
        "presentingLayerId": 201,
        "actionId": 301
    });
    let committed = app
        .clone()
        .oneshot(api_request(
            "PUT",
            &format!("/api/threads/{thread_id}/input-draft/attachments"),
            Some(json!({
                "occurrence": occurrence,
                "value": {"text": "Keep support load flat"},
                "expectedRevision": 0
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(committed.status(), StatusCode::OK);
    assert_eq!(
        observed.lock().unwrap().clone().unwrap(),
        json!({
            "destinationProjectId": null,
            "destinationThreadId": thread_id,
            "occurrence": occurrence
        })
    );
    let replaced = app
        .clone()
        .oneshot(api_request(
            "PUT",
            &format!("/api/threads/{thread_id}/input-draft/attachments"),
            Some(json!({
                "occurrence": occurrence,
                "value": {"text": "Use the newer constraint"},
                "expectedRevision": 1
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(replaced.status(), StatusCode::OK);
    let stale_send = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({
                "text": "Send the inspected input",
                "inputId": "stale-input-draft-send",
                "inputDraftRevision": 1
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(stale_send.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(stale_send).await["code"],
        "input_draft_revision_conflict"
    );
    let detach_uri =
        format!("/api/threads/{thread_id}/input-draft/attachments/101/201/301?expectedRevision=2");
    let detached = app
        .clone()
        .oneshot(api_request("DELETE", &detach_uri, None, true))
        .await
        .unwrap();
    assert_eq!(detached.status(), StatusCode::OK);
    assert_eq!(response_json(detached).await["revision"], 3);
    let replayed_detach = app
        .clone()
        .oneshot(api_request("DELETE", &detach_uri, None, true))
        .await
        .unwrap();
    assert_eq!(replayed_detach.status(), StatusCode::OK);
    assert_eq!(response_json(replayed_detach).await["revision"], 3);
    let revision_only_send = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({
                "text": "Send after inspecting an empty input draft",
                "inputId": "revision-only-empty-input-draft",
                "inputDraftRevision": 3,
                "contexts": [{
                    "target": {
                        "nodeId": 7,
                        "sourceInteractionNodeId": 3,
                        "sourceLayerId": 5
                    },
                    "annotations": ["Keep the ordinary context digest"]
                }]
            })),
            true,
        ))
        .await
        .unwrap();
    let revision_only_status = revision_only_send.status();
    let revision_only_send = response_json(revision_only_send).await;
    assert_eq!(
        revision_only_status,
        StatusCode::CREATED,
        "{revision_only_send}"
    );
    assert_eq!(
        revision_only_send["text"],
        "Send after inspecting an empty input draft"
    );
    let prepared_input = observed_interaction.lock().unwrap().clone().unwrap();
    assert_eq!(prepared_input["submittedInputs"], json!([]));
    assert!(
        prepared_input["inputDigest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:v1:")
    );
    assert_eq!(
        prepared_input["contexts"][0]["annotations"],
        json!(["Keep the ordinary context digest"])
    );
    let empty_multi = app
        .clone()
        .oneshot(api_request(
            "PUT",
            &format!("/api/threads/{thread_id}/input-draft/attachments"),
            Some(json!({
                "occurrence": {
                    "presentingInteractionNodeId": 101,
                    "presentingLayerId": 201,
                    "actionId": 302
                },
                "value": {"selectedKeys": []},
                "expectedRevision": 3
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(empty_multi.status(), StatusCode::OK);
    let empty_multi = response_json(empty_multi).await;
    assert_eq!(empty_multi["revision"], 4);
    assert_eq!(
        empty_multi["attachments"][0]["value"],
        json!({"selectedKeys": []})
    );
    let unrelated_stale_detach = app
        .clone()
        .oneshot(api_request(
            "DELETE",
            &format!(
                "/api/threads/{thread_id}/input-draft/attachments/101/201/301?expectedRevision=3"
            ),
            None,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(unrelated_stale_detach.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(unrelated_stale_detach).await["code"],
        "input_draft_revision_conflict"
    );
    for (action_id, value, expected_code) in [
        (301, json!({"text": "  "}), "input_text_blank"),
        (
            302,
            json!({"selectedKeys": ["logs", "logs"]}),
            "input_option_duplicate",
        ),
        (
            302,
            json!({"selectedKeys": ["missing"]}),
            "input_option_unknown",
        ),
        (303, json!({"selectedKeys": []}), "input_selection_count"),
    ] {
        let rejected = app
            .clone()
            .oneshot(api_request(
                "PUT",
                &format!("/api/threads/{thread_id}/input-draft/attachments"),
                Some(json!({
                    "occurrence": {
                        "presentingInteractionNodeId": 101,
                        "presentingLayerId": 201,
                        "actionId": action_id
                    },
                    "value": value,
                    "expectedRevision": 4
                })),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let rejected = response_json(rejected).await;
        assert_eq!(rejected["code"], expected_code);
        assert_eq!(rejected["path"], "attachments[0].value");
    }

    let pool = sqlite_pool(&database).await;
    let interaction_id: i64 =
        sqlx::query_scalar("SELECT id FROM interactions WHERE thread_id=?1 ORDER BY sequence")
            .bind(thread_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let (family_id, family_revision): (i64, i64) =
        sqlx::query_as("SELECT id,revision FROM model_families ORDER BY id LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query(
        "UPDATE interactions SET completion_status='not_started',completion_error='retryable fixture' WHERE id=?1",
    )
    .bind(interaction_id)
    .execute(&pool)
    .await
    .unwrap();
    let attempt_id = sqlx::query(
        "INSERT INTO interaction_attempts(
            interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,
            harness_configuration_name,harness_configuration_revision,harness_configuration_digest,
            provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,
            outcome,failure_category,effect_boundary
         ) VALUES (?1,1,'1','2',?2,?3,'codex-basic',1,'sha256:test',
            'codex','test-adapter',1,'test-model','managed-runtime@1',
            'model_failed','provider_timeout','none')",
    )
    .bind(interaction_id)
    .bind(family_id)
    .bind(family_revision)
    .execute(&pool)
    .await
    .unwrap()
    .last_insert_rowid();
    pool.close().await;

    let retry_with_committed_input = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions/{interaction_id}/retry"),
            Some(json!({
                "attemptId": attempt_id,
                "text": "Retry must not consume this committed input in place",
                "inputId": "in-place-input-retry",
                "inputDraftRevision": 4,
                "modelSelection": {
                    "familyId": family_id,
                    "providerId": "codex",
                    "modelId": "test-model"
                }
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(
        retry_with_committed_input.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        response_json(retry_with_committed_input).await["code"],
        "submitted_input_retry_requires_new_send"
    );

    graph_task.abort();
    harness_task.abort();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn eval_annotations_are_scoped_append_only_and_durable() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-annotations-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    let thread = response_json(
        app.clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({ "initialMessage": "Review this fixed turn" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    let other_thread = response_json(
        app.clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({ "initialMessage": "Outside the annotation session" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let other_thread_id = other_thread["id"].as_i64().unwrap();
    let token = "annotation-token-with-at-least-thirty-two-bytes";
    let registered = app.clone().oneshot(api_request(
        "POST", "/api/internal/annotation-sessions", Some(json!({
            "token": token, "threadIds": [thread_id], "authorId": "local-vishal", "authorDisplayName": "Vishal"
        })), true,
    )).await.unwrap();
    assert_eq!(registered.status(), StatusCode::NO_CONTENT);

    let state = response_json(
        app.clone()
            .oneshot(annotation_request("GET", "/api/state", None, token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(state["capabilities"]["annotations"], true);

    let annotation_token_only = app
        .clone()
        .oneshot(annotation_token_only_request(
            "GET",
            &format!("/api/threads/{thread_id}/annotations"),
            None,
            token,
        ))
        .await
        .unwrap();
    assert_eq!(annotation_token_only.status(), StatusCode::UNAUTHORIZED);

    let product_write = app
        .clone()
        .oneshot(annotation_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({ "text": "Annotation authority is not product authority" })),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(product_write.status(), StatusCode::FORBIDDEN);

    let cross_thread = app
        .clone()
        .oneshot(annotation_request(
            "POST",
            &format!("/api/threads/{other_thread_id}/annotations"),
            Some(json!({ "anchor": { "kind": "thread" }, "comment": "Forged scope" })),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(cross_thread.status(), StatusCode::NOT_FOUND);

    let generic_review = app
        .clone()
        .oneshot(api_request_with_token(
            "POST",
            &format!("/api/threads/{thread_id}/annotations"),
            Some(json!({ "anchor": { "kind": "thread" }, "comment": "No authority" })),
            "review",
        ))
        .await
        .unwrap();
    assert_eq!(generic_review.status(), StatusCode::UNAUTHORIZED);

    let created = response_json(
        app.clone()
            .oneshot(annotation_request(
                "POST",
                &format!("/api/threads/{thread_id}/annotations"),
                Some(json!({
                    "anchor": { "kind": "thread" }, "comment": "Sparse comment with no rating",
                    "navigationContext": { "threadId": thread_id }
                })),
                token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(created["latestRevision"], 1);
    assert!(created["revisions"][0]["rating"].is_null());
    assert_eq!(created["revisions"][0]["authorDisplayName"], "Vishal");
    let annotation_id = created["id"].as_i64().unwrap();

    let expanded = app.clone().oneshot(api_request(
        "POST", "/api/internal/annotation-sessions", Some(json!({
            "token": token, "threadIds": [thread_id, other_thread_id], "authorId": "local-vishal", "authorDisplayName": "Vishal"
        })), true,
    )).await.unwrap();
    assert_eq!(expanded.status(), StatusCode::NO_CONTENT);
    let other_created = response_json(
        app.clone()
            .oneshot(annotation_request(
                "POST",
                &format!("/api/threads/{other_thread_id}/annotations"),
                Some(json!({
                    "anchor": { "kind": "thread" },
                    "comment": "Second thread comment"
                })),
                token,
            ))
            .await
            .unwrap(),
    )
    .await;
    let snapshot_set = response_json(
        app.clone()
            .oneshot(annotation_request(
                "POST",
                "/api/annotations/snapshot",
                Some(json!({ "threadIds": [other_thread_id, thread_id] })),
                token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(snapshot_set["kind"], "relayer_eval_annotation_snapshot_set");
    assert_eq!(snapshot_set["threads"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot_set["threads"][0]["threadId"], other_thread_id);
    assert_eq!(snapshot_set["threads"][1]["threadId"], thread_id);
    assert_eq!(
        snapshot_set["threads"][0]["annotations"][0]["id"],
        other_created["id"]
    );
    assert_eq!(
        snapshot_set["threads"][1]["annotations"][0]["id"],
        annotation_id
    );

    let incomplete_snapshot = app
        .clone()
        .oneshot(annotation_request(
            "POST",
            "/api/annotations/snapshot",
            Some(json!({ "threadIds": [thread_id] })),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(incomplete_snapshot.status(), StatusCode::NOT_FOUND);

    let duplicate_snapshot = app
        .clone()
        .oneshot(annotation_request(
            "POST",
            "/api/annotations/snapshot",
            Some(json!({ "threadIds": [thread_id, thread_id] })),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(
        duplicate_snapshot.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let over_limit_ids = (1_i64..=257).collect::<Vec<_>>();
    let over_limit_snapshot = app
        .clone()
        .oneshot(annotation_request(
            "POST",
            "/api/annotations/snapshot",
            Some(json!({ "threadIds": over_limit_ids })),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(
        over_limit_snapshot.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let revised = response_json(
        app.clone()
            .oneshot(annotation_request(
                "POST",
                &format!("/api/threads/{thread_id}/annotations/{annotation_id}/revisions"),
                Some(json!({
                    "expectedRevision": 1, "comment": "Now with a deliberate rating", "rating": 3
                })),
                token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(revised["revisions"].as_array().unwrap().len(), 2);
    assert_eq!(
        revised["revisions"][0]["comment"],
        "Sparse comment with no rating"
    );
    assert_eq!(revised["revisions"][1]["rating"], 3);
    let before_retraction = response_json(
        app.clone()
            .oneshot(annotation_request(
                "GET",
                &format!("/api/threads/{thread_id}/annotations/snapshot"),
                None,
                token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        before_retraction["kind"],
        "relayer_eval_annotation_snapshot"
    );

    let conflict = app
        .clone()
        .oneshot(annotation_request(
            "POST",
            &format!("/api/threads/{thread_id}/annotations/{annotation_id}/revisions"),
            Some(json!({ "expectedRevision": 1, "comment": "Stale edit" })),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(conflict).await["code"],
        "annotation_revision_conflict"
    );

    let retracted = response_json(
        app.clone()
            .oneshot(annotation_request(
                "POST",
                &format!("/api/threads/{thread_id}/annotations/{annotation_id}/retract"),
                Some(json!({ "expectedRevision": 2 })),
                token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(retracted["latestRevision"], 3);
    assert_eq!(retracted["revisions"][2]["state"], "retracted");

    let revoked = app
        .clone()
        .oneshot(api_request(
            "DELETE",
            "/api/internal/annotation-sessions",
            Some(json!({ "token": token })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
    let denied_after_revoke = app
        .clone()
        .oneshot(annotation_request(
            "GET",
            &format!("/api/threads/{thread_id}/annotations"),
            None,
            token,
        ))
        .await
        .unwrap();
    assert_eq!(denied_after_revoke.status(), StatusCode::UNAUTHORIZED);
    let state_after_revoke = response_json(
        app.clone()
            .oneshot(annotation_request("GET", "/api/state", None, token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(state_after_revoke["capabilities"]["annotations"], false);
    let revoked_again = app
        .clone()
        .oneshot(api_request(
            "DELETE",
            "/api/internal/annotation-sessions",
            Some(json!({ "token": token })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(revoked_again.status(), StatusCode::NO_CONTENT);

    drop(app);
    let reopened = open_app(&database, &root).await;
    reopened.clone().oneshot(api_request(
        "POST", "/api/internal/annotation-sessions", Some(json!({
            "token": token, "threadIds": [thread_id], "authorId": "local-vishal", "authorDisplayName": "Vishal"
        })), true,
    )).await.unwrap();
    let restored = response_json(
        reopened
            .clone()
            .oneshot(annotation_request(
                "GET",
                &format!("/api/threads/{thread_id}/annotations"),
                None,
                token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(restored["annotations"][0]["latestRevision"], 3);
    assert_eq!(
        restored["annotations"][0]["revisions"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let after_retraction = response_json(
        reopened
            .oneshot(annotation_request(
                "GET",
                &format!("/api/threads/{thread_id}/annotations/snapshot"),
                None,
                token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_ne!(
        before_retraction["annotationsSha256"],
        after_retraction["annotationsSha256"]
    );
    fs::remove_dir_all(root).unwrap();
}

fn authored_layout(node_id: NodeId) -> Option<LayerLayout> {
    Some(LayerLayout::v1(vec![NodePlacement {
        node_id,
        x: 0.5,
        y: 0.5,
    }]))
}

#[tokio::test]
async fn resolved_invoke_destination_is_readable_cross_thread_in_review_mode() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-resolved-invoke-navigation-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    drop(open_app(&database, &root).await);

    let pool = sqlite_pool(&database).await;
    let project_id = sqlx::query(
        "INSERT INTO projects(name,path,created_at,updated_at) VALUES ('Project',?1,'1','1')",
    )
    .bind(root.to_string_lossy().as_ref())
    .execute(&pool)
    .await
    .unwrap()
    .last_insert_rowid();
    let source_thread_id = sqlx::query("INSERT INTO threads(title,project_id,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES ('Source',?1,'1','1','codex-basic','auto')")
        .bind(project_id).execute(&pool).await.unwrap().last_insert_rowid();
    let result_thread_id = sqlx::query("INSERT INTO threads(title,project_id,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES ('Result',?1,'2','2','codex-basic','auto')")
        .bind(project_id).execute(&pool).await.unwrap().last_insert_rowid();
    let stale_source = json!({
        "nodeId": 90,
        "rootLayer": {
            "layer": {"id": 500}, "nodes": [], "edges": [],
            "actions": [{"id": 41, "sourceNodeId": 7, "kind": "invoke", "targetLayerId": null, "state": "accepted"}]
        }
    });
    let source_interaction_id = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,completion_output_json,permission_profile_id) VALUES (?1,1,'Source','1',90,'accepted',?2,'auto')")
        .bind(source_thread_id).bind(stale_source.to_string()).execute(&pool).await.unwrap().last_insert_rowid();
    let reused_source_interaction_id = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,completion_output_json,permission_profile_id) VALUES (?1,1,'Reused source','2',92,'accepted',?2,'auto')")
        .bind(result_thread_id).bind(stale_source.to_string()).execute(&pool).await.unwrap().last_insert_rowid();
    let result_output = json!({
        "nodeId": 91,
        "rootLayer": {"layer": {"id": 501}, "nodes": [], "edges": [], "actions": []}
    });
    let result_interaction_id = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,completion_output_json,completion_error,harness_configuration_name,harness_configuration_digest,permission_profile_id,effective_execution_digest,effective_permission_receipt_json) VALUES (?1,2,'Result','3',91,'failed',?2,'Canonical reconciliation pending: transient persistence failure','codex-basic','sha256:test','auto','sha256:execution',?3)")
        .bind(result_thread_id).bind(result_output.to_string())
        .bind(json!({"schemaVersion":1,"permissionProfileId":"auto","bindingPresent":true}).to_string())
        .execute(&pool).await.unwrap().last_insert_rowid();
    sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at) VALUES (?1,41,?2,'3')")
        .bind(reused_source_interaction_id).bind(result_interaction_id).execute(&pool).await.unwrap();
    pool.close().await;

    let canonical_source = json!({
        "nodeId": 90,
        "rootLayer": {
            "layer": {"id": 500}, "nodes": [], "edges": [],
            "actions": [{"id": 41, "sourceNodeId": 7, "kind": "invoke", "targetLayerId": 501, "state": "accepted"}]
        }
    });
    let graph = axum::Router::new()
        .route(
            "/api/control/interactions/90/actions/41",
            axum::routing::get(|| async {
                axum::Json(json!({"action": {
                    "id": 41, "kind": "invoke", "interactionText": "Continue",
                    "targetLayerId": 501, "state": "accepted"
                }}))
            }),
        )
        .route(
            "/api/control/interactions/90/layers/501/owner",
            axum::routing::get(|| async {
                axum::Json(json!({"layerId": 501, "ownerInteractionNodeId": 91}))
            }),
        )
        .route(
            "/api/control/interactions/90/output",
            axum::routing::get(move || {
                let canonical_source = canonical_source.clone();
                async move { axum::Json(canonical_source) }
            }),
        )
        .route(
            "/api/control/interactions/91/output",
            axum::routing::get(move || {
                let result_output = result_output.clone();
                async move { axum::Json(result_output) }
            }),
        )
        .route(
            "/api/control/interactions/91",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":91,
                    "invocation":{"sourceInteractionNodeId":92,"sourceActionId":41}
                }))
            }),
        )
        .route(
            "/api/control/capabilities",
            axum::routing::delete(|| async { axum::Json(json!({"revoked":true})) }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(axum::Router::new()).await;
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion": 1,
            "configurations": [{
                "configuration": {
                    "schemaVersion": 1, "name": "codex-basic", "implementation": "test",
                    "implementationVersion": 1, "permissionBindings": {"auto": {}}, "settings": {}
                },
                "digest": "sha256:test"
            }]
        })
        .to_string(),
    )
    .unwrap();
    let app = open_app_with_runtime(&database, &root, &catalog, &graph_url, &harness_url).await;

    let destination = app
        .clone()
        .oneshot(api_request_with_token(
            "GET",
            &format!(
                "/api/threads/{source_thread_id}/interactions/{source_interaction_id}/actions/41/destination"
            ),
            None,
            "review",
        ))
        .await
        .unwrap();
    assert_eq!(destination.status(), StatusCode::OK);
    assert_eq!(
        response_json(destination).await,
        json!({
            "actionId": 41, "actionKind": "invoke", "targetLayerId": 501,
            "threadId": result_thread_id, "interactionId": result_interaction_id,
            "rootLayerId": 501
        })
    );

    let state = response_json(
        app.clone()
            .oneshot(api_request_with_token(
                "GET",
                &format!("/api/state?threadId={source_thread_id}"),
                None,
                "review",
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        state["interactions"][0]["completionOutput"]["rootLayer"]["actions"][0],
        json!({"id": 41, "sourceNodeId": 7, "kind": "invoke", "targetLayerId": 501, "state": "accepted"})
    );
    let interactions = response_json(
        app.oneshot(api_request_with_token(
            "GET",
            &format!("/api/threads/{source_thread_id}/interactions"),
            None,
            "review",
        ))
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(
        interactions["interactions"][0]["completionOutput"]["rootLayer"]["actions"][0]["targetLayerId"],
        501
    );

    graph_task.abort();
    harness_task.abort();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn conversation_export_uses_real_accepted_graph_and_rejects_read_only_authority() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-conversation-export-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();

    let graph_database = GraphDatabase::open(root.join("graph.sqlite3"))
        .await
        .unwrap();
    let graph_interaction = graph_database
        .create_interaction(
            Some(GraphProjectId::new(1).unwrap()),
            GraphThreadId::new(1).unwrap(),
            "Review /var/folders/project/tokenizer",
        )
        .await
        .unwrap();
    let writer = graph_database
        .writer_for_subgraph(graph_interaction.id)
        .await
        .unwrap();
    let answer = writer
        .submit_node(&NodeDraft {
            client_key: "answer".into(),
            kind: "concept /var/folders/project/tokenizer".into(),
            icon: "file".into(),
            title: "Finding /var/folders/project/tokenizer".into(),
            detail: "Accepted durable detail /var/folders/project/tokenizer".into(),
        })
        .await
        .unwrap();
    let nested_node = writer
        .submit_node(&NodeDraft {
            client_key: "nested-node".into(),
            kind: "concept".into(),
            icon: "file".into(),
            title: "Nested".into(),
            detail: "Nested expansion".into(),
        })
        .await
        .unwrap();
    let reference_a_node = writer
        .submit_node(&NodeDraft {
            client_key: "reference-a-node".into(),
            kind: "evidence".into(),
            icon: "link".into(),
            title: "Reference A".into(),
            detail: "Shared reference".into(),
        })
        .await
        .unwrap();
    let reference_b_node = writer
        .submit_node(&NodeDraft {
            client_key: "reference-b-node".into(),
            kind: "evidence".into(),
            icon: "link".into(),
            title: "Reference B".into(),
            detail: "Cyclic reference".into(),
        })
        .await
        .unwrap();
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: "root".into(),
            nodes: vec![answer.id],
            edges: vec![],
            layout: authored_layout(answer.id),
            size_justification: None,
        })
        .await
        .unwrap();
    let nested_layer = writer
        .submit_layer(&LayerDraft {
            client_key: "nested".into(),
            nodes: vec![nested_node.id],
            edges: vec![],
            layout: authored_layout(nested_node.id),
            size_justification: None,
        })
        .await
        .unwrap();
    let reference_a = writer
        .submit_layer(&LayerDraft {
            client_key: "reference-a".into(),
            nodes: vec![reference_a_node.id],
            edges: vec![],
            layout: authored_layout(reference_a_node.id),
            size_justification: None,
        })
        .await
        .unwrap();
    let reference_b = writer
        .submit_layer(&LayerDraft {
            client_key: "reference-b".into(),
            nodes: vec![reference_b_node.id],
            edges: vec![],
            layout: authored_layout(reference_b_node.id),
            size_justification: None,
        })
        .await
        .unwrap();
    let invoked = writer
        .add_action(&ActionDraft {
            client_key: "follow-up".into(),
            source_node_id: answer.id,
            source_layer_id: Some(layer.id),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Continue /var/folders/project/tokenizer".into(),
            variant: ActionVariant::Card,
            icon: Some("terminal".into()),
            description: Some("Inspect /var/folders/project/tokenizer".into()),
            target_layer_id: None,
            interaction_text: Some("Continue from /var/folders/project/tokenizer".into()),
            input: None,
        })
        .await
        .unwrap();
    for (client_key, label, source_node_id, source_layer_id, target_layer_id, relation) in [
        (
            "nested-expand",
            "Nested details",
            answer.id,
            layer.id,
            nested_layer.id,
            NavigateRelation::Expand,
        ),
        (
            "shared-reference-root",
            "Shared reference one",
            answer.id,
            layer.id,
            reference_a.id,
            NavigateRelation::Reference,
        ),
        (
            "shared-reference-nested",
            "Shared reference two",
            nested_node.id,
            nested_layer.id,
            reference_a.id,
            NavigateRelation::Reference,
        ),
        (
            "reference-cycle-forward",
            "Reference B",
            reference_a_node.id,
            reference_a.id,
            reference_b.id,
            NavigateRelation::Reference,
        ),
        (
            "reference-cycle-back",
            "Back to reference A",
            reference_b_node.id,
            reference_b.id,
            reference_a.id,
            NavigateRelation::Reference,
        ),
    ] {
        writer
            .add_action(&ActionDraft {
                client_key: client_key.into(),
                source_node_id,
                source_layer_id: Some(source_layer_id),
                kind: ActionKind::Navigate,
                relation: Some(relation),
                label: label.into(),
                variant: ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: Some(target_layer_id),
                interaction_text: None,
                input: None,
            })
            .await
            .unwrap();
    }
    writer
        .add_action(&ActionDraft {
            client_key: "root-action".into(),
            source_node_id: graph_interaction.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response /var/folders/project/tokenizer".into(),
            variant: ActionVariant::Card,
            icon: Some("file".into()),
            description: Some("Root /var/folders/project/tokenizer".into()),
            target_layer_id: Some(layer.id),
            interaction_text: None,
            input: None,
        })
        .await
        .unwrap();
    writer.complete(graph_interaction.id).await.unwrap();
    let graph = relayer_graph_server::router(GraphServerState::new(
        graph_database.clone(),
        "graph-control",
    ));
    let (graph_url, graph_task) = serve_test_app_with_current_graph_contract(graph).await;
    let (harness_url, harness_task) = serve_test_app(Router::new()).await;
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion": 1,
            "configurations": [{
                "configuration": {
                    "schemaVersion": 1,
                    "name": "codex-basic",
                    "implementation": "test",
                    "implementationVersion": 1,
                    "permissionBindings": { "ask": {}, "auto": {}, "full": {} },
                    "settings": {}
                },
                "digest": "sha256:test"
            }]
        })
        .to_string(),
    )
    .unwrap();
    let product_database = root.join("product.sqlite3");
    let app = RelayerAppServer::open(RelayerAppServerConfig {
        database_path: product_database.clone(),
        web_directory: root.clone(),
        permission_catalog: permission_catalog(),
        control_token: "control".into(),
        read_only_control_token: Some("review".into()),
        runtime: Some(RelayerRuntimeConfig {
            graph_url,
            harness_url,
            graph_control_token: "graph-control".into(),
            harness_control_token: "harness-control".into(),
            harness_configurations: catalog,
            default_harness_configuration: "codex-basic".into(),
            allow_harness_override: true,
            standalone_workspaces_directory: root.join("workspaces"),
        }),
        allow_conversation_import: false,
        export_producer: relayer_app_server::conversation_export::ExportProducer {
            desktop_version: "0.2.12".into(),
            build_commit: "test-commit".into(),
            platform: "darwin".into(),
            architecture: "arm64".into(),
        },
        completion_broker_origin: None,
    })
    .await
    .unwrap()
    .router();
    let pool = sqlite_pool(&product_database).await;
    sqlx::query("INSERT INTO projects(id,name,path,created_at,updated_at) VALUES (1,'Tokenizer /var/folders/project/tokenizer','/private/var/folders/project/tokenizer','1','1')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO threads(id,title,project_id,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES (1,'Debug /var/folders/project/tokenizer',1,'1','2','codex-basic','auto')")
        .execute(&pool).await.unwrap();
    let receipt = json!({
        "schemaVersion": 1,
        "permissionProfileId": "auto",
        "label": "Approve /var/folders/project/tokenizer",
        "authority": "bounded /var/folders/project/tokenizer",
        "reviewer": "automatic /var/folders/project/tokenizer",
        "bindingPresent": true,
        "unconfinedHostAccess": false,
        "disclosure": "May access /var/folders/project/tokenizer"
    });
    sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,completion_output_json,permission_profile_id,effective_execution_digest,effective_permission_receipt_json) VALUES (1,1,1,'Review /var/folders/project/tokenizer','1',?1,'accepted','codex-basic','sha256:harness','{}','auto','sha256:execution',?2)")
        .bind(graph_interaction.id.value())
        .bind(receipt.to_string())
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status,harness_configuration_name,completion_error,permission_profile_id) VALUES (2,1,2,'Continue from /var/folders/project/tokenizer','2','failed','codex-basic','Failed in /var/folders/project/tokenizer','auto')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at) VALUES (1,?1,2,'2')")
        .bind(invoked.id.value())
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status,harness_configuration_name,permission_profile_id) VALUES (3,1,3,'Still running','3','running','codex-basic','auto')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO threads(id,title,project_id,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES (2,'Other conversation',1,'4','5','codex-basic','auto')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status,harness_configuration_name,permission_profile_id) VALUES (10,2,1,'Other source','4','failed','codex-basic','auto')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status,harness_configuration_name,permission_profile_id) VALUES (11,2,2,'Other result','5','failed','codex-basic','auto')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at) VALUES (10,999,11,'5')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO conversation_imports(id,source_sha256,export_version,producer_json,header_json,state,created_at,published_at) VALUES ('import-state','sha256:imported',1,'{}','{}','published','6','6')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO threads(id,title,project_id,created_at,updated_at,harness_configuration_name,permission_profile_id,conversation_import_id) VALUES (3,'Imported conversation',1,'6','6','codex-basic','auto','import-state')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status,harness_configuration_name,completion_error,permission_profile_id) VALUES (20,3,1,'Imported failed turn','6','failed','codex-basic','Imported failure','auto')")
        .execute(&pool).await.unwrap();
    pool.close().await;

    let workspace_state = response_json(
        app.clone()
            .oneshot(api_request("GET", "/api/state?threadId=1", None, true))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        workspace_state["actionInvocations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let imported_state = response_json(
        app.clone()
            .oneshot(api_request("GET", "/api/state?threadId=3", None, true))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(imported_state["inputDraftRevision"], Value::Null);

    let response = app
        .clone()
        .oneshot(api_request("GET", "/api/threads/1/export", None, true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "application/x-ndjson; charset=utf-8"
    );
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    assert!(bytes.ends_with(b"\n"));
    let exported_text = String::from_utf8_lossy(&bytes);
    assert!(!exported_text.contains("/var/folders/project/tokenizer"));
    assert!(!exported_text.contains("/private/var/folders/project/tokenizer"));
    let records = decode_export_jsonl(&bytes).unwrap();
    assert_eq!(records.len(), 4);
    let ConversationExportRecord::Header(header) = &records[0] else {
        panic!("expected header")
    };
    assert_eq!(header.conversation.title, "Debug [project-path]");
    assert_eq!(
        header.conversation.project_name.as_deref(),
        Some("Tokenizer [project-path]")
    );
    let ConversationExportRecord::Turn(first) = &records[1] else {
        panic!("expected first turn")
    };
    assert_eq!(first.completion.status, ExportCompletionStatus::Accepted);
    assert_eq!(first.text, "Review [project-path]");
    let accepted_view = first.accepted_view.as_ref().unwrap();
    assert_eq!(accepted_view.layers.len(), 4);
    assert!(accepted_view.root_action.label.contains("[project-path]"));
    let exported_answer = accepted_view
        .layers
        .iter()
        .flat_map(|resolved| &resolved.nodes)
        .find(|node| node.title.starts_with("Finding"))
        .unwrap();
    assert!(exported_answer.kind.contains("[project-path]"));
    assert_eq!(exported_answer.icon, "file");
    assert!(exported_answer.title.contains("[project-path]"));
    assert!(exported_answer.detail.contains("[project-path]"));
    let exported_invoke = accepted_view
        .layers
        .iter()
        .flat_map(|resolved| &resolved.actions)
        .find(|action| {
            action.kind == relayer_app_server::conversation_export::ExportActionKind::Invoke
        })
        .unwrap();
    assert!(exported_invoke.label.contains("[project-path]"));
    assert_eq!(exported_invoke.icon.as_deref(), Some("terminal"));
    assert!(
        exported_invoke
            .description
            .as_deref()
            .unwrap()
            .contains("[project-path]")
    );
    assert!(
        exported_invoke
            .interaction_text
            .as_deref()
            .unwrap()
            .contains("[project-path]")
    );
    let receipt = first
        .completion
        .effective_permission_receipt
        .as_ref()
        .unwrap();
    assert!(receipt.label.contains("[project-path]"));
    assert!(receipt.authority.contains("[project-path]"));
    assert!(receipt.reviewer.contains("[project-path]"));
    assert!(
        receipt
            .disclosure
            .as_deref()
            .unwrap()
            .contains("[project-path]")
    );
    let reference_targets = accepted_view
        .layers
        .iter()
        .flat_map(|resolved| &resolved.actions)
        .filter(|action| {
            action.relation
                == Some(relayer_app_server::conversation_export::ExportNavigateRelation::Reference)
        })
        .filter_map(|action| action.target_layer_id.as_deref())
        .collect::<Vec<_>>();
    assert_eq!(reference_targets.len(), 4);
    assert!(reference_targets.iter().any(|target| {
        reference_targets
            .iter()
            .filter(|other| *other == target)
            .count()
            == 3
    }));
    let ConversationExportRecord::Turn(second) = &records[2] else {
        panic!("expected second turn")
    };
    assert_eq!(second.completion.status, ExportCompletionStatus::Failed);
    assert_eq!(
        second.completion.error.as_deref(),
        Some("Failed in [project-path]")
    );
    assert!(matches!(second.origin, ExportTurnOrigin::Action { .. }));
    let ConversationExportRecord::Turn(third) = &records[3] else {
        panic!("expected third turn")
    };
    assert_eq!(third.completion.status, ExportCompletionStatus::Running);
    assert!(third.accepted_view.is_none());

    let repeated = app
        .clone()
        .oneshot(api_request("GET", "/api/threads/1/export", None, true))
        .await
        .unwrap();
    let repeated_bytes = to_bytes(repeated.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let repeated_records = decode_export_jsonl(&repeated_bytes).unwrap();
    let ConversationExportRecord::Turn(repeated_first) = &repeated_records[1] else {
        panic!("expected repeated first turn")
    };
    assert_eq!(repeated_first.accepted_view, first.accepted_view);

    let forbidden = app
        .oneshot(api_request_with_token(
            "GET",
            "/api/threads/1/export",
            None,
            "review",
        ))
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    graph_task.abort();
    harness_task.abort();
    graph_database.close().await;
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn approval_wait_is_durable_and_the_product_decision_resumes_the_same_completion() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-approval-api-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion": 1,
            "configurations": [{
                "configuration": {
                    "schemaVersion": 1,
                    "name": "codex-basic",
                    "implementation": "test",
                    "implementationVersion": 1,
                    "permissionBindings": { "ask": {} },
                    "settings": {}
                },
                "digest": "sha256:test"
            }]
        })
        .to_string(),
    )
    .unwrap();
    let next_graph_node_id = Arc::new(AtomicI64::new(41));
    let graph_node_id = next_graph_node_id.clone();
    let graph = Router::new()
        .route(
            "/api/control/interactions",
            axum::routing::post(move || {
                let node_id = graph_node_id.fetch_add(1, Ordering::SeqCst);
                async move {
                    axum::Json(json!({ "node": { "id": node_id }, "graphToken": "" }))
                }
            }),
        )
        .route(
            "/api/control/capabilities",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                axum::Json(json!({ "graphToken": body["graphToken"] }))
            })
            .delete(|| async { axum::Json(json!({ "revoked": true })) }),
        )
        .route(
            "/api/control/interactions/{id}",
            axum::routing::get(|axum::extract::Path(id): axum::extract::Path<i64>| async move {
                axum::Json(json!({ "nodeId": id, "invocation": null }))
            }),
        )
        .route(
            "/api/control/interactions/{id}/output",
            axum::routing::get(|axum::extract::Path(id): axum::extract::Path<i64>| async move {
                axum::Json(json!({
                    "nodeId": id,
                    "rootLayer": { "layer": { "id": 1 }, "nodes": [], "edges": [], "actions": [] }
                }))
            }),
        );
    let interaction_id = Arc::new(AtomicI64::new(0));
    let event_interaction_id = Arc::new(AtomicI64::new(0));
    let decided = Arc::new(AtomicBool::new(false));
    let completion_active = Arc::new(AtomicBool::new(false));
    let event_epoch_reset = Arc::new(AtomicBool::new(false));
    let decision_notify = Arc::new(tokio::sync::Notify::new());
    let complete_interaction_id = interaction_id.clone();
    let complete_decided = decided.clone();
    let complete_notify = decision_notify.clone();
    let complete_event_interaction_id = event_interaction_id.clone();
    let complete_active = completion_active.clone();
    let events_interaction_id = event_interaction_id.clone();
    let events_decided = decided.clone();
    let events_completion_active = completion_active.clone();
    let events_epoch_reset = event_epoch_reset.clone();
    let decision_interaction_id = interaction_id.clone();
    let decision_decided = decided.clone();
    let decision_signal = decision_notify.clone();
    let harness = Router::new()
        .route(
            "/sessions",
            axum::routing::post(|| async { (StatusCode::CREATED, axum::Json(json!({}))) }),
        )
        .route(
            "/sessions/{id}/complete",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let complete_interaction_id = complete_interaction_id.clone();
                let complete_decided = complete_decided.clone();
                let complete_notify = complete_notify.clone();
                let event_interaction_id = complete_event_interaction_id.clone();
                let completion_active = complete_active.clone();
                async move {
                    let interaction_id = body["interactionId"].as_i64().unwrap();
                    let graph_node_id = body["graph"]["nodeId"].as_i64().unwrap();
                    complete_interaction_id.store(interaction_id, Ordering::SeqCst);
                    let _ = event_interaction_id.compare_exchange(
                        0,
                        interaction_id,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    );
                    completion_active.store(true, Ordering::SeqCst);
                    while !complete_decided.load(Ordering::SeqCst) {
                        complete_notify.notified().await;
                    }
                    completion_active.store(false, Ordering::SeqCst);
                    axum::Json(json!({
                        "output": {
                            "nodeId": graph_node_id,
                            "rootLayer": { "layer": { "id": 1 }, "nodes": [], "edges": [], "actions": [] }
                        }
                    }))
                }
            }),
        )
        .route(
            "/sessions/{id}/approval-events",
            axum::routing::get(move |axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>| {
                let interaction_id = events_interaction_id.load(Ordering::SeqCst);
                let is_decided = events_decided.load(Ordering::SeqCst);
                let completion_active = events_completion_active.load(Ordering::SeqCst);
                let epoch_reset = events_epoch_reset.clone();
                async move {
                    let after = query.get("after").and_then(|value| value.parse::<u64>().ok()).unwrap_or(0);
                    if epoch_reset.load(Ordering::SeqCst) {
                        return axum::Json(json!({
                            "harnessSessionId": "session-1",
                            "latestSequence": 0,
                            "pendingRequests": [],
                            "events": []
                        }));
                    }
                    let correlation = json!({
                        "threadId": 1,
                        "interactionId": interaction_id,
                        "completeCallId": "complete-1",
                        "harnessSessionId": "session-1"
                    });
                    let request = json!({
                        "requestId": "request-1",
                        "correlation": correlation,
                        "title": "Run tests",
                        "reason": "The harness needs to run tests.",
                        "action": { "kind": "command", "command": "npm test", "workingDirectory": "/workspace" },
                        "scopeKeys": ["command:npm test", "cwd:/workspace"],
                        "scopeDescription": "Run npm test in /workspace",
                        "createdAt": "2026-08-20T12:00:00Z"
                    });
                    let resolution = json!({
                        "requestId": "request-1",
                        "correlation": correlation,
                        "outcome": "approved",
                        "actor": "user",
                        "resolvedAt": "2026-08-20T12:01:00Z",
                        "decision": "approve_once"
                    });
                    let mut events = Vec::new();
                    if interaction_id > 0 && after < 1 {
                        events.push(json!({ "sequence": 1, "type": "requested", "request": request }));
                    }
                    if interaction_id > 0 && is_decided && after < 2 {
                        events.push(json!({ "sequence": 2, "type": "resolved", "resolution": resolution }));
                    }
                    let snapshot = axum::Json(json!({
                        "harnessSessionId": "session-1",
                        "latestSequence": if interaction_id == 0 { 0 } else if is_decided { 2 } else { 1 },
                        "pendingRequests": if interaction_id > 0 && !is_decided { vec![request] } else { Vec::<Value>::new() },
                        "events": events
                    }));
                    if is_decided && !completion_active && after == 2 {
                        epoch_reset.store(true, Ordering::SeqCst);
                    }
                    snapshot
                }
            }),
        )
        .route(
            "/sessions/{id}/approvals/{request_id}/decision",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let interaction_id = decision_interaction_id.load(Ordering::SeqCst);
                let decided = decision_decided.clone();
                let notify = decision_signal.clone();
                async move {
                    assert_eq!(body, json!({ "decision": "approve_once" }));
                    decided.store(true, Ordering::SeqCst);
                    notify.notify_waiters();
                    axum::Json(json!({
                        "requestId": "request-1",
                        "correlation": {
                            "threadId": 1,
                            "interactionId": interaction_id,
                            "completeCallId": "complete-1",
                            "harnessSessionId": "session-1"
                        },
                        "outcome": "approved",
                        "actor": "user",
                        "resolvedAt": "2026-08-20T12:01:00Z",
                        "decision": "approve_once"
                    }))
                }
            }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(harness).await;
    let app =
        open_app_with_runtime_allow_override(&database, &root, &catalog, &graph_url, &harness_url)
            .await;

    let created = response_json(
        app.clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({
                    "initialMessage": "Please run the test suite",
                    "permissionProfileId": "ask"
                })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = created["id"].as_i64().unwrap();
    let product_interaction_id = created["rootInteractionId"].as_i64().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let state = response_json(
            app.clone()
                .oneshot(api_request(
                    "GET",
                    &format!("/api/state?threadId={thread_id}"),
                    None,
                    true,
                ))
                .await
                .unwrap(),
        )
        .await;
        if state["interactions"][0]["completionStatus"] == "waiting_for_approval" {
            assert_eq!(state["approvals"].as_array().unwrap().len(), 1);
            assert!(
                state["approvals"][0]["request"]["correlation"]
                    .get("providerItemId")
                    .is_none()
            );
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for terminal interaction state: {state}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let decision_uri = format!(
        "/api/threads/{thread_id}/interactions/{product_interaction_id}/approvals/request-1/decision"
    );
    let decision_response = app
        .clone()
        .oneshot(api_request(
            "POST",
            &decision_uri,
            Some(json!({ "decision": "approve_once" })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(decision_response.status(), StatusCode::OK);
    let receipt = response_json(decision_response).await;
    assert_eq!(receipt["approval"]["resolution"]["outcome"], "approved");

    loop {
        let state = response_json(
            app.clone()
                .oneshot(api_request(
                    "GET",
                    &format!("/api/state?threadId={thread_id}"),
                    None,
                    true,
                ))
                .await
                .unwrap(),
        )
        .await;
        if state["interactions"][0]["completionStatus"] == "accepted" {
            assert_eq!(
                state["approvals"][0]["resolution"]["decision"],
                "approve_once"
            );
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let duplicate = app
        .clone()
        .oneshot(api_request(
            "POST",
            &decision_uri,
            Some(json!({ "decision": "approve_once" })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    let epoch_reset_deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !event_epoch_reset.load(Ordering::SeqCst) {
        assert!(std::time::Instant::now() < epoch_reset_deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(event_epoch_reset.load(Ordering::SeqCst));

    let second = response_json(
        app.clone()
            .oneshot(api_request(
                "POST",
                &format!("/api/threads/{thread_id}/interactions"),
                Some(json!({ "text": "Continue after the approved command" })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let second_interaction_id = second["id"].as_i64().unwrap();
    loop {
        let state = response_json(
            app.clone()
                .oneshot(api_request(
                    "GET",
                    &format!("/api/state?threadId={thread_id}"),
                    None,
                    true,
                ))
                .await
                .unwrap(),
        )
        .await;
        let second = state["interactions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|interaction| interaction["id"] == second_interaction_id)
            .unwrap();
        if second["completionStatus"] == "accepted" {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    drop(app);
    graph_task.abort();
    harness_task.abort();
    let reopened = open_app(&database, &root).await;
    let restored = response_json(
        reopened
            .oneshot(api_request(
                "GET",
                &format!("/api/state?threadId={thread_id}"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        restored["approvals"][0]["resolution"]["outcome"],
        "approved"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn malformed_approval_reconciliation_cancels_and_fails_the_completion() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-approval-reconciliation-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion": 1,
            "configurations": [{
                "configuration": {
                    "schemaVersion": 1,
                    "name": "codex-basic",
                    "implementation": "test",
                    "implementationVersion": 1,
                    "permissionBindings": { "ask": {} },
                    "settings": {}
                },
                "digest": "sha256:test"
            }]
        })
        .to_string(),
    )
    .unwrap();
    let revoked = Arc::new(AtomicBool::new(false));
    let revoke_signal = revoked.clone();
    let graph = Router::new()
        .route(
            "/api/control/interactions",
            axum::routing::post(|| async {
                axum::Json(json!({ "node": { "id": 41 }, "graphToken": "" }))
            }),
        )
        .route(
            "/api/control/capabilities",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                axum::Json(json!({ "graphToken": body["graphToken"] }))
            })
            .delete(move || {
                let revoked = revoke_signal.clone();
                async move {
                    revoked.store(true, Ordering::SeqCst);
                    axum::Json(json!({ "revoked": true }))
                }
            }),
        )
        .route(
            "/api/control/interactions/{id}",
            axum::routing::get(
                |axum::extract::Path(id): axum::extract::Path<i64>| async move {
                    axum::Json(json!({ "nodeId": id, "invocation": null }))
                },
            ),
        );
    let interaction_id = Arc::new(AtomicI64::new(0));
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancellation = Arc::new(tokio::sync::Notify::new());
    let complete_interaction_id = interaction_id.clone();
    let complete_cancelled = cancelled.clone();
    let complete_cancellation = cancellation.clone();
    let events_interaction_id = interaction_id.clone();
    let cancel_cancelled = cancelled.clone();
    let cancel_cancellation = cancellation.clone();
    let harness = Router::new()
        .route(
            "/sessions",
            axum::routing::post(|| async { (StatusCode::CREATED, axum::Json(json!({}))) }),
        )
        .route(
            "/sessions/{id}/complete",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let interaction_id = complete_interaction_id.clone();
                let cancelled = complete_cancelled.clone();
                let cancellation = complete_cancellation.clone();
                async move {
                    interaction_id.store(body["interactionId"].as_i64().unwrap(), Ordering::SeqCst);
                    while !cancelled.load(Ordering::SeqCst) {
                        cancellation.notified().await;
                    }
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        axum::Json(json!({ "error": "cancelled" })),
                    )
                }
            }),
        )
        .route(
            "/sessions/{id}/cancel",
            axum::routing::post(move || {
                let cancelled = cancel_cancelled.clone();
                let cancellation = cancel_cancellation.clone();
                async move {
                    cancelled.store(true, Ordering::SeqCst);
                    cancellation.notify_waiters();
                    axum::Json(json!({ "cancelled": true }))
                }
            }),
        )
        .route(
            "/sessions/{id}/approval-events",
            axum::routing::get(move || {
                let interaction_id = events_interaction_id.load(Ordering::SeqCst);
                async move {
                    if interaction_id == 0 {
                        return axum::Json(json!({
                            "harnessSessionId": "session-1",
                            "latestSequence": 0,
                            "pendingRequests": [],
                            "events": []
                        }));
                    }
                    let request = json!({
                        "requestId": "request-1",
                        "correlation": {
                            "threadId": 1,
                            "interactionId": interaction_id,
                            "completeCallId": "complete-1",
                            "harnessSessionId": "session-1"
                        },
                        "title": "Run tests",
                        "reason": "The harness needs approval.",
                        "action": { "kind": "command", "command": "npm test", "workingDirectory": "/workspace" },
                        "scopeKeys": ["command:npm test"],
                        "scopeDescription": "Run npm test",
                        "createdAt": "2026-08-20T12:00:00Z"
                    });
                    axum::Json(json!({
                        "harnessSessionId": "session-1",
                        "latestSequence": 2,
                        "pendingRequests": [request.clone()],
                        "events": [{ "sequence": 2, "type": "requested", "request": request }]
                    }))
                }
            }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(harness).await;
    let app =
        open_app_with_runtime_allow_override(&database, &root, &catalog, &graph_url, &harness_url)
            .await;
    let created = response_json(
        app.clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({
                    "initialMessage": "Please run tests",
                    "permissionProfileId": "ask"
                })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = created["id"].as_i64().unwrap();

    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let state = response_json(
            app.clone()
                .oneshot(api_request(
                    "GET",
                    &format!("/api/state?threadId={thread_id}"),
                    None,
                    true,
                ))
                .await
                .unwrap(),
        )
        .await;
        if state["interactions"][0]["completionStatus"] == "failed" {
            assert!(
                state["interactions"][0]["completionError"]
                    .as_str()
                    .unwrap()
                    .contains("event sequence jumped")
            );
            assert!(state["approvals"].as_array().unwrap().is_empty());
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(cancelled.load(Ordering::SeqCst));
    assert!(revoked.load(Ordering::SeqCst));
    graph_task.abort();
    harness_task.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn action_invocation_api_is_idempotent_and_survives_restart() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-action-api-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");

    let app = open_app(&database, &root).await;
    let pool = sqlite_pool(&database).await;
    sqlx::query("UPDATE product_harnesses SET family_policy_id='codex-default-family',family_policy_version=1 WHERE configuration_name='codex-basic'")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let published = app
        .clone()
        .oneshot(provider_publish_request(test_provider_snapshot()))
        .await
        .unwrap();
    assert_eq!(published.status(), StatusCode::NO_CONTENT);
    let pool = sqlite_pool(&database).await;
    sqlx::query(
        "UPDATE product_harnesses SET available=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL WHERE configuration_name='codex-basic'",
    )
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
    let settings = response_json(
        app.clone()
            .oneshot(api_request("GET", "/api/model-settings", None, true))
            .await
            .unwrap(),
    )
    .await;
    let family_id = settings["families"][0]["id"].as_i64().unwrap();
    let thread = app
        .oneshot(api_request(
            "POST",
            "/api/threads",
            Some(json!({
                "title": "Invoke once",
                "initialMessage": "Start here",
                "harnessId": "codex-basic",
                "modelSelection": {
                    "familyId": family_id,
                    "providerId": "codex",
                    "modelId": "test-model"
                }
            })),
            true,
        ))
        .await
        .unwrap();
    let thread = response_json(thread).await;
    let thread_id = thread["id"].as_i64().unwrap();
    let source_interaction_id = thread["rootInteractionId"].as_i64().unwrap();
    let pool = sqlite_pool(&database).await;
    let project_id = sqlx::query(
        "INSERT INTO projects(name,path,created_at,updated_at) VALUES ('Invoke project',?1,'1','1')",
    )
    .bind(root.to_string_lossy().as_ref())
    .execute(&pool)
    .await
    .unwrap()
    .last_insert_rowid();
    sqlx::query("UPDATE threads SET project_id=?1 WHERE id=?2")
        .bind(project_id)
        .bind(thread_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE interactions SET graph_node_id=101,completion_status='accepted',completion_output_json=?1 WHERE id=?2",
    )
    .bind(json!({
        "nodeId":101,
        "rootLayer":{"layer":{"id":1},"nodes":[],"edges":[],"actions":[{
            "id":41,"kind":"invoke","interactionText":"Authored follow-up",
            "state":"accepted","targetLayerId":null
        }]}
    }).to_string())
    .bind(source_interaction_id)
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    let graph_interactions = Arc::new(AtomicUsize::new(202));
    let graph_interaction_counter = graph_interactions.clone();
    let observed_graph_creates = Arc::new(Mutex::new(Vec::<Value>::new()));
    let graph_create_bodies = observed_graph_creates.clone();
    let graph_metadata = Arc::new(Mutex::new(HashMap::<usize, Value>::new()));
    let created_graph_metadata = graph_metadata.clone();
    let graph_nodes_by_pair = Arc::new(Mutex::new(HashMap::<(i64, i64), usize>::new()));
    let created_graph_nodes_by_pair = graph_nodes_by_pair.clone();
    let projection_reads = Arc::new(AtomicUsize::new(0));
    let observed_projection_reads = projection_reads.clone();
    let graph = axum::Router::new()
        .route(
            "/api/control/capabilities",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                axum::Json(json!({ "graphToken": body["graphToken"] }))
            })
            .delete(|| async { axum::Json(json!({ "revoked": true })) }),
        )
        .route(
            "/api/control/interactions/{id}/actions/{action_id}",
            axum::routing::get(
                |axum::extract::Path((id, action_id)): axum::extract::Path<(i64, i64)>| async move {
                    if matches!((id, action_id), (101 | 103, 41) | (101, 43) | (303, 41)) {
                        return (
                            StatusCode::OK,
                            axum::Json(json!({
                                "action": {
                                    "id": action_id,
                                    "kind": "invoke",
                                    "interactionText": "Authored follow-up",
                                    "state": "accepted"
                                }
                            })),
                        );
                    }
                    (
                        StatusCode::NOT_FOUND,
                        axum::Json(json!({
                            "error": {
                                "code": "action_not_visible",
                                "message": "action is not visible from this interaction"
                            }
                        })),
                    )
                },
            ),
        )
        .route(
            "/api/control/interactions",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let graph_interaction_counter = graph_interaction_counter.clone();
                let graph_create_bodies = graph_create_bodies.clone();
                let created_graph_metadata = created_graph_metadata.clone();
                let created_graph_nodes_by_pair = created_graph_nodes_by_pair.clone();
                async move {
                    let invocation = body["invocation"].clone();
                    graph_create_bodies.lock().unwrap().push(body);
                    let pair = (
                        invocation["sourceInteractionNodeId"].as_i64().unwrap(),
                        invocation["sourceActionId"].as_i64().unwrap(),
                    );
                    let node_id = *created_graph_nodes_by_pair
                        .lock()
                        .unwrap()
                        .entry(pair)
                        .or_insert_with(|| {
                            graph_interaction_counter.fetch_add(1, Ordering::SeqCst)
                        });
                    created_graph_metadata
                        .lock()
                        .unwrap()
                        .insert(node_id, invocation);
                    axum::Json(json!({ "node": { "id": node_id }, "graphToken": "" }))
                }
            }),
        )
        .route(
            "/api/control/interactions/{id}",
            axum::routing::get(move |axum::extract::Path(id): axum::extract::Path<usize>| {
                let graph_metadata = graph_metadata.clone();
                async move {
                    axum::Json(json!({
                        "nodeId": id,
                        "invocation": graph_metadata.lock().unwrap().get(&id).cloned()
                    }))
                }
            }),
        )
        .route(
            "/api/control/interactions/101/output",
            axum::routing::get(move || {
                let observed_projection_reads = observed_projection_reads.clone();
                async move {
                    if observed_projection_reads.fetch_add(1, Ordering::SeqCst) == 0 {
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            axum::Json(json!({"error":{"code":"temporarily_unavailable"}})),
                        );
                    }
                    (
                        StatusCode::OK,
                        axum::Json(json!({
                            "nodeId":101,
                            "rootLayer":{"layer":{"id":1},"nodes":[],"edges":[],"actions":[{
                                "id":41,"kind":"invoke","interactionText":"Authored follow-up",
                                "state":"accepted","targetLayerId":null
                            }]}
                        })),
                    )
                }
            }),
        );
    let harness_completions = Arc::new(AtomicUsize::new(0));
    let completion_counter = harness_completions.clone();
    let observed_models = Arc::new(Mutex::new(Vec::<Value>::new()));
    let harness_models = observed_models.clone();
    let product_database = database.clone();
    let harness = axum::Router::new()
        .route(
            "/sessions",
            axum::routing::post(|| async { (StatusCode::CREATED, axum::Json(json!({}))) }),
        )
        .route(
            "/sessions/{id}/execution-leases",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                (StatusCode::CREATED, axum::Json(test_execution_admission(
                    &body,
                    "00000000-0000-0000-0000-000000000007",
                    "7",
                )))
            }),
        )
        .route(
            "/sessions/{id}/execution-leases/{lease}",
            axum::routing::delete(|| async { axum::Json(json!({ "released": false })) }),
        )
        .route(
            "/sessions/{id}/complete",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let completion_counter = completion_counter.clone();
                let harness_models = harness_models.clone();
                let product_database = product_database.clone();
                async move {
                    let pool = sqlite_pool(&product_database).await;
                    let prepared: (Option<i64>, String, Option<String>, Option<String>, Option<String>) =
                        sqlx::query_as("SELECT graph_node_id,completion_status,harness_configuration_digest,effective_execution_digest,effective_permission_receipt_json FROM interactions WHERE id=?1")
                            .bind(body["traceContext"]["productInteractionId"].as_i64().unwrap())
                            .fetch_one(&pool).await.unwrap();
                    pool.close().await;
                    assert_eq!(prepared.0, body["graph"]["nodeId"].as_i64());
                    assert_eq!(prepared.1, "running");
                    assert!(prepared.2.is_some() && prepared.3.is_some() && prepared.4.is_some());
                    assert!(!prepared.4.as_deref().unwrap().contains(
                        body["graph"]["token"].as_str().unwrap()
                    ));
                    harness_models.lock().unwrap().push(body["model"].clone());
                    completion_counter.fetch_add(1, Ordering::SeqCst);
                    let node_id = body["graph"]["nodeId"].as_i64().unwrap();
                    axum::Json(json!({
                        "output": {
                            "nodeId": node_id,
                            "rootLayer": { "layer": { "id": 1 }, "nodes": [], "edges": [], "actions": [] }
                        }
                    }))
                }
            }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(harness).await;
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion": 1,
            "configurations": [{
                "configuration": {
                    "schemaVersion": 1,
                    "name": "codex-basic",
                    "implementation": "test",
                    "implementationVersion": 1,
                    "permissionBindings": { "ask": {}, "auto": {}, "full": {} },
                    "modelCompatibility": [{ "providerId": "codex" }],
                    "executionAccessContracts": ["managed-runtime@1"],
                    "settings": {}
                },
                "digest": "sha256:test"
            }]
        })
        .to_string(),
    )
    .unwrap();

    let app =
        open_app_with_runtime_observed(&database, &root, &catalog, &graph_url, &harness_url).await;
    let rejected = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!(
                "/api/threads/{thread_id}/interactions/{source_interaction_id}/actions/42/invoke"
            ),
            None,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let uri =
        format!("/api/threads/{thread_id}/interactions/{source_interaction_id}/actions/41/invoke");
    let first = app.clone().oneshot(api_request("POST", &uri, None, true));
    let second = app.clone().oneshot(api_request("POST", &uri, None, true));
    let (first, second) = tokio::join!(first, second);
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(
        [first.status(), second.status()]
            .into_iter()
            .filter(|status| *status == StatusCode::CREATED)
            .count(),
        1
    );

    let first_projection = response_json(
        app.clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/state?threadId={thread_id}"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        first_projection["interactions"][0]["projectionFresh"],
        false
    );
    let refreshed_projection = response_json(
        app.clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/state?threadId={thread_id}"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        refreshed_projection["interactions"][0]["projectionFresh"],
        true
    );

    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let state = app
            .clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/state?threadId={thread_id}"),
                None,
                true,
            ))
            .await
            .unwrap();
        let state = response_json(state).await;
        assert_eq!(state["actionInvocations"].as_array().unwrap().len(), 1);
        assert_eq!(state["interactions"].as_array().unwrap().len(), 2);
        assert_eq!(
            state["actionInvocations"][0]["resultCompletionStatus"],
            state["interactions"][1]["completionStatus"]
        );
        if state["interactions"][1]["completionStatus"] == "accepted" {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(harness_completions.load(Ordering::SeqCst), 1);
    assert_eq!(
        observed_models.lock().unwrap().as_slice(),
        [
            json!({ "providerId": "codex", "adapterId": "codex-subscription", "modelId": "test-model" })
        ]
    );
    let action_state = response_json(
        app.clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/state?threadId={thread_id}"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        action_state["interactions"][1]["modelSelection"],
        json!({
            "familyId": family_id,
            "providerId": "codex",
            "modelId": "test-model"
        })
    );

    let canonical_result_interaction_id = action_state["interactions"][1]["id"].as_i64().unwrap();
    let pool = sqlite_pool(&database).await;
    let unrelated_thread_id = sqlx::query("INSERT INTO threads(title,project_id,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES ('Unrelated source',?1,'4','4','codex-basic','auto')")
        .bind(project_id)
        .execute(&pool)
        .await
        .unwrap()
        .last_insert_rowid();
    let unrelated_source_interaction_id = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,completion_output_json,harness_configuration_name,permission_profile_id) VALUES (?1,1,'Unrelated source','4',102,'accepted',?2,'codex-basic','auto')")
        .bind(unrelated_thread_id)
        .bind(json!({
            "nodeId": 102,
            "rootLayer": {"layer": {"id": 2}, "nodes": [], "edges": [], "actions": []}
        }).to_string())
        .execute(&pool)
        .await
        .unwrap()
        .last_insert_rowid();
    let reused_thread_id = sqlx::query("INSERT INTO threads(title,project_id,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES ('Reused source',?1,'5','5','codex-basic','auto')")
        .bind(project_id)
        .execute(&pool)
        .await
        .unwrap()
        .last_insert_rowid();
    let reused_source_interaction_id = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,completion_output_json,harness_configuration_name,permission_profile_id) VALUES (?1,1,'Reused source','5',103,'accepted',?2,'codex-basic','auto')")
        .bind(reused_thread_id)
        .bind(json!({
            "nodeId": 103,
            "rootLayer": {"layer": {"id": 3}, "nodes": [], "edges": [], "actions": [{
                "id": 41, "kind": "invoke", "interactionText": "Authored follow-up",
                "state": "accepted", "targetLayerId": null
            }]}
        }).to_string())
        .execute(&pool)
        .await
        .unwrap()
        .last_insert_rowid();
    pool.close().await;

    let unrelated_uri = format!(
        "/api/threads/{unrelated_thread_id}/interactions/{unrelated_source_interaction_id}/actions/41/invoke"
    );
    let unrelated_terminal = app
        .clone()
        .oneshot(api_request("POST", &unrelated_uri, None, true))
        .await
        .unwrap();
    assert_eq!(
        unrelated_terminal.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(harness_completions.load(Ordering::SeqCst), 1);

    let pool = sqlite_pool(&database).await;
    sqlx::query("UPDATE interactions SET graph_node_id=NULL,completion_status='submitted',completion_output_json=NULL,completion_error='Retry after restart' WHERE id=?1")
        .bind(canonical_result_interaction_id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let unrelated_submitted = app
        .clone()
        .oneshot(api_request("POST", &unrelated_uri, None, true))
        .await
        .unwrap();
    assert_eq!(
        unrelated_submitted.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(harness_completions.load(Ordering::SeqCst), 1);

    let reused_uri = format!(
        "/api/threads/{reused_thread_id}/interactions/{reused_source_interaction_id}/actions/41/invoke"
    );
    let reused_retry = app
        .clone()
        .oneshot(api_request("POST", &reused_uri, None, true))
        .await
        .unwrap();
    assert_eq!(reused_retry.status(), StatusCode::OK);
    assert_eq!(response_json(reused_retry).await["created"], false);
    let retried_state = wait_for_interaction_count_and_terminal(&app, thread_id, 2).await;
    assert_eq!(
        retried_state["interactions"][1]["id"],
        canonical_result_interaction_id
    );
    assert_eq!(
        retried_state["interactions"][1]["completionStatus"],
        "accepted"
    );
    assert_eq!(harness_completions.load(Ordering::SeqCst), 2);

    let ordinary_unselected = app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/threads",
            Some(json!({
                "title": "Still requires a model",
                "initialMessage": "Do not run without a selection",
                "harnessId": "codex-basic"
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(
        ordinary_unselected.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        response_json(ordinary_unselected).await["code"],
        "model_selection_required"
    );

    // A pre-selector accepted interaction has no model columns, but its thread already pins the
    // only harness configuration ordinary Product execution may use.
    let pool = sqlite_pool(&database).await;
    let legacy_timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string();
    let legacy_thread = sqlx::query(
        "INSERT INTO threads(title,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES ('Legacy action',?1,?1,'codex-basic','auto')",
    )
    .bind(&legacy_timestamp)
    .execute(&pool)
    .await
    .unwrap();
    let legacy_thread_id = legacy_thread.last_insert_rowid();
    let legacy_source = sqlx::query(
        "INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,permission_profile_id) VALUES (?1,1,'Legacy source',?2,303,'accepted','codex-basic','auto')",
    )
    .bind(legacy_thread_id)
    .bind(&legacy_timestamp)
    .execute(&pool)
    .await
    .unwrap();
    let legacy_source_interaction_id = legacy_source.last_insert_rowid();
    pool.close().await;

    let legacy_uri = format!(
        "/api/threads/{legacy_thread_id}/interactions/{legacy_source_interaction_id}/actions/41/invoke"
    );
    let legacy_invocation = app
        .clone()
        .oneshot(api_request("POST", &legacy_uri, None, true))
        .await
        .unwrap();
    assert_eq!(legacy_invocation.status(), StatusCode::CREATED);
    let legacy_state = wait_for_interaction_count_and_terminal(&app, legacy_thread_id, 2).await;
    assert_eq!(
        legacy_state["interactions"][1]["completionStatus"],
        "accepted"
    );
    assert_eq!(
        legacy_state["interactions"][1]["modelSelection"],
        Value::Null
    );
    assert_eq!(harness_completions.load(Ordering::SeqCst), 3);
    assert_eq!(
        observed_models.lock().unwrap().as_slice(),
        [
            json!({ "providerId": "codex", "adapterId": "codex-subscription", "modelId": "test-model" }),
            json!({ "providerId": "codex", "adapterId": "codex-subscription", "modelId": "test-model" }),
            Value::Null,
        ]
    );

    // Simulate a request disappearing after its durable one-shot record commits but before the
    // old handler starts execution. Retrying the saved invocation must validate that the source
    // still exposes the action, then claim the durable result exactly once.
    let pool = sqlite_pool(&database).await;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string();
    let result = sqlx::query(
        "INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status,model_provider_id,provider_model_id,model_family_id) VALUES (?1,3,'Recovered follow-up',?2,'not_started','codex','test-model',?3)",
    )
    .bind(thread_id)
    .bind(&created_at)
    .bind(family_id)
    .execute(&pool)
    .await
    .unwrap();
    let result_interaction_id = result.last_insert_rowid();
    sqlx::query(
        "INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at) VALUES (?1,43,?2,?3)",
    )
    .bind(source_interaction_id)
    .bind(result_interaction_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    let recovery_uri =
        format!("/api/threads/{thread_id}/interactions/{source_interaction_id}/actions/43/invoke");
    let first_recovery = app
        .clone()
        .oneshot(api_request("POST", &recovery_uri, None, true));
    let second_recovery = app
        .clone()
        .oneshot(api_request("POST", &recovery_uri, None, true));
    let (first_recovery, second_recovery) = tokio::join!(first_recovery, second_recovery);
    assert_eq!(first_recovery.unwrap().status(), StatusCode::OK);
    assert_eq!(second_recovery.unwrap().status(), StatusCode::OK);

    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let state = response_json(
            app.clone()
                .oneshot(api_request(
                    "GET",
                    &format!("/api/state?threadId={thread_id}"),
                    None,
                    true,
                ))
                .await
                .unwrap(),
        )
        .await;
        let recovered = state["interactions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|interaction| interaction["id"] == result_interaction_id)
            .unwrap();
        if recovered["completionStatus"] == "accepted" {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(harness_completions.load(Ordering::SeqCst), 4);
    let invocation_pairs = {
        let graph_creates = observed_graph_creates.lock().unwrap();
        graph_creates
            .iter()
            .map(|create| {
                (
                    create["invocation"]["sourceInteractionNodeId"]
                        .as_i64()
                        .unwrap(),
                    create["invocation"]["sourceActionId"].as_i64().unwrap(),
                )
            })
            .collect::<Vec<_>>()
    };
    assert!(
        (2..=4).contains(
            &invocation_pairs
                .iter()
                .filter(|pair| **pair == (101, 41))
                .count()
        )
    );
    assert_eq!(
        invocation_pairs
            .iter()
            .filter(|pair| **pair == (303, 41))
            .count(),
        1
    );
    assert!(
        (1..=2).contains(
            &invocation_pairs
                .iter()
                .filter(|pair| **pair == (101, 43))
                .count()
        )
    );
    assert!(
        invocation_pairs
            .iter()
            .all(|pair| matches!(pair, (101, 41) | (303, 41) | (101, 43)))
    );
    assert_eq!(observed_models.lock().unwrap().len(), 4);
    drop(app);

    let reopened =
        open_app_with_runtime(&database, &root, &catalog, &graph_url, &harness_url).await;
    let replay = reopened
        .oneshot(api_request("POST", &uri, None, true))
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::OK);
    let replay = response_json(replay).await;
    assert_eq!(replay["created"], false);
    assert_eq!(replay["interaction"]["text"], "Authored follow-up");

    graph_task.abort();
    harness_task.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn product_model_selection_is_validated_inherited_transported_and_auditable() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-model-interactions-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");

    let graph_node_ids = Arc::new(AtomicUsize::new(700));
    let next_graph_node_id = graph_node_ids.clone();
    let output_reads = Arc::new(AtomicUsize::new(0));
    let observed_output_reads = output_reads.clone();
    let graph = axum::Router::new()
        .route(
            "/api/control/interactions",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let next_graph_node_id = next_graph_node_id.clone();
                async move {
                    if body["text"] == "ordinary create response loss" {
                        return (StatusCode::OK, "truncated create response").into_response();
                    }
                    if body["text"] == "Retry preparation failure" {
                        return (
                            StatusCode::UNPROCESSABLE_ENTITY,
                            axum::Json(json!({"error":"deterministic retry preparation failure"})),
                        )
                            .into_response();
                    }
                    let node_id = next_graph_node_id.fetch_add(1, Ordering::SeqCst);
                    axum::Json(json!({
                        "node": { "id": node_id },
                        "graphToken": "",
                        "inputIdentity": body["inputIdentity"],
                        "inputDigest": body["inputDigest"]
                    }))
                    .into_response()
                }
            }),
        )
        .route(
            "/api/control/context-occurrences/canonical",
            axum::routing::post(canonical_accepted_context_node),
        )
        .route(
            "/api/control/capabilities",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                axum::Json(json!({ "graphToken": body["graphToken"] }))
            })
            .delete(|| async { axum::Json(json!({ "revoked": true })) }),
        )
        .route(
            "/api/control/interactions/{id}",
            axum::routing::get(
                |axum::extract::Path(id): axum::extract::Path<usize>| async move {
                    axum::Json(json!({ "nodeId": id, "invocation": null }))
                },
            ),
        )
        .route(
            "/api/control/interactions/{id}/output",
            axum::routing::get(move || {
                let observed_output_reads = observed_output_reads.clone();
                async move {
                    if observed_output_reads.fetch_add(1, Ordering::SeqCst) == 0 {
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            axum::Json(json!({"error":{"code":"temporarily_unavailable"}})),
                        );
                    }
                    (
                        StatusCode::NOT_FOUND,
                        axum::Json(json!({"error":{"code":"completion_not_found"}})),
                    )
                }
            }),
        );
    let observed_models = Arc::new(Mutex::new(Vec::<Value>::new()));
    let harness_models = observed_models.clone();
    let retryable_failure_seen = Arc::new(AtomicBool::new(false));
    let harness_retryable_failure_seen = retryable_failure_seen.clone();
    let harness = axum::Router::new()
        .route(
            "/sessions",
            axum::routing::post(|| async { (StatusCode::CREATED, axum::Json(json!({}))) }),
        )
        .route(
            "/sessions/{id}/execution-leases",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                (StatusCode::CREATED, axum::Json(test_execution_admission(
                    &body,
                    "00000000-0000-0000-0000-000000000007",
                    "7",
                )))
            }),
        )
        .route(
            "/sessions/{id}/execution-leases/{lease}",
            axum::routing::delete(|| async { axum::Json(json!({ "released": false })) }),
        )
        .route(
            "/sessions/{id}/complete",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let harness_models = harness_models.clone();
                let harness_retryable_failure_seen = harness_retryable_failure_seen.clone();
                async move {
                    harness_models.lock().unwrap().push(body["model"].clone());
                    if body["model"]["modelId"] == "retryable-model"
                        && !harness_retryable_failure_seen.swap(true, Ordering::SeqCst)
                    {
                        return (
                            StatusCode::TOO_MANY_REQUESTS,
                            axum::Json(json!({
                                "error": "deterministic provider rate limit",
                                "failureCategory": "rate_limit",
                                "effectBoundary": "none"
                            })),
                        );
                    }
                    if body["model"]["modelId"] == "broken-model" {
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            axum::Json(json!({ "error": "deterministic harness failure" })),
                        );
                    }
                    (
                        StatusCode::OK,
                        axum::Json(json!({
                            "output": {
                                "nodeId": body["graph"]["nodeId"],
                                "rootLayer": { "layer": { "id": 1 }, "nodes": [], "edges": [], "actions": [] }
                            }
                        })),
                    )
                }
            }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(harness).await;
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion": 1,
            "configurations": [
                {
                    "configuration": {
                        "schemaVersion": 1,
                        "name": "codex-basic",
                        "implementation": "test",
                        "implementationVersion": 1,
                        "permissionBindings": { "ask": {}, "auto": {}, "full": {} },
                        "modelCompatibility": [{ "providerId": "codex" }],
                        "executionAccessContracts": ["managed-runtime@1"],
                        "settings": {}
                    },
                    "digest": "sha256:model-test"
                },
                {
                    "configuration": {
                        "schemaVersion": 1,
                        "name": "full-only",
                        "implementation": "test",
                        "implementationVersion": 1,
                        "permissionBindings": { "full": {} },
                        "modelCompatibility": [{ "providerId": "codex" }],
                        "executionAccessContracts": ["managed-runtime@1"],
                        "settings": {}
                    },
                    "digest": "sha256:full-only"
                }
            ]
        })
        .to_string(),
    )
    .unwrap();
    let app =
        open_app_with_runtime_observed(&database, &root, &catalog, &graph_url, &harness_url).await;
    let full_only_permissions = response_json(
        app.clone()
            .oneshot(api_request(
                "GET",
                "/api/permission-profiles?harnessId=full-only",
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        full_only_permissions["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|profile| profile["available"] == true)
            .map(|profile| profile["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["full"]
    );
    assert_eq!(
        app.clone()
            .oneshot(provider_publish_request(test_provider_snapshot()))
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    let settings = response_json(
        app.clone()
            .oneshot(api_request("GET", "/api/model-settings", None, true))
            .await
            .unwrap(),
    )
    .await;
    assert!(settings["families"].is_array());
    let pool = sqlite_pool(&database).await;
    sqlx::query("INSERT INTO provider_models(provider_id,model_id,label,provider_order,visible,available,provider_default,metadata_json) VALUES ('codex','retryable-model','Retryable model',3,1,1,0,'{}')")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let family = app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/model-families",
            Some(json!({
                "name": "Runtime contract models",
                "members": [
                    { "providerId": "codex", "modelId": "test-model" },
                    { "providerId": "codex", "modelId": "second-model" },
                    { "providerId": "codex", "modelId": "broken-model" },
                    { "providerId": "codex", "modelId": "retryable-model" }
                ]
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(family.status(), StatusCode::CREATED);
    let family_id = response_json(family).await["id"].as_i64().unwrap();

    let raw_override = app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/threads",
            Some(json!({
                "initialMessage": "Do not create",
                "harnessConfigurationName": "codex-basic",
                "modelSelection": model_selection(family_id, "test-model")
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(raw_override.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let invalid = app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/threads",
            Some(json!({
                "initialMessage": "Still do not create",
                "harnessId": "codex-basic",
                "modelSelection": model_selection(family_id, "missing-model")
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        response_json(invalid).await["code"],
        "model_selection_unknown"
    );
    let empty_state = response_json(
        app.clone()
            .oneshot(api_request("GET", "/api/state", None, true))
            .await
            .unwrap(),
    )
    .await;
    assert!(empty_state["threads"].as_array().unwrap().is_empty());

    let created = app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/threads",
            Some(json!({
                "title": "Model transport",
                "initialMessage": "First",
                "harnessId": "codex-basic",
                "modelSelection": model_selection(family_id, "test-model")
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let created = response_json(created).await;
    assert_eq!(created["harnessId"], "codex-basic");
    assert_eq!(created["harnessConfigurationName"], "codex-basic");
    let thread_id = created["id"].as_i64().unwrap();
    wait_for_interaction_count_and_terminal(&app, thread_id, 1).await;

    let inherited = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({ "text": "Second" })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(inherited.status(), StatusCode::CREATED);
    assert_eq!(
        response_json(inherited).await["modelSelection"],
        model_selection(family_id, "test-model")
    );
    wait_for_interaction_count_and_terminal(&app, thread_id, 2).await;

    let changed = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({
                "text": "Third",
                "modelSelection": model_selection(family_id, "second-model")
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(changed.status(), StatusCode::CREATED);
    wait_for_interaction_count_and_terminal(&app, thread_id, 3).await;

    let pool = sqlite_pool(&database).await;
    sqlx::query("UPDATE model_providers SET refreshed_at='0' WHERE id='codex'")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let stale_selection = app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/model-selection/validate",
            Some(json!({
                "harnessId": "codex-basic",
                "familyId": family_id,
                "providerId": "codex",
                "modelId": "second-model"
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(stale_selection.status(), StatusCode::OK);
    assert_eq!(
        response_json(stale_selection).await["modelId"],
        "second-model"
    );
    let pool = sqlite_pool(&database).await;
    let refreshed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string();
    sqlx::query("UPDATE model_providers SET refreshed_at=?1 WHERE id='codex'")
        .bind(refreshed_at)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let invalid_follow_up = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({
                "text": "Must not persist",
                "modelSelection": model_selection(family_id, "missing-model")
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(invalid_follow_up.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let failed = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({
                "text": "Persist my failure identity",
                "modelSelection": model_selection(family_id, "broken-model")
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(failed.status(), StatusCode::CREATED);
    let state = wait_for_interaction_count_and_terminal(&app, thread_id, 4).await;
    let interactions = state["interactions"].as_array().unwrap();
    assert_eq!(interactions.len(), 4);
    assert_eq!(interactions[3]["completionStatus"], "failed");
    assert_eq!(
        interactions[3]["modelSelection"],
        model_selection(family_id, "broken-model")
    );
    assert_eq!(
        interactions[0]["effectiveExecutionDigest"],
        interactions[1]["effectiveExecutionDigest"]
    );
    assert_ne!(
        interactions[0]["effectiveExecutionDigest"],
        interactions[2]["effectiveExecutionDigest"]
    );
    assert_eq!(output_reads.load(Ordering::SeqCst), 2);
    let pool = sqlite_pool(&database).await;
    let unreconciled_terminal_leases: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM interaction_attempts WHERE execution_lease_id IS NOT NULL AND execution_lease_reconciled_at IS NULL AND outcome!='running'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    pool.close().await;
    assert_eq!(unreconciled_terminal_leases, 0);
    assert_eq!(
        observed_models.lock().unwrap().as_slice(),
        [
            json!({ "providerId": "codex", "adapterId": "codex-subscription", "modelId": "test-model" }),
            json!({ "providerId": "codex", "adapterId": "codex-subscription", "modelId": "test-model" }),
            json!({ "providerId": "codex", "adapterId": "codex-subscription", "modelId": "second-model" }),
            json!({ "providerId": "codex", "adapterId": "codex-subscription", "modelId": "broken-model" }),
        ]
    );

    let retryable = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({
                "text": "Retry this exact draft",
                "modelSelection": model_selection(family_id, "retryable-model")
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(retryable.status(), StatusCode::CREATED);
    let retryable_id = response_json(retryable).await["id"].as_i64().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let (attempt_id, receipt_selection) = loop {
        let state = response_json(
            app.clone()
                .oneshot(api_request(
                    "GET",
                    &format!("/api/state?threadId={thread_id}"),
                    None,
                    true,
                ))
                .await
                .unwrap(),
        )
        .await;
        let retryable = state["interactions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|interaction| interaction["id"] == retryable_id)
            .unwrap();
        if retryable["completionStatus"] == "not_started"
            && retryable["latestAttempt"]["outcome"] == "model_failed"
        {
            break (
                retryable["latestAttempt"]["id"].as_i64().unwrap(),
                retryable["latestAttempt"]["modelSelection"].clone(),
            );
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert_eq!(
        receipt_selection,
        model_selection(family_id, "retryable-model")
    );
    let retry_uri = format!("/api/threads/{thread_id}/interactions/{retryable_id}/retry");
    let retry_context = json!({
        "target": {"nodeId": 7, "sourceInteractionNodeId": 3, "sourceLayerId": 5},
        "annotations": ["FIFO"]
    });
    let pool = sqlite_pool(&database).await;
    sqlx::query("INSERT INTO node_context_draft_resolutions(draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at,composer_text) VALUES ('draft-retry-prepare',?1,'confirmed',1,7,3,5,?2,'FIFO','2','FIFO')")
        .bind(thread_id)
        .bind(r#"{"id":7,"kind":"concept","icon":"list","title":"Queue","detail":"Tasks","state":"accepted"}"#)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let mut latest_attempt_id = attempt_id;
    for cycle in 1..=2 {
        let failed_retry = app
            .clone()
            .oneshot(api_request(
                "POST",
                &retry_uri,
                Some(json!({
                    "attemptId": latest_attempt_id,
                    "text": "Retry preparation failure",
                    "inputId": format!("retry-prepare-failure-{cycle}"),
                    "contexts": [retry_context.clone()],
                    "contextConfirmationIds": ["draft-retry-prepare"],
                    "modelSelection": model_selection(family_id, "second-model")
                })),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(failed_retry.status(), StatusCode::OK);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let state = response_json(
                app.clone()
                    .oneshot(api_request(
                        "GET",
                        &format!("/api/state?threadId={thread_id}"),
                        None,
                        true,
                    ))
                    .await
                    .unwrap(),
            )
            .await;
            let retryable = state["interactions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|interaction| interaction["id"] == retryable_id)
                .expect("retry preparation failure must retain the interaction");
            let next_attempt_id = retryable["latestAttempt"]["id"].as_i64().unwrap();
            if retryable["completionStatus"] == "not_started"
                && retryable["latestAttempt"]["outcome"] == "model_failed"
                && next_attempt_id != latest_attempt_id
            {
                latest_attempt_id = next_attempt_id;
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for retry preparation failure restoration: {state}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pool = sqlite_pool(&database).await;
        let consumed_by: Option<i64> = sqlx::query_scalar(
            "SELECT consumed_interaction_id FROM node_context_draft_resolutions WHERE draft_id='draft-retry-prepare'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        pool.close().await;
        assert_eq!(consumed_by, None);
    }
    let retry_body = json!({
        "attemptId": latest_attempt_id,
        "text": "Edited but still the same draft",
        "inputId": "retry-input-edited-draft",
        "contexts": [retry_context],
        "contextConfirmationIds": ["draft-retry-prepare"],
        "modelSelection": model_selection(family_id, "second-model")
    });
    let pool = sqlite_pool(&database).await;
    sqlx::query("UPDATE model_providers SET refreshed_at='0' WHERE id='codex'")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let stale_retry_selection = app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/model-selection/validate",
            Some(json!({
                "harnessId": "codex-basic",
                "familyId": family_id,
                "providerId": "codex",
                "modelId": "second-model"
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(stale_retry_selection.status(), StatusCode::OK);
    let state = response_json(
        app.clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/state?threadId={thread_id}"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let preserved = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == retryable_id)
        .unwrap();
    assert_eq!(preserved["completionStatus"], "not_started");
    assert_eq!(preserved["text"], "Retry preparation failure");
    assert_eq!(preserved["latestAttempt"]["id"], latest_attempt_id);
    let pool = sqlite_pool(&database).await;
    let refreshed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string();
    sqlx::query("UPDATE model_providers SET refreshed_at=?1 WHERE id='codex'")
        .bind(refreshed_at)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let first_retry = app.clone().oneshot(api_request(
        "POST",
        &retry_uri,
        Some(retry_body.clone()),
        true,
    ));
    let repeated_retry =
        app.clone()
            .oneshot(api_request("POST", &retry_uri, Some(retry_body), true));
    let (first_retry, repeated_retry) = tokio::join!(first_retry, repeated_retry);
    assert_eq!(first_retry.unwrap().status(), StatusCode::OK);
    assert_eq!(repeated_retry.unwrap().status(), StatusCode::OK);
    let state = wait_for_interaction_count_and_terminal(&app, thread_id, 5).await;
    let retried = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == retryable_id)
        .unwrap();
    assert_eq!(retried["completionStatus"], "accepted");
    assert_eq!(retried["text"], "Edited but still the same draft");
    assert_eq!(
        retried["modelSelection"],
        model_selection(family_id, "second-model")
    );
    assert_eq!(retried["latestAttempt"]["attemptNumber"], 4);
    assert_eq!(retried["latestAttempt"]["adapterImplementationVersion"], 7);
    assert_eq!(
        observed_models
            .lock()
            .unwrap()
            .iter()
            .filter(|model| model["modelId"] == "second-model")
            .count(),
        2
    );
    let lost_create = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({ "text": "ordinary create response loss" })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(lost_create.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let recovered = wait_for_interaction_count_and_terminal(&app, thread_id, 6).await;
    assert_eq!(recovered["interactions"][5]["completionStatus"], "failed");
    assert!(recovered["interactions"][5]["graphNodeId"].is_null());

    graph_task.abort();
    harness_task.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn interrupted_action_invocation_remains_submitted_for_source_pair_recovery() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-interrupted-action-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");

    let app = open_app(&database, &root).await;
    let thread = response_json(
        app.oneshot(api_request(
            "POST",
            "/api/threads",
            Some(json!({
                "title": "Interrupted action",
                "initialMessage": "Start here"
            })),
            true,
        ))
        .await
        .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    let source_interaction_id = thread["rootInteractionId"].as_i64().unwrap();
    let pool = sqlite_pool(&database).await;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string();
    let result = sqlx::query(
        "INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status) VALUES (?1,2,'Follow up',?2,'running')",
    )
    .bind(thread_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    let result_interaction_id = result.last_insert_rowid();
    sqlx::query(
        "INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required) VALUES (?1,41,?2,?3,1)",
    )
    .bind(source_interaction_id)
    .bind(result_interaction_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    let reopened = open_app(&database, &root).await;
    let pool = sqlite_pool(&database).await;
    let (startup_status, startup_error): (String, String) =
        sqlx::query_as("SELECT completion_status,completion_error FROM interactions WHERE id=?1")
            .bind(result_interaction_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(startup_status, "submitted");
    assert!(startup_error.contains("Invoke the action again"));
    pool.close().await;
    let state = response_json(
        reopened
            .oneshot(api_request(
                "GET",
                &format!("/api/state?threadId={thread_id}"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let recovered = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == result_interaction_id)
        .unwrap();
    assert_eq!(recovered["completionStatus"], "submitted");
    assert_eq!(recovered["graphNodeId"], serde_json::Value::Null);

    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn startup_malformed_create_response_preserves_unbound_lease_for_later_restart() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-startup-prepare-retry-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    let thread = response_json(
        app.oneshot(api_request(
            "POST",
            "/api/threads",
            Some(json!({"initialMessage":"source"})),
            true,
        ))
        .await
        .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    let source_id = thread["rootInteractionId"].as_i64().unwrap();
    let pool = sqlite_pool(&database).await;
    sqlx::query(
        "UPDATE interactions SET graph_node_id=90,completion_status='accepted' WHERE id=?1",
    )
    .bind(source_id)
    .execute(&pool)
    .await
    .unwrap();
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string();
    let result_id = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status) VALUES (?1,2,'leased result',?2,'not_started')")
        .bind(thread_id)
        .bind(&created_at)
        .execute(&pool)
        .await
        .unwrap()
        .last_insert_rowid();
    sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required) VALUES (?1,41,?2,?3,1)")
        .bind(source_id)
        .bind(result_id)
        .bind(&created_at)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion":1,
            "configurations":[{"configuration":{
                "schemaVersion":1,"name":"codex-basic","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},"settings":{}
            },"digest":"sha256:test"}]
        })
        .to_string(),
    )
    .unwrap();
    let creates = Arc::new(AtomicUsize::new(0));
    let observed_creates = creates.clone();
    let graph = Router::new()
        .route(
            "/api/control/interactions",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let observed_creates = observed_creates.clone();
                async move {
                    assert_eq!(
                        body["invocation"],
                        json!({"sourceInteractionNodeId":90,"sourceActionId":41})
                    );
                    if observed_creates.fetch_add(1, Ordering::SeqCst) < 4 {
                        return (StatusCode::OK, "truncated successful response").into_response();
                    }
                    axum::Json(json!({"node":{"id":93},"graphToken":""})).into_response()
                }
            }),
        )
        .route(
            "/api/control/interactions/93",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":93,
                    "invocation":{"sourceInteractionNodeId":90,"sourceActionId":41}
                }))
            }),
        )
        .route(
            "/api/control/interactions/93/output",
            axum::routing::get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    axum::Json(json!({"error":{"code":"completion_not_found"}})),
                )
            }),
        )
        .route(
            "/api/control/capabilities",
            axum::routing::delete(|| async { axum::Json(json!({"revoked":true})) }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(Router::new()).await;

    let first_reopen =
        open_app_with_runtime(&database, &root, &catalog, &graph_url, &harness_url).await;
    drop(first_reopen);
    let pool = sqlite_pool(&database).await;
    let after_failure: (String, Option<i64>, Option<String>) = sqlx::query_as(
        "SELECT completion_status,graph_node_id,completion_error FROM interactions WHERE id=?1",
    )
    .bind(result_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after_failure.0, "submitted");
    assert_eq!(after_failure.1, None);
    assert!(after_failure.2.unwrap().contains("Invoke the action again"));
    pool.close().await;

    let second_reopen =
        open_app_with_runtime(&database, &root, &catalog, &graph_url, &harness_url).await;
    drop(second_reopen);
    let pool = sqlite_pool(&database).await;
    let after_recovery: (String, Option<i64>, Option<String>) = sqlx::query_as(
        "SELECT completion_status,graph_node_id,completion_error FROM interactions WHERE id=?1",
    )
    .bind(result_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after_recovery.0, "submitted");
    assert_eq!(after_recovery.1, Some(93));
    assert!(!after_recovery.2.unwrap().contains("reconciliation pending"));
    assert_eq!(creates.load(Ordering::SeqCst), 5);
    pool.close().await;

    graph_task.abort();
    harness_task.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn startup_binding_failure_preserves_unbound_invocation_for_next_recovery() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-startup-binding-retry-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    let thread = response_json(
        app.oneshot(api_request(
            "POST",
            "/api/threads",
            Some(json!({"initialMessage":"source"})),
            true,
        ))
        .await
        .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    let source_id = thread["rootInteractionId"].as_i64().unwrap();
    let pool = sqlite_pool(&database).await;
    sqlx::query(
        "UPDATE interactions SET graph_node_id=90,completion_status='accepted' WHERE id=?1",
    )
    .bind(source_id)
    .execute(&pool)
    .await
    .unwrap();
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string();
    let result_id = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status) VALUES (?1,2,'leased result',?2,'not_started')")
        .bind(thread_id)
        .bind(&created_at)
        .execute(&pool)
        .await
        .unwrap()
        .last_insert_rowid();
    sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required) VALUES (?1,41,?2,?3,1)")
        .bind(source_id)
        .bind(result_id)
        .bind(&created_at)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(&format!(
        "CREATE TRIGGER fail_startup_bind BEFORE UPDATE OF graph_node_id ON interactions WHEN OLD.id={result_id} AND NEW.graph_node_id IS NOT NULL BEGIN SELECT RAISE(FAIL, 'simulated transient bind failure'); END"
    ))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion":1,
            "configurations":[{"configuration":{
                "schemaVersion":1,"name":"codex-basic","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},"settings":{}
            },"digest":"sha256:test"}]
        })
        .to_string(),
    )
    .unwrap();
    let creates = Arc::new(AtomicUsize::new(0));
    let observed_creates = creates.clone();
    let graph = Router::new()
        .route(
            "/api/control/interactions",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let observed_creates = observed_creates.clone();
                async move {
                    observed_creates.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        body["invocation"],
                        json!({"sourceInteractionNodeId":90,"sourceActionId":41})
                    );
                    axum::Json(json!({"node":{"id":93},"graphToken":""}))
                }
            }),
        )
        .route(
            "/api/control/interactions/93",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":93,
                    "invocation":{"sourceInteractionNodeId":90,"sourceActionId":41}
                }))
            }),
        )
        .route(
            "/api/control/interactions/93/output",
            axum::routing::get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    axum::Json(json!({"error":{"code":"completion_not_found"}})),
                )
            }),
        )
        .route(
            "/api/control/capabilities",
            axum::routing::delete(|| async { axum::Json(json!({"revoked":true})) }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(Router::new()).await;

    let first_reopen =
        open_app_with_runtime(&database, &root, &catalog, &graph_url, &harness_url).await;
    drop(first_reopen);
    let pool = sqlite_pool(&database).await;
    let after_failure: (String, Option<i64>) =
        sqlx::query_as("SELECT completion_status,graph_node_id FROM interactions WHERE id=?1")
            .bind(result_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(after_failure, ("submitted".into(), None));
    sqlx::query("DROP TRIGGER fail_startup_bind")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let second_reopen =
        open_app_with_runtime(&database, &root, &catalog, &graph_url, &harness_url).await;
    drop(second_reopen);
    let pool = sqlite_pool(&database).await;
    let after_recovery: (String, Option<i64>) =
        sqlx::query_as("SELECT completion_status,graph_node_id FROM interactions WHERE id=?1")
            .bind(result_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(after_recovery, ("submitted".into(), Some(93)));
    assert_eq!(creates.load(Ordering::SeqCst), 2);
    pool.close().await;

    graph_task.abort();
    harness_task.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn interrupted_bound_invocation_recovers_canonical_graph_acceptance() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-recover-accepted-invoke-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    let thread = response_json(
        app.oneshot(api_request(
            "POST",
            "/api/threads",
            Some(json!({"initialMessage":"source"})),
            true,
        ))
        .await
        .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    let source_id = thread["rootInteractionId"].as_i64().unwrap();
    let pool = sqlite_pool(&database).await;
    sqlx::query(
        "UPDATE interactions SET graph_node_id=90,completion_status='accepted' WHERE id=?1",
    )
    .bind(source_id)
    .execute(&pool)
    .await
    .unwrap();
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string();
    let result = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,permission_profile_id,effective_execution_digest,effective_permission_receipt_json) VALUES (?1,2,'leased result',?2,91,'running','codex-basic','sha256:test','auto','sha256:execution',?3)")
        .bind(thread_id).bind(&created_at)
        .bind(json!({"schemaVersion":1,"permissionProfileId":"auto","bindingPresent":true}).to_string())
        .execute(&pool).await.unwrap();
    let result_id = result.last_insert_rowid();
    sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required) VALUES (?1,41,?2,?3,1)")
        .bind(source_id).bind(result_id).bind(&created_at).execute(&pool).await.unwrap();
    let ordinary = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,permission_profile_id,effective_execution_digest,effective_permission_receipt_json) VALUES (?1,3,'ordinary result',?2,92,'running','codex-basic','sha256:test','auto','sha256:ordinary',?3)")
        .bind(thread_id).bind(&created_at)
        .bind(json!({"schemaVersion":1,"permissionProfileId":"auto","bindingPresent":true}).to_string())
        .execute(&pool).await.unwrap();
    let ordinary_id = ordinary.last_insert_rowid();
    let unbound = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status,permission_profile_id) VALUES (?1,4,'lost create response',?2,'not_started','auto')")
        .bind(thread_id).bind(&created_at).execute(&pool).await.unwrap();
    let unbound_id = unbound.last_insert_rowid();
    sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required) VALUES (?1,42,?2,?3,1)")
        .bind(source_id).bind(unbound_id).bind(&created_at).execute(&pool).await.unwrap();
    let corrupt = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,permission_profile_id,effective_execution_digest,effective_permission_receipt_json) VALUES (?1,5,'corrupt binding',?2,94,'running','codex-basic','sha256:test','auto','sha256:corrupt',?3)")
        .bind(thread_id).bind(&created_at)
        .bind(json!({"schemaVersion":1,"permissionProfileId":"auto","bindingPresent":true}).to_string())
        .execute(&pool).await.unwrap();
    let corrupt_id = corrupt.last_insert_rowid();
    let approval_wait = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,permission_profile_id,effective_execution_digest,effective_permission_receipt_json) VALUES (?1,6,'accepted while approval response was in flight',?2,95,'waiting_for_approval','codex-basic','sha256:test','ask','sha256:approval',?3)")
        .bind(thread_id).bind(&created_at)
        .bind(json!({"schemaVersion":1,"permissionProfileId":"ask","bindingPresent":true}).to_string())
        .execute(&pool).await.unwrap();
    let approval_wait_id = approval_wait.last_insert_rowid();
    sqlx::query("INSERT INTO approval_requests(request_id,interaction_id,complete_call_id,harness_session_id,title,reason,action_json,scope_keys_json,scope_description,created_at,expires_at) VALUES ('restart-approval',?1,'call-1','session-1','Run command','Needed','{\"kind\":\"command\",\"command\":\"npm test\",\"workingDirectory\":\"/workspace\"}','[]','test scope',?2,NULL)")
        .bind(approval_wait_id).bind(&created_at).execute(&pool).await.unwrap();
    // Rows migrated from the pre-lease schema default to graph_lease_required=0. Their graph
    // interaction metadata legitimately has no invocation provenance, but canonical acceptance
    // must still terminate recovery rather than remain quarantined forever.
    let legacy_unleased = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,permission_profile_id,effective_execution_digest,effective_permission_receipt_json) VALUES (?1,7,'legacy unleased result',?2,96,'running','codex-basic','sha256:test','auto','sha256:legacy',?3)")
        .bind(thread_id).bind(&created_at)
        .bind(json!({"schemaVersion":1,"permissionProfileId":"auto","bindingPresent":true}).to_string())
        .execute(&pool).await.unwrap();
    let legacy_unleased_id = legacy_unleased.last_insert_rowid();
    sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at) VALUES (?1,43,?2,?3)")
        .bind(source_id).bind(legacy_unleased_id).bind(&created_at).execute(&pool).await.unwrap();
    let strict_missing_lease = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,permission_profile_id,effective_execution_digest,effective_permission_receipt_json) VALUES (?1,8,'strict missing lease result',?2,97,'running','codex-basic','sha256:test','auto','sha256:strict',?3)")
        .bind(thread_id).bind(&created_at)
        .bind(json!({"schemaVersion":1,"permissionProfileId":"auto","bindingPresent":true}).to_string())
        .execute(&pool).await.unwrap();
    let strict_missing_lease_id = strict_missing_lease.last_insert_rowid();
    sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required) VALUES (?1,44,?2,?3,1)")
        .bind(source_id).bind(strict_missing_lease_id).bind(&created_at).execute(&pool).await.unwrap();
    let legacy_pending = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,completion_error,harness_configuration_name,harness_configuration_digest,permission_profile_id,effective_execution_digest,effective_permission_receipt_json) VALUES (?1,9,'legacy pending result',?2,98,'failed','Canonical reconciliation pending: pre-lease provenance mismatch','codex-basic','sha256:test','auto','sha256:legacy-pending',?3)")
        .bind(thread_id).bind(&created_at)
        .bind(json!({"schemaVersion":1,"permissionProfileId":"auto","bindingPresent":true}).to_string())
        .execute(&pool).await.unwrap();
    let legacy_pending_id = legacy_pending.last_insert_rowid();
    sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at) VALUES (?1,45,?2,?3)")
        .bind(source_id).bind(legacy_pending_id).bind(&created_at).execute(&pool).await.unwrap();
    let strict_approval_wait = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,permission_profile_id,effective_execution_digest,effective_permission_receipt_json) VALUES (?1,10,'strict leased approval wait',?2,99,'waiting_for_approval','codex-basic','sha256:test','ask','sha256:strict-approval',?3)")
        .bind(thread_id).bind(&created_at)
        .bind(json!({"schemaVersion":1,"permissionProfileId":"ask","bindingPresent":true}).to_string())
        .execute(&pool).await.unwrap();
    let strict_approval_wait_id = strict_approval_wait.last_insert_rowid();
    sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required) VALUES (?1,46,?2,?3,1)")
        .bind(source_id).bind(strict_approval_wait_id).bind(&created_at).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO approval_requests(request_id,interaction_id,complete_call_id,harness_session_id,title,reason,action_json,scope_keys_json,scope_description,created_at,expires_at) VALUES ('strict-restart-approval',?1,'call-strict','session-strict','Run command','Needed','{\"kind\":\"command\",\"command\":\"npm test\",\"workingDirectory\":\"/workspace\"}','[]','test scope',?2,NULL)")
        .bind(strict_approval_wait_id).bind(&created_at).execute(&pool).await.unwrap();
    let legacy_approval_wait = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,permission_profile_id,effective_execution_digest,effective_permission_receipt_json) VALUES (?1,11,'legacy approval wait',?2,100,'waiting_for_approval','codex-basic','sha256:test','ask','sha256:legacy-approval',?3)")
        .bind(thread_id).bind(&created_at)
        .bind(json!({"schemaVersion":1,"permissionProfileId":"ask","bindingPresent":true}).to_string())
        .execute(&pool).await.unwrap();
    let legacy_approval_wait_id = legacy_approval_wait.last_insert_rowid();
    sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at) VALUES (?1,47,?2,?3)")
        .bind(source_id).bind(legacy_approval_wait_id).bind(&created_at).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO approval_requests(request_id,interaction_id,complete_call_id,harness_session_id,title,reason,action_json,scope_keys_json,scope_description,created_at,expires_at) VALUES ('legacy-restart-approval',?1,'call-legacy','session-legacy','Run command','Needed','{\"kind\":\"command\",\"command\":\"npm test\",\"workingDirectory\":\"/workspace\"}','[]','test scope',?2,NULL)")
        .bind(legacy_approval_wait_id).bind(&created_at).execute(&pool).await.unwrap();
    pool.close().await;

    let canonical = json!({
        "nodeId": 91,
        "rootLayer": {"layer":{"id":501},"nodes":[],"edges":[],"actions":[]}
    });
    let graph_output = canonical.clone();
    let recovery_output_reads = Arc::new(AtomicUsize::new(0));
    let observed_recovery_output_reads = recovery_output_reads.clone();
    let concurrent_recovery_barrier = Arc::new(tokio::sync::Barrier::new(2));
    let observed_recovery_barrier = concurrent_recovery_barrier.clone();
    let approval_metadata_reads = Arc::new(AtomicUsize::new(0));
    let observed_approval_metadata_reads = approval_metadata_reads.clone();
    let invalidations = Arc::new(AtomicUsize::new(0));
    let observed_invalidations = invalidations.clone();
    let graph = axum::Router::new()
        .route(
            "/api/control/interactions",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                assert_eq!(
                    body["invocation"],
                    json!({
                        "sourceInteractionNodeId":90,"sourceActionId":42
                    })
                );
                axum::Json(json!({"node":{"id":93},"graphToken":""}))
            }),
        )
        .route(
            "/api/control/interactions/91",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":91,
                    "invocation":{"sourceInteractionNodeId":90,"sourceActionId":41}
                }))
            }),
        )
        .route(
            "/api/control/interactions/92",
            axum::routing::get(|| async { axum::Json(json!({"nodeId":92,"invocation":null})) }),
        )
        .route(
            "/api/control/interactions/93",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":93,
                    "invocation":{"sourceInteractionNodeId":90,"sourceActionId":42}
                }))
            }),
        )
        .route(
            "/api/control/interactions/94",
            axum::routing::get(|| async { axum::Json(json!({"nodeId":999,"invocation":null})) }),
        )
        .route(
            "/api/control/interactions/95",
            axum::routing::get(|| async { axum::Json(json!({"nodeId":95,"invocation":null})) }),
        )
        .route(
            "/api/control/interactions/96",
            axum::routing::get(|| async { axum::Json(json!({"nodeId":96,"invocation":null})) }),
        )
        .route(
            "/api/control/interactions/97",
            axum::routing::get(|| async { axum::Json(json!({"nodeId":97,"invocation":null})) }),
        )
        .route(
            "/api/control/interactions/98",
            axum::routing::get(|| async { axum::Json(json!({"nodeId":98,"invocation":null})) }),
        )
        .route(
            "/api/control/interactions/99",
            axum::routing::get(move || {
                let observed_approval_metadata_reads = observed_approval_metadata_reads.clone();
                async move {
                    if observed_approval_metadata_reads.fetch_add(1, Ordering::SeqCst) == 0 {
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            axum::Json(json!({"error":{"code":"temporarily_unavailable"}})),
                        )
                            .into_response();
                    }
                    axum::Json(json!({
                        "nodeId":99,
                        "invocation":{"sourceInteractionNodeId":90,"sourceActionId":46}
                    }))
                    .into_response()
                }
            }),
        )
        .route(
            "/api/control/interactions/100",
            axum::routing::get(|| async { axum::Json(json!({"nodeId":100,"invocation":null})) }),
        )
        .route(
            "/api/control/capabilities",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                axum::Json(json!({"graphToken":body["graphToken"]}))
            })
            .delete(move || {
                let observed_invalidations = observed_invalidations.clone();
                async move {
                    observed_invalidations.fetch_add(1, Ordering::SeqCst);
                    axum::Json(json!({"revoked":true}))
                }
            }),
        )
        .route(
            "/api/control/interactions/91/output",
            axum::routing::get(move || {
                let graph_output = graph_output.clone();
                let observed_recovery_output_reads = observed_recovery_output_reads.clone();
                let observed_recovery_barrier = observed_recovery_barrier.clone();
                async move {
                    if observed_recovery_output_reads.fetch_add(1, Ordering::SeqCst) == 0 {
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            axum::Json(json!({"error":{"code":"temporarily_unavailable"}})),
                        );
                    }
                    observed_recovery_barrier.wait().await;
                    (StatusCode::OK, axum::Json(graph_output))
                }
            }),
        )
        .route(
            "/api/control/interactions/92/output",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":92,
                    "rootLayer":{"layer":{"id":502},"nodes":[],"edges":[],"actions":[]}
                }))
            }),
        )
        .route(
            "/api/control/interactions/93/output",
            axum::routing::get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    axum::Json(json!({"error":{"code":"completion_not_found"}})),
                )
            }),
        )
        .route(
            "/api/control/interactions/95/output",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":95,
                    "rootLayer":{"layer":{"id":505},"nodes":[],"edges":[],"actions":[]}
                }))
            }),
        )
        .route(
            "/api/control/interactions/96/output",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":96,
                    "rootLayer":{"layer":{"id":506},"nodes":[],"edges":[],"actions":[]}
                }))
            }),
        )
        .route(
            "/api/control/interactions/97/output",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":97,
                    "rootLayer":{"layer":{"id":507},"nodes":[],"edges":[],"actions":[]}
                }))
            }),
        )
        .route(
            "/api/control/interactions/98/output",
            axum::routing::get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    axum::Json(json!({"error":{"code":"completion_not_found"}})),
                )
            }),
        )
        .route(
            "/api/control/interactions/99/output",
            axum::routing::get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    axum::Json(json!({"error":{"code":"completion_not_found"}})),
                )
            }),
        )
        .route(
            "/api/control/interactions/100/output",
            axum::routing::get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    axum::Json(json!({"error":{"code":"completion_not_found"}})),
                )
            }),
        );
    let harness = axum::Router::new();
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(harness).await;
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion":1,
            "configurations":[{"configuration":{
                "schemaVersion":1,"name":"codex-basic","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"ask":{},"auto":{},"full":{}},
                "settings":{}
            },"digest":"sha256:test"}]
        })
        .to_string(),
    )
    .unwrap();

    let first_reopened =
        open_app_with_runtime(&database, &root, &catalog, &graph_url, &harness_url).await;
    let first_state = response_json(
        first_reopened
            .clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/state?threadId={thread_id}"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let first_recovery = first_state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == result_id)
        .unwrap();
    assert_eq!(first_recovery["completionStatus"], "submitted");
    assert!(
        first_recovery["completionError"]
            .as_str()
            .unwrap()
            .contains("Invoke the action again")
    );
    let first_strict_approval = first_state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == strict_approval_wait_id)
        .unwrap();
    assert_eq!(first_strict_approval["completionStatus"], "submitted");
    assert_ne!(first_strict_approval["completionStatus"], "failed");
    let first_strict_resolution = first_state["approvals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|approval| approval["request"]["requestId"] == "strict-restart-approval")
        .unwrap();
    assert_eq!(first_strict_resolution["resolution"]["outcome"], "aborted");
    drop(first_reopened);
    // Live reconciliation can still quarantine an uncertain result. Preserve the concurrent
    // compare-and-swap promotion regression independently of startup's strict-lease policy.
    let pool = sqlite_pool(&database).await;
    sqlx::query("UPDATE interactions SET completion_status='failed',completion_error='Canonical reconciliation pending: simulated live uncertainty' WHERE id=?1")
        .bind(result_id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let reopened =
        open_app_with_runtime(&database, &root, &catalog, &graph_url, &harness_url).await;
    let first_promotion = reopened.clone().oneshot(api_request(
        "GET",
        &format!("/api/state?threadId={thread_id}"),
        None,
        true,
    ));
    let second_promotion = reopened.oneshot(api_request(
        "GET",
        &format!("/api/state?threadId={thread_id}"),
        None,
        true,
    ));
    let (first_promotion, second_promotion) = tokio::join!(first_promotion, second_promotion);
    let state = response_json(first_promotion.unwrap()).await;
    let concurrent_state = response_json(second_promotion.unwrap()).await;
    let recovered = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == result_id)
        .unwrap();
    assert_eq!(recovered["completionStatus"], "accepted");
    assert_eq!(recovered["graphNodeId"], 91);
    assert_eq!(recovered["harnessConfigurationDigest"], "sha256:test");
    assert_eq!(recovered["effectiveExecutionDigest"], "sha256:execution");
    assert_eq!(recovered["completionOutput"], canonical);
    let concurrent_recovered = concurrent_state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == result_id)
        .unwrap();
    assert_eq!(concurrent_recovered["completionStatus"], "accepted");
    assert_eq!(concurrent_recovered["completionOutput"], canonical);
    assert!(recovery_output_reads.load(Ordering::SeqCst) >= 2);
    assert!(approval_metadata_reads.load(Ordering::SeqCst) >= 2);
    let ordinary = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == ordinary_id)
        .unwrap();
    assert_eq!(ordinary["completionStatus"], "accepted");
    assert_eq!(ordinary["graphNodeId"], 92);
    assert_eq!(ordinary["effectiveExecutionDigest"], "sha256:ordinary");
    let unbound = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == unbound_id)
        .unwrap();
    assert_eq!(unbound["graphNodeId"], 93);
    assert_eq!(unbound["completionStatus"], "submitted");
    assert!(
        unbound["completionError"]
            .as_str()
            .unwrap()
            .contains("Invoke the action again")
    );
    let corrupt = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == corrupt_id)
        .unwrap();
    assert_eq!(corrupt["completionStatus"], "failed");
    assert_eq!(corrupt["projectionFresh"], false);
    assert!(
        corrupt["completionError"]
            .as_str()
            .unwrap()
            .contains("reconciliation pending")
    );
    let approval_wait = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == approval_wait_id)
        .unwrap();
    assert_eq!(approval_wait["completionStatus"], "accepted");
    assert_eq!(approval_wait["completionOutput"]["nodeId"], 95);
    let legacy_unleased = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == legacy_unleased_id)
        .unwrap();
    assert_eq!(legacy_unleased["completionStatus"], "accepted");
    assert_eq!(legacy_unleased["completionOutput"]["nodeId"], 96);
    assert_ne!(legacy_unleased["projectionFresh"], false);
    let strict_missing_lease = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == strict_missing_lease_id)
        .unwrap();
    assert_eq!(strict_missing_lease["completionStatus"], "failed");
    assert_eq!(strict_missing_lease["projectionFresh"], false);
    assert!(
        strict_missing_lease["completionError"]
            .as_str()
            .unwrap()
            .contains("reconciliation pending")
    );
    let legacy_pending = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == legacy_pending_id)
        .unwrap();
    assert_eq!(legacy_pending["completionStatus"], "failed");
    assert_ne!(legacy_pending["projectionFresh"], false);
    assert!(
        legacy_pending["completionError"]
            .as_str()
            .unwrap()
            .starts_with("Legacy action invocation ended")
    );
    let strict_approval_wait = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == strict_approval_wait_id)
        .unwrap();
    assert_eq!(strict_approval_wait["completionStatus"], "submitted");
    assert_eq!(strict_approval_wait["graphNodeId"], 99);
    assert!(
        strict_approval_wait["completionError"]
            .as_str()
            .unwrap()
            .contains("Invoke the action again")
    );
    let legacy_approval_wait = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == legacy_approval_wait_id)
        .unwrap();
    assert_eq!(legacy_approval_wait["completionStatus"], "failed");
    assert_eq!(legacy_approval_wait["graphNodeId"], 100);
    assert!(
        legacy_approval_wait["completionError"]
            .as_str()
            .unwrap()
            .contains("harness session ended")
    );
    let approval = state["approvals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|approval| approval["request"]["requestId"] == "restart-approval")
        .unwrap();
    assert_eq!(approval["resolution"]["outcome"], "aborted");
    for request_id in ["strict-restart-approval", "legacy-restart-approval"] {
        let approval = state["approvals"]
            .as_array()
            .unwrap()
            .iter()
            .find(|approval| approval["request"]["requestId"] == request_id)
            .unwrap();
        assert_eq!(approval["resolution"]["outcome"], "aborted");
    }
    assert!(invalidations.load(Ordering::SeqCst) >= 7);
    graph_task.abort();
    harness_task.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn interrupted_ordinary_interaction_becomes_failed_and_releases_the_thread_on_restart() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-interrupted-interaction-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");

    let app = open_app(&database, &root).await;
    let thread = response_json(
        app.clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({
                    "title": "Interrupted interaction",
                    "initialMessage": "Start here"
                })),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    let root_interaction_id = thread["rootInteractionId"].as_i64().unwrap();

    let pool = sqlite_pool(&database).await;
    sqlx::query("UPDATE interactions SET completion_status='failed',completion_error='fixture terminal state' WHERE id=?1")
        .bind(root_interaction_id)
        .execute(&pool)
        .await
        .unwrap();
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string();
    let interrupted = sqlx::query(
        "INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status) VALUES (?1,2,'Interrupted follow-up',?2,'running')",
    )
    .bind(thread_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    let interrupted_id = interrupted.last_insert_rowid();
    pool.close().await;
    drop(app);

    let reopened = open_app(&database, &root).await;
    let state = response_json(
        reopened
            .clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/state?threadId={thread_id}"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let recovered = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == interrupted_id)
        .unwrap();
    assert_eq!(recovered["completionStatus"], "failed");
    assert!(
        recovered["completionError"]
            .as_str()
            .unwrap()
            .contains("Send a follow-up to continue")
    );

    let follow_up = reopened
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({ "text": "Continue after restart" })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(follow_up.status(), StatusCode::CREATED);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn exits_when_desktop_control_pipe_closes() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-app-server-parent-exit-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let permissions = permission_catalog();

    let mut child = Command::new(env!("CARGO_BIN_EXE_relayer-app-server"))
        .args([
            "--data-dir",
            root.join("data").to_str().unwrap(),
            "--web-dir",
            root.to_str().unwrap(),
            "--permission-catalog",
            permissions.to_str().unwrap(),
            "--port",
            "0",
            "--producer-desktop-version",
            "test",
            "--producer-build-commit",
            "test",
            "--producer-platform",
            "test",
            "--producer-architecture",
            "test",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut control_pipe = child.stdin.take().unwrap();
    writeln!(
        control_pipe,
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    )
    .unwrap();
    control_pipe.flush().unwrap();

    let mut ready_line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready_line)
        .unwrap();
    if ready_line.is_empty() {
        let status = child.wait().unwrap();
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        panic!("Relayer app server exited before readiness ({status}): {stderr}");
    }
    assert_eq!(
        serde_json::from_str::<Value>(&ready_line).unwrap()["ready"],
        true
    );

    drop(control_pipe);
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let exit_status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("Relayer app server remained alive after its desktop control pipe closed");
        }
        thread::sleep(Duration::from_millis(10));
    };
    assert!(exit_status.success());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn persists_project_thread_and_interaction_across_restart() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-app-server-{}-{unique}",
        std::process::id()
    ));
    let project_folder = root.join("project");
    let racing_project_folder = root.join("racing-project");
    fs::create_dir_all(&project_folder).unwrap();
    fs::create_dir_all(&racing_project_folder).unwrap();
    let database = root.join("product.sqlite3");

    let newest_thread_id = {
        let app = open_app(&database, &root).await;
        let denied = app
            .clone()
            .oneshot(api_request("GET", "/api/state", None, false))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

        let permission_profiles = app
            .clone()
            .oneshot(api_request("GET", "/api/permission-profiles", None, true))
            .await
            .unwrap();
        assert_eq!(permission_profiles.status(), StatusCode::OK);
        let permission_profiles = response_json(permission_profiles).await;
        assert_eq!(permission_profiles["defaultProfile"], "auto");
        assert_eq!(
            permission_profiles["profiles"]
                .as_array()
                .unwrap()
                .iter()
                .map(|profile| profile["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["ask", "auto", "full"]
        );
        assert!(
            permission_profiles["profiles"]
                .as_array()
                .unwrap()
                .iter()
                .all(|profile| profile["unavailableReason"] == "runtime_unavailable")
        );

        let review_state = app
            .clone()
            .oneshot(api_request_with_token("GET", "/api/state", None, "review"))
            .await
            .unwrap();
        assert_eq!(review_state.status(), StatusCode::OK);
        let review_write = app
            .clone()
            .oneshot(api_request_with_token(
                "POST",
                "/api/projects",
                Some(json!({ "path": project_folder })),
                "review",
            ))
            .await
            .unwrap();
        assert_eq!(review_write.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            response_json(review_write).await["code"],
            "read_only_session"
        );

        let project = app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/projects",
                Some(json!({ "path": project_folder })),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(project.status(), StatusCode::CREATED);
        let project = response_json(project).await;
        assert!(project["id"].as_i64().is_some_and(|id| id > 0));

        let duplicate = app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/projects",
                Some(json!({ "path": project_folder })),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);
        let duplicate = response_json(duplicate).await;
        assert_eq!(duplicate["code"], "project_exists");
        assert_eq!(duplicate["existingProject"]["id"], project["id"]);

        let reused = app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/projects",
                Some(json!({ "path": project_folder, "reuseExisting": true })),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(reused.status(), StatusCode::OK);

        let unavailable = app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/projects",
                Some(json!({ "path": root.join("missing") })),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(unavailable.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let unavailable: Value =
            serde_json::from_slice(&to_bytes(unavailable.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(unavailable["code"], "folder_unavailable");

        let first_project = app.clone().oneshot(api_request(
            "POST",
            "/api/projects",
            Some(json!({ "path": racing_project_folder })),
            true,
        ));
        let second_project = app.clone().oneshot(api_request(
            "POST",
            "/api/projects",
            Some(json!({ "path": racing_project_folder })),
            true,
        ));
        let (first_project, second_project) = tokio::join!(first_project, second_project);
        let mut project_statuses = [
            first_project.unwrap().status(),
            second_project.unwrap().status(),
        ];
        project_statuses.sort();
        assert_eq!(
            project_statuses,
            [StatusCode::CREATED, StatusCode::CONFLICT]
        );

        let unknown_profile = app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({
                    "initialMessage": "Do not run",
                    "permissionProfileId": "fixture"
                })),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(unknown_profile.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let unknown_profile = response_json(unknown_profile).await;
        assert_eq!(unknown_profile["code"], "permission_profile_unknown");
        assert_eq!(unknown_profile["permissionProfileId"], "fixture");

        let thread = app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({
                    "title": "Persist me",
                    "projectId": project["id"],
                    "initialMessage": "Map the project",
                    "permissionProfileId": "ask"
                })),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(thread.status(), StatusCode::CREATED);
        assert_eq!(response_json(thread).await["permissionProfileId"], "ask");

        let standalone = app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({
                    "title": "Standalone thread",
                    "initialMessage": "Keep this local"
                })),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(standalone.status(), StatusCode::CREATED);
        response_json(standalone).await["id"].as_i64().unwrap()
    };

    let timestamp_pool = sqlite_pool(&database).await;
    let future_timestamp = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        + 60_000)
        .to_string();
    sqlx::query("UPDATE threads SET created_at=?1, updated_at=?1")
        .bind(&future_timestamp)
        .execute(&timestamp_pool)
        .await
        .unwrap();
    timestamp_pool.close().await;

    let app = open_app(&database, &root).await;
    let state = app
        .clone()
        .oneshot(api_request("GET", "/api/state", None, true))
        .await
        .unwrap();
    let state: Value =
        serde_json::from_slice(&to_bytes(state.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(state["projects"].as_array().unwrap().len(), 2);
    assert_eq!(state["threads"].as_array().unwrap().len(), 2);
    assert_eq!(
        state["threads"][0]["id"].as_i64().unwrap(),
        newest_thread_id
    );
    assert_eq!(state["threads"][0]["active"], true);
    assert!(
        state["threads"].as_array().unwrap().iter().any(|thread| {
            thread["title"] == "Standalone thread" && thread["projectId"].is_null()
        })
    );
    for (title, expected_message, expected_profile) in [
        ("Persist me", "Map the project", "ask"),
        ("Standalone thread", "Keep this local", "auto"),
    ] {
        let persisted_thread = state["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|thread| thread["title"] == title)
            .unwrap();
        let thread_id = persisted_thread["id"].as_i64().unwrap();
        assert!(thread_id > 0);
        assert_eq!(persisted_thread["permissionProfileId"], expected_profile);
        let interactions = app
            .clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/threads/{thread_id}/interactions"),
                None,
                true,
            ))
            .await
            .unwrap();
        let interactions: Value = serde_json::from_slice(
            &to_bytes(interactions.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(interactions["interactions"][0]["text"], expected_message);
        assert_eq!(
            interactions["interactions"][0]["permissionProfileId"],
            expected_profile
        );
        assert_eq!(
            persisted_thread["rootInteractionId"],
            interactions["interactions"][0]["id"]
        );
    }
    assert_eq!(state["capabilities"]["graph"], false);
    assert_eq!(state["capabilities"]["harness"], false);
    assert!(state["interactions"].is_array());
    assert!(state["actionInvocations"].is_array());
    assert!(state.get("nodes").is_none());
    assert!(state.get("edges").is_none());
    assert!(state.get("status").is_none());

    let persisted_thread_id = state["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|thread| thread["title"] == "Persist me")
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let mut writes = tokio::task::JoinSet::new();
    for index in 0..12 {
        let app = app.clone();
        writes.spawn(async move {
            app.oneshot(api_request(
                "POST",
                &format!("/api/threads/{persisted_thread_id}/interactions"),
                Some(json!({ "text": format!("follow-up-{index}") })),
                true,
            ))
            .await
            .unwrap()
            .status()
        });
    }
    while let Some(status) = writes.join_next().await {
        assert_eq!(status.unwrap(), StatusCode::CREATED);
    }
    let interactions = app
        .clone()
        .oneshot(api_request(
            "GET",
            &format!("/api/threads/{persisted_thread_id}/interactions"),
            None,
            true,
        ))
        .await
        .unwrap();
    let interactions = response_json(interactions).await;
    let sequences = interactions["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|interaction| interaction["sequence"].as_i64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(sequences, (1..=13).collect::<Vec<_>>());
    assert!(
        interactions["interactions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|interaction| interaction["permissionProfileId"] == "ask")
    );
    let timestamps = interactions["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|interaction| interaction["createdAt"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(timestamps.windows(2).all(|pair| pair[0] <= pair[1]));
    assert!(
        timestamps
            .iter()
            .skip(1)
            .all(|timestamp| *timestamp == future_timestamp)
    );

    drop(app);
    let migration_pool = sqlite_pool(&database).await;
    let applied_migrations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = 1")
            .fetch_one(&migration_pool)
            .await
            .unwrap();
    assert_eq!(applied_migrations, 28);
    migration_pool.close().await;

    let incompatible_database = root.join("incompatible.sqlite3");
    let incompatible_pool = sqlite_pool(&incompatible_database).await;
    sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT)")
        .execute(&incompatible_pool)
        .await
        .unwrap();
    incompatible_pool.close().await;
    let incompatible = RelayerAppServer::open(RelayerAppServerConfig {
        database_path: incompatible_database,
        web_directory: root.clone(),
        permission_catalog: permission_catalog(),
        control_token: "control".to_owned(),
        read_only_control_token: None,
        runtime: None,
        allow_conversation_import: false,
        export_producer: test_export_producer(),
        completion_broker_origin: None,
    })
    .await;
    let error = match incompatible {
        Ok(_) => panic!("incompatible product schema was accepted"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("schema is incompatible"));

    let rootless_database = root.join("rootless.sqlite3");
    drop(open_app(&rootless_database, &root).await);
    let rootless_pool = sqlite_pool(&rootless_database).await;
    sqlx::query(
        "INSERT INTO threads(title,project_id,created_at,updated_at) VALUES ('rootless',NULL,'1','1')",
    )
    .execute(&rootless_pool)
    .await
    .unwrap();
    rootless_pool.close().await;
    let rootless = RelayerAppServer::open(RelayerAppServerConfig {
        database_path: rootless_database,
        web_directory: root.clone(),
        permission_catalog: permission_catalog(),
        control_token: "control".to_owned(),
        read_only_control_token: None,
        runtime: None,
        allow_conversation_import: false,
        export_producer: test_export_producer(),
        completion_broker_origin: None,
    })
    .await;
    let rootless_error = match rootless {
        Ok(_) => panic!("thread without a root interaction was accepted"),
        Err(error) => error,
    };
    assert!(
        rootless_error
            .to_string()
            .contains("must have a root interaction")
    );

    let partial_index_database = root.join("partial-index.sqlite3");
    drop(open_app(&partial_index_database, &root).await);
    let partial_index_pool = sqlite_pool(&partial_index_database).await;
    sqlx::query("PRAGMA foreign_keys=OFF")
        .execute(&partial_index_pool)
        .await
        .unwrap();
    for statement in [
        "DROP TABLE interaction_submitted_input_attachments",
        "DROP TABLE interaction_submitted_input_attempts",
        "DROP TABLE interactions",
        "DROP TABLE threads",
        "DROP TABLE projects",
        "CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,path TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
        "CREATE TABLE threads (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,harness_configuration_name TEXT NOT NULL DEFAULT 'codex-basic',permission_profile_id TEXT NOT NULL DEFAULT 'auto',conversation_import_id TEXT,surface TEXT NOT NULL DEFAULT 'conversation' CHECK(surface IN ('conversation', 'personal_presentation_profile')),personal_presentation_version_key TEXT REFERENCES personal_presentation_versions(version_key) ON DELETE RESTRICT)",
        "CREATE TABLE interactions (id INTEGER PRIMARY KEY AUTOINCREMENT,thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,sequence INTEGER NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,graph_node_id INTEGER,completion_status TEXT NOT NULL DEFAULT 'not_started',harness_configuration_name TEXT,harness_configuration_digest TEXT,completion_output_json TEXT,completion_error TEXT,permission_profile_id TEXT NOT NULL DEFAULT 'auto',effective_execution_digest TEXT,effective_permission_receipt_json TEXT,model_provider_id TEXT,provider_model_id TEXT,model_family_id INTEGER,input_identity TEXT,input_digest TEXT)",
        "CREATE UNIQUE INDEX projects_path_partial ON projects(path) WHERE id > 0",
        "CREATE UNIQUE INDEX interactions_sequence_partial ON interactions(thread_id,sequence) WHERE id > 0",
    ] {
        sqlx::query(statement)
            .execute(&partial_index_pool)
            .await
            .unwrap();
    }
    sqlx::raw_sql(include_str!(
        "../src/storage/sqlite/migrations/0027_submitted_input_attempts.sql"
    ))
    .execute(&partial_index_pool)
    .await
    .unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&partial_index_pool)
        .await
        .unwrap();
    partial_index_pool.close().await;
    let partial_index = RelayerAppServer::open(RelayerAppServerConfig {
        database_path: partial_index_database,
        web_directory: root.clone(),
        permission_catalog: permission_catalog(),
        control_token: "control".to_owned(),
        read_only_control_token: None,
        runtime: None,
        allow_conversation_import: false,
        export_producer: test_export_producer(),
        completion_broker_origin: None,
    })
    .await;
    let partial_index_error = match partial_index {
        Ok(_) => panic!("partial unique indexes were accepted"),
        Err(error) => error,
    };
    assert!(
        partial_index_error
            .to_string()
            .contains("missing its required unique index"),
        "{partial_index_error}"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn invalid_context_client_errors_are_preserved_without_product_mutation() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-invalid-context-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let offline = open_app(&database, &root).await;
    let thread = response_json(
        offline
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({"initialMessage":"Seed"})),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    drop(offline);
    seed_explicit_test_model_default(&database, thread_id).await;
    let pool = sqlite_pool(&database).await;
    let original_timestamp: String =
        sqlx::query_scalar("SELECT updated_at FROM threads WHERE id=?1")
            .bind(thread_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    pool.close().await;

    let graph = Router::new()
        .route(
            "/api/control/context-occurrences/canonical",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                if body["nodeId"] == 990 {
                    return (
                        StatusCode::NOT_FOUND,
                        axum::Json(json!({
                            "code": "not_found",
                            "error": "context target not found"
                        })),
                    )
                        .into_response();
                }
                (
                    StatusCode::OK,
                    axum::Json(json!({
                        "id": body["nodeId"],
                        "kind": "answer",
                        "icon": "document",
                        "title": "Context target",
                        "detail": "Context detail",
                        "state": "accepted"
                    })),
                )
                    .into_response()
            }),
        )
        .route(
            "/api/control/interactions",
            axum::routing::post(|| async {
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    axum::Json(json!({"error":{
                        "code":"invalid_context_occurrence",
                        "path":"contexts[0].target",
                        "message":"forged provenance sourceInteractionNodeId=991 sourceLayerId=992"
                    }})),
                )
            }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(Router::new()).await;
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion":1,
            "configurations":[{"configuration":{
                "schemaVersion":1,"name":"codex-basic","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},
                "modelCompatibility":[{"providerId":"codex"}],
                "executionAccessContracts":["managed-runtime@1"],
                "settings":{"model":"test-model"}
            },"digest":"sha256:test"}]
        })
        .to_string(),
    )
    .unwrap();
    let app =
        open_app_with_runtime_allow_override(&database, &root, &catalog, &graph_url, &harness_url)
            .await;
    let invalid_id = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({
                "text":"Invalid ID",
                "inputId":"invalid-id",
                "contexts":[{"target":{"nodeId":0,"sourceInteractionNodeId":2,"sourceLayerId":3},"annotations":["note"]}]
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(invalid_id.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response_json(invalid_id).await["code"], "invalid_input");
    for invalid in [
        json!({"text":"Missing identity","contexts":[{"target":{"nodeId":1,"sourceInteractionNodeId":2,"sourceLayerId":3},"annotations":["note"]}]}),
        json!({"text":"Blank annotation","inputId":"invalid-blank","contexts":[{"target":{"nodeId":1,"sourceInteractionNodeId":2,"sourceLayerId":3},"annotations":["   "]}]}),
        json!({"text":"","inputId":"invalid-empty","contexts":[{"target":{"nodeId":1,"sourceInteractionNodeId":2,"sourceLayerId":3},"annotations":[]}]}),
        json!({"text":"Duplicate","inputId":"invalid-duplicate","contexts":[
            {"target":{"nodeId":1,"sourceInteractionNodeId":2,"sourceLayerId":3},"annotations":["one"]},
            {"target":{"nodeId":1,"sourceInteractionNodeId":2,"sourceLayerId":3},"annotations":["two"]}
        ]}),
    ] {
        let rejected = app
            .clone()
            .oneshot(api_request(
                "POST",
                &format!("/api/threads/{thread_id}/interactions"),
                Some(invalid),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            response_json(rejected).await,
            json!({
                "error":"Relayer could not send this message. Your draft was preserved."
            })
        );
    }
    let response = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({
                "text":"Use this",
                "inputId":"send-invalid-1",
                "contexts":[{"target":{
                    "nodeId":990,"sourceInteractionNodeId":991,"sourceLayerId":992
                },"annotations":["exact note"]}]
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let outward = response_json(response).await;
    assert_eq!(
        outward,
        json!({"code":"not_found","error":"context target not found"})
    );

    let context_free = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({
                "text":"Context-free deterministic rejection",
                "inputId":"invalid-context-free"
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(context_free.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let pool = sqlite_pool(&database).await;
    let interaction_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM interactions WHERE thread_id=?1")
            .bind(thread_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let context_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM interaction_context_intents")
        .fetch_one(&pool)
        .await
        .unwrap();
    let annotation_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM interaction_context_annotations")
            .fetch_one(&pool)
            .await
            .unwrap();
    let updated_at: String = sqlx::query_scalar("SELECT updated_at FROM threads WHERE id=?1")
        .bind(thread_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(interaction_count, 1);
    assert_eq!(context_count, 0);
    assert_eq!(annotation_count, 0);
    assert_eq!(updated_at, original_timestamp);
    pool.close().await;
    graph_task.abort();
    harness_task.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn orphan_context_confirmation_ids_are_rejected_without_creating_an_interaction() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-orphan-context-confirmations-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    let thread = response_json(
        app.clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({"initialMessage":"Seed"})),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();

    for request in [
        json!({
            "text":"Missing context payload",
            "contextConfirmationIds":["draft-orphan"]
        }),
        json!({
            "text":"Identified but missing context payload",
            "inputId":"send-orphan",
            "contextConfirmationIds":["draft-orphan"]
        }),
    ] {
        let rejected = app
            .clone()
            .oneshot(api_request(
                "POST",
                &format!("/api/threads/{thread_id}/interactions"),
                Some(request),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(response_json(rejected).await["code"], "invalid_input");
    }

    let pool = sqlite_pool(&database).await;
    let interaction_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM interactions WHERE thread_id=?1")
            .bind(thread_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(interaction_count, 1);
    pool.close().await;
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn pre_binding_failure_restores_consumed_context_confirmation() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-context-prepare-failure-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let offline = open_app(&database, &root).await;
    let thread = response_json(
        offline
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({"initialMessage":"Seed"})),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    seed_explicit_test_model_default(&database, thread_id).await;
    let pool = sqlite_pool(&database).await;
    sqlx::query("INSERT INTO node_context_draft_resolutions(draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at,composer_text) VALUES ('draft-retry',?1,'confirmed',1,7,3,5,?2,'FIFO','2','FIFO')")
        .bind(thread_id)
        .bind(r#"{"id":7,"kind":"concept","icon":"list","title":"Queue","detail":"Tasks","state":"accepted"}"#)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let graph = Router::new()
        .route(
            "/api/control/context-occurrences/canonical",
            axum::routing::post(canonical_accepted_context_node),
        )
        .route(
            "/api/control/interactions",
            axum::routing::post(|| async {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(json!({"error":"temporary graph failure"})),
                )
            }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(Router::new()).await;
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":"codex-basic","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},
                "modelCompatibility":[{"providerId":"codex"}],
                "executionAccessContracts":["managed-runtime@1"],
                "settings":{"model":"test-model"}
            },"digest":"sha256:test"}]
        })
        .to_string(),
    )
    .unwrap();
    let app =
        open_app_with_runtime_allow_override(&database, &root, &catalog, &graph_url, &harness_url)
            .await;
    let response = app
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(json!({
                "text":"Use context",
                "inputId":"send-after-prepare-failure",
                "contexts":[{"target":{
                    "nodeId":7,"sourceInteractionNodeId":3,"sourceLayerId":5
                },"annotations":["FIFO"]}],
                "contextConfirmationIds":["draft-retry"]
            })),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        response_json(response).await,
        json!({"error":"Relayer could not send this message. Your draft was preserved."})
    );

    let pool = sqlite_pool(&database).await;
    let failed_input_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM interactions WHERE input_identity='send-after-prepare-failure')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let consumed_interaction_id: Option<i64> = sqlx::query_scalar(
        "SELECT consumed_interaction_id FROM node_context_draft_resolutions WHERE draft_id='draft-retry'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!failed_input_exists);
    assert_eq!(consumed_interaction_id, None);
    pool.close().await;
    graph_task.abort();
    harness_task.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn product_harness_retirement_precedes_retryable_startup_reconciliation() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-identified-startup-recovery-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let offline = open_app(&database, &root).await;
    let thread = response_json(
        offline
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({"initialMessage":"Seed"})),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();

    let pool = sqlite_pool(&database).await;
    sqlx::query("UPDATE threads SET harness_configuration_name='codex-basic-high' WHERE id=?1")
        .bind(thread_id)
        .execute(&pool)
        .await
        .unwrap();
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string();
    let receipt = json!({
        "schemaVersion": 1,
        "permissionProfileId": "auto",
        "bindingPresent": true
    })
    .to_string();
    let mut interaction_ids = Vec::new();
    for (sequence, status, graph_node_id) in [
        (2, "running", Some(902_i64)),
        (3, "waiting_for_approval", None),
    ] {
        let result = sqlx::query(
            "INSERT INTO interactions(
                thread_id,sequence,text,created_at,graph_node_id,completion_status,
                harness_configuration_name,harness_configuration_digest,permission_profile_id,
                effective_execution_digest,effective_permission_receipt_json,input_identity,input_digest
             ) VALUES (?1,?2,?3,?4,?5,?6,'codex-basic-high','sha256:test','auto',
                'sha256:execution',?7,?8,?9)",
        )
        .bind(thread_id)
        .bind(sequence)
        .bind(format!("Recover {status}"))
        .bind(&created_at)
        .bind(graph_node_id)
        .bind(status)
        .bind(&receipt)
        .bind(format!("send-restart-{sequence}"))
        .bind(format!("sha256:input-{sequence}"))
        .execute(&pool)
        .await
        .unwrap();
        interaction_ids.push(result.last_insert_rowid());
    }
    pool.close().await;

    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":"codex-basic","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},
                "modelCompatibility":[{"providerId":"codex"}],
                "executionAccessContracts":["managed-runtime@1"],
                "settings":{"model":"test-model"}
            },"digest":"sha256:test"}]
        })
        .to_string(),
    )
    .unwrap();

    let resumed_inputs = Arc::new(Mutex::new(Vec::new()));
    let observed_resumes = resumed_inputs.clone();
    let graph = Router::new()
        .route(
            "/api/control/interactions",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let observed_resumes = observed_resumes.clone();
                async move {
                    observed_resumes
                        .lock()
                        .unwrap()
                        .push(body["inputIdentity"].as_str().unwrap().to_owned());
                    (StatusCode::OK, "lost graph create response")
                }
            }),
        )
        .route(
            "/api/control/capabilities",
            axum::routing::delete(|| async { axum::Json(json!({"revoked":true})) }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(Router::new()).await;

    let resumed =
        open_app_with_runtime_allow_override(&database, &root, &catalog, &graph_url, &harness_url)
            .await;
    for _ in 0..100 {
        let both_resumed = {
            let resumed_inputs = resumed_inputs.lock().unwrap();
            ["send-restart-2", "send-restart-3"]
                .iter()
                .all(|expected| resumed_inputs.iter().any(|actual| actual == expected))
        };
        if both_resumed {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    {
        let resumed_inputs = resumed_inputs.lock().unwrap();
        for expected in ["send-restart-2", "send-restart-3"] {
            assert!(resumed_inputs.iter().any(|actual| actual == expected));
        }
    }
    let pool = sqlite_pool(&database).await;
    let migrated_harness: String =
        sqlx::query_scalar("SELECT harness_configuration_name FROM threads WHERE id=?1")
            .bind(thread_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(migrated_harness, "codex-basic");
    for interaction_id in interaction_ids {
        let (status, error): (String, Option<String>) = sqlx::query_as(
            "SELECT completion_status,completion_error FROM interactions WHERE id=?1",
        )
        .bind(interaction_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "submitted");
        assert!(
            error.unwrap().contains(
                "startup reconciliation was interrupted transiently and is ready to resume"
            )
        );
    }
    pool.close().await;

    drop(resumed);
    graph_task.abort();
    harness_task.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn interrupted_submitted_input_without_graph_acceptance_restores_without_provider_replay() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-submitted-input-restart-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let offline = open_app(&database, &root).await;
    let thread = response_json(
        offline
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({"initialMessage":"Seed"})),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    seed_explicit_test_model_default(&database, thread_id).await;

    let pool = sqlite_pool(&database).await;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string();
    let interaction_id = sqlx::query(
        "INSERT INTO interactions(
            thread_id,sequence,text,created_at,graph_node_id,completion_status,
            harness_configuration_name,harness_configuration_digest,permission_profile_id,
            effective_execution_digest,effective_permission_receipt_json,input_identity,input_digest
         ) VALUES (?1,2,'Use the committed answer',?2,77,'running','codex-basic','sha256:test',
            'auto','sha256:execution','{}','send-restart-input','sha256:input')",
    )
    .bind(thread_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap()
    .last_insert_rowid();
    let (family_id, family_revision): (i64, i64) =
        sqlx::query_as("SELECT id,revision FROM model_families ORDER BY id LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query(
        "INSERT INTO interaction_attempts(
            interaction_id,attempt_number,started_at,family_id,family_revision,
            harness_configuration_name,harness_configuration_revision,harness_configuration_digest,
            provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,
            outcome,effect_boundary
         ) VALUES (?1,1,?2,?3,?4,'codex-basic',1,'sha256:test',
            'codex','test-adapter',1,'test-model','managed-runtime@1','running','unknown')",
    )
    .bind(interaction_id)
    .bind(&created_at)
    .bind(family_id)
    .bind(family_revision)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO action_input_drafts(thread_id,revision,updated_at) VALUES (?1,2,?2)")
        .bind(thread_id)
        .bind(&created_at)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO interaction_submitted_input_attempts(
            interaction_id,thread_id,draft_revision,authority_digest,semantic_digest,state,
            graph_root_node_id,created_at,bound_at
         ) VALUES (?1,?2,1,'sha256:input','sha256:semantic','running',77,?3,?3)",
    )
    .bind(interaction_id)
    .bind(thread_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO interaction_submitted_input_attachments(
            interaction_id,presenting_interaction_node_id,presenting_layer_id,action_id,
            source_node_id,action_json,value_json,committed_at
         ) VALUES (?1,10,20,30,40,?2,?3,?4)",
    )
    .bind(interaction_id)
    .bind(json!({"control":"text","prompt":"Answer"}).to_string())
    .bind(json!({"text":"committed"}).to_string())
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    let transient_interaction_id = sqlx::query(
        "INSERT INTO interactions(
            thread_id,sequence,text,created_at,graph_node_id,completion_status,
            harness_configuration_name,harness_configuration_digest,permission_profile_id,
            effective_execution_digest,effective_permission_receipt_json,input_identity,input_digest
         ) VALUES (?1,3,'Use another committed answer',?2,78,'running','codex-basic','sha256:test',
            'auto','sha256:execution','{}','send-restart-transient','sha256:transient-input')",
    )
    .bind(thread_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap()
    .last_insert_rowid();
    sqlx::query(
        "INSERT INTO interaction_attempts(
            interaction_id,attempt_number,started_at,family_id,family_revision,
            harness_configuration_name,harness_configuration_revision,harness_configuration_digest,
            provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,
            outcome,effect_boundary
         ) VALUES (?1,1,?2,?3,?4,'codex-basic',1,'sha256:test',
            'codex','test-adapter',1,'test-model','managed-runtime@1','running','unknown')",
    )
    .bind(transient_interaction_id)
    .bind(&created_at)
    .bind(family_id)
    .bind(family_revision)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO interaction_submitted_input_attempts(
            interaction_id,thread_id,draft_revision,authority_digest,semantic_digest,state,
            graph_root_node_id,created_at,bound_at
         ) VALUES (?1,?2,1,'sha256:transient-input','sha256:transient-semantic','running',78,?3,?3)",
    )
    .bind(transient_interaction_id)
    .bind(thread_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO interaction_submitted_input_attachments(
            interaction_id,presenting_interaction_node_id,presenting_layer_id,action_id,
            source_node_id,action_json,value_json,committed_at
         ) VALUES (?1,11,21,31,41,?2,?3,?4)",
    )
    .bind(transient_interaction_id)
    .bind(json!({"control":"text","prompt":"Another answer"}).to_string())
    .bind(json!({"text":"accepted later"}).to_string())
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    let mismatched_interaction_id = sqlx::query(
        "INSERT INTO interactions(
            thread_id,sequence,text,created_at,graph_node_id,completion_status,
            harness_configuration_name,harness_configuration_digest,permission_profile_id,
            effective_execution_digest,effective_permission_receipt_json,input_identity,input_digest
         ) VALUES (?1,4,'Do not accept mismatched provenance',?2,79,'running','codex-basic','sha256:test',
            'auto','sha256:execution','{}','send-restart-mismatch','sha256:expected-input')",
    )
    .bind(thread_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap()
    .last_insert_rowid();
    sqlx::query(
        "INSERT INTO interaction_attempts(
            interaction_id,attempt_number,started_at,family_id,family_revision,
            harness_configuration_name,harness_configuration_revision,harness_configuration_digest,
            provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,
            outcome,effect_boundary
         ) VALUES (?1,1,?2,?3,?4,'codex-basic',1,'sha256:test',
            'codex','test-adapter',1,'test-model','managed-runtime@1','running','unknown')",
    )
    .bind(mismatched_interaction_id)
    .bind(&created_at)
    .bind(family_id)
    .bind(family_revision)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO interaction_submitted_input_attempts(
            interaction_id,thread_id,draft_revision,authority_digest,semantic_digest,state,
            graph_root_node_id,created_at,bound_at
         ) VALUES (?1,?2,1,'sha256:expected-input','sha256:mismatch-semantic','running',79,?3,?3)",
    )
    .bind(mismatched_interaction_id)
    .bind(thread_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO interaction_submitted_input_attachments(
            interaction_id,presenting_interaction_node_id,presenting_layer_id,action_id,
            source_node_id,action_json,value_json,committed_at
         ) VALUES (?1,12,22,32,42,?2,?3,?4)",
    )
    .bind(mismatched_interaction_id)
    .bind(json!({"control":"text","prompt":"Mismatch"}).to_string())
    .bind(json!({"text":"must remain quarantined"}).to_string())
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    let transient_missing_interaction_id = sqlx::query(
        "INSERT INTO interactions(
            thread_id,sequence,text,created_at,graph_node_id,completion_status,
            harness_configuration_name,harness_configuration_digest,permission_profile_id,
            effective_execution_digest,effective_permission_receipt_json,input_identity,input_digest
         ) VALUES (?1,5,'Restore after definitive absence',?2,80,'running','codex-basic','sha256:test',
            'auto','sha256:execution','{}','send-restart-missing','sha256:missing-input')",
    )
    .bind(thread_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap()
    .last_insert_rowid();
    sqlx::query(
        "INSERT INTO interaction_attempts(
            interaction_id,attempt_number,started_at,family_id,family_revision,
            harness_configuration_name,harness_configuration_revision,harness_configuration_digest,
            provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,
            outcome,effect_boundary
         ) VALUES (?1,1,?2,?3,?4,'codex-basic',1,'sha256:test',
            'codex','test-adapter',1,'test-model','managed-runtime@1','running','unknown')",
    )
    .bind(transient_missing_interaction_id)
    .bind(&created_at)
    .bind(family_id)
    .bind(family_revision)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO interaction_submitted_input_attempts(
            interaction_id,thread_id,draft_revision,authority_digest,semantic_digest,state,
            graph_root_node_id,created_at,bound_at
         ) VALUES (?1,?2,1,'sha256:missing-input','sha256:missing-semantic','running',80,?3,?3)",
    )
    .bind(transient_missing_interaction_id)
    .bind(thread_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO interaction_submitted_input_attachments(
            interaction_id,presenting_interaction_node_id,presenting_layer_id,action_id,
            source_node_id,action_json,value_json,committed_at
         ) VALUES (?1,13,23,33,43,?2,?3,?4)",
    )
    .bind(transient_missing_interaction_id)
    .bind(json!({"control":"text","prompt":"Missing"}).to_string())
    .bind(json!({"text":"restore me"}).to_string())
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    let unbound_interaction_id = sqlx::query(
        "INSERT INTO interactions(
            thread_id,sequence,text,created_at,completion_status,
            harness_configuration_name,harness_configuration_digest,permission_profile_id,
            effective_execution_digest,effective_permission_receipt_json,input_identity,input_digest
         ) VALUES (?1,6,'Restore an unbound answer',?2,'submitted','codex-basic','sha256:test',
            'auto','sha256:execution','{}','send-restart-unbound','sha256:unbound-input')",
    )
    .bind(thread_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap()
    .last_insert_rowid();
    sqlx::query(
        "INSERT INTO interaction_submitted_input_attempts(
            interaction_id,thread_id,draft_revision,authority_digest,semantic_digest,state,
            created_at
         ) VALUES (?1,?2,1,'sha256:unbound-input','sha256:unbound-semantic','preparing',?3)",
    )
    .bind(unbound_interaction_id)
    .bind(thread_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO interaction_submitted_input_attachments(
            interaction_id,presenting_interaction_node_id,presenting_layer_id,action_id,
            source_node_id,action_json,value_json,committed_at
         ) VALUES (?1,14,24,34,44,?2,?3,?4)",
    )
    .bind(unbound_interaction_id)
    .bind(json!({"control":"text","prompt":"Unbound"}).to_string())
    .bind(json!({"text":"restore unbound"}).to_string())
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":"codex-basic","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},
                "modelCompatibility":[{"providerId":"codex"}],
                "executionAccessContracts":["managed-runtime@1"],
                "settings":{"model":"test-model"}
            },"digest":"sha256:test"}]
        })
        .to_string(),
    )
    .unwrap();

    let transient_output_reads = Arc::new(AtomicUsize::new(0));
    let observed_transient_output_reads = transient_output_reads.clone();
    let transient_missing_output_reads = Arc::new(AtomicUsize::new(0));
    let observed_transient_missing_output_reads = transient_missing_output_reads.clone();
    let graph = Router::new()
        .route(
            "/api/control/interactions",
            axum::routing::post(|| async {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    axum::Json(json!({"error":{"code":"temporarily_unavailable"}})),
                )
            }),
        )
        .route(
            "/api/control/interactions/77",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":77,"invocation":null,
                    "inputIdentity":"send-restart-input","inputDigest":"sha256:input"
                }))
            }),
        )
        .route(
            "/api/control/interactions/77/output",
            axum::routing::get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    axum::Json(json!({"error":{"code":"completion_not_found"}})),
                )
            }),
        )
        .route(
            "/api/control/interactions/78",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":78,"invocation":null,
                    "inputIdentity":"send-restart-transient",
                    "inputDigest":"sha256:transient-input"
                }))
            }),
        )
        .route(
            "/api/control/interactions/78/output",
            axum::routing::get(move || {
                let observed_transient_output_reads = observed_transient_output_reads.clone();
                async move {
                    if observed_transient_output_reads.fetch_add(1, Ordering::SeqCst) == 0 {
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            axum::Json(json!({"error":{"code":"temporarily_unavailable"}})),
                        )
                            .into_response();
                    }
                    axum::Json(json!({
                        "nodeId":78,
                        "rootLayer":{"id":1,"nodes":[],"edges":[],"actions":[]}
                    }))
                    .into_response()
                }
            }),
        )
        .route(
            "/api/control/interactions/79",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":79,"invocation":null,
                    "inputIdentity":"send-restart-mismatch",
                    "inputDigest":"sha256:wrong-input"
                }))
            }),
        )
        .route(
            "/api/control/interactions/79/output",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":79,
                    "rootLayer":{"id":1,"nodes":[],"edges":[],"actions":[]}
                }))
            }),
        )
        .route(
            "/api/control/interactions/80",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "nodeId":80,"invocation":null,
                    "inputIdentity":"send-restart-missing",
                    "inputDigest":"sha256:missing-input"
                }))
            }),
        )
        .route(
            "/api/control/interactions/80/output",
            axum::routing::get(move || {
                let observed_transient_missing_output_reads =
                    observed_transient_missing_output_reads.clone();
                async move {
                    if observed_transient_missing_output_reads.fetch_add(1, Ordering::SeqCst) == 0 {
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            axum::Json(json!({"error":{"code":"temporarily_unavailable"}})),
                        )
                            .into_response();
                    }
                    (
                        StatusCode::NOT_FOUND,
                        axum::Json(json!({"error":{"code":"completion_not_found"}})),
                    )
                        .into_response()
                }
            }),
        )
        .route(
            "/api/control/capabilities",
            axum::routing::delete(|| async { axum::Json(json!({"revoked":true})) }),
        );
    let provider_calls = Arc::new(AtomicUsize::new(0));
    let observed_provider_calls = provider_calls.clone();
    let harness = Router::new().route(
        &format!("/sessions/{thread_id}/complete"),
        axum::routing::post(move || {
            let observed_provider_calls = observed_provider_calls.clone();
            async move {
                observed_provider_calls.fetch_add(1, Ordering::SeqCst);
                axum::Json(json!({"output":{"nodeId":77}}))
            }
        }),
    );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(harness).await;
    let resumed =
        open_app_with_runtime_allow_override(&database, &root, &catalog, &graph_url, &harness_url)
            .await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    let pool = sqlite_pool(&database).await;
    let transient_pending: (String, String, String, String, i64) = sqlx::query_as(
        "SELECT i.completion_status,i.completion_error,a.state,
                (SELECT outcome FROM interaction_attempts execution
                 WHERE execution.interaction_id=i.id ORDER BY attempt_number DESC LIMIT 1),
                (SELECT COUNT(*) FROM action_input_attachments d
                 WHERE d.thread_id=i.thread_id AND d.action_id=31)
         FROM interactions i
         JOIN interaction_submitted_input_attempts a ON a.interaction_id=i.id
         WHERE i.id=?1",
    )
    .bind(transient_interaction_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(transient_pending.0, "failed");
    assert!(
        transient_pending
            .1
            .starts_with("Canonical reconciliation pending:")
    );
    assert_eq!(transient_pending.2, "running");
    assert_eq!(transient_pending.3, "running");
    assert_eq!(transient_pending.4, 0);
    let mismatched_pending: (String, String, String, i64) = sqlx::query_as(
        "SELECT i.completion_status,i.completion_error,a.state,
                (SELECT COUNT(*) FROM action_input_attachments d
                 WHERE d.thread_id=i.thread_id AND d.action_id=32)
         FROM interactions i
         JOIN interaction_submitted_input_attempts a ON a.interaction_id=i.id
         WHERE i.id=?1",
    )
    .bind(mismatched_interaction_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(mismatched_pending.0, "failed");
    assert!(mismatched_pending.1.contains("input draft was restored"));
    assert_eq!(mismatched_pending.2, "failed");
    assert_eq!(mismatched_pending.3, 1);
    let transient_missing_pending: (String, String, String, String, i64) = sqlx::query_as(
        "SELECT i.completion_status,i.completion_error,a.state,
                (SELECT outcome FROM interaction_attempts execution
                 WHERE execution.interaction_id=i.id ORDER BY attempt_number DESC LIMIT 1),
                (SELECT COUNT(*) FROM action_input_attachments d
                 WHERE d.thread_id=i.thread_id AND d.action_id=33)
         FROM interactions i
         JOIN interaction_submitted_input_attempts a ON a.interaction_id=i.id
         WHERE i.id=?1",
    )
    .bind(transient_missing_interaction_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(transient_missing_pending.0, "failed");
    assert!(
        transient_missing_pending
            .1
            .starts_with("Canonical reconciliation pending:")
    );
    assert_eq!(transient_missing_pending.2, "running");
    assert_eq!(transient_missing_pending.3, "running");
    assert_eq!(transient_missing_pending.4, 0);
    let unbound_failed: (String, String, String, i64) = sqlx::query_as(
        "SELECT i.completion_status,COALESCE(i.completion_error,''),a.state,
                (SELECT COUNT(*) FROM action_input_attachments d
                 WHERE d.thread_id=i.thread_id AND d.action_id=34)
         FROM interactions i
         JOIN interaction_submitted_input_attempts a ON a.interaction_id=i.id
         WHERE i.id=?1",
    )
    .bind(unbound_interaction_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(unbound_failed.0, "failed");
    assert!(
        !unbound_failed
            .1
            .starts_with("Canonical reconciliation pending:")
    );
    assert!(unbound_failed.1.contains("input draft was restored"));
    assert_eq!(unbound_failed.2, "failed");
    assert_eq!(unbound_failed.3, 1);
    let (status, error): (String, Option<String>) =
        sqlx::query_as("SELECT completion_status,completion_error FROM interactions WHERE id=?1")
            .bind(interaction_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "failed");
    assert!(error.unwrap().contains("input draft was restored"));
    let attempt_state: String = sqlx::query_scalar(
        "SELECT state FROM interaction_submitted_input_attempts WHERE interaction_id=?1",
    )
    .bind(interaction_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(attempt_state, "failed");
    let attempt_receipt: (String, Option<String>, String, Option<String>) = sqlx::query_as(
        "SELECT outcome,failure_category,effect_boundary,finished_at
         FROM interaction_attempts WHERE interaction_id=?1",
    )
    .bind(interaction_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(attempt_receipt.0, "execution_failed");
    assert_eq!(attempt_receipt.1.as_deref(), Some("application_restart"));
    assert_eq!(attempt_receipt.2, "unknown");
    assert!(attempt_receipt.3.is_some());
    let restored: (i64, String) = sqlx::query_as(
        "SELECT COUNT(*),MAX(value_json) FROM action_input_attachments WHERE thread_id=?1 AND action_id=30",
    )
    .bind(thread_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(restored, (1, json!({"text":"committed"}).to_string()));
    assert_eq!(provider_calls.load(Ordering::SeqCst), 0);
    pool.close().await;

    let state = response_json(
        resumed
            .clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/state?threadId={thread_id}"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let transient = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == transient_interaction_id)
        .unwrap();
    assert_eq!(transient["completionStatus"], "accepted");
    let mismatched = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == mismatched_interaction_id)
        .unwrap();
    assert_eq!(mismatched["completionStatus"], "failed");
    let transient_missing = state["interactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|interaction| interaction["id"] == transient_missing_interaction_id)
        .unwrap();
    assert_eq!(transient_missing["completionStatus"], "failed");
    assert!(
        transient_missing["completionError"]
            .as_str()
            .unwrap()
            .contains("input draft was restored")
    );
    let pool = sqlite_pool(&database).await;
    let transient_accepted: (String, String, i64) = sqlx::query_as(
        "SELECT a.state,
                (SELECT outcome FROM interaction_attempts execution
                 WHERE execution.interaction_id=a.interaction_id
                 ORDER BY attempt_number DESC LIMIT 1),
                (SELECT COUNT(*) FROM action_input_attachments d
                 WHERE d.thread_id=a.thread_id AND d.action_id=31)
         FROM interaction_submitted_input_attempts a WHERE a.interaction_id=?1",
    )
    .bind(transient_interaction_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        transient_accepted,
        ("accepted".into(), "accepted".into(), 0)
    );
    let mismatch_still_quarantined: (String, i64) = sqlx::query_as(
        "SELECT a.state,
                (SELECT COUNT(*) FROM action_input_attachments d
                 WHERE d.thread_id=a.thread_id AND d.action_id=32)
         FROM interaction_submitted_input_attempts a WHERE a.interaction_id=?1",
    )
    .bind(mismatched_interaction_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(mismatch_still_quarantined, ("failed".into(), 1));
    let transient_missing_failed: (String, String, String, String, i64) = sqlx::query_as(
        "SELECT submitted.state,execution.outcome,
                COALESCE(execution.failure_category,''),execution.effect_boundary,
                (SELECT COUNT(*) FROM action_input_attachments d
                 WHERE d.thread_id=submitted.thread_id AND d.action_id=33)
         FROM interaction_submitted_input_attempts submitted
         JOIN interaction_attempts execution
           ON execution.interaction_id=submitted.interaction_id
         WHERE submitted.interaction_id=?1",
    )
    .bind(transient_missing_interaction_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        transient_missing_failed,
        (
            "failed".into(),
            "execution_failed".into(),
            "application_restart".into(),
            "unknown".into(),
            1
        )
    );
    assert_eq!(provider_calls.load(Ordering::SeqCst), 0);
    pool.close().await;

    drop(resumed);
    graph_task.abort();
    harness_task.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn identified_context_replays_after_response_loss_and_resumes_bound_input_after_restart() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-context-recovery-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let offline = open_app(&database, &root).await;
    let thread = response_json(
        offline
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({"initialMessage":"Seed"})),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let thread_id = thread["id"].as_i64().unwrap();
    drop(offline);
    seed_explicit_test_model_default(&database, thread_id).await;
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        json!({
            "schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":"codex-basic","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},
                "modelCompatibility":[{"providerId":"codex"}],
                "executionAccessContracts":["managed-runtime@1"],
                "settings":{"model":"test-model"}
            },"digest":"sha256:test"}]
        })
        .to_string(),
    )
    .unwrap();

    let creates = Arc::new(AtomicUsize::new(0));
    let observed_creates = creates.clone();
    let observed_digest = Arc::new(Mutex::new(String::new()));
    let captured_digest = observed_digest.clone();
    let graph = Router::new()
        .route(
            "/api/control/context-occurrences/canonical",
            axum::routing::post(canonical_accepted_context_node),
        )
        .route(
            "/api/control/interactions",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let observed_creates = observed_creates.clone();
                let captured_digest = captured_digest.clone();
                async move {
                    assert_eq!(body["inputIdentity"], "send-recover-1");
                    *captured_digest.lock().unwrap() =
                        body["inputDigest"].as_str().unwrap().to_owned();
                    observed_creates.fetch_add(1, Ordering::SeqCst);
                    (StatusCode::OK, "lost graph create response").into_response()
                }
            }),
        )
        .route(
            "/api/control/capabilities",
            axum::routing::post(|| async {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    axum::Json(json!({"error":"activation unavailable"})),
                )
            })
            .delete(|| async { axum::Json(json!({"revoked":true})) }),
        );
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(Router::new()).await;
    let app =
        open_app_with_runtime_allow_override(&database, &root, &catalog, &graph_url, &harness_url)
            .await;
    let request_body = json!({
        "text":"Use this context","inputId":"send-recover-1",
        "contexts":[{"target":{"nodeId":7,"sourceInteractionNodeId":3,"sourceLayerId":5},
            "annotations":["raw note"]}]
    });
    let first = app
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(request_body.clone()),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::CREATED);
    let first_id = response_json(first).await["id"].as_i64().unwrap();
    assert_eq!(creates.load(Ordering::SeqCst), 4);
    let pool = sqlite_pool(&database).await;
    let counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM interactions WHERE thread_id=?1 AND input_identity='send-recover-1'),(SELECT COUNT(*) FROM interaction_context_intents),(SELECT COUNT(*) FROM interaction_context_annotations)",
    ).bind(thread_id).fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (1, 1, 1));
    let bound: (String, Option<i64>) =
        sqlx::query_as("SELECT completion_status,graph_node_id FROM interactions WHERE id=?1")
            .bind(first_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(bound, ("submitted".into(), None));
    pool.close().await;
    drop(app);
    graph_task.abort();
    harness_task.abort();

    let digest = observed_digest.lock().unwrap().clone();
    let metadata_digest = digest.clone();
    let create_digest = digest.clone();
    let input_reads = Arc::new(AtomicUsize::new(0));
    let observed_input_reads = input_reads.clone();
    let context_action_reads = Arc::new(AtomicUsize::new(0));
    let observed_context_action_reads = context_action_reads.clone();
    let graph = Router::new()
        .route(
            "/api/control/context-occurrences/canonical",
            axum::routing::post(canonical_accepted_context_node),
        )
        .route("/api/control/interactions", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let create_digest = create_digest.clone();
            async move { axum::Json(json!({
                "node":{"id":77},"graphToken":"","inputIdentity":"send-recover-1",
                "inputDigest":create_digest,"contextActions":[],"echo":body
            })) }
        }))
        .route("/api/control/interactions/77", axum::routing::get(move || {
            let metadata_digest = metadata_digest.clone();
            async move { axum::Json(json!({
                "nodeId":77,"invocation":null,"inputIdentity":"send-recover-1","inputDigest":metadata_digest
            })) }
        }))
        .route("/api/control/interactions/77/output", axum::routing::get(|| async {
            (StatusCode::NOT_FOUND, axum::Json(json!({"error":{"code":"completion_not_found"}})))
        }))
        .route("/api/control/interactions/77/input", axum::routing::get(move || {
            let observed_input_reads = observed_input_reads.clone();
            async move {
                if observed_input_reads.fetch_add(1, Ordering::SeqCst) + 1 == 3 {
                    return (StatusCode::SERVICE_UNAVAILABLE, "transient input failure")
                        .into_response();
                }
                axum::Json(json!({
                    "interaction":{"id":77,"kind":"user-interaction","icon":"user","title":"Use this context","detail":"Use this context","state":"accepted"},
                    "contexts":[{"type":"interaction.context","targetNode":{"id":7,"kind":"concept","icon":"box","title":"Target","detail":"Immutable target","state":"accepted"},"annotations":["raw note"]}]
                })).into_response()
            }
        }))
        .route("/api/control/interactions/77/context-actions", axum::routing::get(move || {
            let observed_context_action_reads = observed_context_action_reads.clone();
            async move {
                if observed_context_action_reads.fetch_add(1, Ordering::SeqCst) + 1 == 2 {
                    return (StatusCode::SERVICE_UNAVAILABLE, "transient action failure")
                        .into_response();
                }
                axum::Json(json!({"actions":[{
                    "id":88,"type":"interaction.context","sourceNodeId":77,
                    "target":{"nodeId":7,"sourceInteractionNodeId":3,"sourceLayerId":5},
                    "annotations":["raw note"],"state":"accepted"
                }]})).into_response()
            }
        }))
        .route("/api/control/capabilities", axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
            axum::Json(json!({"graphToken":body["graphToken"]}))
        }).delete(|| async { axum::Json(json!({"revoked":true})) }));
    let harness = Router::new()
        .route("/sessions", axum::routing::post(|| async { (StatusCode::CREATED, axum::Json(json!({}))) }))
        .route("/sessions/{id}/execution-leases", axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
            (StatusCode::CREATED, axum::Json(test_execution_admission(
                &body,
                "00000000-0000-0000-0000-000000000077",
                "1",
            )))
        }))
        .route("/sessions/{id}/execution-leases/{lease}", axum::routing::delete(|| async {
            axum::Json(json!({"released":true}))
        }))
        .route(&format!("/sessions/{thread_id}/complete"), axum::routing::post(|| async {
            axum::Json(json!({"output":{"nodeId":77,"rootLayer":{"id":1,"nodes":[],"edges":[],"actions":[]}}}))
        }));
    let (graph_url, graph_task) = serve_test_app(graph).await;
    let (harness_url, harness_task) = serve_test_app(harness).await;
    let resumed =
        open_app_with_runtime_allow_override(&database, &root, &catalog, &graph_url, &harness_url)
            .await;
    for _ in 0..100 {
        let pool = sqlite_pool(&database).await;
        let status: String =
            sqlx::query_scalar("SELECT completion_status FROM interactions WHERE id=?1")
                .bind(first_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        pool.close().await;
        if status == "accepted" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let pool = sqlite_pool(&database).await;
    let status: String =
        sqlx::query_scalar("SELECT completion_status FROM interactions WHERE id=?1")
            .bind(first_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "accepted");
    pool.close().await;
    let listed = response_json(
        resumed
            .clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/threads/{thread_id}/interactions"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        listed["interactions"][1]["contexts"],
        json!([{
            "id":88,"type":"interaction.context",
            "target":{"nodeId":7,"sourceInteractionNodeId":3,"sourceLayerId":5},
            "targetNode":{"id":7,"kind":"concept","icon":"box","title":"Target","detail":"Immutable target","state":"accepted"},
            "annotations":["raw note"]
        }])
    );
    let hydrated = response_json(
        resumed
            .clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/state?threadId={thread_id}"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(hydrated["interactions"][1]["contexts"], json!([]));
    assert_eq!(hydrated["interactions"][1]["projectionFresh"], false);
    let stale_detail = response_json(
        resumed
            .clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/threads/{thread_id}"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(stale_detail["interactions"][1]["contexts"], json!([]));
    assert_eq!(stale_detail["interactions"][1]["projectionFresh"], false);
    let recovered_detail = response_json(
        resumed
            .clone()
            .oneshot(api_request(
                "GET",
                &format!("/api/threads/{thread_id}"),
                None,
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        recovered_detail["interactions"][1]["contexts"],
        listed["interactions"][1]["contexts"]
    );
    assert_eq!(recovered_detail["interactions"][1]["projectionFresh"], true);
    let replay = resumed
        .clone()
        .oneshot(api_request(
            "POST",
            &format!("/api/threads/{thread_id}/interactions"),
            Some(request_body),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::CREATED);
    assert_eq!(response_json(replay).await["id"].as_i64(), Some(first_id));
    let conflict = resumed.clone().oneshot(api_request(
        "POST", &format!("/api/threads/{thread_id}/interactions"), Some(json!({
            "text":"Changed payload","inputId":"send-recover-1",
            "contexts":[{"target":{"nodeId":8,"sourceInteractionNodeId":3,"sourceLayerId":5},"annotations":["changed"]}]
        })), true,
    )).await.unwrap();
    assert_eq!(conflict.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let conflict_body = response_json(conflict).await;
    assert_eq!(
        conflict_body,
        json!({"error":"Relayer could not send this message. Your draft was preserved."})
    );
    assert!(!conflict_body.to_string().contains("different content"));
    let pool = sqlite_pool(&database).await;
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM interactions WHERE input_identity='send-recover-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    pool.close().await;
    drop(resumed);
    graph_task.abort();
    harness_task.abort();
    fs::remove_dir_all(root).unwrap();
}

async fn canonical_accepted_context_node(axum::Json(body): axum::Json<Value>) -> axum::Json<Value> {
    axum::Json(json!({
        "id": body["nodeId"],
        "kind": "concept",
        "icon": "list",
        "title": "Queue",
        "detail": "Tasks",
        "state": "accepted"
    }))
}

async fn sqlite_pool(database: &Path) -> sqlx::SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(database)
                .create_if_missing(true),
        )
        .await
        .unwrap()
}

async fn seed_explicit_test_model_default(database: &Path, thread_id: i64) {
    let pool = sqlite_pool(database).await;
    sqlx::query("UPDATE model_providers SET connected=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL,refreshed_at='1',lifecycle_state='active',removed_at=NULL WHERE id='codex'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO provider_models(provider_id,model_id,label,provider_order,visible,available,unavailable_reason_code,unavailable_reason_message,provider_default,replacement_model_id,metadata_json) VALUES ('codex','test-model','Test model',0,1,1,NULL,NULL,1,NULL,'{}')")
        .execute(&pool)
        .await
        .unwrap();
    let family_id = sqlx::query("INSERT INTO model_families(name,kind,system_key,enabled,position) VALUES ('Test default','custom',NULL,1,0)")
        .execute(&pool)
        .await
        .unwrap()
        .last_insert_rowid();
    sqlx::query("INSERT INTO model_family_members(family_id,position,provider_id,model_id) VALUES (?1,0,'codex','test-model')")
        .bind(family_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE product_model_preferences SET default_provider_id='codex',default_family_id=?1 WHERE singleton=1")
        .bind(family_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE interactions SET completion_status='accepted',model_provider_id='codex',provider_model_id='test-model',model_family_id=?1 WHERE thread_id=?2")
        .bind(family_id)
        .bind(thread_id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

async fn seed_thread_with_current_test_model(database: &Path, thread_id: i64) {
    let pool = sqlite_pool(database).await;
    let family_id: i64 = sqlx::query_scalar(
        "SELECT default_family_id FROM product_model_preferences WHERE singleton=1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE interactions SET completion_status='accepted',model_provider_id='codex',provider_model_id='test-model',model_family_id=?1 WHERE thread_id=?2")
        .bind(family_id)
        .bind(thread_id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

async fn seed_action_input_draft_count(database: &Path, thread_id: i64, count: i64) {
    let pool = sqlite_pool(database).await;
    sqlx::query(
        "INSERT INTO action_input_drafts(thread_id,revision,updated_at) VALUES (?1,?2,'seed')",
    )
    .bind(thread_id)
    .bind(count)
    .execute(&pool)
    .await
    .unwrap();
    let action = json!({
        "control": "text",
        "prompt": "Seeded portable input"
    })
    .to_string();
    for index in 0..count {
        sqlx::query("INSERT INTO action_input_attachments(thread_id,presenting_interaction_node_id,presenting_layer_id,action_id,source_node_id,action_json,value_json,committed_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'seed')")
            .bind(thread_id)
            .bind(1_000 + index)
            .bind(2_000 + index)
            .bind(3_000 + index)
            .bind(4_000 + index)
            .bind(&action)
            .bind(json!({ "text": format!("value-{index}") }).to_string())
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
}

async fn seed_action_input_draft_bytes(
    database: &Path,
    thread_id: i64,
    count: i64,
    value_bytes: usize,
) {
    let pool = sqlite_pool(database).await;
    sqlx::query(
        "INSERT INTO action_input_drafts(thread_id,revision,updated_at) VALUES (?1,?2,'seed')",
    )
    .bind(thread_id)
    .bind(count)
    .execute(&pool)
    .await
    .unwrap();
    let action = json!({"control":"text","prompt":"Seeded portable input"}).to_string();
    let value = json!({"text":"x".repeat(value_bytes)}).to_string();
    for index in 0..count {
        sqlx::query("INSERT INTO action_input_attachments(thread_id,presenting_interaction_node_id,presenting_layer_id,action_id,source_node_id,action_json,value_json,committed_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'seed')")
            .bind(thread_id)
            .bind(5_000 + index)
            .bind(6_000 + index)
            .bind(7_000 + index)
            .bind(8_000 + index)
            .bind(&action)
            .bind(&value)
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
}

async fn seed_thread_interactions_terminal(database: &Path, thread_id: i64) {
    let pool = sqlite_pool(database).await;
    sqlx::query("UPDATE interactions SET completion_status='failed',completion_error='seed terminal state' WHERE thread_id=?1")
        .bind(thread_id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

async fn seed_project_path_expanding_action_input_draft(
    database: &Path,
    thread_id: i64,
    project_path: &str,
    repetitions: usize,
) {
    let pool = sqlite_pool(database).await;
    sqlx::query(
        "INSERT INTO projects(name,path,created_at,updated_at) VALUES ('Short path',?1,'seed','seed')",
    )
    .bind(project_path)
    .execute(&pool)
    .await
    .unwrap();
    let project_id: i64 = sqlx::query_scalar("SELECT id FROM projects WHERE path=?1")
        .bind(project_path)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE threads SET project_id=?1 WHERE id=?2")
        .bind(project_id)
        .bind(thread_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE interactions SET completion_status='failed',completion_error='seed terminal state' WHERE thread_id=?1")
        .bind(thread_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO action_input_drafts(thread_id,revision,updated_at) VALUES (?1,1,'seed')",
    )
    .bind(thread_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO action_input_attachments(thread_id,presenting_interaction_node_id,presenting_layer_id,action_id,source_node_id,action_json,value_json,committed_at) VALUES (?1,5000,6000,7000,8000,?2,?3,'seed')")
        .bind(thread_id)
        .bind(json!({"control":"text","prompt":"Seeded portable input"}).to_string())
        .bind(json!({"text":project_path.repeat(repetitions)}).to_string())
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

async fn response_json(response: Response<Body>) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

async fn open_app(database: &Path, web_directory: &Path) -> Router {
    RelayerAppServer::open(RelayerAppServerConfig {
        database_path: database.to_owned(),
        web_directory: web_directory.to_owned(),
        permission_catalog: permission_catalog(),
        control_token: "control".to_owned(),
        read_only_control_token: Some("review".to_owned()),
        runtime: None,
        allow_conversation_import: false,
        export_producer: test_export_producer(),
        completion_broker_origin: None,
    })
    .await
    .unwrap()
    .router()
}

async fn open_app_with_runtime(
    database: &Path,
    web_directory: &Path,
    catalog: &Path,
    graph_url: &str,
    harness_url: &str,
) -> Router {
    open_app_with_runtime_observed(database, web_directory, catalog, graph_url, harness_url).await
}

async fn open_app_with_runtime_allow_override(
    database: &Path,
    web_directory: &Path,
    catalog: &Path,
    graph_url: &str,
    harness_url: &str,
) -> Router {
    open_app_with_runtime_observed_with_override(
        database,
        web_directory,
        catalog,
        graph_url,
        harness_url,
        true,
    )
    .await
}

async fn open_app_with_runtime_observed(
    database: &Path,
    web_directory: &Path,
    catalog: &Path,
    graph_url: &str,
    harness_url: &str,
) -> Router {
    open_app_with_runtime_observed_with_override(
        database,
        web_directory,
        catalog,
        graph_url,
        harness_url,
        false,
    )
    .await
}

async fn open_app_with_runtime_observed_with_override(
    database: &Path,
    web_directory: &Path,
    catalog: &Path,
    graph_url: &str,
    harness_url: &str,
    allow_harness_override: bool,
) -> Router {
    RelayerAppServer::open(RelayerAppServerConfig {
        database_path: database.to_owned(),
        web_directory: web_directory.to_owned(),
        permission_catalog: permission_catalog(),
        control_token: "control".to_owned(),
        read_only_control_token: Some("review".to_owned()),
        runtime: Some(RelayerRuntimeConfig {
            graph_url: graph_url.to_owned(),
            harness_url: harness_url.to_owned(),
            graph_control_token: "graph-control".to_owned(),
            harness_control_token: "harness-control".to_owned(),
            harness_configurations: catalog.to_owned(),
            default_harness_configuration: "codex-basic".to_owned(),
            allow_harness_override,
            standalone_workspaces_directory: web_directory.join("workspaces"),
        }),
        allow_conversation_import: false,
        export_producer: test_export_producer(),
        completion_broker_origin: None,
    })
    .await
    .unwrap()
    .router()
}

fn test_export_producer() -> relayer_app_server::conversation_export::ExportProducer {
    relayer_app_server::conversation_export::ExportProducer {
        desktop_version: "test".into(),
        build_commit: "test".into(),
        platform: "test".into(),
        architecture: "test".into(),
    }
}

fn permission_catalog() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../permissions/desktop.json")
}

async fn serve_test_app(
    app: Router,
) -> (String, tokio::task::JoinHandle<Result<(), std::io::Error>>) {
    let app = app.route(
        "/api/control/personal-presentation",
        axum::routing::get(|| async { axum::Json(json!({ "schemaVersion": 0 })) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(axum::serve(listener, app).into_future());
    (format!("http://{address}/"), task)
}

async fn serve_test_app_with_current_graph_contract(
    app: Router,
) -> (String, tokio::task::JoinHandle<Result<(), std::io::Error>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(axum::serve(listener, app).into_future());
    (format!("http://{address}/"), task)
}

fn api_request(method: &str, uri: &str, body: Option<Value>, authenticated: bool) -> Request<Body> {
    api_request_with_token(
        method,
        uri,
        body,
        if authenticated { "control" } else { "" },
    )
}

fn api_request_with_token(
    method: &str,
    uri: &str,
    body: Option<Value>,
    token: &str,
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if !token.is_empty() {
        builder = builder.header("cookie", format!("{CONTROL_COOKIE}={token}"));
    }
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    builder
        .body(Body::from(
            body.map(|value| value.to_string()).unwrap_or_default(),
        ))
        .unwrap()
}

fn annotation_request(method: &str, uri: &str, body: Option<Value>, token: &str) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri).header(
        "cookie",
        format!("{CONTROL_COOKIE}=review; {ANNOTATION_COOKIE}={token}"),
    );
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    builder
        .body(Body::from(
            body.map(|value| value.to_string()).unwrap_or_default(),
        ))
        .unwrap()
}

fn input_operator_request(
    method: &str,
    uri: &str,
    body: Option<Value>,
    token: &str,
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri).header(
        "cookie",
        format!("{CONTROL_COOKIE}=review; {INPUT_OPERATOR_COOKIE}={token}"),
    );
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    builder
        .body(Body::from(
            body.map(|value| value.to_string()).unwrap_or_default(),
        ))
        .unwrap()
}

fn annotation_token_only_request(
    method: &str,
    uri: &str,
    body: Option<Value>,
    token: &str,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("cookie", format!("{ANNOTATION_COOKIE}={token}"));
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    builder
        .body(Body::from(
            body.map(|value| value.to_string()).unwrap_or_default(),
        ))
        .unwrap()
}

fn provider_publish_request(body: Value) -> Request<Body> {
    Request::builder()
        .method("PUT")
        .uri("/api/internal/provider-catalog")
        .header("authorization", "Bearer control")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn model_selection(family_id: i64, model_id: &str) -> Value {
    json!({
        "familyId": family_id,
        "providerId": "codex",
        "modelId": model_id
    })
}

async fn wait_for_interaction_count_and_terminal(
    app: &Router,
    thread_id: i64,
    expected_count: usize,
) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let state = response_json(
            app.clone()
                .oneshot(api_request(
                    "GET",
                    &format!("/api/state?threadId={thread_id}"),
                    None,
                    true,
                ))
                .await
                .unwrap(),
        )
        .await;
        let interactions = state["interactions"].as_array().unwrap();
        if interactions.len() == expected_count
            && interactions.last().is_some_and(|interaction| {
                matches!(
                    interaction["completionStatus"].as_str(),
                    Some("accepted" | "failed")
                )
            })
        {
            return state;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for terminal interaction state: {state}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn test_provider_snapshot() -> Value {
    json!({
        "providerId": "codex",
        "label": "Codex",
        "connected": true,
        "models": [
            {
                "id": "test-model",
                "label": "Test model",
                "order": 0,
                "visible": true,
                "available": true,
                "providerDefault": true,
                "metadata": {}
            },
            {
                "id": "second-model",
                "label": "Second model",
                "order": 1,
                "visible": true,
                "available": true,
                "metadata": {}
            },
            {
                "id": "broken-model",
                "label": "Broken model",
                "order": 2,
                "visible": true,
                "available": true,
                "metadata": {}
            }
        ],
        "systemFamily": {
            "key": "codex",
            "name": "Codex",
            "modelIds": ["test-model", "second-model", "broken-model"]
        }
    })
}

fn test_execution_admission(body: &Value, lease_id: &str, version: &str) -> Value {
    let policy_bytes = serde_json::to_vec(&body["harnessPolicy"]).unwrap();
    let mut policy_hasher = Sha256::new();
    policy_hasher.update(b"relayer.harness-policy.v1\0");
    policy_hasher.update(policy_bytes);
    let harness_policy_digest = format!("sha256:{:x}", policy_hasher.finalize());
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Route {
        provider_id: Value,
        adapter_id: Value,
        access_contract: Value,
        model_id: Value,
        adapter_implementation_version: String,
    }
    let versioned = |route: &Value| Route {
        provider_id: route["providerId"].clone(),
        adapter_id: route["adapterId"].clone(),
        access_contract: route["accessContract"].clone(),
        model_id: route["modelId"].clone(),
        adapter_implementation_version: version.into(),
    };
    let plan = &body["modelPlan"];
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Unsigned<'a> {
        family_id: &'a Value,
        family_revision: &'a Value,
        orchestrator: Route,
        roster: Vec<Route>,
        harness_policy_digest: &'a str,
    }
    let unsigned = Unsigned {
        family_id: &plan["familyId"],
        family_revision: &plan["familyRevision"],
        orchestrator: versioned(&plan["orchestrator"]),
        roster: plan["roster"]
            .as_array()
            .unwrap()
            .iter()
            .map(versioned)
            .collect(),
        harness_policy_digest: &harness_policy_digest,
    };
    let mut plan_hasher = Sha256::new();
    plan_hasher.update(b"relayer.harness-model-plan.v1\0");
    plan_hasher.update(serde_json::to_vec(&unsigned).unwrap());
    let digest = format!("sha256:{:x}", plan_hasher.finalize());
    let mut admitted_plan = serde_json::to_value(&unsigned).unwrap();
    admitted_plan["digest"] = Value::String(digest);
    json!({
        "executionLeaseId": lease_id,
        "adapterImplementationVersion": version,
        "admittedPlan": admitted_plan,
    })
}
