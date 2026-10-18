//! Runs a restart stopped where they were (#722, PRD 8.2). A run that was queued, behind a run
//! on its node (#718) or for capacity (#720), is `paused`. A human-started run that was
//! executing and can run again on its own interaction is `interrupted`. Neither is active work,
//! and nothing starts either until the user resumes it. Resume starts the run again from its
//! claimed state, `submitted`; Discard ends it stopped and keeps its text.
//!
//! On a node, paused and interrupted runs form a chain in creation order. Only its head
//! resumes, and the runs behind it resume with it, in order (#721).

use super::SqliteProductStore;
use crate::{
    product::{InteractionId, ThreadId},
    storage::StorageError,
};

/// How a Resume's claim met the runs it asked for (#722).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RestartClaim {
    /// The head was claimed, with the runs behind it that were still paused or interrupted.
    Claimed(Vec<InteractionId>),
    /// Another Resume claimed the head first. Nothing was claimed, and the caller reports
    /// the head as it stands.
    AlreadyResumed,
    /// The head is no longer paused or interrupted, and no Resume claimed it, for example
    /// because a Discard ended it. Nothing was claimed.
    Changed,
}

/// How a Discard met a paused or interrupted run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestartDiscard {
    /// The run was neither paused nor interrupted; nothing changed.
    NotResumable,
    /// Nothing was prepared for the run in the graph, so it ended stopped at once.
    Stopped,
    /// The graph already holds the run's call. The run now carries a Stop, and the caller
    /// stops its graph current before the product row ends stopped.
    SettleBeforeStart,
    /// The graph holds the run's call, but GraphComplete is unavailable to stop it, so
    /// nothing changed.
    NeedsGraph,
}

impl SqliteProductStore {
    /// At startup no run holds a node or a capacity slot, so no run may stay queued. Every
    /// queued human-started run is paused, keeping its node, its text and the inputs it
    /// snapshotted. A paused run is not active, and nothing starts it on its own (#722).
    pub(crate) async fn pause_queued_runs(&self, note: &str) -> Result<u64, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let paused = sqlx::query(
            "UPDATE interactions SET completion_status='paused',completion_error=?1
             WHERE completion_status='queued'
               AND NOT EXISTS(SELECT 1 FROM action_invocations child WHERE child.result_interaction_id=interactions.id AND child.agent_invoked=1)
               AND thread_id IN (SELECT id FROM threads WHERE conversation_import_id IS NULL)",
        )
        .bind(note)
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        // Which runs wait for a slot is live state; the paused runs keep only their status.
        sqlx::query("DELETE FROM run_capacity_waits")
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(paused)
    }

    /// Marks an identified send that was executing when Relayer stopped as interrupted. Its
    /// input identity lets it run again on the same graph interaction, so it is kept for the
    /// user to resume rather than started on its own.
    pub(crate) async fn interrupt_identified_interaction(
        &self,
        interaction_id: InteractionId,
        note: &str,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query(
            "UPDATE interactions SET completion_status='interrupted',completion_error=?1
             WHERE id=?2 AND input_identity IS NOT NULL AND input_digest IS NOT NULL
               AND completion_status IN ('not_started','running','submitted','waiting_for_approval')",
        )
        .bind(note)
        .bind(interaction_id.value())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Marks a message with no input identity that was executing when Relayer stopped as
    /// interrupted, such as a thread's first message. Resume runs it again on the graph
    /// interaction it is bound to, or prepares it if it was not bound yet, so no second user
    /// message is created. A run with a Stop, submitted answers or an invoke origin is left to
    /// its own recovery.
    pub(crate) async fn interrupt_unidentified_message(
        &self,
        interaction_id: InteractionId,
        note: &str,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query(
            "UPDATE interactions SET completion_status='interrupted',completion_error=?1
             WHERE id=?2 AND input_identity IS NULL AND input_digest IS NULL
               AND completion_status IN ('running','submitted','waiting_for_approval')
               AND NOT EXISTS(SELECT 1 FROM action_invocations WHERE result_interaction_id=interactions.id)
               AND NOT EXISTS(SELECT 1 FROM interaction_submitted_input_attempts WHERE interaction_id=interactions.id)
               AND NOT EXISTS(SELECT 1 FROM interaction_stop_requests WHERE interaction_id=interactions.id)
               AND thread_id IN (SELECT id FROM threads WHERE conversation_import_id IS NULL)",
        )
        .bind(note)
        .bind(interaction_id.value())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Whether the user resumed this run after a restart (#722).
    pub(crate) async fn was_resumed(&self, run: InteractionId) -> Result<bool, StorageError> {
        Ok(sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM run_resumptions WHERE interaction_id=?1)",
        )
        .bind(run.value())
        .fetch_one(&self.pool)
        .await?)
    }

    /// Records a run's new execution receipts on the graph interaction it is already bound to.
    /// A message a restart interrupted resumes under the thread's current harness, which an
    /// upgrade or a harness retirement may have changed (#722). Only a message with no invoke
    /// origin and no submitted answers, claimed and bound to that node, is rebound.
    pub(crate) async fn rebind_message_receipts(
        &self,
        binding: crate::product::PreparedInteractionBinding<'_>,
    ) -> Result<bool, StorageError> {
        let receipt = serde_json::to_string(binding.effective_permission_receipt)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let result = sqlx::query(
            "UPDATE interactions SET harness_configuration_name=?3,harness_configuration_digest=?4,effective_execution_digest=?5,effective_permission_receipt_json=?6
             WHERE id=?1 AND graph_node_id=?2 AND completion_status='submitted'
               AND NOT EXISTS(SELECT 1 FROM action_invocations WHERE result_interaction_id=interactions.id)
               AND NOT EXISTS(SELECT 1 FROM interaction_submitted_input_attempts WHERE interaction_id=interactions.id)",
        )
        .bind(binding.interaction_id.value())
        .bind(binding.graph_node_id)
        .bind(binding.harness_configuration_name)
        .bind(binding.harness_configuration_digest)
        .bind(binding.effective_execution_digest)
        .bind(receipt)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// The paused and interrupted runs on run `run`'s node, in creation order, or `None` when
    /// `run` is not a node run.
    pub(crate) async fn restart_chain(
        &self,
        run: InteractionId,
    ) -> Result<Option<Vec<InteractionId>>, StorageError> {
        let Some(key) = self.node_run_key(run).await? else {
            return Ok(None);
        };
        let runs: Vec<i64> = sqlx::query_scalar(
            "SELECT run.id FROM node_runs queue JOIN interactions run ON run.id=queue.result_interaction_id
             WHERE queue.thread_id=?1 AND queue.node_id=?2 AND run.completion_status IN ('paused','interrupted')
             ORDER BY run.sequence,run.id",
        )
        .bind(key.thread_id.value())
        .bind(key.node_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(Some(
            runs.into_iter().map(InteractionId::from_database).collect(),
        ))
    }

    /// The runs Resume all starts in thread `thread`, in creation order: every run that is not
    /// on a node, and the head of each node's chain.
    pub(crate) async fn restart_heads(
        &self,
        thread: ThreadId,
    ) -> Result<Vec<InteractionId>, StorageError> {
        let runs: Vec<i64> = sqlx::query_scalar(
            "SELECT run.id FROM interactions run LEFT JOIN node_runs queue ON queue.result_interaction_id=run.id
             WHERE run.thread_id=?1 AND run.completion_status IN ('paused','interrupted')
               AND NOT EXISTS(SELECT 1 FROM action_invocations child WHERE child.result_interaction_id=run.id AND child.agent_invoked=1)
               AND (queue.result_interaction_id IS NULL OR NOT EXISTS(
                 SELECT 1 FROM node_runs ahead_queue JOIN interactions ahead ON ahead.id=ahead_queue.result_interaction_id
                 WHERE ahead_queue.thread_id=queue.thread_id AND ahead_queue.node_id=queue.node_id
                   AND ahead.completion_status IN ('paused','interrupted')
                   AND (ahead.sequence<run.sequence OR (ahead.sequence=run.sequence AND ahead.id<run.id))))
             ORDER BY run.sequence,run.id",
        )
        .bind(thread.value())
        .fetch_all(&self.pool)
        .await?;
        Ok(runs.into_iter().map(InteractionId::from_database).collect())
    }

    /// Claims paused or interrupted runs of thread `thread` to start again, in one
    /// transaction: each returns to `submitted`, its claimed state before it waited or ran.
    /// Returns the runs this call claimed; one already claimed or ended is left out. An
    /// archived thread refuses the claim.
    pub(crate) async fn claim_restart_runs(
        &self,
        thread: ThreadId,
        runs: &[InteractionId],
    ) -> Result<RestartClaim, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut claimed = Vec::new();
        for (index, run) in runs.iter().enumerate() {
            let changed = sqlx::query(
                "UPDATE interactions SET completion_status='submitted',completion_error=NULL
                 WHERE id=?1 AND thread_id=?2 AND completion_status IN ('paused','interrupted')
                   AND NOT EXISTS(SELECT 1 FROM action_invocations child WHERE child.result_interaction_id=interactions.id AND child.agent_invoked=1)
                   AND thread_id IN (SELECT id FROM threads WHERE conversation_import_id IS NULL)",
            )
            .bind(run.value())
            .bind(thread.value())
            .execute(&mut *transaction)
            .await?
            .rows_affected();
            if changed == 1 {
                // Durable evidence that the user resumed it, so a repeated Resume can report
                // it as it stands once it has ended.
                sqlx::query("INSERT INTO run_resumptions(interaction_id,resumed_at) VALUES (?1,strftime('%s','now') || '000') ON CONFLICT(interaction_id) DO NOTHING")
                    .bind(run.value())
                    .execute(&mut *transaction)
                    .await?;
                claimed.push(*run);
            } else if index == 0 {
                // The head must be the run that starts. A durable Resume of it means a
                // concurrent duplicate Resume won; anything else changed it.
                let resumed: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM run_resumptions WHERE interaction_id=?1)",
                )
                .bind(run.value())
                .fetch_one(&mut *transaction)
                .await?;
                transaction.rollback().await?;
                return Ok(if resumed {
                    RestartClaim::AlreadyResumed
                } else {
                    RestartClaim::Changed
                });
            }
        }
        transaction.commit().await?;
        Ok(RestartClaim::Claimed(claimed))
    }

    /// Returns a run whose resume was claimed, but which never started, to where the restart
    /// left it (`paused` or `interrupted`), with its note. A run something else moved on, or
    /// one that carries a Stop, is left alone.
    pub(crate) async fn restore_restart_run(
        &self,
        run: InteractionId,
        status: &str,
        note: Option<&str>,
    ) -> Result<bool, StorageError> {
        if !matches!(status, "paused" | "interrupted") {
            return Ok(false);
        }
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let restored = sqlx::query(
            "UPDATE interactions SET completion_status=?2,completion_error=?3
             WHERE id=?1 AND completion_status='submitted'
               AND NOT EXISTS(SELECT 1 FROM interaction_stop_requests WHERE interaction_id=?1)
               AND NOT EXISTS(SELECT 1 FROM interaction_attempts WHERE interaction_id=?1 AND outcome='running')",
        )
        .bind(run.value())
        .bind(status)
        .bind(note)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            == 1;
        // It never started, so it waits for the user's Resume as though none happened.
        if restored {
            sqlx::query("DELETE FROM run_resumptions WHERE interaction_id=?1")
                .bind(run.value())
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(restored)
    }

    /// Marks a discarded run whose graph current a Stop settled as discarded, not stopped by a
    /// follow-up Stop, so it reads as the user's Discard.
    pub(crate) async fn mark_restart_discarded(
        &self,
        run: InteractionId,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query(
            // Only the Stop's own text is replaced; a note an input restore appended is kept.
            "UPDATE interactions SET completion_error=?2 || substr(completion_error,length('Stopped. Send a follow-up to continue.')+1)
             WHERE id=?1 AND completion_status='stopped' AND completion_error LIKE 'Stopped. Send a follow-up to continue.%'",
        )
        .bind(run.value())
        .bind(super::RESTART_DISCARDED)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Discards a paused or interrupted run of thread `thread`: it ends stopped, never starts,
    /// and keeps its text. A run whose call the graph already holds keeps the Stop instead,
    /// so its graph current stops before the product row ends (`SettleBeforeStart`).
    pub(crate) async fn discard_restart_run(
        &self,
        thread: ThreadId,
        run: InteractionId,
        graph_available: bool,
    ) -> Result<RestartDiscard, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let bound: Option<bool> = sqlx::query_scalar(
            "SELECT i.graph_node_id IS NOT NULL OR EXISTS(SELECT 1 FROM action_invocations WHERE result_interaction_id=i.id AND prepared_graph_node_id IS NOT NULL)
             FROM interactions i WHERE i.id=?1 AND i.thread_id=?2 AND i.completion_status IN ('paused','interrupted')
               AND NOT EXISTS(SELECT 1 FROM action_invocations child WHERE child.result_interaction_id=i.id AND child.agent_invoked=1)
               AND i.thread_id IN (SELECT id FROM threads WHERE conversation_import_id IS NULL AND archived_at IS NULL)",
        )
        .bind(run.value())
        .bind(thread.value())
        .fetch_optional(&mut *transaction)
        .await?;
        let outcome = match bound {
            None => RestartDiscard::NotResumable,
            Some(true) if !graph_available => RestartDiscard::NeedsGraph,
            Some(false) => {
                sqlx::query("UPDATE interactions SET completion_status='stopped',completion_error=?2 WHERE id=?1 AND completion_status IN ('paused','interrupted')")
                    .bind(run.value())
                    .bind(super::RESTART_DISCARDED)
                    .execute(&mut *transaction)
                    .await?;
                RestartDiscard::Stopped
            }
            Some(true) => {
                sqlx::query("UPDATE interactions SET completion_status='submitted',completion_error=NULL WHERE id=?1 AND completion_status IN ('paused','interrupted')")
                    .bind(run.value())
                    .execute(&mut *transaction)
                    .await?;
                sqlx::query("INSERT INTO interaction_stop_requests(interaction_id,error) VALUES (?1,NULL) ON CONFLICT(interaction_id) DO UPDATE SET error=NULL")
                    .bind(run.value())
                    .execute(&mut *transaction)
                    .await?;
                RestartDiscard::SettleBeforeStart
            }
        };
        // Durable evidence that the user discarded it, so a repeated Discard can report it as
        // it stands while its graph Stop settles and after.
        if matches!(
            outcome,
            RestartDiscard::Stopped | RestartDiscard::SettleBeforeStart
        ) {
            sqlx::query("INSERT INTO run_discards(interaction_id,discarded_at) VALUES (?1,strftime('%s','now') || '000') ON CONFLICT(interaction_id) DO NOTHING")
                .bind(run.value())
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(outcome)
    }

    /// Projects a message whose graph current a Stop already ended before a restart (#722).
    /// It ends stopped, as a settled Stop does, and is never offered for Resume. Returns
    /// whether it changed; a run that already ended is left alone.
    pub(crate) async fn finish_restart_stopped(
        &self,
        run: InteractionId,
        timestamp: &str,
    ) -> Result<bool, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let changed = sqlx::query("UPDATE interactions SET completion_status='stopped',completion_error='Stopped. Send a follow-up to continue.' WHERE id=?1 AND completion_status IN ('submitted','running','waiting_for_approval','interrupted')")
            .bind(run.value())
            .execute(&mut *transaction)
            .await?
            .rows_affected()
            == 1;
        if changed {
            sqlx::query("UPDATE interaction_attempts SET outcome='cancelled',finished_at=?2,failure_category='cancelled_by_user',effect_boundary='unknown' WHERE interaction_id=?1 AND outcome='running'")
                .bind(run.value())
                .bind(timestamp)
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(changed)
    }

    /// Whether the user discarded this run after a restart (#722).
    pub(crate) async fn was_discarded(&self, run: InteractionId) -> Result<bool, StorageError> {
        Ok(
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM run_discards WHERE interaction_id=?1)")
                .bind(run.value())
                .fetch_one(&self.pool)
                .await?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store() -> (tempfile::TempDir, SqliteProductStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(&directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        (directory, store)
    }

    /// PAUSE-001: at startup every queued human-started run is paused, whether it waited
    /// behind its node or for capacity, and keeps the context it snapshotted. No wait for
    /// capacity survives, and a second startup leaves the paused runs paused.
    #[tokio::test]
    async fn startup_pauses_every_queued_run_and_keeps_its_context() {
        let (_directory, store) = store().await;
        let (thread, runs) = store.seed_node_runs_for_test(&[7, 7, 8]).await;
        for run in &runs {
            assert!(store.claim_interaction_preparing(*run).await.unwrap());
        }
        // Behind its node, and for capacity.
        assert!(store.queue_node_run(runs[1]).await.unwrap());
        assert!(store.queue_run_for_capacity(runs[2]).await.unwrap());
        // The waiting run consumed a confirmed node context: it travels with its Send.
        sqlx::query("INSERT INTO node_context_draft_resolutions(draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at,composer_text,consumed_interaction_id) VALUES ('waited',?1,'confirmed',1,7,3,5,'{}','Keep it','2','Keep it',?2)")
            .bind(thread.value())
            .bind(runs[2].value())
            .execute(&store.pool)
            .await
            .unwrap();

        assert_eq!(store.pause_queued_runs("Paused").await.unwrap(), 2);
        assert_eq!(store.completion_status_for_test(runs[0]).await, "submitted");
        for run in &runs[1..] {
            let paused = store.get_interaction(*run).await.unwrap().unwrap();
            assert_eq!(paused.completion_status, "paused");
            assert_eq!(paused.completion_error.as_deref(), Some("Paused"));
            assert!(!paused.waiting_for_capacity);
        }
        let waits: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM run_capacity_waits")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(waits, 0);
        let consumed: Option<i64> = sqlx::query_scalar(
            "SELECT consumed_interaction_id FROM node_context_draft_resolutions WHERE draft_id='waited'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(consumed, Some(runs[2].value()));
        // A paused run is neither claimed back by a slot nor by its node.
        assert!(!store.claim_capacity_run(runs[2]).await.unwrap());
        assert!(!store.claim_queued_node_run(runs[1]).await.unwrap());

        // A second startup changes nothing.
        assert_eq!(store.pause_queued_runs("Again").await.unwrap(), 0);
        assert_eq!(
            store
                .get_interaction(runs[1])
                .await
                .unwrap()
                .unwrap()
                .completion_error
                .as_deref(),
            Some("Paused")
        );
    }

    /// PAUSE-001: a paused send that reserved answered inputs before it paused is not active
    /// work, so its thread can be archived and shows no running symbol. Resuming it on the
    /// archived thread is refused.
    #[tokio::test]
    async fn a_paused_answered_send_never_blocks_archive() {
        let (_directory, store) = store().await;
        let (thread, runs) = store.seed_node_runs_for_test(&[7]).await;
        sqlx::query("INSERT INTO interaction_submitted_input_attempts(interaction_id,thread_id,draft_revision,authority_digest,semantic_digest,state,created_at) VALUES (?1,?2,1,'sha256:a','sha256:s','reserved','1')")
            .bind(runs[0].value())
            .bind(thread.value())
            .execute(&store.pool)
            .await
            .unwrap();
        store
            .set_completion_status_for_test(runs[0], "queued")
            .await;
        let busy = store.get_thread(thread).await.unwrap().unwrap();
        assert!(busy.archive_blocked);
        assert_eq!(store.pause_queued_runs("Paused").await.unwrap(), 1);
        let paused = store.get_thread(thread).await.unwrap().unwrap();
        assert!(!paused.archive_blocked);
        assert_eq!(paused.activity, None);
        assert_eq!(paused.resumable_runs, 1);
        store.set_thread_archived(thread, true).await.unwrap();
        assert!(store.claim_restart_runs(thread, &[runs[0]]).await.is_err());
        assert_eq!(store.completion_status_for_test(runs[0]).await, "paused");
        // Nor is it discarded there.
        assert_eq!(
            store
                .discard_restart_run(thread, runs[0], true)
                .await
                .unwrap(),
            RestartDiscard::NotResumable
        );
        assert_eq!(store.completion_status_for_test(runs[0]).await, "paused");
    }

    /// PAUSE-003: on a node, only the head of the paused chain is a Resume all head, and a
    /// chain lists its runs in creation order. Claiming a run returns it to `submitted` once.
    /// Discard stops an unprepared run at once and keeps its text; a prepared one keeps a Stop
    /// for its graph current to settle first.
    #[tokio::test]
    async fn chains_resume_in_order_and_discard_keeps_the_text() {
        let (_directory, store) = store().await;
        let (thread, runs) = store.seed_node_runs_for_test(&[7, 7, 7, 8]).await;
        store
            .set_completion_status_for_test(runs[0], "interrupted")
            .await;
        for run in &runs[1..] {
            store.set_completion_status_for_test(*run, "paused").await;
        }
        // A message turn that waited for capacity is not on a node.
        let message = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status,permission_profile_id) VALUES (?1,9,'Message','1','paused','auto')")
            .bind(thread.value())
            .execute(&store.pool)
            .await
            .unwrap()
            .last_insert_rowid();
        let message = InteractionId::from_database(message);

        assert_eq!(
            store.restart_chain(runs[2]).await.unwrap(),
            Some(runs[..3].to_vec())
        );
        assert_eq!(store.restart_chain(message).await.unwrap(), None);
        assert_eq!(
            store.restart_heads(thread).await.unwrap(),
            vec![runs[0], runs[3], message]
        );

        // Discarding the head makes the next run the head, still paused.
        assert_eq!(
            store
                .discard_restart_run(thread, runs[0], true)
                .await
                .unwrap(),
            RestartDiscard::Stopped
        );
        let discarded = store.get_interaction(runs[0]).await.unwrap().unwrap();
        assert_eq!(discarded.completion_status, "stopped");
        assert_eq!(discarded.text, "Run");
        // It never ran, so it neither owns nor obscures the thread's route, even with no model.
        assert_ne!(
            store
                .conversation_compatibility(thread)
                .await
                .unwrap()
                .status,
            "blocked"
        );
        assert_eq!(
            store
                .discard_restart_run(thread, runs[0], true)
                .await
                .unwrap(),
            RestartDiscard::NotResumable
        );
        assert_eq!(store.completion_status_for_test(runs[1]).await, "paused");
        assert_eq!(
            store.restart_heads(thread).await.unwrap(),
            vec![runs[1], runs[3], message]
        );

        // Claiming is exact and happens once.
        assert_eq!(
            store
                .claim_restart_runs(thread, &[runs[1], runs[2], runs[0]])
                .await
                .unwrap(),
            RestartClaim::Claimed(vec![runs[1], runs[2]])
        );
        assert_eq!(store.completion_status_for_test(runs[1]).await, "submitted");
        assert!(store.was_resumed(runs[1]).await.unwrap());
        assert!(!store.was_resumed(runs[0]).await.unwrap());
        // A duplicate Resume that lost the claim finds the winner's Resume on record.
        assert_eq!(
            store.claim_restart_runs(thread, &[runs[1]]).await.unwrap(),
            RestartClaim::AlreadyResumed
        );
        // A head a Discard ended was changed, and the run behind it is not claimed.
        assert_eq!(
            store
                .claim_restart_runs(thread, &[runs[0], runs[3]])
                .await
                .unwrap(),
            RestartClaim::Changed
        );
        assert_eq!(store.completion_status_for_test(runs[3]).await, "paused");
        assert!(!store.was_resumed(runs[3]).await.unwrap());
        // A claimed run that never started returns to where the restart left it.
        assert!(
            store
                .restore_restart_run(runs[2], "paused", Some("Paused"))
                .await
                .unwrap()
        );
        assert_eq!(store.completion_status_for_test(runs[2]).await, "paused");
        // A run returned to paused never started, so no Resume is on record for it.
        assert!(!store.was_resumed(runs[2]).await.unwrap());
        assert!(
            !store
                .restore_restart_run(runs[2], "paused", None)
                .await
                .unwrap()
        );
        assert!(
            !store
                .restore_restart_run(runs[1], "running", None)
                .await
                .unwrap()
        );

        // A run whose graph call is already prepared settles its Stop before it ends.
        sqlx::query("UPDATE interactions SET graph_node_id=903 WHERE id=?1")
            .bind(runs[3].value())
            .execute(&store.pool)
            .await
            .unwrap();
        // Without GraphComplete its graph current cannot stop, so nothing changes.
        assert_eq!(
            store
                .discard_restart_run(thread, runs[3], false)
                .await
                .unwrap(),
            RestartDiscard::NeedsGraph
        );
        assert_eq!(store.completion_status_for_test(runs[3]).await, "paused");
        assert_eq!(
            store
                .discard_restart_run(thread, runs[3], true)
                .await
                .unwrap(),
            RestartDiscard::SettleBeforeStart
        );
        let settling = store.get_interaction(runs[3]).await.unwrap().unwrap();
        assert_eq!(settling.completion_status, "submitted");
        assert!(settling.stop_requested);
        // Both Discards are on record; a run never discarded is not.
        assert!(store.was_discarded(runs[3]).await.unwrap());
        assert!(store.was_discarded(runs[0]).await.unwrap());
        assert!(!store.was_discarded(runs[1]).await.unwrap());
        // A run with a Stop is never returned to paused.
        assert!(
            !store
                .restore_restart_run(runs[3], "paused", None)
                .await
                .unwrap()
        );
        sqlx::query("UPDATE interactions SET completion_status='stopped',completion_error='Stopped. Send a follow-up to continue. A newer committed value was preserved.' WHERE id=?1")
            .bind(runs[3].value())
            .execute(&store.pool)
            .await
            .unwrap();
        assert!(store.mark_restart_discarded(runs[3]).await.unwrap());
        assert_eq!(
            store
                .get_interaction(runs[3])
                .await
                .unwrap()
                .unwrap()
                .completion_error,
            Some(format!(
                "{} A newer committed value was preserved.",
                super::super::RESTART_DISCARDED
            ))
        );
    }
}
