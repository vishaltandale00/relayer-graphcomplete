use super::SqliteProductStore;
use crate::{
    conversation_export::{
        ConversationExportHeader, ConversationExportTurn, ExportCompletionStatus,
    },
    product::{InteractionId, ThreadId},
    storage::{
        ConversationImportRecord, ImportedTurnExportRecord, NewConversationImport,
        StagedConversationImport, StagedConversationTurnSummary, StorageError,
    },
};
use sqlx::Row;

impl SqliteProductStore {
    pub(crate) async fn imported_bound_input_export_records(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<crate::conversation_export::ExportAction>, StorageError> {
        let header: Option<String> = sqlx::query_scalar("SELECT ci.header_json FROM conversation_imports ci JOIN threads t ON t.conversation_import_id=ci.id WHERE t.id=?1 AND ci.state='published'")
            .bind(thread_id.value()).fetch_optional(&self.pool).await?;
        header
            .map(|json| {
                serde_json::from_str::<ConversationExportHeader>(&json)
                    .map(|header| header.bound_inputs)
                    .map_err(serialization)
            })
            .unwrap_or_else(|| Ok(Vec::new()))
    }
    pub(crate) async fn imported_invocation_asset_contents(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<crate::conversation_export::ExportVisualAssetContent>, StorageError> {
        sqlx::query_scalar::<_, String>("SELECT contents.content_json FROM conversation_import_asset_contents contents JOIN conversation_imports ci ON ci.id=contents.conversation_import_id JOIN threads t ON t.conversation_import_id=ci.id WHERE t.id=?1 AND ci.state='published' ORDER BY contents.digest_sha256")
            .bind(thread_id.value()).fetch_all(&self.pool).await?
            .into_iter().map(|json| serde_json::from_str(&json).map_err(serialization)).collect()
    }

    pub(crate) async fn imported_invocation_export_records(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<crate::conversation_export::ExportInvocation>, StorageError> {
        let header: Option<String> = sqlx::query_scalar("SELECT ci.header_json FROM conversation_imports ci JOIN threads t ON t.conversation_import_id=ci.id WHERE t.id=?1 AND ci.state='published'")
            .bind(thread_id.value()).fetch_optional(&self.pool).await?;
        header
            .map(|json| {
                serde_json::from_str::<ConversationExportHeader>(&json)
                    .map(|header| header.invocations)
                    .map_err(|error| StorageError::Serialization(error.to_string()))
            })
            .unwrap_or_else(|| Ok(Vec::new()))
    }

    pub(crate) async fn imported_turn_export_records(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<ImportedTurnExportRecord>, StorageError> {
        let rows = sqlx::query(
            "SELECT it.product_interaction_id,it.source_turn_id,it.source_origin_json,it.source_completion_json,ci.export_version
             FROM imported_turns it
             JOIN conversation_imports ci ON ci.id=it.conversation_import_id
             JOIN threads t ON t.conversation_import_id=ci.id
             WHERE t.id=?1 AND ci.state='published'
             ORDER BY it.product_interaction_id",
        )
        .bind(thread_id.value())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(ImportedTurnExportRecord {
                    export_version: row.try_get(4)?,
                    interaction_id: InteractionId::from_database(row.try_get(0)?),
                    source_turn_id: row.try_get(1)?,
                    origin: serde_json::from_str(&row.try_get::<String, _>(2)?)
                        .map_err(serialization)?,
                    turn: serde_json::from_str(&row.try_get::<String, _>(3)?)
                        .map_err(serialization)?,
                })
            })
            .collect()
    }

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

    pub(crate) async fn append_conversation_import_visual_asset_content(
        &self,
        import_id: &str,
        content: &crate::conversation_export::ExportVisualAssetContent,
    ) -> Result<(), StorageError> {
        let result = sqlx::query("INSERT INTO conversation_import_asset_contents(conversation_import_id,digest_sha256,content_json) SELECT id,?2,?3 FROM conversation_imports WHERE id=?1 AND state='staging'")
            .bind(import_id).bind(&content.digest_sha256)
            .bind(serde_json::to_string(content).map_err(serialization)?)
            .execute(&self.pool).await?;
        require_one(result.rows_affected(), "conversation import is not staged")
    }

    pub(crate) async fn next_conversation_import_visual_asset_content(
        &self,
        import_id: &str,
        after_digest: &str,
    ) -> Result<Option<crate::conversation_export::ExportVisualAssetContent>, StorageError> {
        let json: Option<String> = sqlx::query_scalar("SELECT content_json FROM conversation_import_asset_contents content JOIN conversation_imports ci ON ci.id=content.conversation_import_id WHERE ci.id=?1 AND ci.state='staging' AND content.digest_sha256>?2 ORDER BY content.digest_sha256 LIMIT 1")
            .bind(import_id).bind(after_digest).fetch_optional(&self.pool).await?;
        json.map(|json| serde_json::from_str(&json).map_err(serialization))
            .transpose()
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
        portable_turn: &ConversationExportTurn,
    ) -> Result<(), StorageError> {
        if portable_turn.id != source_turn_id {
            return Err(StorageError::IncompatibleSchema(
                "prepared portable turn does not match its source turn".into(),
            ));
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let result = sqlx::query("UPDATE interactions SET graph_node_id=?1,completion_output_json=?2 WHERE id=(SELECT it.product_interaction_id FROM imported_turns it JOIN conversation_imports ci ON ci.id=it.conversation_import_id WHERE ci.id=?3 AND ci.state='staging' AND it.source_turn_id=?4)")
            .bind(graph_node_id)
            .bind(output.map(serde_json::to_string).transpose().map_err(serialization)?)
            .bind(import_id).bind(source_turn_id).execute(&mut *tx).await?;
        require_one(
            result.rows_affected(),
            "conversation import turn is missing or not staged",
        )?;
        let result = sqlx::query("UPDATE imported_turns SET source_completion_json=?1 WHERE conversation_import_id=?2 AND source_turn_id=?3 AND EXISTS(SELECT 1 FROM conversation_imports WHERE id=?2 AND state='staging')")
            .bind(serde_json::to_string(portable_turn).map_err(serialization)?)
            .bind(import_id)
            .bind(source_turn_id)
            .execute(&mut *tx)
            .await?;
        require_one(
            result.rows_affected(),
            "conversation import turn is missing or not staged",
        )?;
        tx.commit().await?;
        Ok(())
    }

    pub(crate) async fn publish_conversation_import(
        &self,
        import_id: &str,
        published_at: &str,
    ) -> Result<(), StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let result = sqlx::query("UPDATE conversation_imports SET state='published',published_at=?1 WHERE id=?2 AND state='staging' AND source_sha256 LIKE 'sha256:%' AND NOT EXISTS(SELECT 1 FROM imported_turns it JOIN interactions i ON i.id=it.product_interaction_id WHERE it.conversation_import_id=?2 AND i.completion_status='accepted' AND (i.graph_node_id IS NULL OR i.completion_output_json IS NULL))")
            .bind(published_at).bind(import_id).execute(&mut *tx).await?;
        require_one(
            result.rows_affected(),
            "conversation import is incomplete or not staged",
        )?;
        sqlx::query(
            "DELETE FROM conversation_import_asset_contents WHERE conversation_import_id=?1 AND digest_sha256 NOT IN (SELECT pins.value FROM conversation_imports imported,json_tree(imported.header_json,'$.invocations') pins WHERE imported.id=?1 AND pins.key='digestSha256' AND pins.type='text' UNION SELECT pins.value FROM conversation_imports imported,json_tree(imported.header_json,'$.boundInputs') pins WHERE imported.id=?1 AND pins.key='digestSha256' AND pins.type='text')",
        )
        .bind(import_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
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
            let mut header =
                serde_json::from_str::<ConversationExportHeader>(&row.try_get::<String, _>(2)?)
                    .map_err(serialization)?;
            header.visual_asset_contents.clear();
            records.push(ConversationImportRecord {
                id,
                source_sha256: row.try_get(1)?,
                header,
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
        ExportCompletionStatus::WaitingForApproval => "waiting_for_approval",
        ExportCompletionStatus::Accepted => "accepted",
        ExportCompletionStatus::Failed => "failed",
        ExportCompletionStatus::Stopped => "stopped",
    }
}

fn parse_completion_status(value: &str) -> Result<ExportCompletionStatus, StorageError> {
    match value {
        "not_started" => Ok(ExportCompletionStatus::NotStarted),
        "running" => Ok(ExportCompletionStatus::Running),
        "submitted" => Ok(ExportCompletionStatus::Submitted),
        "waiting_for_approval" => Ok(ExportCompletionStatus::WaitingForApproval),
        "accepted" => Ok(ExportCompletionStatus::Accepted),
        "failed" => Ok(ExportCompletionStatus::Failed),
        "stopped" => Ok(ExportCompletionStatus::Stopped),
        other => Err(StorageError::Serialization(format!(
            "stored import completion status is invalid: {other}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::{completion_status, parse_completion_status};
    use crate::{
        conversation_export::{
            ConversationExportHeader, ConversationExportTurn, EXPORT_VERSION_V1,
            ExportCompletionReceipt, ExportCompletionStatus, ExportConversation, ExportProducer,
            ExportTurnManifestEntry, ExportTurnOrigin,
        },
        storage::{NewConversationImport, SqliteProductStore},
    };

    fn fixture_header(export_version: u32) -> ConversationExportHeader {
        ConversationExportHeader {
            invocations: Vec::new(),
            bound_inputs: Vec::new(),
            export_version,
            exported_at: "1770000000000".into(),
            producer: ExportProducer {
                desktop_version: "test".into(),
                build_commit: "test".into(),
                platform: "test".into(),
                architecture: "test".into(),
            },
            conversation: ExportConversation {
                id: "conversation:rollback".into(),
                title: "Rollback".into(),
                created_at: "1770000000000".into(),
                project_name: None,
                harness_configuration_name: "codex-basic".into(),
                permission_profile_id: "auto".into(),
            },
            turns: vec![ExportTurnManifestEntry {
                id: "turn:1".into(),
                sequence: 1,
            }],
            visual_asset_contents: Vec::new(),
        }
    }

    fn fixture_turn() -> ConversationExportTurn {
        ConversationExportTurn {
            id: "turn:1".into(),
            sequence: 1,
            created_at: "1770000000001".into(),
            text: "Portable source".into(),
            interaction_node_id: None,
            origin: ExportTurnOrigin::User,
            completion: ExportCompletionReceipt {
                status: ExportCompletionStatus::Failed,
                attempt_outcome: None,
                harness_configuration_name: None,
                harness_configuration_digest: None,
                model_selection: None,
                permission_profile_id: "auto".into(),
                effective_execution_digest: None,
                effective_permission_receipt: None,
                error: Some("fixture".into()),
                attempt_admission_id: None,
                admitted_model_plan: None,
            },
            contexts: vec![],
            submitted_inputs: vec![],
            accepted_view: None,
        }
    }

    #[test]
    fn imported_approval_lifecycle_statuses_round_trip() {
        for status in [
            ExportCompletionStatus::WaitingForApproval,
            ExportCompletionStatus::Stopped,
        ] {
            let stored = completion_status(status);
            assert_eq!(parse_completion_status(stored).unwrap(), status);
        }
    }

    #[tokio::test]
    async fn preparing_import_turn_rolls_back_interaction_when_portable_update_fails() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        let header = fixture_header(EXPORT_VERSION_V1);
        let turn = fixture_turn();
        store
            .stage_conversation_import(NewConversationImport {
                id: "import:rollback",
                source_sha256: "pending",
                header: &header,
            })
            .await
            .unwrap();
        let staged_turn = store
            .append_conversation_import_turn("import:rollback", &turn)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TRIGGER reject_portable_turn_update BEFORE UPDATE OF source_completion_json ON imported_turns BEGIN SELECT RAISE(ABORT, 'forced portable update failure'); END",
        )
        .execute(&store.pool)
        .await
        .unwrap();

        assert!(
            store
                .prepare_conversation_import_turn(
                    "import:rollback",
                    "turn:1",
                    Some(99),
                    Some(&serde_json::json!({"result":"should roll back"})),
                    &turn,
                )
                .await
                .is_err()
        );
        let (graph_node_id, output): (Option<i64>, Option<String>) = sqlx::query_as(
            "SELECT graph_node_id,completion_output_json FROM interactions WHERE id=?1",
        )
        .bind(staged_turn.interaction_id.value())
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(graph_node_id, None);
        assert_eq!(output, None);
        let stored: String = sqlx::query_scalar(
            "SELECT source_completion_json FROM imported_turns WHERE conversation_import_id='import:rollback' AND source_turn_id='turn:1'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_str::<ConversationExportTurn>(&stored).unwrap(),
            turn
        );
    }
    #[tokio::test]
    async fn published_import_retains_original_snapshot_version_for_reexport() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        for version in [1, 2, 3, 4] {
            let id = format!("import:version-{version}");
            let staged = store
                .stage_conversation_import(NewConversationImport {
                    id: &id,
                    source_sha256: &id,
                    header: &fixture_header(version),
                })
                .await
                .unwrap();
            store
                .append_conversation_import_turn(&id, &fixture_turn())
                .await
                .unwrap();
            assert!(
                store
                    .imported_turn_export_records(staged.thread_id)
                    .await
                    .unwrap()
                    .is_empty()
            );
            sqlx::query("UPDATE conversation_imports SET state='published' WHERE id=?1")
                .bind(&id)
                .execute(&store.pool)
                .await
                .unwrap();
            let records = store
                .imported_turn_export_records(staged.thread_id)
                .await
                .unwrap();
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].export_version, version);
            assert_eq!(records[0].turn, fixture_turn());
        }
    }

    #[tokio::test]
    async fn published_inert_invocation_inventory_reopens_for_exact_reexport() {
        use base64::Engine as _;
        use sha2::Digest as _;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("inert-product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        let mut header = fixture_header(4);
        header.invocations = vec![serde_json::from_value(serde_json::json!({
            "schemaVersion":1,"id":"invocation:1","source":{
                "interactionNodeId":"node:1","actionId":"action:1","parentNodeId":"node:2",
                "layerId":null,"instruction":"Analyze","label":"Analyze","description":null,"icon":null,"iconAsset":null,
                "variant":"pill","inputActionIds":[],"inputBindingsDefined":true,"parentTitle":"Parent","parentDetail":"Detail","state":"draft"
            },"childInteractionNodeId":"node:3","resultTurnId":null,"lifecycle":"active","headRevision":0,
                "currentLayerId":null,"returnedLayerId":null,"arguments":[],"current":null,"safeReason":null
        })).unwrap()];
        let bytes = b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
        let digest = format!("{:x}", sha2::Sha256::digest(bytes));
        header.invocations[0].source.icon_asset =
            Some(crate::conversation_export::ExportVisualAssetAssociation {
                asset_id: "call-icon".into(),
                digest_sha256: digest.clone(),
                media_type: "image/svg+xml".into(),
                byte_length: bytes.len(),
                provenance: crate::conversation_export::ExportVisualAssetProvenance {
                    source: "fixture".into(),
                    file_name: "call.svg".into(),
                },
            });
        let content = crate::conversation_export::ExportVisualAssetContent {
            digest_sha256: digest,
            media_type: "image/svg+xml".into(),
            byte_length: bytes.len(),
            content_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        };
        let staged = store
            .stage_conversation_import(NewConversationImport {
                id: "inert-inventory",
                source_sha256: "sha256:inert",
                header: &header,
            })
            .await
            .unwrap();
        assert!(
            store
                .imported_invocation_export_records(staged.thread_id)
                .await
                .unwrap()
                .is_empty()
        );
        store
            .append_conversation_import_turn("inert-inventory", &fixture_turn())
            .await
            .unwrap();
        store
            .append_conversation_import_visual_asset_content("inert-inventory", &content)
            .await
            .unwrap();
        store
            .publish_conversation_import("inert-inventory", "1770000000001")
            .await
            .unwrap();
        drop(store);
        let reopened = SqliteProductStore::open(&path).await.unwrap();
        assert_eq!(
            reopened
                .imported_invocation_export_records(staged.thread_id)
                .await
                .unwrap(),
            header.invocations
        );
        assert_eq!(
            reopened
                .imported_invocation_asset_contents(staged.thread_id)
                .await
                .unwrap(),
            vec![content]
        );
    }

    #[tokio::test]
    async fn published_standalone_bound_input_reopens_with_original_provenance_and_only_pinned_asset()
     {
        use base64::Engine as _;
        use sha2::Digest as _;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bound-input-product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        let mut header = fixture_header(4);
        let bytes = b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
        let digest = format!("{:x}", sha2::Sha256::digest(bytes));
        header.bound_inputs = vec![serde_json::from_value(serde_json::json!({
            "id":"action:outside-input","clientKey":"original-input","sourceNodeId":"node:unpublished-parent",
            "sourceLayerId":"layer:outside-closure","kind":"input","label":"Destination","variant":"pill",
            "iconAsset":{"assetId":"input-icon","digestSha256":digest,"mediaType":"image/svg+xml","byteLength":bytes.len(),
                "provenance":{"source":"fixture","fileName":"input.svg"}},
            "input":{"control":"text","prompt":"Destination"},"state":"accepted"
        })).unwrap()];
        // No Invocation pins exist: this exercises the independent boundInputs GC branch.
        assert!(header.invocations.is_empty());
        let content = crate::conversation_export::ExportVisualAssetContent {
            digest_sha256: digest,
            media_type: "image/svg+xml".into(),
            byte_length: bytes.len(),
            content_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        };
        let staged = store
            .stage_conversation_import(NewConversationImport {
                id: "bound-only",
                source_sha256: "sha256:bound-only",
                header: &header,
            })
            .await
            .unwrap();
        assert!(
            store
                .imported_bound_input_export_records(staged.thread_id)
                .await
                .unwrap()
                .is_empty()
        );
        store
            .append_conversation_import_turn("bound-only", &fixture_turn())
            .await
            .unwrap();
        store
            .append_conversation_import_visual_asset_content("bound-only", &content)
            .await
            .unwrap();
        let unpinned_bytes =
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><title>unused</title></svg>";
        store
            .append_conversation_import_visual_asset_content(
                "bound-only",
                &crate::conversation_export::ExportVisualAssetContent {
                    digest_sha256: format!("{:x}", sha2::Sha256::digest(unpinned_bytes)),
                    media_type: "image/svg+xml".into(),
                    byte_length: unpinned_bytes.len(),
                    content_base64: base64::engine::general_purpose::STANDARD
                        .encode(unpinned_bytes),
                },
            )
            .await
            .unwrap();
        store
            .publish_conversation_import("bound-only", "1770000000001")
            .await
            .unwrap();
        drop(store);
        let reopened = SqliteProductStore::open(&path).await.unwrap();
        assert_eq!(
            reopened
                .imported_bound_input_export_records(staged.thread_id)
                .await
                .unwrap(),
            header.bound_inputs
        );
        assert_eq!(
            reopened
                .imported_invocation_asset_contents(staged.thread_id)
                .await
                .unwrap(),
            vec![content]
        );
    }
}
