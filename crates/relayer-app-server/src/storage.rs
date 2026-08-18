mod sqlite;

use crate::product::{Interaction, Project, Thread, ThreadId};
pub(crate) use sqlite::SqliteProductStore;
use thiserror::Error;

pub(crate) struct ProductStateSnapshot {
    pub(crate) projects: Vec<Project>,
    pub(crate) threads: Vec<Thread>,
    pub(crate) selected_thread_id: Option<ThreadId>,
    pub(crate) interactions: Vec<Interaction>,
}

pub(crate) struct ThreadSnapshot {
    pub(crate) thread: Option<Thread>,
    pub(crate) interactions: Vec<Interaction>,
}

#[derive(Debug, Error)]
pub(crate) enum StorageError {
    #[error("database operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("database migration failed: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("product database schema is incompatible: {0}")]
    IncompatibleSchema(String),
    #[error("stored product JSON is invalid: {0}")]
    Serialization(String),
}
