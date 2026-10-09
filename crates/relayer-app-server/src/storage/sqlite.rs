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
mod personal_presentation;
mod product_state;
mod projects;
mod schema;
mod stops;
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

/// Whether thread ?1 has a message turn in progress. Message turns resume the thread's native
/// root session, so they still run one at a time. A run started by an invoke action, whether a
/// user clicked it or an agent launched it, starts a fresh session and runs beside them.
const MESSAGE_TURN_IN_PROGRESS: &str = "SELECT EXISTS(SELECT 1 FROM interactions turn WHERE turn.thread_id=?1 AND turn.completion_status IN ('not_started','running','submitted') AND NOT EXISTS(SELECT 1 FROM action_invocations run WHERE run.result_interaction_id=turn.id))";

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
