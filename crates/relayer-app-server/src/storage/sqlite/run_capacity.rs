//! The durable half of the app's limit on human-started runs (#720, PRD 12.2). A run that
//! finds every slot taken waits as `queued`, and `run_capacity_waits` records that it waits for
//! capacity. Which runs hold slots, and the order of the wait, are live state owned by the app
//! server's run capacity, since only a run this process executes can hold a slot.

use super::SqliteProductStore;
use crate::{product::InteractionId, storage::StorageError};

impl SqliteProductStore {
    /// Puts a run whose start was claimed into the wait for capacity. A run with a pending Stop
    /// is never queued; it is about to end, and it settles without a slot. A Stop that failed
    /// is not pending, so its run waits like any other.
    pub(crate) async fn queue_run_for_capacity(
        &self,
        run: InteractionId,
    ) -> Result<bool, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let queued = sqlx::query(
            "UPDATE interactions SET completion_status='queued' WHERE id=?1 AND completion_status='submitted' AND NOT EXISTS(SELECT 1 FROM interaction_stop_requests WHERE interaction_id=?1 AND error IS NULL) AND thread_id IN (SELECT id FROM threads WHERE conversation_import_id IS NULL)",
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

    /// Ends stopped a claimed run that never started and carries a valid Stop, marked as never
    /// started so it neither owns nor obscures its conversation's route.
    pub(crate) async fn stop_unstarted_run(
        &self,
        run: InteractionId,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query(
            "UPDATE interactions SET completion_status='stopped',completion_error=?2 WHERE id=?1 AND completion_status='submitted' AND graph_node_id IS NULL AND EXISTS(SELECT 1 FROM interaction_stop_requests WHERE interaction_id=?1 AND error IS NULL)",
        )
        .bind(run.value())
        .bind(super::QUEUED_RUN_STOPPED)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }
}

#[cfg(test)]
impl SqliteProductStore {
    /// Makes the capacity wait unreachable, or reachable again, to fault its storage in tests.
    pub(crate) async fn set_capacity_waits_offline_for_test(&self, offline: bool) {
        let (from, to) = if offline {
            ("run_capacity_waits", "run_capacity_waits_offline")
        } else {
            ("run_capacity_waits_offline", "run_capacity_waits")
        };
        sqlx::query(&format!("ALTER TABLE {from} RENAME TO {to}"))
            .execute(&self.pool)
            .await
            .unwrap();
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

        // A waiting run that already has a graph interaction, such as an identified send
        // startup resumed, settles its Stop before native work so its graph current stops too.
        let (_, prepared) = store.seed_node_runs_for_test(&[7]).await;
        assert!(
            store
                .claim_interaction_preparing(prepared[0])
                .await
                .unwrap()
        );
        assert!(store.queue_run_for_capacity(prepared[0]).await.unwrap());
        sqlx::query("UPDATE interactions SET graph_node_id=902 WHERE id=?1")
            .bind(prepared[0].value())
            .execute(&store.pool)
            .await
            .unwrap();
        let prepared_thread = store
            .get_interaction(prepared[0])
            .await
            .unwrap()
            .unwrap()
            .thread_id;
        assert_eq!(
            store
                .request_interaction_stop(prepared_thread, prepared[0])
                .await
                .unwrap(),
            QueuedStop::SettleBeforeStart
        );
        assert!(!store.claim_capacity_run(prepared[0]).await.unwrap());
    }

    /// A claimed run that never started and carries a valid Stop ends stopped, marked as never
    /// started; a run whose Stop failed, or one already bound to the graph, is left alone.
    #[tokio::test]
    async fn an_unstarted_run_with_a_stop_ends_marked_as_never_started() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(&directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        let (thread, runs) = store.seed_node_runs_for_test(&[1, 2]).await;
        for run in &runs {
            assert!(store.claim_interaction_preparing(*run).await.unwrap());
            store.request_interaction_stop(thread, *run).await.unwrap();
        }
        store
            .record_stop_error(runs[1], "The provider refused the Stop.")
            .await
            .unwrap();
        assert!(store.stop_unstarted_run(runs[0]).await.unwrap());
        let stopped = store.get_interaction(runs[0]).await.unwrap().unwrap();
        assert_eq!(stopped.completion_status, "stopped");
        assert_eq!(
            stopped.completion_error.as_deref(),
            Some(super::super::QUEUED_RUN_STOPPED)
        );
        assert!(!store.stop_unstarted_run(runs[1]).await.unwrap());
        assert_eq!(store.completion_status_for_test(runs[1]).await, "submitted");
    }
}
