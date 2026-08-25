use super::SqliteProductStore;
use crate::{
    product::{
        Annotation, AnnotationAnchor, AnnotationRevision, AnnotationState, NewAnnotationRevision,
        ThreadId,
    },
    storage::StorageError,
};
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

impl SqliteProductStore {
    pub(crate) async fn snapshot_annotations(
        &self,
        thread_ids: &[ThreadId],
    ) -> Result<Option<Vec<(ThreadId, Vec<Annotation>)>>, StorageError> {
        if thread_ids.is_empty()
            || thread_ids.len() > crate::product::MAX_ANNOTATION_SNAPSHOT_THREADS
            || thread_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != thread_ids.len()
        {
            return Err(StorageError::AnnotationConflict(
                "annotation snapshot thread set is empty, duplicated, or over limit".into(),
            ));
        }
        // The entire requested set is resolved under one SQLite read transaction.
        // Callers therefore cannot observe revisions from different database moments
        // across threads, even when a writer commits while this snapshot is assembled.
        let mut transaction = self.pool.begin().await?;
        for thread_id in thread_ids {
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)")
                    .bind(thread_id.value())
                    .fetch_one(&mut *transaction)
                    .await?;
            if !exists {
                transaction.rollback().await?;
                return Ok(None);
            }
        }
        let mut snapshots = Vec::with_capacity(thread_ids.len());
        for thread_id in thread_ids {
            snapshots.push((
                *thread_id,
                fetch_annotations(&mut transaction, *thread_id).await?,
            ));
        }
        transaction.commit().await?;
        Ok(Some(snapshots))
    }

    pub(crate) async fn list_annotations(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<Annotation>, StorageError> {
        // One annotation response is one SQLite snapshot. Without an explicit
        // transaction, an append between the header and revision queries could
        // produce a bundle that never existed at any single point in time.
        let mut transaction = self.pool.begin().await?;
        let annotations = fetch_annotations(&mut transaction, thread_id).await?;
        transaction.commit().await?;
        Ok(annotations)
    }

    pub(crate) async fn create_annotation(
        &self,
        thread_id: ThreadId,
        anchor: &AnnotationAnchor,
        revision: NewAnnotationRevision<'_>,
    ) -> Result<Annotation, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let thread_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)")
                .bind(thread_id.value())
                .fetch_one(&mut *transaction)
                .await?;
        if !thread_exists {
            return Err(StorageError::AnnotationConflict(format!(
                "thread {thread_id} does not exist"
            )));
        }
        let result = sqlx::query(
            "INSERT INTO annotations(thread_id,anchor_json,created_at) VALUES (?1,?2,?3)",
        )
        .bind(thread_id.value())
        .bind(json(anchor)?)
        .bind(revision.created_at)
        .execute(&mut *transaction)
        .await?;
        let annotation_id = result.last_insert_rowid();
        insert_revision(&mut transaction, annotation_id, 1, revision).await?;
        let annotation = fetch_annotation(&mut transaction, thread_id, annotation_id)
            .await?
            .expect("new annotation must be readable in its transaction");
        transaction.commit().await?;
        Ok(annotation)
    }

    pub(crate) async fn append_annotation_revision(
        &self,
        thread_id: ThreadId,
        annotation_id: i64,
        expected_revision: i64,
        revision: NewAnnotationRevision<'_>,
    ) -> Result<Annotation, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let current: Option<i64> = sqlx::query_scalar(
            "SELECT MAX(r.revision) FROM annotations a JOIN annotation_revisions r ON r.annotation_id=a.id WHERE a.thread_id=?1 AND a.id=?2",
        )
        .bind(thread_id.value())
        .bind(annotation_id)
        .fetch_optional(&mut *transaction)
        .await?
        .flatten();
        let current = current.ok_or_else(|| {
            StorageError::AnnotationConflict(format!(
                "annotation {annotation_id} does not belong to thread {thread_id}"
            ))
        })?;
        if current != expected_revision {
            return Err(StorageError::AnnotationConflict(format!(
                "expected revision {expected_revision}, but latest revision is {current}"
            )));
        }
        insert_revision(&mut transaction, annotation_id, current + 1, revision).await?;
        let annotation = fetch_annotation(&mut transaction, thread_id, annotation_id)
            .await?
            .expect("revised annotation must remain readable");
        transaction.commit().await?;
        Ok(annotation)
    }
}

async fn insert_revision(
    connection: &mut SqliteConnection,
    annotation_id: i64,
    revision_number: i64,
    revision: NewAnnotationRevision<'_>,
) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO annotation_revisions(annotation_id,revision,author_id,author_display_name,comment,rating,state,navigation_context_json,evidence_refs_json,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
    )
    .bind(annotation_id)
    .bind(revision_number)
    .bind(revision.author_id)
    .bind(revision.author_display_name)
    .bind(revision.comment)
    .bind(revision.rating.map(i64::from))
    .bind(revision.state.as_str())
    .bind(json(revision.navigation_context)?)
    .bind(json(revision.evidence_refs)?)
    .bind(revision.created_at)
    .execute(connection)
    .await?;
    Ok(())
}

async fn fetch_annotations(
    connection: &mut SqliteConnection,
    thread_id: ThreadId,
) -> Result<Vec<Annotation>, StorageError> {
    let rows = sqlx::query(
        "SELECT id,thread_id,anchor_json,created_at FROM annotations WHERE thread_id=?1 ORDER BY created_at,id",
    )
    .bind(thread_id.value())
    .fetch_all(&mut *connection)
    .await?;
    let mut annotations = Vec::with_capacity(rows.len());
    for row in rows {
        annotations.push(annotation_from_row(connection, &row).await?);
    }
    Ok(annotations)
}

async fn fetch_annotation(
    connection: &mut SqliteConnection,
    thread_id: ThreadId,
    annotation_id: i64,
) -> Result<Option<Annotation>, StorageError> {
    let Some(row) = sqlx::query(
        "SELECT id,thread_id,anchor_json,created_at FROM annotations WHERE thread_id=?1 AND id=?2",
    )
    .bind(thread_id.value())
    .bind(annotation_id)
    .fetch_optional(&mut *connection)
    .await?
    else {
        return Ok(None);
    };
    annotation_from_row(connection, &row).await.map(Some)
}

async fn annotation_from_row(
    connection: &mut SqliteConnection,
    row: &SqliteRow,
) -> Result<Annotation, StorageError> {
    let id: i64 = row.try_get("id")?;
    let revision_rows = sqlx::query(
        "SELECT revision,author_id,author_display_name,comment,rating,state,navigation_context_json,evidence_refs_json,created_at FROM annotation_revisions WHERE annotation_id=?1 ORDER BY revision",
    )
    .bind(id)
    .fetch_all(connection)
    .await?;
    let revisions = revision_rows
        .iter()
        .map(revision_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    let latest_revision = revisions
        .last()
        .map(|revision| revision.revision)
        .ok_or_else(|| StorageError::Serialization(format!("annotation {id} has no revisions")))?;
    Ok(Annotation {
        id,
        thread_id: row.try_get("thread_id")?,
        anchor: from_json(row.try_get::<String, _>("anchor_json")?)?,
        created_at: row.try_get("created_at")?,
        latest_revision,
        revisions,
    })
}

fn revision_from_row(row: &SqliteRow) -> Result<AnnotationRevision, StorageError> {
    let rating = row
        .try_get::<Option<i64>, _>("rating")?
        .map(|value| {
            u8::try_from(value).map_err(|_| {
                StorageError::Serialization("stored annotation rating is out of range".into())
            })
        })
        .transpose()?;
    Ok(AnnotationRevision {
        revision: row.try_get("revision")?,
        author_id: row.try_get("author_id")?,
        author_display_name: row.try_get("author_display_name")?,
        comment: row.try_get("comment")?,
        rating,
        state: AnnotationState::from_database(&row.try_get::<String, _>("state")?)
            .map_err(StorageError::Serialization)?,
        navigation_context: from_json(row.try_get::<String, _>("navigation_context_json")?)?,
        evidence_refs: from_json(row.try_get::<String, _>("evidence_refs_json")?)?,
        created_at: row.try_get("created_at")?,
    })
}

fn json<T: serde::Serialize + ?Sized>(value: &T) -> Result<String, StorageError> {
    serde_json::to_string(value).map_err(|error| StorageError::Serialization(error.to_string()))
}

fn from_json<T: serde::de::DeserializeOwned>(value: String) -> Result<T, StorageError> {
    serde_json::from_str(&value).map_err(|error| StorageError::Serialization(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn one_read_transaction_keeps_multi_thread_snapshot_consistent() {
        let temporary = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(temporary.path().join("product.sqlite3"))
            .await
            .unwrap();
        assert!(matches!(
            store.snapshot_annotations(&[]).await,
            Err(StorageError::AnnotationConflict(_))
        ));
        for id in [1_i64, 2] {
            sqlx::query(
                "INSERT INTO threads(id,title,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES (?1,?2,'1','1','codex-basic','auto')",
            )
            .bind(id)
            .bind(format!("Thread {id}"))
            .execute(&store.pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO annotations(id,thread_id,anchor_json,created_at) VALUES (?1,?1,'{\"kind\":\"thread\"}','1')",
            )
            .bind(id)
            .execute(&store.pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO annotation_revisions(annotation_id,revision,author_id,author_display_name,comment,rating,state,navigation_context_json,evidence_refs_json,created_at) VALUES (?1,1,'author','Author',?2,NULL,'active','{}','[]','1')",
            )
            .bind(id)
            .bind(format!("before-{id}"))
            .execute(&store.pool)
            .await
            .unwrap();
        }

        let mut snapshot = store.pool.begin().await.unwrap();
        let first = fetch_annotations(&mut snapshot, ThreadId::from_database(1))
            .await
            .unwrap();
        assert_eq!(first[0].revisions[0].comment, "before-1");

        sqlx::query(
            "UPDATE annotation_revisions SET comment='after-2' WHERE annotation_id=2 AND revision=1",
        )
        .execute(&store.pool)
        .await
        .unwrap();

        let second = fetch_annotations(&mut snapshot, ThreadId::from_database(2))
            .await
            .unwrap();
        assert_eq!(second[0].revisions[0].comment, "before-2");
        snapshot.commit().await.unwrap();

        let current = store
            .list_annotations(ThreadId::from_database(2))
            .await
            .unwrap();
        assert_eq!(current[0].revisions[0].comment, "after-2");
    }
}
