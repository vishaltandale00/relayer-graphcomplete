/// Whether `$result` names a user's invocation result whose preparation failed before anything
/// ran and waits for its action's Retry. Such a reservation is not running. One predicate serves
/// the Retry path and the thread's live state, so they never disagree.
macro_rules! recoverable_user_preparation {
    ($result:literal) => {
        concat!(
            "EXISTS(SELECT 1 FROM action_invocations ai JOIN interactions result ON result.id=ai.result_interaction_id JOIN invocation_input_submission_receipts receipt ON receipt.result_interaction_id=result.id WHERE result.id=",
            $result,
            " AND ai.authoritative=1 AND ai.agent_invoked=0 AND ai.invocation_key!='legacy' AND result.graph_node_id IS NULL AND NOT EXISTS(SELECT 1 FROM interaction_stop_requests stop WHERE stop.interaction_id=result.id) AND NOT EXISTS(SELECT 1 FROM completion_executions e WHERE e.interaction_id=result.id) AND NOT EXISTS(SELECT 1 FROM interaction_attempts a WHERE a.interaction_id=result.id AND (a.outcome!='model_failed' OR a.effect_boundary!='none')) AND (result.completion_status IN ('not_started','submitted') OR result.completion_status='failed' AND ai.prepared_graph_node_id IS NOT NULL AND EXISTS(SELECT 1 FROM interaction_attempts a WHERE a.interaction_id=result.id AND a.outcome='model_failed' AND a.effect_boundary='none')))"
        )
    };
}

mod action_invocations;
mod annotations;
mod approvals;
mod attempts;
mod catalog;
mod completion_executions;
mod context_drafts;
mod conversation_compatibility;
pub(crate) use conversation_compatibility::ConversationCompatibility;
mod conversation_imports;
mod input_drafts;
mod interaction_contexts;
mod interactions;
mod migrations;
mod node_runs;
mod personal_presentation;
mod product_state;
mod projects;
mod run_capacity;
mod schema;
mod stops;
pub(crate) use stops::QueuedStop;
mod threads;

use super::StorageError;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};
use tokio::sync::Mutex;

pub(crate) use personal_presentation::PersonalPresentationPin;

/// The model selection of thread ?1's latest human turn, which a new turn inherits. A child an
/// agent launched is not a human turn, so its selection is never inherited.
const LATEST_HUMAN_TURN_MODEL: &str = "SELECT turn.model_provider_id,turn.provider_model_id,turn.model_family_id FROM interactions turn WHERE turn.thread_id=?1 AND NOT EXISTS(SELECT 1 FROM action_invocations child WHERE child.result_interaction_id=turn.id AND child.agent_invoked=1) ORDER BY turn.sequence DESC LIMIT 1";

/// The error of a queued run a Stop removed before it started (#718, #720).
pub(crate) const QUEUED_RUN_STOPPED: &str = "Stopped before it started.";

/// The error of a message turn that waited for capacity when Relayer stopped (#720).
pub(crate) const CAPACITY_WAIT_INTERRUPTED: &str =
    "Relayer stopped before this message had capacity to start. Send it again to run it.";

/// The error of a message a model failure returned to unsent after a later message was sent.
pub(crate) const STALE_RETURNED_MESSAGE: &str = "This message could not run, and a later message was sent before it was retried. Send it again to run it.";

/// Thread messages run in parallel (#719), so a message a model failure returned to unsent can
/// be followed by later messages. Its draft is then stale: only the latest message can be
/// retried in place (`interaction_retry_stale`). A message returned before any attempt began
/// records no attempt, whether or not its graph interaction was already bound; it is recognized
/// by the harness its preparation recorded, which a message that was never prepared does not
/// have. It is settled as failed, with its error, so it
/// never stays `not_started` and holds its thread out of the archive. Its restored inputs and
/// context confirmations stay restored. Call this inside the transaction that creates a message
/// or returns one to unsent.
pub(super) async fn fail_stale_returned_messages(
    connection: &mut sqlx::SqliteConnection,
    thread_id: i64,
) -> Result<(), StorageError> {
    sqlx::query(
        "UPDATE interactions SET completion_status='failed',completion_error=?2 WHERE thread_id=?1 AND completion_status='not_started' AND ((SELECT a.outcome FROM interaction_attempts a WHERE a.interaction_id=interactions.id ORDER BY a.attempt_number DESC LIMIT 1) IS 'model_failed' OR (harness_configuration_name IS NOT NULL AND NOT EXISTS(SELECT 1 FROM interaction_attempts a WHERE a.interaction_id=interactions.id))) AND NOT EXISTS(SELECT 1 FROM action_invocations run WHERE run.result_interaction_id=interactions.id) AND EXISTS(SELECT 1 FROM interactions later WHERE later.thread_id=interactions.thread_id AND later.sequence>interactions.sequence AND NOT EXISTS(SELECT 1 FROM action_invocations run WHERE run.result_interaction_id=later.id))",
    )
    .bind(thread_id)
    .bind(STALE_RETURNED_MESSAGE)
    .execute(connection)
    .await?;
    Ok(())
}

/// [`fail_stale_returned_messages`] for the thread of interaction ?1.
pub(super) async fn fail_stale_returned_messages_beside(
    connection: &mut sqlx::SqliteConnection,
    interaction_id: i64,
) -> Result<(), StorageError> {
    let thread_id: i64 = sqlx::query_scalar("SELECT thread_id FROM interactions WHERE id=?1")
        .bind(interaction_id)
        .fetch_one(&mut *connection)
        .await?;
    fail_stale_returned_messages(connection, thread_id).await
}

#[derive(Clone)]
pub(crate) struct SqliteProductStore {
    pool: SqlitePool,
    /// The highest readiness generation accepted per harness in this process (PROV-005).
    /// Electron restarts its generation counter with every process, and the app server
    /// never outlives it in the desktop, so this ordering is deliberately not persisted.
    harness_readiness_generations: Arc<Mutex<HashMap<String, u64>>>,
}

impl SqliteProductStore {
    pub(crate) async fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        if let Err(error) = schema::validate_existing_or_empty(&pool).await {
            pool.close().await;
            return Err(error);
        }
        if let Err(error) = migrations::run(&pool).await {
            pool.close().await;
            return Err(error);
        }
        if let Err(error) = schema::validate(&pool).await {
            pool.close().await;
            return Err(error);
        }
        Ok(Self {
            pool,
            harness_readiness_generations: Arc::default(),
        })
    }
}
