pub(crate) mod actions;
pub(crate) mod completions;
pub(crate) mod contexts;
pub(crate) mod currents;
pub(crate) mod edges;
pub(crate) mod input_children;
pub(crate) mod layers;
pub(crate) mod migrations;
pub(crate) mod nodes;
pub(crate) mod personal_presentation;

use std::{path::Path, str::FromStr, time::Duration};

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Sqlite, SqliteConnection, SqlitePool, Transaction, pool::PoolConnection};

use crate::GraphError;

pub(crate) type GraphConnection = SqliteConnection;

#[derive(Clone)]
pub(crate) struct SqliteGraphStore {
    pool: SqlitePool,
}

impl SqliteGraphStore {
    pub(crate) async fn open(path: impl AsRef<Path>) -> Result<Self, GraphError> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        Self::migrate_or_close(pool).await
    }

    pub(crate) async fn in_memory() -> Result<Self, GraphError> {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")?
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Memory)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        Self::migrate_or_close(pool).await
    }

    pub(crate) async fn acquire(&self) -> Result<PoolConnection<Sqlite>, GraphError> {
        Ok(self.pool.acquire().await?)
    }

    pub(crate) async fn begin_write(&self) -> Result<Transaction<'static, Sqlite>, GraphError> {
        Ok(self.pool.begin_with("BEGIN IMMEDIATE").await?)
    }

    pub(crate) async fn begin_read(&self) -> Result<Transaction<'static, Sqlite>, GraphError> {
        Ok(self.pool.begin().await?)
    }

    pub(crate) async fn close(&self) {
        self.pool.close().await;
    }

    async fn migrate_or_close(pool: SqlitePool) -> Result<Self, GraphError> {
        if let Err(error) = migrations::run(&pool).await {
            pool.close().await;
            return Err(error);
        }
        Ok(Self { pool })
    }
}
