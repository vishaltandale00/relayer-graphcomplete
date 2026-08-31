use sqlx::{FromRow, SqliteConnection};

use crate::{GraphError, ProjectId, SearchTarget, ThreadId};

pub(crate) struct ImportTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

#[derive(FromRow)]
struct ImportTargetRow {
    project_id: Option<i64>,
    thread_id: i64,
}

impl<'connection> ImportTable<'connection> {
    pub(crate) fn new(connection: &'connection mut SqliteConnection) -> Self {
        Self { connection }
    }

    /// The logical publication target reserved by an existing import stage.
    pub(crate) async fn target(&mut self, import_id: &str) -> Result<SearchTarget, GraphError> {
        let row = sqlx::query_as::<_, ImportTargetRow>(
            "SELECT project_id,thread_id FROM graph_imports WHERE import_id=?1",
        )
        .bind(import_id)
        .fetch_one(&mut *self.connection)
        .await?;
        let project_id = row
            .project_id
            .map(|value| {
                ProjectId::new(value)
                    .ok_or_else(|| GraphError::Internal("invalid imported project ID".into()))
            })
            .transpose()?;
        let thread_id = ThreadId::new(row.thread_id).ok_or_else(|| {
            GraphError::Internal("imported conversation has an invalid thread".into())
        })?;
        Ok(SearchTarget::new(project_id, thread_id))
    }
}
