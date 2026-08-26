use crate::storage::StorageError;
use sqlx::{SqlitePool, migrate::Migrator};

// Keep this declaration adjacent to the migration directory; adding a migration must rebuild the
// embedded migrator before schema validation runs.
static MIGRATOR: Migrator = sqlx::migrate!("./src/storage/sqlite/migrations");

pub(super) async fn run(pool: &SqlitePool) -> Result<(), StorageError> {
    MIGRATOR.run(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::SqliteProductStore;
    use sqlx::{Executor, Row, sqlite::SqlitePoolOptions};
    use std::time::{SystemTime, UNIX_EPOCH};

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
    async fn pre_execution_receipt_migration_preserves_existing_attempt_history() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-attempt-receipt-migration-{}-{unique}.sqlite3",
            std::process::id()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        sqlx::query(
            "INSERT INTO threads(id,title,created_at,updated_at) VALUES (1,'Attempts','1','1')",
        )
        .execute(&store.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status) VALUES (1,1,1,'Accepted','1','accepted'),(2,1,2,'Failed','2','failed'),(3,1,3,'Running','3','running')")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO interaction_attempts(id,interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,failure_category,effect_boundary) VALUES (11,1,1,'1','2',7,3,'codex-basic',4,'sha256:one','codex','codex-subscription',5,'gpt','managed-runtime@1','accepted',NULL,'graph_write'),(12,2,1,'3','4',7,3,'codex-basic',4,'sha256:two','codex','codex-subscription',5,'gpt','managed-runtime@1','model_failed','provider_timeout','none'),(13,3,1,'5',NULL,7,3,'codex-basic',4,'sha256:three','codex','codex-subscription',5,'gpt','managed-runtime@1','running',NULL,'unknown')")
            .execute(&store.pool)
            .await
            .unwrap();
        store.pool.close().await;

        // Recreate the v14 constraint and ledger exactly enough to prove that migration 0015
        // upgrades an already-used development profile rather than only fresh databases.
        let url = format!("sqlite://{}", path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        pool.execute("PRAGMA foreign_keys=OFF").await.unwrap();
        pool.execute("ALTER TABLE interaction_attempts RENAME TO interaction_attempts_current")
            .await
            .unwrap();
        pool.execute(
            "CREATE TABLE interaction_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
                attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
                started_at TEXT NOT NULL,
                finished_at TEXT,
                family_id INTEGER NOT NULL,
                family_revision INTEGER NOT NULL CHECK (family_revision > 0),
                harness_configuration_name TEXT NOT NULL,
                harness_configuration_revision INTEGER NOT NULL CHECK (harness_configuration_revision > 0),
                harness_configuration_digest TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                adapter_id TEXT NOT NULL,
                adapter_implementation_version INTEGER NOT NULL CHECK (adapter_implementation_version > 0),
                model_id TEXT NOT NULL,
                access_contract TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK (outcome IN ('running','accepted','model_failed','execution_failed','cancelled')),
                failure_category TEXT,
                effect_boundary TEXT NOT NULL DEFAULT 'unknown' CHECK (effect_boundary IN ('none','partial_output','graph_write','tool_effect','unknown')),
                UNIQUE (interaction_id,attempt_number),
                CHECK ((outcome='running') = (finished_at IS NULL)),
                CHECK (failure_category IS NULL OR outcome NOT IN ('running','accepted'))
            )",
        )
        .await
        .unwrap();
        pool.execute("INSERT INTO interaction_attempts SELECT * FROM interaction_attempts_current")
            .await
            .unwrap();
        pool.execute("DROP TABLE interaction_attempts_current")
            .await
            .unwrap();
        pool.execute("CREATE INDEX interaction_attempts_interaction ON interaction_attempts(interaction_id,attempt_number)")
            .await
            .unwrap();
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version=15")
            .execute(&pool)
            .await
            .unwrap();
        pool.execute("PRAGMA foreign_keys=ON").await.unwrap();
        pool.close().await;

        let reopened = SqliteProductStore::open(&path).await.unwrap();
        let rows: Vec<(i64, i64, String, Option<String>, String)> = sqlx::query_as(
            "SELECT id,adapter_implementation_version,outcome,failure_category,effect_boundary FROM interaction_attempts ORDER BY id",
        )
        .fetch_all(&reopened.pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                (11, 5, "accepted".into(), None, "graph_write".into()),
                (
                    12,
                    5,
                    "model_failed".into(),
                    Some("provider_timeout".into()),
                    "none".into()
                ),
                (13, 5, "running".into(), None, "unknown".into()),
            ]
        );
        let zero_version = sqlx::query("INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,failure_category,effect_boundary) VALUES (2,2,'6','7',7,3,'codex-basic',4,'sha256:four','codex','codex-subscription',0,'gpt','managed-runtime@1','model_failed','provider_authentication','none')")
            .execute(&reopened.pool)
            .await
            .unwrap();
        assert_eq!(zero_version.rows_affected(), 1);
        assert!(sqlx::query("INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,failure_category,effect_boundary) VALUES (2,2,'8','9',7,3,'codex-basic',4,'sha256:duplicate','codex','codex-subscription',0,'gpt','managed-runtime@1','model_failed','provider_authentication','none')")
            .execute(&reopened.pool)
            .await
            .is_err());
        sqlx::query("DELETE FROM interactions WHERE id=1")
            .execute(&reopened.pool)
            .await
            .unwrap();
        let accepted_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM interaction_attempts WHERE interaction_id=1")
                .fetch_one(&reopened.pool)
                .await
                .unwrap();
        assert_eq!(accepted_count, 0);
        reopened.pool.close().await;
        std::fs::remove_file(path).unwrap();
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
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version IN (8,9,10,11)")
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
        let interaction_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM interactions")
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
}
