use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, Response, StatusCode},
};
use relayer_app_server::{CONTROL_COOKIE, RelayerAppServer, RelayerAppServerConfig};
use serde_json::{Value, json};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::path::Path;
use tower::ServiceExt;

#[tokio::test]
async fn subscription_authority_refuses_family_change_between_validation_and_creation() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("product.sqlite3");
    let app = open_app(&database, directory.path()).await;
    configure_codex_policy(&database).await;
    let pool = sqlite_pool(&database).await;
    sqlx::query("INSERT INTO model_providers(id,label,connected,refreshed_at,adapter_id,access_contract,connection_generation,lifecycle_state) VALUES ('api','API',0,'1','openai-api','secret@1',1,'active')").execute(&pool).await.unwrap();
    pool.close().await;
    for provider in ["codex", "api"] {
        let mut snapshot = provider_snapshot_for(provider, provider, None);
        snapshot["adapterId"] = json!(if provider == "codex" {
            "codex-subscription"
        } else {
            "openai-api"
        });
        snapshot["accessContract"] = json!(if provider == "codex" {
            "managed-runtime@1"
        } else {
            "secret@1"
        });
        assert_eq!(
            app.clone()
                .oneshot(bearer_request(
                    "PUT",
                    "/api/internal/provider-catalog",
                    Some(snapshot)
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
    }
    let pool = sqlite_pool(&database).await;
    sqlx::query("UPDATE product_harnesses SET available=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL,model_rules_present=1,execution_access_contracts_json='[\"managed-runtime@1\",\"secret@1\"]' WHERE configuration_name='codex-basic'").execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM harness_model_rules WHERE harness_configuration_name='codex-basic'")
        .execute(&pool)
        .await
        .unwrap();
    let member = |provider| json!({ "providerId": provider, "modelId": "gpt-5.6-sol", "roles": [{ "name": "orchestrator" }] });
    let family = response_json(
        app.clone()
            .oneshot(cookie_request(
                "POST",
                "/api/model-families",
                Some(
                    json!({"name":"Authorized family","enabled":true,"members":[member("codex")]}),
                ),
            ))
            .await
            .unwrap(),
    )
    .await;
    let id = family["id"].as_i64().unwrap();
    let validated = response_json(
        app.clone()
            .oneshot(cookie_request(
                "POST",
                "/api/model-selection/validate",
                Some(json!({"harnessId":"codex-basic","familyId":id})),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(validated["providerId"], "codex");
    // Pause after credential/route validation; another control client edits through the real API.
    let changed = app
        .clone()
        .oneshot(cookie_request(
            "PUT",
            &format!("/api/model-families/{id}"),
            Some(json!({"enabled":true,"members":[member("api")]})),
        ))
        .await
        .unwrap();
    assert_eq!(changed.status(), StatusCode::OK);
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
        .fetch_one(&pool)
        .await
        .unwrap();
    let request = json!({"creationRequestId":"subscription-task", "initialMessage":"Authorized task", "harnessId":"codex-basic", "modelSelection":{"familyId":id},"requiredProviderAdapterId":"codex-subscription"});
    let refused = app
        .clone()
        .oneshot(cookie_request(
            "POST",
            "/api/threads",
            Some(request.clone()),
        ))
        .await
        .unwrap();
    let status = refused.status();
    let error = response_json(refused).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    assert_eq!(error["code"], "execution_provider_not_authorized");
    let threads: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(threads, before);
    assert_eq!(
        app.clone()
            .oneshot(cookie_request(
                "PUT",
                &format!("/api/model-families/{id}"),
                Some(json!({"enabled":true,"members":[member("codex")]}))
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let created = app
        .clone()
        .oneshot(cookie_request(
            "POST",
            "/api/threads",
            Some(request.clone()),
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let created = response_json(created).await;
    let replay = response_json(
        app.clone()
            .oneshot(cookie_request(
                "POST",
                "/api/threads",
                Some(request.clone()),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        replay["id"].as_i64().unwrap(),
        created["id"].as_i64().unwrap()
    );
    let mut unconstrained = request;
    unconstrained
        .as_object_mut()
        .unwrap()
        .remove("requiredProviderAdapterId");
    assert_eq!(
        app.clone()
            .oneshot(cookie_request("POST", "/api/threads", Some(unconstrained)))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let constraints: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM thread_execution_constraints")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(constraints, 1);
    pool.close().await;
}

#[tokio::test]
async fn managed_refresh_keeps_unavailable_orchestrator_and_family_only_requests_refuse() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("product.sqlite3");
    let app = open_app(&database, directory.path()).await;
    configure_codex_policy(&database).await;
    let publish = app
        .clone()
        .oneshot(bearer_request(
            "PUT",
            "/api/internal/provider-catalog",
            Some(provider_snapshot(None)),
        ))
        .await
        .unwrap();
    assert_eq!(publish.status(), StatusCode::NO_CONTENT);
    let pool = sqlite_pool(&database).await;
    sqlx::query("UPDATE product_harnesses SET available=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL WHERE configuration_name='codex-basic'").execute(&pool).await.unwrap();
    pool.close().await;
    let before = response_json(
        app.clone()
            .oneshot(cookie_request("GET", "/api/model-settings", None))
            .await
            .unwrap(),
    )
    .await;
    let family = before["families"][0]["id"].as_i64().unwrap();
    let revision = before["families"][0]["revision"].as_i64().unwrap();
    let publish = app
        .clone()
        .oneshot(bearer_request(
            "PUT",
            "/api/internal/provider-catalog",
            Some(provider_snapshot(Some("gpt-5.6-sol"))),
        ))
        .await
        .unwrap();
    assert_eq!(publish.status(), StatusCode::NO_CONTENT);
    let after = response_json(
        app.clone()
            .oneshot(cookie_request("GET", "/api/model-settings", None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(after["families"][0]["id"], family);
    assert_eq!(after["families"][0]["revision"], revision);
    assert_eq!(
        after["families"][0]["members"][0]["roles"],
        json!([{"name":"orchestrator"}])
    );
    assert_eq!(after["families"][0]["members"][1]["roles"], json!([]));
    for model_fields in [
        json!({}),
        json!({"providerId":"codex","modelId":"gpt-5.6-terra"}),
    ] {
        let mut request = json!({"harnessId":"codex-basic","familyId":family});
        request
            .as_object_mut()
            .unwrap()
            .extend(model_fields.as_object().unwrap().clone());
        let refused = app
            .clone()
            .oneshot(cookie_request(
                "POST",
                "/api/model-selection/validate",
                Some(request),
            ))
            .await
            .unwrap();
        assert_eq!(refused.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let refused = response_json(refused).await;
        assert_eq!(refused["code"], "model_unavailable");
        assert!(refused["error"].as_str().unwrap().contains("orchestrator"));
    }
}

#[tokio::test]
async fn default_selection_uses_family_and_member_order_not_harness_preference() {
    let temporary = tempfile::Builder::new()
        .prefix("relayer-model-order-")
        .tempdir()
        .unwrap();
    let root = temporary.path().to_path_buf();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    configure_codex_policy(&database).await;

    let published = app
        .clone()
        .oneshot(bearer_request(
            "PUT",
            "/api/internal/provider-catalog",
            Some(provider_snapshot(None)),
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
    let preferred_update = sqlx::query("UPDATE harness_provider_compatibility SET preferred_model_id='gpt-5.6-luna' WHERE harness_configuration_name='codex-basic' AND provider_id='codex'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(preferred_update.rows_affected(), 1);
    pool.close().await;

    let settings = response_json(
        app.clone()
            .oneshot(cookie_request("GET", "/api/model-settings", None))
            .await
            .unwrap(),
    )
    .await;
    let system_family_id = settings["families"][0]["id"].as_i64().unwrap();
    assert_eq!(
        settings["harnesses"][0]["modelCompatibility"][0]["preferredModelId"],
        "gpt-5.6-luna"
    );
    assert_eq!(
        settings["families"][0]["members"][2]["modelId"],
        "gpt-5.6-luna"
    );
    let first_family = response_json(
        app.clone()
            .oneshot(cookie_request(
                "POST",
                "/api/model-families",
                Some(json!({
                    "name": "First family",
                    "members": [
                        { "providerId": "codex", "modelId": "gpt-5.6-sol", "roles": [{ "name": "orchestrator" }] },
                        { "providerId": "codex", "modelId": "gpt-5.6-terra" }
                    ]
                })),
            ))
            .await
            .unwrap(),
    )
    .await;
    let first_family_id = first_family["id"].as_i64().unwrap();
    let reordered = app
        .clone()
        .oneshot(cookie_request(
            "PUT",
            "/api/model-families/order",
            Some(json!({ "familyIds": [first_family_id, system_family_id] })),
        ))
        .await
        .unwrap();
    assert_eq!(reordered.status(), StatusCode::NO_CONTENT);
    let defaults_updated = app
        .clone()
        .oneshot(cookie_request(
            "PUT",
            "/api/model-settings/defaults",
            Some(json!({
                "harnessId": "codex-basic",
                "providerId": "codex",
                "familyId": first_family_id
            })),
        ))
        .await
        .unwrap();
    assert_eq!(defaults_updated.status(), StatusCode::OK);

    let default = response_json(
        app.clone()
            .oneshot(cookie_request(
                "GET",
                "/api/model-selection/default?harnessId=codex-basic",
                None,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(default["familyId"], first_family_id);
    assert_eq!(default["providerId"], "codex");
    assert_eq!(default["modelId"], "gpt-5.6-sol");
}

#[tokio::test]
async fn model_catalog_families_defaults_and_selection_are_typed_and_durable() {
    let temporary = tempfile::Builder::new()
        .prefix("relayer-model-catalog-")
        .tempdir()
        .unwrap();
    let root = temporary.path().to_path_buf();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    configure_codex_policy(&database).await;

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
    assert_eq!(settings["providers"][0]["adapterId"], "codex-subscription");
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
                    { "providerId": "codex", "modelId": "gpt-5.6-sol", "roles": [{ "name": "orchestrator" }] },
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
                "members": [{ "providerId": "codex", "modelId": "gpt-5.6-sol", "roles": [{ "name": "orchestrator" }] }]
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
                    { "providerId": "codex", "modelId": "gpt-5.6-sol", "roles": [{ "name": "orchestrator" }] },
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
                "members": [{ "providerId": "codex", "modelId": "gpt-5.6-sol", "roles": [{ "name": "orchestrator" }] }]
            })),
        ))
        .await
        .unwrap();
    assert_eq!(system_edit.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        response_json(system_edit).await["code"],
        "system_family_read_only"
    );

    let incomplete_order = app
        .clone()
        .oneshot(cookie_request(
            "PUT",
            "/api/model-families/order",
            Some(json!({ "familyIds": [custom_family_id] })),
        ))
        .await
        .unwrap();
    assert_eq!(incomplete_order.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        response_json(incomplete_order).await["code"],
        "model_family_order_invalid"
    );
    let settings_after_invalid_order = app
        .clone()
        .oneshot(cookie_request("GET", "/api/model-settings", None))
        .await
        .unwrap();
    let settings_after_invalid_order = response_json(settings_after_invalid_order).await;
    let positions = settings_after_invalid_order["families"]
        .as_array()
        .unwrap()
        .iter()
        .map(|family| family["position"].as_i64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(positions, vec![0, 1]);

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
    assert_eq!(outside_harness_subset.status(), StatusCode::OK);
    assert_eq!(
        response_json(outside_harness_subset).await["modelId"],
        "gpt-5.6-sol"
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
}

// PROV-008: the default provider and family are one pair, so a catalog refresh has nothing to
// revert. Before the pairing, the Settings provider selector saved only the provider, and the
// next refresh of the default family's provider moved the default provider back to it.
#[tokio::test]
async fn catalog_refresh_keeps_the_chosen_default_provider_and_its_managed_family() {
    let temporary = tempfile::Builder::new()
        .prefix("relayer-default-provider-")
        .tempdir()
        .unwrap();
    let root = temporary.path().to_path_buf();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    configure_codex_policy(&database).await;
    let publish = |snapshot: Value| {
        let app = app.clone();
        async move {
            let response = app
                .oneshot(bearer_request(
                    "PUT",
                    "/api/internal/provider-catalog",
                    Some(snapshot),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
        }
    };
    let settings = || {
        let app = app.clone();
        async move {
            response_json(
                app.oneshot(cookie_request("GET", "/api/model-settings", None))
                    .await
                    .unwrap(),
            )
            .await
        }
    };
    let save_defaults = |body: Value| {
        let app = app.clone();
        async move {
            app.oneshot(cookie_request(
                "PUT",
                "/api/model-settings/defaults",
                Some(body),
            ))
            .await
            .unwrap()
        }
    };
    let managed_family = |settings: &Value, provider: &str| {
        settings["families"]
            .as_array()
            .unwrap()
            .iter()
            .find(|family| {
                family["kind"] == "system"
                    && family["members"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|member| member["providerId"] == provider)
            })
            .map(|family| family["id"].as_i64().unwrap())
    };

    // P = codex publishes first, so its managed family becomes the default.
    publish(provider_snapshot(None)).await;
    // Q = work, a second Codex account the default harness can run, then its first catalog.
    // "bare" is connected but has published no catalog, so it has no managed family.
    let pool = sqlite_pool(&database).await;
    for statement in [
        "UPDATE product_harnesses SET available=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL WHERE configuration_name='codex-basic'",
        "INSERT INTO model_providers(id,label,connected,refreshed_at,adapter_id,access_contract,lifecycle_state) VALUES('work','Work',1,'1','codex-subscription','managed-runtime@1','active')",
        "INSERT INTO model_providers(id,label,connected,refreshed_at,adapter_id,access_contract,lifecycle_state) VALUES('bare','Bare',1,'1','codex-subscription','managed-runtime@1','active')",
        "INSERT INTO harness_provider_compatibility(harness_configuration_name,provider_id,all_models) VALUES ('codex-basic','work',1)",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    pool.close().await;
    publish(provider_snapshot_for("work", "Work", None)).await;
    let before = settings().await;
    let codex_family = managed_family(&before, "codex").unwrap();
    let work_family = managed_family(&before, "work").unwrap();
    assert_eq!(before["defaults"]["providerId"], "codex");
    assert_eq!(before["defaults"]["familyId"], codex_family);
    // Settings learns which harnesses the server may move the default to. Without a runtime,
    // no harness has a permission profile.
    assert!(
        before["harnesses"]
            .as_array()
            .unwrap()
            .iter()
            .all(|harness| harness["permissionAvailable"] == false)
    );

    // The Settings selector saves only the provider. Its managed family comes with it.
    let chosen = save_defaults(json!({ "providerId": "work" })).await;
    assert_eq!(chosen.status(), StatusCode::OK);
    let chosen = response_json(chosen).await;
    assert_eq!(chosen["providerId"], "work");
    assert_eq!(chosen["familyId"], work_family);

    // Every later refresh of either provider leaves the chosen pair alone.
    publish(provider_snapshot(None)).await;
    publish(provider_snapshot_for("work", "Work", None)).await;
    let after_refresh = settings().await;
    assert_eq!(after_refresh["defaults"]["providerId"], "work");
    assert_eq!(after_refresh["defaults"]["familyId"], work_family);

    // A provider without a managed family cannot become the default; nothing changes.
    let refused = save_defaults(json!({ "providerId": "bare" })).await;
    assert_eq!(refused.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        response_json(refused).await["code"],
        "default_provider_family_unavailable"
    );
    // A managed family cannot be paired with another provider.
    let mismatched = save_defaults(json!({ "providerId": "codex", "familyId": work_family })).await;
    assert_eq!(mismatched.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        response_json(mismatched).await["code"],
        "default_family_provider_mismatch"
    );
    let unchanged = settings().await;
    assert_eq!(unchanged["defaults"]["providerId"], "work");
    assert_eq!(unchanged["defaults"]["familyId"], work_family);

    // Choosing a managed family alone brings its provider, which a refresh then keeps.
    let family_only = save_defaults(json!({ "familyId": codex_family })).await;
    assert_eq!(family_only.status(), StatusCode::OK);
    publish(provider_snapshot_for("work", "Work", None)).await;
    let family_chosen = settings().await;
    assert_eq!(family_chosen["defaults"]["providerId"], "codex");
    assert_eq!(family_chosen["defaults"]["familyId"], codex_family);
}

// PROV-002: a catalog result is tied to the connection generation it started with. Sign-out and
// a completed reconnect advance the generation in their own publish transaction, and the store
// rejects a result from an older generation inside the write transaction, so it changes nothing.
#[tokio::test]
async fn a_catalog_result_from_a_superseded_connection_generation_has_no_effect() {
    let temporary = tempfile::Builder::new()
        .prefix("relayer-connection-generation-")
        .tempdir()
        .unwrap();
    let root = temporary.path().to_path_buf();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    configure_codex_policy(&database).await;
    let publish = |snapshot: Value| {
        let app = app.clone();
        async move {
            app.oneshot(bearer_request(
                "PUT",
                "/api/internal/provider-catalog",
                Some(snapshot),
            ))
            .await
            .unwrap()
        }
    };
    let stamped = |mut snapshot: Value, generation: i64, event: Option<&str>| {
        snapshot["connectionGeneration"] = json!(generation);
        if let Some(event) = event {
            snapshot["connectionEvent"] = json!(event);
        }
        snapshot
    };
    let signed_out = || {
        json!({
            "providerId": "codex",
            "label": "Codex",
            "connected": false,
            "models": [],
        })
    };
    let zero_eligible = || {
        let mut snapshot = provider_snapshot(None);
        for model in snapshot["models"].as_array_mut().unwrap() {
            model["providerDefault"] = json!(false);
        }
        snapshot.as_object_mut().unwrap().remove("systemFamily");
        snapshot
    };
    let state = || {
        let database = database.clone();
        async move {
            let pool = sqlite_pool(&database).await;
            let provider: (bool, i64) = sqlx::query_as(
                "SELECT connected,connection_generation FROM model_providers WHERE id='codex'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let family: String = sqlx::query_scalar(
                "SELECT lifecycle_state FROM model_families WHERE kind='system' AND managed_provider_id='codex'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            pool.close().await;
            (provider.0, provider.1, family)
        }
    };
    let assert_superseded = |response: Response<Body>| async move {
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            response_json(response).await["code"],
            "provider_connection_superseded"
        );
    };

    // Every publish names its generation; one that does not is refused.
    let mut unstamped = provider_snapshot(None);
    unstamped
        .as_object_mut()
        .unwrap()
        .remove("connectionGeneration");
    assert_eq!(
        publish(unstamped).await.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        publish(provider_snapshot(None)).await.status(),
        StatusCode::NO_CONTENT
    );
    let definitions = response_json(
        app.clone()
            .oneshot(bearer_request(
                "GET",
                "/api/internal/provider-definitions",
                None,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(definitions[0]["connectionGeneration"], 1);
    assert_eq!(state().await, (true, 1, "active".to_owned()));

    // Sign-out commits the disconnected state and generation 2 together.
    assert_eq!(
        publish(stamped(signed_out(), 1, Some("signed-out")))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(state().await, (false, 2, "active".to_owned()));
    // A refresh that discovered the old account before the sign-out cannot reconnect it.
    assert_superseded(publish(stamped(provider_snapshot(None), 1, None)).await).await;
    assert_eq!(state().await, (false, 2, "active".to_owned()));

    // CR-V1: a refresh discovers "disconnected" under generation 2 and stalls. The reconnect
    // completes and publishes connected; the stalled result then changes nothing.
    assert_eq!(
        publish(stamped(provider_snapshot(None), 2, Some("reconnected")))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(state().await, (true, 3, "active".to_owned()));
    assert_superseded(publish(stamped(signed_out(), 2, None)).await).await;
    assert_eq!(state().await, (true, 3, "active".to_owned()));

    // CR-V3: a refresh discovers eligible models under generation 3. A reconnect to an account
    // with zero eligible models tombstones the managed family. The older eligible result cannot
    // repopulate it.
    assert_eq!(
        publish(stamped(zero_eligible(), 3, Some("reconnected")))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(state().await, (true, 4, "tombstoned".to_owned()));
    assert_superseded(publish(stamped(provider_snapshot(None), 3, None)).await).await;
    assert_eq!(state().await, (true, 4, "tombstoned".to_owned()));
    // A refresh started under the current generation still repairs the family.
    assert_eq!(
        publish(stamped(provider_snapshot(None), 4, None))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(state().await, (true, 4, "active".to_owned()));

    // A lifecycle event must match what it commits.
    assert_eq!(
        publish(stamped(provider_snapshot(None), 4, Some("signed-out")))
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(state().await, (true, 4, "active".to_owned()));
}

// PROV-008 (Q15): a refresh reporting provider_no_eligible_execution_models tombstones the
// provider's managed family. When that family is the default, it stays selected and Send is
// refused with the provider's recovery reason, not as a family the user disabled or removed.
// A later eligible refresh restores it; after a policy upgrade the successor family restores.
#[tokio::test]
async fn a_default_family_without_eligible_models_needs_model_setup_until_a_refresh_restores_it() {
    const RECOVERY: &str = "provider_no_eligible_execution_models";
    let temporary = tempfile::Builder::new()
        .prefix("relayer-default-family-recovery-")
        .tempdir()
        .unwrap();
    let root = temporary.path().to_path_buf();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    configure_codex_policy(&database).await;
    let send = |method: &str, uri: &str, body: Option<Value>| {
        let request = if uri.starts_with("/api/internal/") {
            bearer_request(method, uri, body)
        } else {
            cookie_request(method, uri, body)
        };
        let app = app.clone();
        async move { app.oneshot(request).await.unwrap() }
    };
    let publish = |snapshot: Value| {
        let response = send("PUT", "/api/internal/provider-catalog", Some(snapshot));
        async move {
            assert_eq!(response.await.status(), StatusCode::NO_CONTENT);
        }
    };
    let settings = || {
        let response = send("GET", "/api/model-settings", None);
        async move { response_json(response.await).await }
    };
    let validate = |family_id: i64, model_id: &str| {
        send(
            "POST",
            "/api/model-selection/validate",
            Some(json!({
                "harnessId": "codex-basic",
                "familyId": family_id,
                "providerId": "codex",
                "modelId": model_id,
            })),
        )
    };
    let assert_needs_model_setup = |response: Response<Body>| async move {
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = response_json(response).await;
        assert_eq!(body["code"], RECOVERY, "{body}");
        assert!(
            body["error"].as_str().unwrap().contains("Refresh"),
            "{body}"
        );
    };
    let zero_eligible = || {
        let mut snapshot = provider_snapshot(None);
        for model in snapshot["models"].as_array_mut().unwrap() {
            model["providerDefault"] = json!(false);
        }
        snapshot.as_object_mut().unwrap().remove("systemFamily");
        snapshot
    };

    publish(provider_snapshot(None)).await;
    // A second provider with its own managed family, which must not take over the default.
    let pool = sqlite_pool(&database).await;
    for statement in [
        "UPDATE product_harnesses SET available=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL WHERE configuration_name='codex-basic'",
        "INSERT INTO model_providers(id,label,connected,refreshed_at,adapter_id,access_contract,lifecycle_state) VALUES('work','Work',1,'1','codex-subscription','managed-runtime@1','active')",
        "INSERT INTO harness_provider_compatibility(harness_configuration_name,provider_id,all_models) VALUES ('codex-basic','work',1)",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    pool.close().await;
    publish(provider_snapshot_for("work", "Work", None)).await;
    let before = settings().await;
    let default_family = before["defaults"]["familyId"].as_i64().unwrap();
    assert_eq!(before["defaults"]["providerId"], "codex");
    assert_eq!(before["defaultFamilyRecovery"], Value::Null);
    assert_eq!(
        validate(default_family, "gpt-5.6-sol").await.status(),
        StatusCode::OK
    );
    // A family the user disabled keeps its own code.
    let custom = response_json(
        send(
            "POST",
            "/api/model-families",
            Some(json!({
                "name": "hidden",
                "enabled": false,
                "members": [{ "providerId": "codex", "modelId": "gpt-5.6-sol", "roles": [{ "name": "orchestrator" }] }],
            })),
        )
        .await,
    )
    .await;
    let hidden_family = custom["id"].as_i64().unwrap();

    // The refresh reports no eligible models. The default stays selected, and Settings still
    // names it, in its recovery state.
    publish(zero_eligible()).await;
    // Another provider's refresh during recovery never takes over the default either.
    publish(provider_snapshot_for("work", "Work", None)).await;
    let recovering = settings().await;
    assert_eq!(recovering["defaults"]["familyId"], default_family);
    assert_eq!(recovering["defaults"]["providerId"], "codex");
    assert_eq!(
        recovering["defaultFamilyRecovery"]["familyId"],
        default_family
    );
    assert_eq!(recovering["defaultFamilyRecovery"]["providerId"], "codex");
    assert_eq!(
        recovering["defaultFamilyRecovery"]["familyName"],
        before["families"]
            .as_array()
            .unwrap()
            .iter()
            .find(|family| family["id"] == default_family)
            .unwrap()["name"]
    );
    assert_eq!(
        recovering["defaultFamilyRecovery"]["reason"]["code"],
        RECOVERY
    );
    // The renderer tests read this exact response as their fixture.
    assert_renderer_fixture("model-settings-default-family-recovery.json", &recovering);

    // Validate and thread creation both give the provider's recovery reason.
    assert_needs_model_setup(validate(default_family, "gpt-5.6-sol").await).await;
    assert_needs_model_setup(
        send(
            "POST",
            "/api/threads",
            Some(json!({
                "initialMessage": "Blocked until the models are set up",
                "harnessId": "codex-basic",
                "modelSelection": {
                    "familyId": default_family,
                    "providerId": "codex",
                    "modelId": "gpt-5.6-sol",
                },
            })),
        )
        .await,
    )
    .await;
    // A harness-only default save is refused with the same reason and moves nothing.
    assert_needs_model_setup(
        send(
            "PUT",
            "/api/model-settings/defaults",
            Some(json!({ "harnessId": "codex-basic" })),
        )
        .await,
    )
    .await;
    let unchanged = settings().await;
    assert_eq!(unchanged["defaults"], recovering["defaults"]);
    let disabled = response_json(validate(hidden_family, "gpt-5.6-sol").await).await;
    assert_eq!(disabled["code"], "model_family_disabled");

    // A disconnect after the zero-eligible refresh keeps the family selected and in recovery.
    // The recovery now follows the provider: it is not connected, so Refresh models cannot help.
    publish(json!({
        "providerId": "codex",
        "label": "Codex",
        "connected": false,
        "connectionGeneration": 1,
        "unavailableReason": {
            "code": "provider_unavailable",
            "message": "The provider rejected the saved credentials.",
        },
        "models": [],
    }))
    .await;
    let disconnected = settings().await;
    assert_eq!(disconnected["defaults"], recovering["defaults"]);
    assert_eq!(
        disconnected["defaultFamilyRecovery"]["familyId"],
        default_family
    );
    assert_eq!(
        disconnected["defaultFamilyRecovery"]["reason"],
        json!({
            "code": "provider_unavailable",
            "message": "The provider rejected the saved credentials.",
        })
    );
    assert_eq!(
        disconnected["familiesNeedingModelSetup"],
        json!([disconnected["defaultFamilyRecovery"]])
    );
    assert_renderer_fixture(
        "model-settings-default-family-disconnected.json",
        &disconnected,
    );
    let refused = validate(default_family, "gpt-5.6-sol").await;
    assert_eq!(refused.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        response_json(refused).await["code"],
        "provider_disconnected"
    );
    // Reconnecting to the same empty catalog returns to Needs model setup.
    publish(zero_eligible()).await;
    assert_eq!(
        settings().await["defaultFamilyRecovery"],
        recovering["defaultFamilyRecovery"]
    );

    // A later eligible refresh restores the same family.
    publish(provider_snapshot(None)).await;
    let restored = settings().await;
    assert_eq!(restored["defaults"]["familyId"], default_family);
    assert_eq!(restored["defaultFamilyRecovery"], Value::Null);
    assert_eq!(
        validate(default_family, "gpt-5.6-sol").await.status(),
        StatusCode::OK
    );

    // After a policy upgrade, the successor managed family is what restores.
    publish(zero_eligible()).await;
    let pool = sqlite_pool(&database).await;
    sqlx::query("UPDATE product_harnesses SET family_policy_version=2 WHERE configuration_name='codex-basic'")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    publish(provider_snapshot(None)).await;
    let upgraded = settings().await;
    let successor = upgraded["defaults"]["familyId"].as_i64().unwrap();
    assert_ne!(successor, default_family);
    assert_eq!(upgraded["defaults"]["providerId"], "codex");
    assert_eq!(upgraded["defaultFamilyRecovery"], Value::Null);
    let first_member = upgraded["families"]
        .as_array()
        .unwrap()
        .iter()
        .find(|family| family["id"] == successor)
        .unwrap()["members"][0]["modelId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        validate(successor, &first_member).await.status(),
        StatusCode::OK
    );

    // The user may explicitly choose another default provider during recovery. The family that
    // needs model setup is still reported, and a thread still selecting it gets the same code.
    // Policy version 2 names its models, so this refresh hides them all to leave none eligible.
    let mut none_visible = zero_eligible();
    for model in none_visible["models"].as_array_mut().unwrap() {
        model["visible"] = json!(false);
    }
    publish(none_visible).await;
    let moved = response_json(
        send(
            "PUT",
            "/api/model-settings/defaults",
            Some(json!({ "providerId": "work" })),
        )
        .await,
    )
    .await;
    assert_eq!(moved["providerId"], "work");
    let chosen = settings().await;
    assert_eq!(chosen["defaultFamilyRecovery"], Value::Null);
    assert_eq!(
        chosen["familiesNeedingModelSetup"]
            .as_array()
            .unwrap()
            .iter()
            .map(|family| family["familyId"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![successor]
    );
    assert_needs_model_setup(validate(successor, &first_member).await).await;
}

// A managed family the user disabled stays disabled. A zero-eligible refresh tombstones it
// without taking over that choice: it is not in recovery, keeps model_family_disabled, and a
// later eligible refresh restores it still disabled.
#[tokio::test]
async fn a_disabled_managed_family_stays_disabled_through_a_zero_eligible_refresh() {
    let temporary = tempfile::Builder::new()
        .prefix("relayer-disabled-managed-family-")
        .tempdir()
        .unwrap();
    let root = temporary.path().to_path_buf();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    configure_codex_policy(&database).await;
    let send = |method: &str, uri: &str, body: Option<Value>| {
        let request = if uri.starts_with("/api/internal/") {
            bearer_request(method, uri, body)
        } else {
            cookie_request(method, uri, body)
        };
        let app = app.clone();
        async move { app.oneshot(request).await.unwrap() }
    };
    let publish = |snapshot: Value| {
        let response = send("PUT", "/api/internal/provider-catalog", Some(snapshot));
        async move {
            assert_eq!(response.await.status(), StatusCode::NO_CONTENT);
        }
    };
    let settings = || {
        let response = send("GET", "/api/model-settings", None);
        async move { response_json(response.await).await }
    };

    // Codex is the default. Work is a second provider whose managed family the user disables.
    publish(provider_snapshot(None)).await;
    let pool = sqlite_pool(&database).await;
    for statement in [
        "UPDATE product_harnesses SET available=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL WHERE configuration_name='codex-basic'",
        "INSERT INTO model_providers(id,label,connected,refreshed_at,adapter_id,access_contract,lifecycle_state) VALUES('work','Work',1,'1','codex-subscription','managed-runtime@1','active')",
        "INSERT INTO harness_provider_compatibility(harness_configuration_name,provider_id,all_models) VALUES ('codex-basic','work',1)",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    pool.close().await;
    publish(provider_snapshot_for("work", "Work", None)).await;
    let work_family = settings().await["families"]
        .as_array()
        .unwrap()
        .iter()
        .find(|family| family["managedPolicy"]["providerId"] == "work")
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let disabled = send(
        "PUT",
        &format!("/api/model-families/{work_family}"),
        Some(json!({ "enabled": false })),
    )
    .await;
    assert_eq!(disabled.status(), StatusCode::OK);
    let validate = || {
        let response = send(
            "POST",
            "/api/model-selection/validate",
            Some(json!({
                "harnessId": "codex-basic",
                "familyId": work_family,
                "providerId": "work",
                "modelId": "gpt-5.6-sol",
            })),
        );
        async move { response_json(response.await).await["code"].clone() }
    };
    assert_eq!(validate().await, "model_family_disabled");

    let mut zero_eligible = provider_snapshot_for("work", "Work", None);
    for model in zero_eligible["models"].as_array_mut().unwrap() {
        model["providerDefault"] = json!(false);
    }
    zero_eligible
        .as_object_mut()
        .unwrap()
        .remove("systemFamily");
    publish(zero_eligible).await;
    // The refresh did tombstone Work's family; only the user's disable keeps it out of recovery.
    let pool = sqlite_pool(&database).await;
    let row: (String, bool, Option<String>) = sqlx::query_as(
        "SELECT lifecycle_state,enabled,tombstone_cause FROM model_families WHERE id=?1",
    )
    .bind(work_family)
    .fetch_one(&pool)
    .await
    .unwrap();
    pool.close().await;
    assert_eq!(
        row,
        (
            "tombstoned".into(),
            false,
            Some("no_eligible_models".into())
        )
    );
    let tombstoned = settings().await;
    assert_eq!(tombstoned["familiesNeedingModelSetup"], json!([]));
    assert_eq!(validate().await, "model_family_disabled");

    publish(provider_snapshot_for("work", "Work", None)).await;
    let restored = settings().await;
    let family = restored["families"]
        .as_array()
        .unwrap()
        .iter()
        .find(|family| family["id"] == work_family)
        .unwrap();
    assert_eq!(family["enabled"], false);
    assert_eq!(validate().await, "model_family_disabled");

    // A deleted custom family is removed. Validate now gives the code execution already gave;
    // before PROV-008 it said the family was disabled.
    let custom = response_json(
        send(
            "POST",
            "/api/model-families",
            Some(json!({
                "name": "short-lived",
                "members": [{ "providerId": "codex", "modelId": "gpt-5.6-sol", "roles": [{ "name": "orchestrator" }] }],
            })),
        )
        .await,
    )
    .await["id"]
        .as_i64()
        .unwrap();
    assert_eq!(
        send("DELETE", &format!("/api/model-families/{custom}"), None)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let deleted = send(
        "POST",
        "/api/model-selection/validate",
        Some(json!({
            "harnessId": "codex-basic",
            "familyId": custom,
            "providerId": "codex",
            "modelId": "gpt-5.6-sol",
        })),
    )
    .await;
    assert_eq!(response_json(deleted).await["code"], "model_family_removed");
}

// PROV-008: only the family the latest zero-eligible refresh kept is in recovery, whatever its id.
// A policy upgrade replaces family A with B, B is kept by a zero-eligible refresh, then the policy
// reverts and A becomes the default again. B is superseded and never shows as in recovery; A is
// the family a later zero-eligible refresh keeps.
#[tokio::test]
async fn after_a_policy_revert_the_restored_family_is_the_one_in_recovery() {
    const RECOVERY: &str = "provider_no_eligible_execution_models";
    let temporary = tempfile::Builder::new()
        .prefix("relayer-policy-revert-recovery-")
        .tempdir()
        .unwrap();
    let root = temporary.path().to_path_buf();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    configure_codex_policy(&database).await;
    let send = |method: &str, uri: &str, body: Option<Value>| {
        let request = if uri.starts_with("/api/internal/") {
            bearer_request(method, uri, body)
        } else {
            cookie_request(method, uri, body)
        };
        let app = app.clone();
        async move { app.oneshot(request).await.unwrap() }
    };
    let publish = |snapshot: Value| {
        let response = send("PUT", "/api/internal/provider-catalog", Some(snapshot));
        async move {
            assert_eq!(response.await.status(), StatusCode::NO_CONTENT);
        }
    };
    let settings = || {
        let response = send("GET", "/api/model-settings", None);
        async move { response_json(response.await).await }
    };
    let policy_version = |version: i64| {
        let database = database.clone();
        async move {
            let pool = sqlite_pool(&database).await;
            sqlx::query("UPDATE product_harnesses SET family_policy_version=?1 WHERE configuration_name='codex-basic'")
                .bind(version)
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        }
    };
    // Hidden models are eligible under no Codex policy version.
    let none_eligible = || {
        let mut snapshot = provider_snapshot(None);
        for model in snapshot["models"].as_array_mut().unwrap() {
            model["providerDefault"] = json!(false);
            model["visible"] = json!(false);
        }
        snapshot.as_object_mut().unwrap().remove("systemFamily");
        snapshot
    };
    let disconnected = || {
        json!({
            "providerId": "codex",
            "label": "Codex",
            "connected": false,
            "connectionGeneration": 1,
            "models": [],
        })
    };

    publish(provider_snapshot(None)).await;
    let pool = sqlite_pool(&database).await;
    sqlx::query("UPDATE product_harnesses SET available=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL WHERE configuration_name='codex-basic'")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let family_a = settings().await["defaults"]["familyId"].as_i64().unwrap();
    policy_version(2).await;
    publish(provider_snapshot(None)).await;
    let family_b = settings().await["defaults"]["familyId"].as_i64().unwrap();
    assert!(family_b > family_a);
    publish(none_eligible()).await;
    assert_eq!(
        settings().await["defaultFamilyRecovery"]["familyId"],
        family_b
    );

    // The policy reverts. A is the default again, and B is superseded.
    policy_version(1).await;
    publish(provider_snapshot(None)).await;
    let reverted = settings().await;
    assert_eq!(reverted["defaults"]["familyId"], family_a);
    assert_eq!(reverted["familiesNeedingModelSetup"], json!([]));
    // A disconnect now leaves nothing in recovery: A is live and B is not kept.
    publish(disconnected()).await;
    assert_eq!(settings().await["familiesNeedingModelSetup"], json!([]));

    // A later zero-eligible refresh keeps A, the default, and only A.
    publish(none_eligible()).await;
    let recovering = settings().await;
    assert_eq!(recovering["defaultFamilyRecovery"]["familyId"], family_a);
    assert_eq!(
        recovering["familiesNeedingModelSetup"]
            .as_array()
            .unwrap()
            .iter()
            .map(|family| family["familyId"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![family_a]
    );
    let validate = |family_id: i64| {
        let response = send(
            "POST",
            "/api/model-selection/validate",
            Some(json!({
                "harnessId": "codex-basic",
                "familyId": family_id,
                "providerId": "codex",
                "modelId": "gpt-5.6-sol",
            })),
        );
        async move { response_json(response.await).await["code"].clone() }
    };
    assert_eq!(validate(family_a).await, RECOVERY);
    // B is superseded, not in recovery. Its models are hidden, so that is what validate reports.
    assert_ne!(validate(family_b).await, RECOVERY);
}

/// Compares a real /api/model-settings response with the fixture the renderer tests read.
/// RELAYER_WRITE_FIXTURES=1 regenerates it.
fn assert_renderer_fixture(name: &str, response: &Value) {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures")
        .join(name);
    if std::env::var_os("RELAYER_WRITE_FIXTURES").is_some() {
        std::fs::write(
            &fixture,
            serde_json::to_string_pretty(response).unwrap() + "\n",
        )
        .unwrap();
    }
    assert_eq!(
        &serde_json::from_str::<Value>(&std::fs::read_to_string(&fixture).unwrap()).unwrap(),
        response,
        "regenerate {} with RELAYER_WRITE_FIXTURES=1",
        fixture.display()
    );
}

/// #556: Desktop reads which routes an upgrade left due for their one automatic readiness
/// evaluation. The read is internal, and the evaluation's committed result clears it.
#[tokio::test]
async fn post_upgrade_readiness_due_is_internal_and_clears_when_a_result_commits() {
    let temporary = tempfile::Builder::new()
        .prefix("relayer-readiness-due-")
        .tempdir()
        .unwrap();
    let root = temporary.path().to_path_buf();
    let database = root.join("product.sqlite3");
    let app = open_app(&database, &root).await;
    let pool = sqlite_pool(&database).await;
    sqlx::query("UPDATE product_harnesses SET readiness_update_due=1,runtime_configuration_digest='sha256:upgraded' WHERE configuration_name='codex-basic'")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let due = |app: Router| async move {
        response_json(
            app.oneshot(bearer_request(
                "GET",
                "/api/internal/harness-readiness",
                None,
            ))
            .await
            .unwrap(),
        )
        .await
    };

    assert_eq!(
        app.clone()
            .oneshot(cookie_request(
                "GET",
                "/api/internal/harness-readiness",
                None
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        due(app.clone()).await,
        json!({ "updateDue": ["codex-basic"] })
    );
    assert_eq!(
        app.clone()
            .oneshot(bearer_request(
                "PUT",
                "/api/internal/harness-readiness",
                Some(json!([{
                    "harnessId": "codex-basic",
                    "configurationDigest": "sha256:upgraded",
                    "generation": 1,
                    "available": true,
                    "unavailableReason": null
                }])),
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(due(app).await, json!({ "updateDue": [] }));
}

fn provider_snapshot(unavailable: Option<&str>) -> Value {
    provider_snapshot_for("codex", "Codex", unavailable)
}

fn provider_snapshot_for(provider_id: &str, label: &str, unavailable: Option<&str>) -> Value {
    let ids = [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-daybreak-blue-latest",
        "gpt-5.5",
        "gpt-5.4",
    ];
    json!({
        "providerId": provider_id,
        "label": label,
        "connected": true,
        "connectionGeneration": 1,
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
                // The managed Codex family policy consumes normalized providerDefault
                // metadata (rather than the legacy systemFamily payload) and caps the
                // resulting ordered family at five members.
                "providerDefault": order < 5,
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
        allow_conversation_import: false,
        export_producer: relayer_app_server::conversation_export::ExportProducer {
            desktop_version: "test".into(),
            build_commit: "test".into(),
            platform: "test".into(),
            architecture: "test".into(),
        },
        completion_broker_origin: None,
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

async fn configure_codex_policy(database: &Path) {
    let pool = sqlite_pool(database).await;
    sqlx::query("UPDATE product_harnesses SET family_policy_id='codex-default-family',family_policy_version=1 WHERE configuration_name='codex-basic'")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
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
