use crate::storage::StorageError;
use sqlx::{SqlitePool, migrate::Migrator};

static MIGRATOR: Migrator = sqlx::migrate!("./src/storage/sqlite/migrations");

pub(super) async fn run(pool: &SqlitePool) -> Result<(), StorageError> {
    MIGRATOR.run(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use sqlx::{Executor, Row, sqlite::SqlitePoolOptions};

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
}
