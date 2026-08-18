use super::SqliteProductStore;
use crate::product::{InteractionId, ProjectId, Thread, ThreadId};
use crate::storage::StorageError;
use sqlx::{Row, sqlite::SqliteRow};

const THREAD_COLUMNS: &str = r#"
    SELECT t.id,t.title,t.project_id,t.created_at,t.updated_at,
           (SELECT id FROM interactions WHERE thread_id=t.id ORDER BY sequence ASC LIMIT 1)
    FROM threads t
"#;

impl SqliteProductStore {
    pub(crate) async fn list_threads(&self) -> Result<Vec<Thread>, StorageError> {
        let rows = sqlx::query(&format!(
            "{THREAD_COLUMNS} ORDER BY t.updated_at DESC, t.created_at DESC"
        ))
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(thread_from_row).collect()
    }

    pub(crate) async fn get_thread(&self, id: ThreadId) -> Result<Option<Thread>, StorageError> {
        sqlx::query(&format!("{THREAD_COLUMNS} WHERE t.id=?1"))
            .bind(id.value())
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(thread_from_row)
            .transpose()
    }

    pub(crate) async fn insert_thread_with_initial_interaction(
        &self,
        title: &str,
        project_id: Option<ProjectId>,
        initial_message: &str,
        timestamp: &str,
    ) -> Result<Thread, StorageError> {
        let mut transaction = self.pool.begin().await?;
        let thread = sqlx::query(
            "INSERT INTO threads(title,project_id,created_at,updated_at) VALUES (?1,?2,?3,?3)",
        )
        .bind(title)
        .bind(project_id.map(ProjectId::value))
        .bind(timestamp)
        .execute(&mut *transaction)
        .await?;
        let thread_id = ThreadId::from_database(thread.last_insert_rowid());
        sqlx::query(
            "INSERT INTO interactions(thread_id,sequence,text,created_at) VALUES (?1,1,?2,?3)",
        )
        .bind(thread_id.value())
        .bind(initial_message)
        .bind(timestamp)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        self.get_thread(thread_id)
            .await?
            .ok_or_else(|| sqlx::Error::RowNotFound.into())
    }
}

fn thread_from_row(row: &SqliteRow) -> Result<Thread, StorageError> {
    Ok(Thread {
        id: ThreadId::from_database(row.try_get(0)?),
        title: row.try_get(1)?,
        project_id: row
            .try_get::<Option<i64>, _>(2)?
            .map(ProjectId::from_database),
        created_at: row.try_get(3)?,
        updated_at: row.try_get(4)?,
        root_interaction_id: InteractionId::from_database(row.try_get(5)?),
    })
}
