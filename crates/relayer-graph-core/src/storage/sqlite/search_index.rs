use sqlx::SqliteConnection;

use crate::{GraphError, SearchIndexComponent, SearchIndexRevision, SearchTarget};

pub(crate) struct SearchIndexTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

impl<'connection> SearchIndexTable<'connection> {
    pub(crate) fn new(connection: &'connection mut SqliteConnection) -> Self {
        Self { connection }
    }

    /// The last revision this target is known to have committed, or `None` when
    /// it has never been indexed.
    pub(crate) async fn revision(
        &mut self,
        target: SearchTarget,
    ) -> Result<Option<SearchIndexRevision>, GraphError> {
        sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM search_index_targets WHERE target_kind=?1 AND target_id=?2",
        )
        .bind(target.kind())
        .bind(target.id())
        .fetch_optional(&mut *self.connection)
        .await?
        .map(valid_revision)
        .transpose()
    }

    /// Record the revision a target has committed to the search store. Written
    /// inside the caller's still-open write transaction, so it becomes durable
    /// with the closure it describes or not at all.
    pub(crate) async fn record_revision(
        &mut self,
        target: SearchTarget,
        revision: SearchIndexRevision,
    ) -> Result<(), GraphError> {
        sqlx::query(
            "INSERT INTO search_index_targets(target_kind,target_id,revision,updated_at) \
             VALUES (?1,?2,?3,datetime('now')) \
             ON CONFLICT(target_kind,target_id) \
             DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at",
        )
        .bind(target.kind())
        .bind(target.id())
        .bind(revision.value())
        .execute(&mut *self.connection)
        .await?;
        Ok(())
    }

    pub(crate) async fn version(
        &mut self,
        component: SearchIndexComponent,
    ) -> Result<Option<String>, GraphError> {
        Ok(sqlx::query_scalar::<_, String>(
            "SELECT version FROM search_index_versions WHERE component=?1",
        )
        .bind(component.column())
        .fetch_optional(&mut *self.connection)
        .await?)
    }

    pub(crate) async fn record_version(
        &mut self,
        component: SearchIndexComponent,
        version: &str,
    ) -> Result<(), GraphError> {
        sqlx::query(
            "INSERT INTO search_index_versions(component,version) VALUES (?1,?2) \
             ON CONFLICT(component) DO UPDATE SET version=excluded.version",
        )
        .bind(component.column())
        .bind(version)
        .execute(&mut *self.connection)
        .await?;
        Ok(())
    }
}

fn valid_revision(value: i64) -> Result<SearchIndexRevision, GraphError> {
    SearchIndexRevision::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid search revision".into()))
}
