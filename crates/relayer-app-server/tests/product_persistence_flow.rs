use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, Response, StatusCode},
};
use relayer_app_server::{
    CONTROL_COOKIE, RelayerAppServer, RelayerAppServerConfig, RelayerRuntimeConfig,
};
use serde_json::{Value, json};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};
use tower::ServiceExt;

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
    let thread = app
        .oneshot(api_request(
            "POST",
            "/api/threads",
            Some(json!({
                "title": "Invoke once",
                "initialMessage": "Start here"
            })),
            true,
        ))
        .await
        .unwrap();
    let thread = response_json(thread).await;
    let thread_id = thread["id"].as_i64().unwrap();
    let source_interaction_id = thread["rootInteractionId"].as_i64().unwrap();
    let pool = sqlite_pool(&database).await;
    sqlx::query(
        "UPDATE interactions SET graph_node_id=101,completion_status='accepted' WHERE id=?1",
    )
    .bind(source_interaction_id)
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    let graph_interactions = Arc::new(AtomicUsize::new(202));
    let graph_interaction_counter = graph_interactions.clone();
    let graph = axum::Router::new()
        .route(
            "/api/control/capabilities",
            axum::routing::post(|| async { axum::Json(json!({ "graphToken": "graph" })) }),
        )
        .route(
            "/api/graph/actions/41",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "action": {
                        "id": 41,
                        "kind": "invoke",
                        "interactionText": "Authored follow-up",
                        "state": "accepted"
                    }
                }))
            }),
        )
        .route(
            "/api/control/interactions",
            axum::routing::post(move || {
                let graph_interaction_counter = graph_interaction_counter.clone();
                async move {
                    let node_id = graph_interaction_counter.fetch_add(1, Ordering::SeqCst);
                    axum::Json(json!({ "node": { "id": node_id }, "graphToken": "next" }))
                }
            }),
        );
    let harness_completions = Arc::new(AtomicUsize::new(0));
    let completion_counter = harness_completions.clone();
    let harness = axum::Router::new()
        .route(
            "/sessions",
            axum::routing::post(|| async { (StatusCode::CREATED, axum::Json(json!({}))) }),
        )
        .route(
            "/sessions/{id}/complete",
            axum::routing::post(move || {
                let completion_counter = completion_counter.clone();
                async move {
                    let completion_number = completion_counter.fetch_add(1, Ordering::SeqCst);
                    let node_id = 202 + completion_number;
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
                    "settings": {}
                },
                "digest": "sha256:test"
            }]
        })
        .to_string(),
    )
    .unwrap();

    let app = open_app_with_runtime(&database, &root, &catalog, &graph_url, &harness_url).await;
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
        if state["interactions"][1]["completionStatus"] == "accepted" {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(harness_completions.load(Ordering::SeqCst), 1);

    // Simulate a request disappearing after its durable one-shot record commits but before the
    // old handler starts execution. Retrying the saved invocation must claim it exactly once and
    // must not need the graph server to validate the already-authorized action again.
    let pool = sqlite_pool(&database).await;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string();
    let result = sqlx::query(
        "INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status) VALUES (?1,3,'Recovered follow-up',?2,'not_started')",
    )
    .bind(thread_id)
    .bind(&created_at)
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
    assert_eq!(harness_completions.load(Ordering::SeqCst), 2);
    drop(app);

    let reopened =
        open_app_with_runtime(&database, &root, &catalog, &graph_url, &harness_url).await;
    graph_task.abort();
    let replay = reopened
        .oneshot(api_request("POST", &uri, None, true))
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::OK);
    let replay = response_json(replay).await;
    assert_eq!(replay["created"], false);
    assert_eq!(replay["interaction"]["text"], "Authored follow-up");

    harness_task.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn interrupted_action_invocation_becomes_failed_on_restart() {
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
        "INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at) VALUES (?1,41,?2,?3)",
    )
    .bind(source_interaction_id)
    .bind(result_interaction_id)
    .bind(&created_at)
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    let reopened = open_app(&database, &root).await;
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
    assert_eq!(recovered["completionStatus"], "failed");
    assert!(
        recovered["completionError"]
            .as_str()
            .unwrap()
            .contains("temporary one-shot UX")
    );

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

    let mut child = Command::new(env!("CARGO_BIN_EXE_relayer-app-server"))
        .args([
            "--data-dir",
            root.join("data").to_str().unwrap(),
            "--web-dir",
            root.to_str().unwrap(),
            "--port",
            "0",
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

        let thread = app
            .clone()
            .oneshot(api_request(
                "POST",
                "/api/threads",
                Some(json!({
                    "title": "Persist me",
                    "projectId": project["id"],
                    "initialMessage": "Map the project"
                })),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(thread.status(), StatusCode::CREATED);

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
    for (title, expected_message) in [
        ("Persist me", "Map the project"),
        ("Standalone thread", "Keep this local"),
    ] {
        let persisted_thread = state["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|thread| thread["title"] == title)
            .unwrap();
        let thread_id = persisted_thread["id"].as_i64().unwrap();
        assert!(thread_id > 0);
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
    assert_eq!(applied_migrations, 3);
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
        control_token: "control".to_owned(),
        read_only_control_token: None,
        runtime: None,
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
        control_token: "control".to_owned(),
        read_only_control_token: None,
        runtime: None,
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
    for statement in [
        "DROP TABLE interactions",
        "DROP TABLE threads",
        "DROP TABLE projects",
        "CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,path TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
        "CREATE TABLE threads (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,harness_configuration_name TEXT NOT NULL DEFAULT 'codex-basic')",
        "CREATE TABLE interactions (id INTEGER PRIMARY KEY AUTOINCREMENT,thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,sequence INTEGER NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,graph_node_id INTEGER,completion_status TEXT NOT NULL DEFAULT 'not_started',harness_configuration_name TEXT,harness_configuration_digest TEXT,completion_output_json TEXT,completion_error TEXT)",
        "CREATE UNIQUE INDEX projects_path_partial ON projects(path) WHERE id > 0",
        "CREATE UNIQUE INDEX interactions_sequence_partial ON interactions(thread_id,sequence) WHERE id > 0",
    ] {
        sqlx::query(statement)
            .execute(&partial_index_pool)
            .await
            .unwrap();
    }
    partial_index_pool.close().await;
    let partial_index = RelayerAppServer::open(RelayerAppServerConfig {
        database_path: partial_index_database,
        web_directory: root.clone(),
        control_token: "control".to_owned(),
        read_only_control_token: None,
        runtime: None,
    })
    .await;
    let partial_index_error = match partial_index {
        Ok(_) => panic!("partial unique indexes were accepted"),
        Err(error) => error,
    };
    assert!(
        partial_index_error
            .to_string()
            .contains("missing its required unique index")
    );
    fs::remove_dir_all(root).unwrap();
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

async fn response_json(response: Response<Body>) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

async fn open_app(database: &Path, web_directory: &Path) -> Router {
    RelayerAppServer::open(RelayerAppServerConfig {
        database_path: database.to_owned(),
        web_directory: web_directory.to_owned(),
        control_token: "control".to_owned(),
        read_only_control_token: Some("review".to_owned()),
        runtime: None,
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
    RelayerAppServer::open(RelayerAppServerConfig {
        database_path: database.to_owned(),
        web_directory: web_directory.to_owned(),
        control_token: "control".to_owned(),
        read_only_control_token: Some("review".to_owned()),
        runtime: Some(RelayerRuntimeConfig {
            graph_url: graph_url.to_owned(),
            harness_url: harness_url.to_owned(),
            control_token: "runtime-control".to_owned(),
            harness_configurations: catalog.to_owned(),
            default_harness_configuration: "codex-basic".to_owned(),
            allow_harness_override: false,
            standalone_workspaces_directory: web_directory.join("workspaces"),
        }),
    })
    .await
    .unwrap()
    .router()
}

async fn serve_test_app(
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
