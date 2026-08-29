use crate::storage::StorageError;
use sqlx::{SqlitePool, migrate::Migrator};

static MIGRATOR: Migrator = sqlx::migrate!("./src/storage/sqlite/migrations");

pub(super) async fn run(pool: &SqlitePool) -> Result<(), StorageError> {
    MIGRATOR.run(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{super::super::SqliteProductStore, MIGRATOR};
    use crate::product::{
        HarnessModelRule, HarnessModelRules, RuntimeProductHarness, UpdateHarnessModelRulesCommand,
    };
    use sqlx::{Executor, Row, migrate::Migrator, sqlite::SqlitePoolOptions};
    use std::{
        borrow::Cow,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[tokio::test]
    async fn schema_22_interactions_remain_unpinned_after_migration_and_reopen() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let url = format!("sqlite://{}", file.path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let pre_personal_presentation = Migrator {
            migrations: Cow::Owned(
                MIGRATOR
                    .iter()
                    .filter(|migration| migration.version <= 22)
                    .cloned()
                    .collect(),
            ),
            ..Migrator::DEFAULT
        };
        pre_personal_presentation.run(&pool).await.unwrap();
        sqlx::query("INSERT INTO threads(id,title,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES (1,'Legacy','1','1','codex-basic','auto')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status,permission_profile_id) VALUES (1,1,1,'Interrupted legacy turn','1','submitted','auto'),(2,1,2,'Stopped legacy turn','2','stopped','auto')")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let store = SqliteProductStore::open(file.path()).await.unwrap();
        for (key, node_id, layer_id) in [
            ("personal-presentation-v0", 501, 601),
            ("personal-presentation-v1", 502, 602),
        ] {
            store
                .publish_personal_presentation_version(
                    key,
                    node_id,
                    layer_id,
                    &serde_json::json!({"nodeId":node_id,"rootLayer":{"layer":{"id":layer_id}}}),
                    "3",
                )
                .await
                .unwrap();
        }
        for interaction_id in [1, 2] {
            assert!(
                store
                    .prepare_personal_presentation_pin(
                        crate::product::InteractionId::from_database(interaction_id),
                        None,
                        "4",
                    )
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        let new_thread = store
            .insert_thread_with_initial_interaction(crate::storage::NewThreadRecord {
                title: "Current",
                project_id: None,
                initial_message: "New turn",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: None,
                timestamp: "5",
            })
            .await
            .unwrap();
        let new_pin = store
            .prepare_personal_presentation_pin(new_thread.root_interaction_id, None, "5")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(new_pin.version_key, "personal-presentation-v1");
        store.pool.close().await;

        let reopened = SqliteProductStore::open(file.path()).await.unwrap();
        let legacy_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM interactions WHERE id IN (1,2) AND thread_id=1",
        )
        .fetch_one(&reopened.pool)
        .await
        .unwrap();
        assert_eq!(legacy_count, 2);
        assert!(
            reopened
                .prepare_personal_presentation_pin(
                    crate::product::InteractionId::from_database(1),
                    None,
                    "6",
                )
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            reopened
                .prepare_personal_presentation_pin(new_thread.root_interaction_id, None, "6")
                .await
                .unwrap()
                .unwrap(),
            new_pin
        );
    }

    #[tokio::test]
    async fn schema_23_personal_presentation_state_survives_input_migrations() {
        // Starts from the merged personal-presentation predecessor and upgrades
        // through the input migrations (24/25). Published versions, the active
        // policy, a per-thread version override, and already-pinned interactions
        // must all come through unchanged.
        let file = tempfile::NamedTempFile::new().unwrap();
        let url = format!("sqlite://{}", file.path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let pre_input_actions = Migrator {
            migrations: Cow::Owned(
                MIGRATOR
                    .iter()
                    .filter(|migration| migration.version <= 23)
                    .cloned()
                    .collect(),
            ),
            ..Migrator::DEFAULT
        };
        pre_input_actions.run(&pool).await.unwrap();

        sqlx::query("INSERT INTO threads(id,title,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES (1,'Pinned','1','1','codex-basic','auto'),(2,'Overridden','1','1','codex-basic','auto')")
            .execute(&pool)
            .await
            .unwrap();
        for (key, node_id, layer_id) in [
            ("personal-presentation-v0", 501, 601),
            ("personal-presentation-v1", 502, 602),
        ] {
            sqlx::query(
                "UPDATE personal_presentation_versions SET graph_node_id=?1,root_layer_id=?2,published_at='2' WHERE version_key=?3",
            )
            .bind(node_id)
            .bind(layer_id)
            .bind(key)
            .execute(&pool)
            .await
            .unwrap();
        }
        // Thread 2 pins the older version explicitly; thread 1 follows the policy.
        sqlx::query("UPDATE threads SET personal_presentation_version_key='personal-presentation-v0' WHERE id=2")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status,permission_profile_id) VALUES (1,1,1,'Policy turn','3','accepted','auto'),(2,2,1,'Overridden turn','3','accepted','auto')")
            .execute(&pool)
            .await
            .unwrap();
        let pinned_before: Vec<(i64, String, i64, i64)> = sqlx::query(
            "SELECT interaction_id,version_key,version_interaction_node_id,root_layer_id FROM interaction_personal_presentation_pins ORDER BY interaction_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| (row.get(0), row.get(1), row.get(2), row.get(3)))
        .collect();
        assert_eq!(
            pinned_before,
            vec![
                (1, "personal-presentation-v1".to_owned(), 502, 602),
                (2, "personal-presentation-v0".to_owned(), 501, 601),
            ]
        );
        pool.close().await;

        // Opening the store runs migrations 24 and 25.
        let store = SqliteProductStore::open(file.path()).await.unwrap();
        let version: i64 =
            sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success=1")
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(version, 25);

        let pinned_after: Vec<(i64, String, i64, i64)> = sqlx::query(
            "SELECT interaction_id,version_key,version_interaction_node_id,root_layer_id FROM interaction_personal_presentation_pins ORDER BY interaction_id",
        )
        .fetch_all(&store.pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| (row.get(0), row.get(1), row.get(2), row.get(3)))
        .collect();
        assert_eq!(pinned_after, pinned_before);

        let active: String = sqlx::query_scalar(
            "SELECT active_version_key FROM personal_presentation_policy WHERE singleton=1",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(active, "personal-presentation-v1");
        let override_key: Option<String> =
            sqlx::query_scalar("SELECT personal_presentation_version_key FROM threads WHERE id=2")
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(override_key.as_deref(), Some("personal-presentation-v0"));

        // Existing pins are still readable, and the per-thread override still wins
        // for a turn created after the upgrade.
        assert_eq!(
            store
                .prepare_personal_presentation_pin(
                    crate::product::InteractionId::from_database(1),
                    None,
                    "4",
                )
                .await
                .unwrap()
                .unwrap()
                .version_key,
            "personal-presentation-v1"
        );
        let upgraded_thread_turn = store
            .insert_thread_with_initial_interaction(crate::storage::NewThreadRecord {
                title: "After upgrade",
                project_id: None,
                initial_message: "New turn",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: None,
                timestamp: "5",
            })
            .await
            .unwrap();
        assert_eq!(
            store
                .prepare_personal_presentation_pin(
                    upgraded_thread_turn.root_interaction_id,
                    None,
                    "5",
                )
                .await
                .unwrap()
                .unwrap()
                .version_key,
            "personal-presentation-v1"
        );

        // The input migrations really did land alongside the preserved profile state.
        store
            .pool
            .execute(
                "INSERT INTO action_input_drafts(thread_id,revision,updated_at) VALUES (1,1,'6')",
            )
            .await
            .unwrap();
        store.pool.close().await;
    }

    #[tokio::test]
    async fn legacy_prime_threads_migrate_to_full_access() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for migration in [
            include_str!("migrations/0001_product_schema.sql"),
            include_str!("migrations/0002_graphcomplete_runtime.sql"),
            include_str!("migrations/0003_action_invocations.sql"),
        ] {
            pool.execute(migration).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO threads(id,title,created_at,updated_at,harness_configuration_name) VALUES (1,'Prime','1','1','prime-agent-basic'),(2,'Codex','1','1','codex-basic')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO interactions(id,thread_id,sequence,text,created_at) VALUES (1,1,1,'Prime','1'),(2,2,1,'Codex','1')",
        )
        .execute(&pool)
        .await
        .unwrap();

        pool.execute(include_str!("migrations/0004_permission_profiles.sql"))
            .await
            .unwrap();

        let threads = sqlx::query(
            "SELECT harness_configuration_name,permission_profile_id FROM threads ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(threads[0].get::<String, _>("permission_profile_id"), "full");
        assert_eq!(threads[1].get::<String, _>("permission_profile_id"), "auto");
        let interactions =
            sqlx::query("SELECT permission_profile_id FROM interactions ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            interactions[0].get::<String, _>("permission_profile_id"),
            "full"
        );
        assert_eq!(
            interactions[1].get::<String, _>("permission_profile_id"),
            "auto"
        );
    }

    #[tokio::test]
    async fn existing_action_invocations_migrate_as_pre_lease_records() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for migration in [
            include_str!("migrations/0001_product_schema.sql"),
            include_str!("migrations/0002_graphcomplete_runtime.sql"),
            include_str!("migrations/0003_action_invocations.sql"),
        ] {
            pool.execute(migration).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO threads(id,title,created_at,updated_at) VALUES (1,'Legacy','1','1')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO interactions(id,thread_id,sequence,text,created_at,graph_node_id,completion_status) VALUES (1,1,1,'Source','1',90,'accepted'),(2,1,2,'Result','2',91,'running')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at) VALUES (1,41,2,'2')",
        )
        .execute(&pool)
        .await
        .unwrap();

        pool.execute(include_str!("migrations/0008_action_invocation_leases.sql"))
            .await
            .unwrap();

        let graph_lease_required: bool = sqlx::query_scalar(
            "SELECT graph_lease_required FROM action_invocations WHERE result_interaction_id=2",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(!graph_lease_required);
    }

    #[tokio::test]
    async fn schema_20_confirmations_migrate_as_historical_not_pending() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        pool.execute(include_str!("migrations/0001_product_schema.sql"))
            .await
            .unwrap();
        pool.execute(include_str!("migrations/0020_node_context_drafts.sql"))
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO threads(id,title,created_at,updated_at) VALUES (1,'Legacy','1','1')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO node_context_draft_resolutions(draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at) VALUES ('legacy-confirmed',1,'confirmed',2,7,3,5,'{}','FIFO','2')",
        )
        .execute(&pool)
        .await
        .unwrap();

        pool.execute(include_str!(
            "migrations/0022_confirmed_composer_contexts.sql"
        ))
        .await
        .unwrap();

        let migrated: (Option<String>, Option<String>, Option<i64>) = sqlx::query_as(
            "SELECT composer_text,dismissed_at,consumed_interaction_id FROM node_context_draft_resolutions WHERE draft_id='legacy-confirmed'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(migrated, (Some("FIFO".into()), Some("2".into()), None));
        let pending_legacy: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM node_context_draft_resolutions WHERE outcome='confirmed' AND dismissed_at IS NULL AND consumed_interaction_id IS NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(pending_legacy, 0);

        sqlx::query(
            "INSERT INTO node_context_draft_resolutions(draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at,composer_text) VALUES ('new-confirmed',1,'confirmed',1,8,3,5,'{}','LIFO','3','LIFO')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let pending_after_new_confirmation: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM node_context_draft_resolutions WHERE outcome='confirmed' AND dismissed_at IS NULL AND consumed_interaction_id IS NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(pending_after_new_confirmation, 1);
    }

    #[tokio::test]
    async fn legacy_reused_action_duplicates_are_canonicalized_before_open_validation() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-legacy-invocation-dedupe-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        sqlx::query("INSERT INTO projects(id,name,path,created_at,updated_at) VALUES (1,'Shared','/tmp/legacy-shared','1','1')")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO threads(id,title,project_id,created_at,updated_at) VALUES (1,'First',1,'1','1'),(2,'Second',1,'2','2'),(3,'Third',1,'3','3')")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,graph_node_id,completion_status) VALUES (1,1,1,'Source one','1',90,'accepted'),(2,1,2,'Canonical result','2',91,'running'),(3,2,1,'Source two','2',92,'accepted'),(4,2,2,'Accepted historical result','3',93,'accepted'),(5,3,1,'Source three','3',94,'accepted'),(6,3,2,'Interrupted historical result','4',95,'submitted')")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at) VALUES (1,41,2,'2'),(3,41,4,'3'),(5,41,6,'4')")
            .execute(&store.pool)
            .await
            .unwrap();
        store.pool.close().await;

        // Recreate the exact pre-0008 action-invocation shape and migration ledger. Opening this
        // database must apply 0008 and the canonicalization migration before strict validation.
        let url = format!("sqlite://{}", path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        pool.execute("PRAGMA foreign_keys=OFF").await.unwrap();
        pool.execute("ALTER TABLE action_invocations RENAME TO action_invocations_with_lease")
            .await
            .unwrap();
        pool.execute(include_str!("migrations/0003_action_invocations.sql"))
            .await
            .unwrap();
        pool.execute("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at) SELECT source_interaction_id,action_id,result_interaction_id,created_at FROM action_invocations_with_lease")
            .await
            .unwrap();
        pool.execute("DROP TABLE action_invocations_with_lease")
            .await
            .unwrap();
        pool.execute("DROP TRIGGER interaction_input_identity_pair_insert")
            .await
            .unwrap();
        pool.execute("DROP TRIGGER interaction_input_identity_pair_update")
            .await
            .unwrap();
        pool.execute("DROP INDEX interactions_input_identity")
            .await
            .unwrap();
        pool.execute("DROP TABLE interaction_context_annotations")
            .await
            .unwrap();
        pool.execute("DROP TABLE interaction_context_intents")
            .await
            .unwrap();
        pool.execute("ALTER TABLE interactions DROP COLUMN input_digest")
            .await
            .unwrap();
        pool.execute("ALTER TABLE interactions DROP COLUMN input_identity")
            .await
            .unwrap();
        // Replay only the legacy action/context migrations whose schema was removed above.
        // Later provider/model migrations remain physically present and must retain their
        // ledger entries, otherwise reopening would try to add their columns a second time.
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version BETWEEN 8 AND 11")
            .execute(&pool)
            .await
            .unwrap();
        pool.execute("PRAGMA foreign_keys=ON").await.unwrap();
        pool.close().await;

        let reopened = SqliteProductStore::open(&path).await.unwrap();
        let mappings: Vec<(i64, i64, i64, bool)> = sqlx::query_as(
            "SELECT source_interaction_id,action_id,result_interaction_id,authoritative FROM action_invocations ORDER BY result_interaction_id",
        )
        .fetch_all(&reopened.pool)
        .await
        .unwrap();
        assert_eq!(
            mappings,
            vec![(1, 41, 2, false), (3, 41, 4, true), (5, 41, 6, false)]
        );
        let history: Vec<(i64, String, Option<String>)> = sqlx::query_as(
            "SELECT id,completion_status,completion_error FROM interactions WHERE id IN (2,4,6) ORDER BY id",
        )
        .fetch_all(&reopened.pool)
        .await
        .unwrap();
        assert_eq!(history[0].0, 2);
        assert_eq!(history[0].1, "failed");
        assert!(
            history[0]
                .2
                .as_deref()
                .unwrap()
                .contains("action origin was retained")
        );
        assert_eq!(history[1], (4, "accepted".into(), None));
        assert_eq!(history[2].0, 6);
        assert_eq!(history[2].1, "failed");
        assert!(
            history[2]
                .2
                .as_deref()
                .unwrap()
                .contains("superseded during graph lease migration")
        );
        let projected = reopened
            .get_action_invocation(crate::product::InteractionId::from_database(1), 41)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(projected.0.source_interaction_id.value(), 3);
        assert_eq!(projected.0.result_interaction_id.value(), 4);
        let product_projection = reopened
            .load_thread(crate::product::ThreadId::from_database(1))
            .await
            .unwrap();
        assert_eq!(product_projection.action_invocations.len(), 1);
        assert_eq!(
            product_projection.action_invocations[0]
                .result_interaction_id
                .value(),
            4
        );
        let first_thread_history = reopened
            .action_invocations_for_export(crate::product::ThreadId::from_database(1))
            .await
            .unwrap();
        assert_eq!(first_thread_history.len(), 1);
        assert_eq!(first_thread_history[0].source_interaction_id.value(), 1);
        assert_eq!(first_thread_history[0].result_interaction_id.value(), 2);
        let interaction_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM interactions i JOIN threads t ON t.id=i.thread_id WHERE t.surface='conversation'",
        )
            .fetch_one(&reopened.pool)
            .await
            .unwrap();
        assert_eq!(interaction_count, 6);
        sqlx::query("UPDATE action_invocations SET authoritative=1 WHERE result_interaction_id=2")
            .execute(&reopened.pool)
            .await
            .unwrap();
        reopened.pool.close().await;
        let error = SqliteProductStore::open(&path).await.err().unwrap();
        assert!(
            error
                .to_string()
                .contains("exactly one authoritative invocation result")
        );
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn legacy_ui_rule_overrides_reset_once_before_catalog_reseeding() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-legacy-harness-rules-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        let shipped = RuntimeProductHarness {
            id: "codex-basic".into(),
            configuration_digest: "sha256:shipped".into(),
            model_compatibility: Vec::new(),
            configuration_revision: 1,
            model_rules: Some(HarnessModelRules {
                allow: vec![HarnessModelRule {
                    adapter_id: "codex-subscription".into(),
                    model_id_exact: None,
                    model_id_regex: Some(".*".into()),
                }],
                deny: Vec::new(),
            }),
            execution_access_contracts: vec!["managed-runtime@1".into()],
            family_policy: None,
            runtime_available: true,
            unavailable_reason: None,
        };
        store
            .initialize_model_catalog("codex-basic", std::slice::from_ref(&shipped))
            .await
            .unwrap();
        store
            .update_harness_model_rules(&UpdateHarnessModelRulesCommand {
                harness_id: "codex-basic".into(),
                expected_revision: 1,
                rules: HarnessModelRules {
                    allow: Vec::new(),
                    deny: vec![HarnessModelRule {
                        adapter_id: "codex-subscription".into(),
                        model_id_exact: None,
                        model_id_regex: Some(".*".into()),
                    }],
                },
            })
            .await
            .unwrap();
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version=21")
            .execute(&store.pool)
            .await
            .unwrap();
        store.pool.close().await;

        let reopened = SqliteProductStore::open(&path).await.unwrap();
        let reset: (bool, i64, String, i64) = sqlx::query_as(
            "SELECT model_rules_modified,configuration_revision,configuration_digest,(SELECT COUNT(*) FROM harness_model_rules WHERE harness_configuration_name='codex-basic') FROM product_harnesses WHERE configuration_name='codex-basic'",
        )
        .fetch_one(&reopened.pool)
        .await
        .unwrap();
        assert_eq!(reset, (false, 1, "sha256:shipped".into(), 0));

        reopened
            .initialize_model_catalog("codex-basic", std::slice::from_ref(&shipped))
            .await
            .unwrap();
        let rules = reopened
            .load_model_settings()
            .await
            .unwrap()
            .harnesses
            .into_iter()
            .find(|harness| harness.id == "codex-basic")
            .unwrap()
            .model_rules;
        assert_eq!(rules, shipped.model_rules);
        reopened.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }
}
