use super::SqliteProductStore;
use crate::{
    conversation_export::{
        ConversationExportHeader, ConversationExportTurn, ExportCompletionStatus,
    },
    product::{InteractionId, ThreadId},
    storage::{
        ConversationImportRecord, NewConversationImport, StagedConversationImport,
        StagedConversationTurnSummary, StorageError,
    },
};
use sqlx::Row;

impl SqliteProductStore {
    pub(crate) async fn staged_conversation_import_ids(&self) -> Result<Vec<String>, StorageError> {
        sqlx::query_scalar(
            "SELECT id FROM conversation_imports WHERE state='staging' ORDER BY created_at,id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(Into::into)
    }

    pub(crate) async fn stage_conversation_import(
        &self,
        input: NewConversationImport<'_>,
    ) -> Result<StagedConversationImport, StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query("INSERT INTO conversation_imports(id,source_sha256,export_version,producer_json,header_json,state,created_at) VALUES (?1,?2,?3,?4,?5,'staging',?6)")
            .bind(input.id).bind(input.source_sha256).bind(i64::from(input.header.export_version))
            .bind(serde_json::to_string(&input.header.producer).map_err(serialization)?)
            .bind(serde_json::to_string(input.header).map_err(serialization)?)
            .bind(&input.header.exported_at).execute(&mut *tx).await?;
        let thread = sqlx::query("INSERT INTO threads(title,project_id,created_at,updated_at,harness_configuration_name,permission_profile_id,conversation_import_id) VALUES (?1,NULL,?2,?2,?3,?4,?5)")
            .bind(&input.header.conversation.title).bind(&input.header.conversation.created_at)
            .bind(&input.header.conversation.harness_configuration_name).bind(&input.header.conversation.permission_profile_id)
            .bind(input.id).execute(&mut *tx).await?;
        let thread_id = ThreadId::from_database(thread.last_insert_rowid());
        tx.commit().await?;
        Ok(StagedConversationImport {
            id: input.id.to_owned(),
            source_sha256: input.source_sha256.to_owned(),
            header: input.header.clone(),
            thread_id,
            turns: Vec::new(),
        })
    }

    pub(crate) async fn append_conversation_import_turn(
        &self,
        import_id: &str,
        turn: &ConversationExportTurn,
    ) -> Result<StagedConversationTurnSummary, StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let thread_id: i64 = sqlx::query_scalar("SELECT t.id FROM threads t JOIN conversation_imports ci ON ci.id=t.conversation_import_id WHERE ci.id=?1 AND ci.state='staging'")
            .bind(import_id).fetch_one(&mut *tx).await?;
        let completion = &turn.completion;
        let result = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status,harness_configuration_name,harness_configuration_digest,completion_error,permission_profile_id,effective_execution_digest,effective_permission_receipt_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)")
            .bind(thread_id).bind(i64::from(turn.sequence)).bind(&turn.text).bind(&turn.created_at)
            .bind(completion_status(completion.status)).bind(&completion.harness_configuration_name)
            .bind(&completion.harness_configuration_digest).bind(&completion.error).bind(&completion.permission_profile_id)
            .bind(&completion.effective_execution_digest)
            .bind(completion.effective_permission_receipt.as_ref().map(serde_json::to_string).transpose().map_err(serialization)?)
            .execute(&mut *tx).await?;
        let interaction_id = InteractionId::from_database(result.last_insert_rowid());
        sqlx::query("INSERT INTO imported_turns(conversation_import_id,source_turn_id,product_interaction_id,source_origin_json,source_completion_json) VALUES (?1,?2,?3,?4,?5)")
            .bind(import_id).bind(&turn.id).bind(interaction_id.value())
            .bind(serde_json::to_string(&turn.origin).map_err(serialization)?)
            .bind(serde_json::to_string(turn).map_err(serialization)?)
            .execute(&mut *tx).await?;
        sqlx::query("UPDATE threads SET updated_at=?1 WHERE id=?2")
            .bind(&turn.created_at)
            .bind(thread_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(StagedConversationTurnSummary {
            source_turn_id: turn.id.clone(),
            sequence: turn.sequence,
            interaction_id,
            completion_status: turn.completion.status,
        })
    }

    pub(crate) async fn finalize_conversation_import_digest(
        &self,
        import_id: &str,
        source_sha256: &str,
    ) -> Result<(), StorageError> {
        let result = sqlx::query(
            "UPDATE conversation_imports SET source_sha256=?1 WHERE id=?2 AND state='staging'",
        )
        .bind(source_sha256)
        .bind(import_id)
        .execute(&self.pool)
        .await?;
        require_one(result.rows_affected(), "conversation import is not staged")
    }

    pub(crate) async fn staged_conversation_import(
        &self,
        import_id: &str,
    ) -> Result<StagedConversationImport, StorageError> {
        let row = sqlx::query("SELECT ci.source_sha256,ci.header_json,t.id FROM conversation_imports ci JOIN threads t ON t.conversation_import_id=ci.id WHERE ci.id=?1 AND ci.state='staging'")
            .bind(import_id).fetch_one(&self.pool).await?;
        let turns = sqlx::query("SELECT it.source_turn_id,i.sequence,it.product_interaction_id,i.completion_status FROM imported_turns it JOIN interactions i ON i.id=it.product_interaction_id WHERE it.conversation_import_id=?1 ORDER BY i.sequence")
            .bind(import_id).fetch_all(&self.pool).await?.into_iter().map(|turn| {
                Ok(StagedConversationTurnSummary {
                    source_turn_id: turn.try_get(0)?,
                    sequence: u32::try_from(turn.try_get::<i64,_>(1)?).map_err(|_| StorageError::Serialization("stored import sequence is invalid".into()))?,
                    interaction_id: InteractionId::from_database(turn.try_get(2)?),
                    completion_status: parse_completion_status(&turn.try_get::<String,_>(3)?)?,
                })
            }).collect::<Result<Vec<_>, StorageError>>()?;
        Ok(StagedConversationImport {
            id: import_id.to_owned(),
            source_sha256: row.try_get(0)?,
            header: serde_json::from_str(&row.try_get::<String, _>(1)?).map_err(serialization)?,
            thread_id: ThreadId::from_database(row.try_get(2)?),
            turns,
        })
    }

    pub(crate) async fn staged_conversation_turn(
        &self,
        import_id: &str,
        source_turn_id: &str,
    ) -> Result<ConversationExportTurn, StorageError> {
        let json: String = sqlx::query_scalar("SELECT it.source_completion_json FROM imported_turns it JOIN conversation_imports ci ON ci.id=it.conversation_import_id WHERE ci.id=?1 AND ci.state='staging' AND it.source_turn_id=?2")
            .bind(import_id).bind(source_turn_id).fetch_one(&self.pool).await?;
        serde_json::from_str(&json).map_err(serialization)
    }

    pub(crate) async fn prepare_conversation_import_turn(
        &self,
        import_id: &str,
        source_turn_id: &str,
        graph_node_id: Option<i64>,
        output: Option<&serde_json::Value>,
    ) -> Result<(), StorageError> {
        let result = sqlx::query("UPDATE interactions SET graph_node_id=?1,completion_output_json=?2 WHERE id=(SELECT it.product_interaction_id FROM imported_turns it JOIN conversation_imports ci ON ci.id=it.conversation_import_id WHERE ci.id=?3 AND ci.state='staging' AND it.source_turn_id=?4)")
            .bind(graph_node_id)
            .bind(output.map(serde_json::to_string).transpose().map_err(serialization)?)
            .bind(import_id).bind(source_turn_id).execute(&self.pool).await?;
        require_one(
            result.rows_affected(),
            "conversation import turn is missing or not staged",
        )
    }

    pub(crate) async fn publish_conversation_import(
        &self,
        import_id: &str,
        published_at: &str,
    ) -> Result<(), StorageError> {
        let result = sqlx::query("UPDATE conversation_imports SET state='published',published_at=?1 WHERE id=?2 AND state='staging' AND source_sha256 LIKE 'sha256:%' AND NOT EXISTS(SELECT 1 FROM imported_turns it JOIN interactions i ON i.id=it.product_interaction_id WHERE it.conversation_import_id=?2 AND i.completion_status='accepted' AND (i.graph_node_id IS NULL OR i.completion_output_json IS NULL))")
            .bind(published_at).bind(import_id).execute(&self.pool).await?;
        require_one(
            result.rows_affected(),
            "conversation import is incomplete or not staged",
        )
    }

    pub(crate) async fn remove_conversation_import(
        &self,
        import_id: &str,
    ) -> Result<(), StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let threads = sqlx::query("DELETE FROM threads WHERE conversation_import_id=?1 AND EXISTS(SELECT 1 FROM conversation_imports WHERE id=?1 AND state='staging')")
            .bind(import_id).execute(&mut *tx).await?.rows_affected();
        let imports =
            sqlx::query("DELETE FROM conversation_imports WHERE id=?1 AND state='staging'")
                .bind(import_id)
                .execute(&mut *tx)
                .await?
                .rows_affected();
        if threads != 1 || imports != 1 {
            return Err(StorageError::IncompatibleSchema(
                "conversation import is not staged".into(),
            ));
        }
        tx.commit().await?;
        Ok(())
    }

    pub(crate) async fn list_published_conversation_imports(
        &self,
    ) -> Result<Vec<ConversationImportRecord>, StorageError> {
        let rows = sqlx::query("SELECT ci.id,ci.source_sha256,ci.header_json,t.id FROM conversation_imports ci JOIN threads t ON t.conversation_import_id=ci.id WHERE ci.state='published' ORDER BY ci.created_at DESC").fetch_all(&self.pool).await?;
        let mut records = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get(0)?;
            let turns = sqlx::query("SELECT it.source_turn_id,it.product_interaction_id,i.graph_node_id,i.completion_status FROM imported_turns it JOIN interactions i ON i.id=it.product_interaction_id WHERE it.conversation_import_id=?1 ORDER BY i.sequence")
                .bind(&id).fetch_all(&self.pool).await?.into_iter()
                .map(|turn| Ok((turn.try_get(0)?, InteractionId::from_database(turn.try_get(1)?), turn.try_get(2)?, turn.try_get(3)?)))
                .collect::<Result<Vec<_>, sqlx::Error>>()?;
            records.push(ConversationImportRecord {
                id,
                source_sha256: row.try_get(1)?,
                header: serde_json::from_str::<ConversationExportHeader>(
                    &row.try_get::<String, _>(2)?,
                )
                .map_err(serialization)?,
                thread_id: ThreadId::from_database(row.try_get(3)?),
                turns,
            });
        }
        Ok(records)
    }

    pub(crate) async fn thread_is_imported(
        &self,
        thread_id: ThreadId,
    ) -> Result<bool, StorageError> {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1 AND conversation_import_id IS NOT NULL)")
            .bind(thread_id.value()).fetch_one(&self.pool).await.map_err(Into::into)
    }
}

fn require_one(rows: u64, message: &str) -> Result<(), StorageError> {
    if rows == 1 {
        Ok(())
    } else {
        Err(StorageError::IncompatibleSchema(message.into()))
    }
}

fn serialization(error: serde_json::Error) -> StorageError {
    StorageError::Serialization(error.to_string())
}

fn completion_status(status: ExportCompletionStatus) -> &'static str {
    match status {
        ExportCompletionStatus::NotStarted => "not_started",
        ExportCompletionStatus::Running => "running",
        ExportCompletionStatus::Submitted => "submitted",
        ExportCompletionStatus::Accepted => "accepted",
        ExportCompletionStatus::Failed => "failed",
    }
}

fn parse_completion_status(value: &str) -> Result<ExportCompletionStatus, StorageError> {
    match value {
        "not_started" => Ok(ExportCompletionStatus::NotStarted),
        "running" => Ok(ExportCompletionStatus::Running),
        "submitted" => Ok(ExportCompletionStatus::Submitted),
        "accepted" => Ok(ExportCompletionStatus::Accepted),
        "failed" => Ok(ExportCompletionStatus::Failed),
        other => Err(StorageError::Serialization(format!(
            "stored import completion status is invalid: {other}"
        ))),
    }
}
