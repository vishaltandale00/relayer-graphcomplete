use super::SqliteProductStore;
use crate::{
    product::{CatalogError, InteractionId, ThreadId},
    storage::StorageError,
};

/// A test pauses one Stop between reading whether its run is queued and recording its
/// request, to show nothing can queue the run in between.
#[cfg(test)]
type StopPause = (
    InteractionId,
    std::sync::Arc<tokio::sync::Notify>,
    std::sync::Arc<tokio::sync::Notify>,
);

#[cfg(test)]
pub(crate) static STOP_PAUSE: std::sync::Mutex<Option<StopPause>> = std::sync::Mutex::new(None);

#[cfg(test)]
async fn pause_for_test(interaction: InteractionId) {
    let pause = STOP_PAUSE
        .lock()
        .unwrap()
        .as_ref()
        .filter(|(paused, _, _)| *paused == interaction)
        .map(|(_, reached, resume)| (reached.clone(), resume.clone()));
    if let Some((reached, resume)) = pause {
        reached.notify_one();
        resume.notified().await;
    }
}

/// How a Stop request met a queued run: one waiting in its node's queue (#718) or for capacity
/// (#720).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QueuedStop {
    /// The run was not queued; the Stop is an ordinary request on an active run, or a no-op.
    NotQueued,
    /// The queued run stopped at once. Nothing had been prepared for it.
    Stopped,
    /// The graph had already prepared the queued run's call. The run now carries the Stop and
    /// the caller settles it before native execution, so its graph current stops too.
    SettleBeforeStart,
}

impl SqliteProductStore {
    /// Only a product-owned, live execution can acquire this durable request. A child an
    /// agent launched is refused: its parent agent keeps the only authority to stop it,
    /// through its broker. Every refusal is the caller's error, not the server's.
    pub(crate) async fn request_interaction_stop(
        &self,
        thread: ThreadId,
        interaction: InteractionId,
    ) -> Result<QueuedStop, StorageError> {
        let agent_child: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM interactions WHERE id=?1 AND thread_id=?2 AND (
                EXISTS(SELECT 1 FROM completion_executions WHERE interaction_id=?1)
                OR EXISTS(SELECT 1 FROM action_invocations WHERE result_interaction_id=?1 AND agent_invoked=1)))",
        )
        .bind(interaction.value())
        .bind(thread.value())
        .fetch_one(&self.pool)
        .await?;
        if agent_child {
            return Err(StorageError::Catalog(CatalogError::invalid(
                "agent_child_stop",
                "Only the agent that launched this child can stop it.",
            )));
        }
        // A queued run has not started, and it never will. Starting it claims the same row, so
        // exactly one of the two wins. One the graph has not prepared stops at once. One whose
        // call the graph already prepared settles as a Stop before native execution, which also
        // stops its graph current (`QueuedStop::SettleBeforeStart`). Either way it leaves the
        // wait for capacity (#720) as well as its node's queue, and keeps its text.
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let queued: Option<bool> = sqlx::query_scalar(
            "SELECT i.graph_node_id IS NOT NULL OR EXISTS(SELECT 1 FROM action_invocations WHERE result_interaction_id=i.id AND prepared_graph_node_id IS NOT NULL) FROM interactions i WHERE i.id=?1 AND i.thread_id=?2 AND i.completion_status='queued' AND i.thread_id IN (SELECT id FROM threads WHERE conversation_import_id IS NULL)",
        )
        .bind(interaction.value())
        .bind(thread.value())
        .fetch_optional(&mut *transaction)
        .await?;
        match queued {
            Some(false) => {
                sqlx::query("UPDATE interactions SET completion_status='stopped',completion_error=?2 WHERE id=?1 AND completion_status='queued'")
                    .bind(interaction.value())
                    .bind(super::QUEUED_RUN_STOPPED)
                    .execute(&mut *transaction)
                    .await?;
                sqlx::query("DELETE FROM run_capacity_waits WHERE interaction_id=?1")
                    .bind(interaction.value())
                    .execute(&mut *transaction)
                    .await?;
                transaction.commit().await?;
                return Ok(QueuedStop::Stopped);
            }
            Some(true) => {
                sqlx::query("UPDATE interactions SET completion_status='submitted',completion_error=NULL WHERE id=?1 AND completion_status='queued'")
                    .bind(interaction.value())
                    .execute(&mut *transaction)
                    .await?;
                sqlx::query("DELETE FROM run_capacity_waits WHERE interaction_id=?1")
                    .bind(interaction.value())
                    .execute(&mut *transaction)
                    .await?;
                sqlx::query("INSERT INTO interaction_stop_requests(interaction_id,error) VALUES (?1,NULL) ON CONFLICT(interaction_id) DO UPDATE SET error=NULL")
                    .bind(interaction.value())
                    .execute(&mut *transaction)
                    .await?;
                transaction.commit().await?;
                return Ok(QueuedStop::SettleBeforeStart);
            }
            // Not queued: the ordinary request is recorded in this same write transaction. An
            // admission that queues the run is ordered either before it (then the read above
            // sees `queued`) or after it (then it sees the request and never queues the run).
            None => {}
        }
        #[cfg(test)]
        pause_for_test(interaction).await;
        let changed = sqlx::query(
            "INSERT INTO interaction_stop_requests(interaction_id,error)
            SELECT id,NULL FROM interactions WHERE id=?1 AND thread_id=?2
            AND completion_status IN ('submitted','running','waiting_for_approval')
            AND thread_id IN (SELECT id FROM threads WHERE conversation_import_id IS NULL)
            AND NOT EXISTS(SELECT 1 FROM completion_executions WHERE interaction_id=?1)
            ON CONFLICT(interaction_id) DO UPDATE SET error=NULL",
        )
        .bind(interaction.value())
        .bind(thread.value())
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        if changed == 0 {
            let terminal: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM interactions WHERE id=?1 AND thread_id=?2 AND completion_status IN ('accepted','stopped','failed') AND thread_id IN (SELECT id FROM threads WHERE conversation_import_id IS NULL) AND NOT EXISTS(SELECT 1 FROM completion_executions WHERE interaction_id=?1))")
                .bind(interaction.value()).bind(thread.value()).fetch_one(&mut *transaction).await?;
            transaction.commit().await?;
            if terminal {
                return Ok(QueuedStop::NotQueued);
            }
            return Err(StorageError::Catalog(CatalogError::invalid(
                "no_active_run",
                "This interaction has no active product run to stop.",
            )));
        }
        transaction.commit().await?;
        Ok(QueuedStop::NotQueued)
    }

    pub(crate) async fn record_stop_error(
        &self,
        interaction: InteractionId,
        error: &str,
    ) -> Result<(), StorageError> {
        sqlx::query("UPDATE interaction_stop_requests SET error=?2 WHERE interaction_id=?1")
            .bind(interaction.value())
            .bind(error)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Called only after provider settlement (or before provider execution begins),
    /// and after canonical acceptance reconciliation. Existing input restoration
    /// triggers run in this same transaction when the interaction becomes stopped.
    pub(crate) async fn finish_interaction_stopped(
        &self,
        interaction: InteractionId,
        timestamp: &str,
    ) -> Result<(), StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let changed = sqlx::query("UPDATE interactions SET completion_status='stopped',completion_error='Stopped. Send a follow-up to continue.' WHERE id=?1 AND completion_status IN ('submitted','running','waiting_for_approval')")
            .bind(interaction.value()).execute(&mut *tx).await?.rows_affected();
        if changed != 1 {
            return Err(StorageError::CompletionExecutionConflict(
                "Interaction is no longer active while settling Stop.".into(),
            ));
        }
        sqlx::query("UPDATE interaction_attempts SET outcome='cancelled',finished_at=?2,failure_category='cancelled_by_user',effect_boundary='unknown' WHERE interaction_id=?1 AND outcome='running'")
            .bind(interaction.value()).bind(timestamp).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn durable_stop_is_exact_idempotent_retryable_and_never_overwrites_terminal_output() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("product.sqlite");
        let store = SqliteProductStore::open(&path).await.unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(crate::storage::NewThreadRecord {
                required_provider_adapter_id: None,
                icon_selection_eligible: true,
                title: "Stop",
                project_id: None,
                initial_message: "Work",
                harness_configuration_name: "test",
                permission_profile_id: "full",
                model_selection: None,
                timestamp: "1",
            })
            .await
            .unwrap();
        let id = thread.root_interaction_id;
        store.mark_interaction_running(id, "test").await.unwrap();
        assert!(
            store
                .request_interaction_stop(ThreadId::from_database(thread.id.value() + 1), id)
                .await
                .is_err()
        );
        store.request_interaction_stop(thread.id, id).await.unwrap();
        store.request_interaction_stop(thread.id, id).await.unwrap();
        store
            .record_stop_error(id, "Native abort failed")
            .await
            .unwrap();
        drop(store);
        let store = SqliteProductStore::open(&path).await.unwrap();
        let pending = store.get_interaction(id).await.unwrap().unwrap();
        assert_eq!(pending.completion_status, "running");
        assert!(pending.stop_requested);
        assert_eq!(pending.stop_error.as_deref(), Some("Native abort failed"));
        store.request_interaction_stop(thread.id, id).await.unwrap();
        assert!(
            store
                .get_interaction(id)
                .await
                .unwrap()
                .unwrap()
                .stop_error
                .is_none()
        );
        store.finish_interaction_stopped(id, "2").await.unwrap();
        store.request_interaction_stop(thread.id, id).await.unwrap();
        drop(store);
        let store = SqliteProductStore::open(&path).await.unwrap();
        let stopped = store.get_interaction(id).await.unwrap().unwrap();
        assert_eq!(stopped.completion_status, "stopped");
        assert!(stopped.completion_output.is_none());
        sqlx::query("UPDATE interactions SET completion_status='accepted',completion_output_json='{}' WHERE id=?1").bind(id.value()).execute(&store.pool).await.unwrap();
        assert!(store.finish_interaction_stopped(id, "3").await.is_err());
        store.request_interaction_stop(thread.id, id).await.unwrap();
        let accepted = store.get_interaction(id).await.unwrap().unwrap();
        assert_eq!(accepted.completion_status, "accepted");
        assert_eq!(accepted.completion_output, Some(serde_json::json!({})));
    }
}
