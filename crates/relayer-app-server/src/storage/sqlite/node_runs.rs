//! The durable half of the per-node run queue (#718, PRD 12.2). A run a user starts on a node
//! records the node; while another run on that node is active it waits as `queued`. Which run
//! holds a node is live state, owned by the app server's node-run queue, since only a run this
//! process executes can hold one.

use super::SqliteProductStore;
use crate::{
    product::{InteractionId, NodeRunKey, ThreadId},
    storage::StorageError,
};

impl SqliteProductStore {
    /// Records the node a user's run was started on. The first record wins, so a retried
    /// request never moves a run to another node's queue.
    pub(crate) async fn record_node_run(
        &self,
        run: InteractionId,
        node_id: i64,
    ) -> Result<(), StorageError> {
        sqlx::query(
            "INSERT INTO node_runs(result_interaction_id,thread_id,node_id) SELECT id,thread_id,?2 FROM interactions WHERE id=?1 ON CONFLICT(result_interaction_id) DO NOTHING",
        )
        .bind(run.value())
        .bind(node_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub(crate) async fn node_run_key(
        &self,
        run: InteractionId,
    ) -> Result<Option<NodeRunKey>, StorageError> {
        let key: Option<(i64, i64)> = sqlx::query_as(
            "SELECT thread_id,node_id FROM node_runs WHERE result_interaction_id=?1",
        )
        .bind(run.value())
        .fetch_optional(&self.pool)
        .await?;
        Ok(key.map(|(thread_id, node_id)| NodeRunKey {
            thread_id: ThreadId::from_database(thread_id),
            node_id,
        }))
    }

    /// Puts a run that has not started into its node's queue. A run with a pending Stop is
    /// never queued; it is about to end.
    pub(crate) async fn queue_node_run(&self, run: InteractionId) -> Result<bool, StorageError> {
        let result = sqlx::query(
            "UPDATE interactions SET completion_status='queued' WHERE id=?1 AND completion_status IN ('not_started','submitted') AND EXISTS(SELECT 1 FROM node_runs WHERE result_interaction_id=?1) AND NOT EXISTS(SELECT 1 FROM interaction_stop_requests WHERE interaction_id=?1)",
        )
        .bind(run.value())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Claims a queued run to start it, as `claim_interaction_preparing` claims a new one.
    /// A Stop that won the race leaves it stopped.
    pub(crate) async fn claim_queued_node_run(
        &self,
        run: InteractionId,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query(
            "UPDATE interactions SET completion_status='submitted',completion_error=NULL WHERE id=?1 AND completion_status='queued'",
        )
        .bind(run.value())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// The runs waiting on a node, in the order they were created. The live queue keeps this
    /// order itself; this read is for tests.
    #[cfg(test)]
    pub(crate) async fn queued_node_runs(
        &self,
        key: NodeRunKey,
    ) -> Result<Vec<InteractionId>, StorageError> {
        let runs: Vec<i64> = sqlx::query_scalar(
            "SELECT run.id FROM node_runs queue JOIN interactions run ON run.id=queue.result_interaction_id WHERE queue.thread_id=?1 AND queue.node_id=?2 AND run.completion_status='queued' ORDER BY run.sequence,run.id",
        )
        .bind(key.thread_id.value())
        .bind(key.node_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(runs.into_iter().map(InteractionId::from_database).collect())
    }
}

#[cfg(test)]
impl SqliteProductStore {
    /// A thread with one run per entry, each not started and recorded on the given node.
    pub(crate) async fn seed_node_runs_for_test(
        &self,
        nodes: &[i64],
    ) -> (ThreadId, Vec<InteractionId>) {
        let thread = sqlx::query("INSERT INTO threads(title,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES ('Node runs','1','1','codex-basic','auto')")
            .execute(&self.pool)
            .await
            .unwrap()
            .last_insert_rowid();
        let mut runs = Vec::new();
        for (index, node) in nodes.iter().enumerate() {
            let run = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status,permission_profile_id) VALUES (?1,?2,'Run','1','not_started','auto')")
                .bind(thread)
                .bind(index as i64 + 1)
                .execute(&self.pool)
                .await
                .unwrap()
                .last_insert_rowid();
            let run = InteractionId::from_database(run);
            self.record_node_run(run, *node).await.unwrap();
            runs.push(run);
        }
        (ThreadId::from_database(thread), runs)
    }

    pub(crate) async fn set_completion_status_for_test(&self, run: InteractionId, status: &str) {
        sqlx::query("UPDATE interactions SET completion_status=?2 WHERE id=?1")
            .bind(run.value())
            .bind(status)
            .execute(&self.pool)
            .await
            .unwrap();
    }

    pub(crate) async fn completion_status_for_test(&self, run: InteractionId) -> String {
        sqlx::query_scalar("SELECT completion_status FROM interactions WHERE id=?1")
            .bind(run.value())
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::QueuedStop;

    /// Stopping a queued run ends it at once, and it never starts: the Stop and the claim
    /// that would start it change the same row, so exactly one of them wins.
    #[tokio::test]
    async fn a_queued_run_stops_without_starting_and_a_started_one_takes_a_stop_request() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(&directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        let (thread, runs) = store.seed_node_runs_for_test(&[7, 7, 7]).await;
        let key = store.node_run_key(runs[0]).await.unwrap().unwrap();
        assert_eq!(
            key,
            NodeRunKey {
                thread_id: thread,
                node_id: 7
            }
        );
        // The first record wins: a retried request never moves a run to another node.
        store.record_node_run(runs[0], 8).await.unwrap();
        assert_eq!(store.node_run_key(runs[0]).await.unwrap(), Some(key));
        for run in &runs[1..] {
            assert!(store.queue_node_run(*run).await.unwrap());
        }
        assert_eq!(store.queued_node_runs(key).await.unwrap(), runs[1..]);

        assert_eq!(
            store
                .request_interaction_stop(thread, runs[1])
                .await
                .unwrap(),
            QueuedStop::Stopped
        );
        assert_eq!(store.completion_status_for_test(runs[1]).await, "stopped");
        assert!(!store.claim_queued_node_run(runs[1]).await.unwrap());
        assert_eq!(store.queued_node_runs(key).await.unwrap(), [runs[2]]);

        assert!(store.claim_queued_node_run(runs[2]).await.unwrap());
        store
            .request_interaction_stop(thread, runs[2])
            .await
            .unwrap();
        assert_eq!(store.completion_status_for_test(runs[2]).await, "submitted");
        assert!(
            store
                .get_interaction(runs[2])
                .await
                .unwrap()
                .unwrap()
                .stop_requested
        );
        // A run with a pending Stop is about to end, so it is never queued.
        assert!(!store.queue_node_run(runs[2]).await.unwrap());

        // A queued run whose call the graph already prepared takes its Stop to settle before
        // native execution, so its graph current stops too. It never runs.
        let (thread, prepared) = store.seed_node_runs_for_test(&[7, 7]).await;
        sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required,authoritative,agent_invoked,invocation_key,prepared_graph_node_id) VALUES (?1,41,?2,'1',1,1,0,'key',901)")
            .bind(prepared[0].value())
            .bind(prepared[1].value())
            .execute(&store.pool)
            .await
            .unwrap();
        assert!(store.queue_node_run(prepared[1]).await.unwrap());
        assert_eq!(
            store
                .request_interaction_stop(thread, prepared[1])
                .await
                .unwrap(),
            QueuedStop::SettleBeforeStart
        );
        let settling = store.get_interaction(prepared[1]).await.unwrap().unwrap();
        assert_eq!(settling.completion_status, "submitted");
        assert!(settling.stop_requested);
        assert!(!store.claim_queued_node_run(prepared[1]).await.unwrap());
    }

    /// A queued run is active work: its thread shows as running and stays out of the archive,
    /// and an archived thread cannot queue a run.
    #[tokio::test]
    async fn a_queued_run_keeps_its_thread_active_and_out_of_the_archive() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(&directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        let (thread, runs) = store.seed_node_runs_for_test(&[7]).await;
        sqlx::query("UPDATE interactions SET completion_status='accepted' WHERE id=?1")
            .bind(runs[0].value())
            .execute(&store.pool)
            .await
            .unwrap();
        assert_eq!(
            store.get_thread(thread).await.unwrap().unwrap().activity,
            None
        );
        sqlx::query("UPDATE interactions SET completion_status='queued' WHERE id=?1")
            .bind(runs[0].value())
            .execute(&store.pool)
            .await
            .unwrap();
        assert_eq!(
            store
                .get_thread(thread)
                .await
                .unwrap()
                .unwrap()
                .activity
                .as_deref(),
            Some("running")
        );
        assert!(matches!(
            store.set_thread_archived(thread, true).await,
            Err(StorageError::ThreadArchiveBusy)
        ));
        sqlx::query("UPDATE interactions SET completion_status='stopped' WHERE id=?1")
            .bind(runs[0].value())
            .execute(&store.pool)
            .await
            .unwrap();
        store.set_thread_archived(thread, true).await.unwrap();
        assert!(
            sqlx::query("UPDATE interactions SET completion_status='queued' WHERE id=?1")
                .bind(runs[0].value())
                .execute(&store.pool)
                .await
                .is_err(),
            "an archived thread queued a run"
        );
    }
}
