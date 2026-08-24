use super::{SqliteProductStore, catalog};
use crate::product::{InteractionId, ProjectId, Thread, ThreadId, ValidateModelSelectionCommand};
use crate::storage::{NewThreadRecord, StorageError};
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

const THREAD_COLUMNS: &str = r#"
    SELECT t.id,t.title,t.project_id,t.created_at,t.updated_at,
           t.harness_configuration_name,
           t.permission_profile_id,
           (SELECT id FROM interactions WHERE thread_id=t.id ORDER BY sequence ASC LIMIT 1),
           t.conversation_import_id IS NOT NULL
    FROM threads t
"#;

const VISIBLE_THREAD: &str = "(t.conversation_import_id IS NULL OR EXISTS(SELECT 1 FROM conversation_imports ci WHERE ci.id=t.conversation_import_id AND ci.state='published'))";

impl SqliteProductStore {
    pub(crate) async fn list_threads(&self) -> Result<Vec<Thread>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        fetch_threads(&mut connection).await
    }

    pub(crate) async fn get_thread(&self, id: ThreadId) -> Result<Option<Thread>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        fetch_thread(&mut connection, id).await
    }

    pub(crate) async fn insert_thread_with_initial_interaction(
        &self,
        record: NewThreadRecord<'_>,
    ) -> Result<Thread, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(selection) = record.model_selection {
            let command = ValidateModelSelectionCommand {
                harness_id: record.harness_configuration_name.to_owned(),
                family_id: selection.family_id,
                provider_id: selection.provider_id.clone(),
                model_id: selection.model_id.clone(),
            };
            catalog::validate_model_selection_on(&mut transaction, &command).await?;
            catalog::validate_provider_catalog_freshness_on(&mut transaction, &command).await?;
        }
        let thread = sqlx::query(
            "INSERT INTO threads(title,project_id,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES (?1,?2,?3,?3,?4,?5)",
        )
        .bind(record.title)
        .bind(record.project_id.map(ProjectId::value))
        .bind(record.timestamp)
        .bind(record.harness_configuration_name)
        .bind(record.permission_profile_id)
        .execute(&mut *transaction)
        .await?;
        let thread_id = ThreadId::from_database(thread.last_insert_rowid());
        sqlx::query(
            "INSERT INTO interactions(thread_id,sequence,text,created_at,permission_profile_id,model_provider_id,provider_model_id,model_family_id) VALUES (?1,1,?2,?3,?4,?5,?6,?7)",
        )
        .bind(thread_id.value())
        .bind(record.initial_message)
        .bind(record.timestamp)
        .bind(record.permission_profile_id)
        .bind(record.model_selection.map(|selection| selection.provider_id.as_str()))
        .bind(record.model_selection.map(|selection| selection.model_id.as_str()))
        .bind(record.model_selection.map(|selection| selection.family_id.value()))
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        self.get_thread(thread_id)
            .await?
            .ok_or_else(|| sqlx::Error::RowNotFound.into())
    }
}

pub(super) async fn fetch_threads(
    connection: &mut SqliteConnection,
) -> Result<Vec<Thread>, StorageError> {
    let rows = sqlx::query(&format!(
        "{THREAD_COLUMNS} WHERE {VISIBLE_THREAD} ORDER BY t.updated_at DESC, t.created_at DESC, t.id DESC"
    ))
    .fetch_all(connection)
    .await?;
    rows.iter().map(thread_from_row).collect()
}

pub(super) async fn fetch_thread(
    connection: &mut SqliteConnection,
    id: ThreadId,
) -> Result<Option<Thread>, StorageError> {
    sqlx::query(&format!(
        "{THREAD_COLUMNS} WHERE t.id=?1 AND {VISIBLE_THREAD}"
    ))
    .bind(id.value())
    .fetch_optional(connection)
    .await?
    .as_ref()
    .map(thread_from_row)
    .transpose()
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
        harness_configuration_name: row.try_get(5)?,
        permission_profile_id: row.try_get(6)?,
        root_interaction_id: InteractionId::from_database(row.try_get(7)?),
        imported: row.try_get::<i64, _>(8)? != 0,
    })
}
