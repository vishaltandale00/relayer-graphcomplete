mod action_invocations;
mod approvals;
mod catalog;
mod interactions;
mod migrations;
mod product_state;
mod projects;
mod schema;
mod threads;

use super::StorageError;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use std::{path::Path, time::Duration};

#[derive(Clone)]
pub(crate) struct SqliteProductStore {
    pool: SqlitePool,
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
        Ok(Self { pool })
    }
}
