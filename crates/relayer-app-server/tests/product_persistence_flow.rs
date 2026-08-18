use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, Response, StatusCode},
};
use relayer_app_server::{CONTROL_COOKIE, RelayerAppServer, RelayerAppServerConfig};
use serde_json::{Value, json};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tower::ServiceExt;

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
    sqlx::query("UPDATE threads SET created_at='same', updated_at='same'")
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

    drop(app);
    let migration_pool = sqlite_pool(&database).await;
    let applied_migrations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = 1")
            .fetch_one(&migration_pool)
            .await
            .unwrap();
    assert_eq!(applied_migrations, 1);
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
    })
    .await;
    let error = match incompatible {
        Ok(_) => panic!("incompatible product schema was accepted"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("schema is incompatible"));
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
    })
    .await
    .unwrap()
    .router()
}

fn api_request(method: &str, uri: &str, body: Option<Value>, authenticated: bool) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if authenticated {
        builder = builder.header("cookie", format!("{CONTROL_COOKIE}=control"));
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
