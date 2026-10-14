//! The durable half of the app's limit on human-started runs (#720, PRD 12.2). A run that
//! finds every slot taken waits as `queued`, and `run_capacity_waits` records that it waits for
//! capacity. Which runs hold slots, and the order of the wait, are live state owned by the app
//! server's run capacity, since only a run this process executes can hold a slot.

use super::SqliteProductStore;
use crate::{product::InteractionId, storage::StorageError};

impl SqliteProductStore {
    /// Puts a run whose start was claimed into the wait for capacity. A run with a pending Stop
    /// is never queued; it is about to end, and it settles without a slot.
    pub(crate) async fn queue_run_for_capacity(
        &self,
        run: InteractionId,
    ) -> Result<bool, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let queued = sqlx::query(
            "UPDATE interactions SET completion_status='queued' WHERE id=?1 AND completion_status='submitted' AND NOT EXISTS(SELECT 1 FROM interaction_stop_requests WHERE interaction_id=?1) AND thread_id IN (SELECT id FROM threads WHERE conversation_import_id IS NULL)",
        )
        .bind(run.value())
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            == 1;
        if queued {
            sqlx::query(
                "INSERT INTO run_capacity_waits(interaction_id) VALUES (?1) ON CONFLICT(interaction_id) DO NOTHING",
            )
            .bind(run.value())
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(queued)
    }

    /// Claims a run waiting for capacity to start it: it returns to `submitted`, as its start
    /// was claimed before it waited. A Stop that won the race leaves it stopped.
    pub(crate) async fn claim_capacity_run(
        &self,
        run: InteractionId,
    ) -> Result<bool, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let claimed = sqlx::query(
            "UPDATE interactions SET completion_status='submitted',completion_error=NULL WHERE id=?1 AND completion_status='queued' AND EXISTS(SELECT 1 FROM run_capacity_waits WHERE interaction_id=?1)",
        )
        .bind(run.value())
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            == 1;
        sqlx::query("DELETE FROM run_capacity_waits WHERE interaction_id=?1")
            .bind(run.value())
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(claimed)
    }

    /// At startup no run holds a slot, so no run may stay queued for one. A run that waited is
    /// interrupted like a run queued behind its node (#718): nothing starts it on its own. An
    /// invoked run stays `queued` for startup's action recovery, which resumes it when its
    /// action is invoked again. A message turn fails, restoring any committed inputs it took.
    pub(crate) async fn interrupt_capacity_waits(&self, error: &str) -> Result<u64, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let waited = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM run_capacity_waits")
            .fetch_one(&mut *transaction)
            .await?;
        sqlx::query(
            "UPDATE interactions SET completion_status='failed',completion_error=?1 WHERE completion_status='queued' AND id IN (SELECT interaction_id FROM run_capacity_waits) AND id NOT IN (SELECT result_interaction_id FROM action_invocations WHERE authoritative=1)",
        )
        .bind(error)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("DELETE FROM run_capacity_waits")
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(waited as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::QueuedStop;

    /// A run waits for capacity only after its start was claimed, and it returns to that
    /// claimed state when a slot frees. Stopping it removes it from the wait and keeps its
    /// text; the Stop and the claim change the same row, so exactly one of them wins.
    #[tokio::test]
    async fn a_run_waits_for_capacity_from_its_claimed_start_and_a_stop_removes_it() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(&directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        let (thread, runs) = store.seed_node_runs_for_test(&[7, 8, 9]).await;
        // An unclaimed run is not queued for capacity.
        assert!(!store.queue_run_for_capacity(runs[0]).await.unwrap());
        for run in &runs {
            assert!(store.claim_interaction_preparing(*run).await.unwrap());
            assert!(store.queue_run_for_capacity(*run).await.unwrap());
            let waiting = store.get_interaction(*run).await.unwrap().unwrap();
            assert_eq!(waiting.completion_status, "queued");
            assert!(waiting.waiting_for_capacity);
        }
        assert!(store.claim_capacity_run(runs[0]).await.unwrap());
        let started = store.get_interaction(runs[0]).await.unwrap().unwrap();
        assert_eq!(started.completion_status, "submitted");
        assert!(!started.waiting_for_capacity);
        // A run queued behind its node is not one that waits for capacity.
        assert!(!store.claim_capacity_run(runs[0]).await.unwrap());

        assert_eq!(
            store
                .request_interaction_stop(thread, runs[1])
                .await
                .unwrap(),
            QueuedStop::Stopped
        );
        let removed = store.get_interaction(runs[1]).await.unwrap().unwrap();
        assert_eq!(removed.completion_status, "stopped");
        assert_eq!(removed.text, "Run");
        assert!(!removed.waiting_for_capacity);
        assert!(!store.claim_capacity_run(runs[1]).await.unwrap());

        // At startup a message turn still waiting fails as interrupted; it never stays queued.
        assert_eq!(
            store.interrupt_capacity_waits("Interrupted").await.unwrap(),
            1
        );
        let interrupted = store.get_interaction(runs[2]).await.unwrap().unwrap();
        assert_eq!(interrupted.completion_status, "failed");
        assert_eq!(interrupted.completion_error.as_deref(), Some("Interrupted"));
        assert!(!store.claim_capacity_run(runs[2]).await.unwrap());
    }
}
