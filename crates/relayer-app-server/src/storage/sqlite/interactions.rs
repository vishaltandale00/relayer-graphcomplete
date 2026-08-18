use super::SqliteProductStore;
use crate::product::{Interaction, InteractionId, ThreadId};
use crate::storage::StorageError;
use sqlx::{Row, sqlite::SqliteRow};

impl SqliteProductStore {
    pub(crate) async fn list_interactions(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<Interaction>, StorageError> {
        let rows = sqlx::query(
            "SELECT id,thread_id,sequence,text,created_at FROM interactions WHERE thread_id=?1 ORDER BY sequence ASC",
        )
        .bind(thread_id.value())
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(interaction_from_row).collect()
    }

    pub(crate) async fn insert_interaction(
        &self,
        thread_id: ThreadId,
        text: &str,
        timestamp: &str,
    ) -> Result<Interaction, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let sequence: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM interactions WHERE thread_id=?1",
        )
        .bind(thread_id.value())
        .fetch_one(&mut *transaction)
        .await?;
        let result = sqlx::query(
            "INSERT INTO interactions(thread_id,sequence,text,created_at) VALUES (?1,?2,?3,?4)",
        )
        .bind(thread_id.value())
        .bind(sequence)
        .bind(text)
        .bind(timestamp)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("UPDATE threads SET updated_at=?1 WHERE id=?2")
            .bind(timestamp)
            .bind(thread_id.value())
            .execute(&mut *transaction)
            .await?;
        let interaction = Interaction {
            id: InteractionId::from_database(result.last_insert_rowid()),
            thread_id,
            sequence,
            text: text.to_owned(),
            created_at: timestamp.to_owned(),
        };
        transaction.commit().await?;
        Ok(interaction)
    }
}

fn interaction_from_row(row: &SqliteRow) -> Result<Interaction, StorageError> {
    Ok(Interaction {
        id: InteractionId::from_database(row.try_get(0)?),
        thread_id: ThreadId::from_database(row.try_get(1)?),
        sequence: row.try_get(2)?,
        text: row.try_get(3)?,
        created_at: row.try_get(4)?,
    })
}
