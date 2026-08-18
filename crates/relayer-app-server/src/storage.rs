mod sqlite;

pub(crate) use sqlite::SqliteProductStore;
use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum StorageError {
    #[error("database operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("database migration failed: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
}
