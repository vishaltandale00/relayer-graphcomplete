use super::SqliteProductStore;
use crate::{
    product::{CatalogError, InteractionId, ThreadId},
    storage::StorageError,
};

impl SqliteProductStore {
    /// Only a product-owned, live execution can acquire this durable request. A child an
    /// agent launched is refused: its parent agent keeps the only authority to stop it,
    /// through its broker. Every refusal is the caller's error, not the server's.
    pub(crate) async fn request_interaction_stop(
        &self,
        thread: ThreadId,
        interaction: InteractionId,
    ) -> Result<(), StorageError> {
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
        .execute(&self.pool)
        .await?
        .rows_affected();
        if changed == 0 {
            let terminal: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM interactions WHERE id=?1 AND thread_id=?2 AND completion_status IN ('accepted','stopped','failed') AND thread_id IN (SELECT id FROM threads WHERE conversation_import_id IS NULL) AND NOT EXISTS(SELECT 1 FROM completion_executions WHERE interaction_id=?1))")
                .bind(interaction.value()).bind(thread.value()).fetch_one(&self.pool).await?;
            if terminal {
                return Ok(());
            }
            return Err(StorageError::Catalog(CatalogError::invalid(
                "no_active_run",
                "This interaction has no active product run to stop.",
            )));
        }
        Ok(())
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
