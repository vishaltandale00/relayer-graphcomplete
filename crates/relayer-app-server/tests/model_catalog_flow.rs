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
async fn model_catalog_families_defaults_and_selection_are_typed_and_durable() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-model-catalog-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;

    let snapshot = provider_snapshot(None);
    let renderer_cannot_publish = app
        .clone()
        .oneshot(cookie_request(
            "PUT",
            "/api/internal/provider-catalog",
            Some(snapshot.clone()),
        ))
        .await
        .unwrap();
    assert_eq!(renderer_cannot_publish.status(), StatusCode::UNAUTHORIZED);

    let published = app
        .clone()
        .oneshot(bearer_request(
            "PUT",
            "/api/internal/provider-catalog",
            Some(snapshot),
        ))
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
            .oneshot(cookie_request("GET", "/api/model-settings", None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(settings["defaults"]["harnessId"], "codex-basic");
    assert_eq!(settings["defaults"]["providerId"], "codex");
    assert_eq!(
        settings["providers"][0]["models"].as_array().unwrap().len(),
        6
    );
    assert_eq!(settings["families"].as_array().unwrap().len(), 1);
    assert_eq!(settings["families"][0]["kind"], "system");
    assert_eq!(
        settings["families"][0]["members"].as_array().unwrap().len(),
        5
    );
    let system_family_id = settings["families"][0]["id"].as_i64().unwrap();

    let custom = app
        .clone()
        .oneshot(cookie_request(
            "POST",
            "/api/model-families",
            Some(json!({
                "name": "Focused",
                "members": [
                    { "providerId": "codex", "modelId": "gpt-5.6-sol" },
                    { "providerId": "codex", "modelId": "gpt-5.6-terra" }
                ]
            })),
        ))
        .await
        .unwrap();
    assert_eq!(custom.status(), StatusCode::CREATED);
    let custom = response_json(custom).await;
    let custom_family_id = custom["id"].as_i64().unwrap();
    assert_eq!(custom["position"], 1);

    let duplicate_name = app
        .clone()
        .oneshot(cookie_request(
            "POST",
            "/api/model-families",
            Some(json!({
                "name": "focused",
                "members": [{ "providerId": "codex", "modelId": "gpt-5.6-sol" }]
            })),
        ))
        .await
        .unwrap();
    assert_eq!(duplicate_name.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        response_json(duplicate_name).await["code"],
        "model_family_name_duplicate"
    );

    let duplicate = app
        .clone()
        .oneshot(cookie_request(
            "POST",
            "/api/model-families",
            Some(json!({
                "name": "Duplicate",
                "members": [
                    { "providerId": "codex", "modelId": "gpt-5.6-sol" },
                    { "providerId": "codex", "modelId": "gpt-5.6-sol" }
                ]
            })),
        ))
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        response_json(duplicate).await["code"],
        "model_family_duplicate_model"
    );

    let too_large = app
        .clone()
        .oneshot(cookie_request(
            "POST",
            "/api/model-families",
            Some(json!({
                "name": "Too large",
                "members": (1..=6).map(|index| json!({
                    "providerId": "codex",
                    "modelId": format!("model-{index}")
                })).collect::<Vec<_>>()
            })),
        ))
        .await
        .unwrap();
    assert_eq!(too_large.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        response_json(too_large).await["code"],
        "model_family_too_large"
    );

    let system_edit = app
        .clone()
        .oneshot(cookie_request(
            "PUT",
            &format!("/api/model-families/{system_family_id}"),
            Some(json!({
                "name": "Changed",
                "enabled": true,
                "members": [{ "providerId": "codex", "modelId": "gpt-5.6-sol" }]
            })),
        ))
        .await
        .unwrap();
    assert_eq!(system_edit.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        response_json(system_edit).await["code"],
        "system_family_read_only"
    );

    let reordered = app
        .clone()
        .oneshot(cookie_request(
            "PUT",
            "/api/model-families/order",
            Some(json!({ "familyIds": [custom_family_id, system_family_id] })),
        ))
        .await
        .unwrap();
    assert_eq!(reordered.status(), StatusCode::NO_CONTENT);

    let valid = app
        .clone()
        .oneshot(cookie_request(
            "POST",
            "/api/model-selection/validate",
            Some(json!({
                "harnessId": "codex-basic",
                "familyId": custom_family_id,
                "providerId": "codex",
                "modelId": "gpt-5.6-sol"
            })),
        ))
        .await
        .unwrap();
    assert_eq!(valid.status(), StatusCode::OK);
    assert_eq!(response_json(valid).await["modelId"], "gpt-5.6-sol");

    let pool = sqlite_pool(&database).await;
    sqlx::query("UPDATE harness_provider_compatibility SET all_models=0 WHERE harness_configuration_name='codex-basic' AND provider_id='codex'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO harness_model_compatibility(harness_configuration_name,provider_id,model_id) VALUES ('codex-basic','codex','gpt-5.6-sol')")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let outside_harness_subset = app
        .clone()
        .oneshot(cookie_request(
            "POST",
            "/api/model-selection/validate",
            Some(json!({
                "harnessId": "codex-basic",
                "familyId": system_family_id,
                "providerId": "codex",
                "modelId": "gpt-5.6-terra"
            })),
        ))
        .await
        .unwrap();
    assert_eq!(
        response_json(outside_harness_subset).await["code"],
        "harness_model_incompatible"
    );

    let defaults = app
        .clone()
        .oneshot(cookie_request(
            "PUT",
            "/api/model-settings/defaults",
            Some(json!({ "harnessId": "codex-basic", "providerId": "codex" })),
        ))
        .await
        .unwrap();
    assert_eq!(defaults.status(), StatusCode::OK);

    let unavailable_snapshot = provider_snapshot(Some("gpt-5.6-sol"));
    let republished = app
        .clone()
        .oneshot(bearer_request(
            "PUT",
            "/api/internal/provider-catalog",
            Some(unavailable_snapshot),
        ))
        .await
        .unwrap();
    assert_eq!(republished.status(), StatusCode::NO_CONTENT);
    let stale = app
        .clone()
        .oneshot(cookie_request(
            "POST",
            "/api/model-selection/validate",
            Some(json!({
                "harnessId": "codex-basic",
                "familyId": custom_family_id,
                "providerId": "codex",
                "modelId": "gpt-5.6-sol"
            })),
        ))
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let stale = response_json(stale).await;
    assert_eq!(stale["code"], "model_unavailable");
    assert_eq!(stale["providerId"], "codex");
    assert_eq!(stale["modelId"], "gpt-5.6-sol");

    drop(app);
    let reopened = open_app(&database, &root).await;
    let persisted = response_json(
        reopened
            .oneshot(cookie_request("GET", "/api/model-settings", None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(persisted["families"][0]["id"], custom_family_id);
    let saved_model = persisted["providers"][0]["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["id"] == "gpt-5.6-sol")
        .unwrap();
    assert_eq!(saved_model["available"], false);
    assert_eq!(
        saved_model["unavailableReason"]["code"],
        "account_restricted"
    );

    fs::remove_dir_all(root).unwrap();
}

fn provider_snapshot(unavailable: Option<&str>) -> Value {
    let ids = [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-daybreak-blue-latest",
        "gpt-5.5",
        "gpt-5.4",
    ];
    json!({
        "providerId": "codex",
        "label": "Codex",
        "connected": true,
        "models": ids.iter().enumerate().map(|(order, id)| {
            let is_unavailable = unavailable == Some(*id);
            json!({
                "id": id,
                "label": id,
                "order": order,
                "visible": true,
                "available": !is_unavailable,
                "unavailableReason": is_unavailable.then(|| json!({
                    "code": "account_restricted",
                    "message": "This model is unavailable for the connected account."
                })),
                "providerDefault": order == 0,
                "metadata": { "executionModel": id }
            })
        }).collect::<Vec<_>>(),
        "systemFamily": {
            "key": "codex",
            "name": "Codex",
            "modelIds": ids[..5]
        }
    })
}

async fn open_app(database: &Path, web_directory: &Path) -> Router {
    RelayerAppServer::open(RelayerAppServerConfig {
        database_path: database.to_owned(),
        web_directory: web_directory.to_owned(),
        permission_catalog: Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../permissions/desktop.json"),
        control_token: "control".to_owned(),
        read_only_control_token: None,
        runtime: None,
    })
    .await
    .unwrap()
    .router()
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

fn cookie_request(method: &str, uri: &str, body: Option<Value>) -> Request<Body> {
    request(
        method,
        uri,
        body,
        Some(("cookie", &format!("{CONTROL_COOKIE}=control"))),
    )
}

fn bearer_request(method: &str, uri: &str, body: Option<Value>) -> Request<Body> {
    request(method, uri, body, Some(("authorization", "Bearer control")))
}

fn request(
    method: &str,
    uri: &str,
    body: Option<Value>,
    authority: Option<(&str, &str)>,
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some((name, value)) = authority {
        builder = builder.header(name, value);
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
