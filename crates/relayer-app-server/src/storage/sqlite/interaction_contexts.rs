use super::{
    SqliteProductStore,
    interactions::{interaction_from_row, monotonic_timestamp},
};
use crate::{
    product::{
        DurableInteractionInput, Interaction, InteractionContextIntent, InteractionContextTarget,
        InteractionModelSelection, ThreadId, ValidateModelSelectionCommand,
    },
    storage::{InteractionInputInsertOutcome, NewInteractionInput, StorageError},
};
use sqlx::Row;

impl SqliteProductStore {
    pub(crate) async fn insert_interaction_input(
        &self,
        thread_id: ThreadId,
        input: NewInteractionInput<'_>,
        model_selection: Option<&InteractionModelSelection>,
        require_model_selection: bool,
        enforce_single_active_interaction: bool,
    ) -> Result<InteractionInputInsertOutcome, StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let thread: Option<(String, String, String)> = sqlx::query_as(
            "SELECT updated_at,permission_profile_id,harness_configuration_name FROM threads WHERE id=?1 AND conversation_import_id IS NULL",
        ).bind(thread_id.value()).fetch_optional(&mut *tx).await?;
        let (previous_timestamp, permission_profile_id, harness_id) = thread.ok_or_else(|| {
            StorageError::IncompatibleSchema(format!("thread {thread_id} is missing or immutable"))
        })?;

        if let Some(row) = sqlx::query(
            "SELECT i.id,i.thread_id,i.sequence,i.text,i.created_at,i.graph_node_id,i.completion_status,i.harness_configuration_name,i.harness_configuration_digest,i.completion_output_json,i.completion_error,i.permission_profile_id,i.effective_execution_digest,i.effective_permission_receipt_json,i.model_provider_id,i.provider_model_id,i.model_family_id,a.id,a.attempt_number,a.started_at,a.finished_at,a.family_id,a.family_revision,a.harness_configuration_name,a.harness_configuration_revision,a.harness_configuration_digest,a.provider_id,a.adapter_id,a.adapter_implementation_version,a.model_id,a.access_contract,a.outcome,a.failure_category,a.effect_boundary,i.input_digest FROM interactions i LEFT JOIN interaction_attempts a ON a.id=(SELECT latest.id FROM interaction_attempts latest WHERE latest.interaction_id=i.id ORDER BY latest.attempt_number DESC LIMIT 1) WHERE i.thread_id=?1 AND i.input_identity=?2",
        ).bind(thread_id.value()).bind(input.input_identity).fetch_optional(&mut *tx).await? {
            let stored_digest: String = row.try_get("input_digest")?;
            if stored_digest != input.input_digest {
                return Err(StorageError::IncompatibleSchema(
                    "interaction input identity was reused with different content".into(),
                ));
            }
            let existing = interaction_from_row(&row)?;
            if let Some(requested) = model_selection
                && existing.model_selection.as_ref() != Some(requested)
            {
                return Err(StorageError::IncompatibleSchema(
                    "interaction input identity was reused with a different model selection"
                        .into(),
                ));
            }
            tx.commit().await?;
            return Ok(InteractionInputInsertOutcome::Existing(existing));
        }

        if enforce_single_active_interaction {
            let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM interactions WHERE thread_id=?1 AND completion_status IN ('not_started','running','submitted'))")
                .bind(thread_id.value()).fetch_one(&mut *tx).await?;
            if active {
                return Err(StorageError::Catalog(
                    crate::product::CatalogError::invalid(
                        "interaction_in_progress",
                        "Wait for the active interaction to finish.",
                    ),
                ));
            }
        }
        let model_selection = match model_selection {
            Some(value) => Some(value.clone()),
            None => sqlx::query("SELECT model_provider_id,provider_model_id,model_family_id FROM interactions WHERE thread_id=?1 ORDER BY sequence DESC LIMIT 1")
                .bind(thread_id.value()).fetch_optional(&mut *tx).await?
                .map(|row| super::interactions::interaction_model_selection_from_row(&row, 0, 1, 2)).transpose()?.flatten(),
        };
        if let Some(selection) = model_selection.as_ref() {
            let command = ValidateModelSelectionCommand {
                harness_id,
                family_id: selection.family_id,
                provider_id: selection.provider_id.clone(),
                model_id: selection.model_id.clone(),
            };
            super::catalog::validate_model_selection_on(&mut tx, &command).await?;
        } else if require_model_selection {
            return Err(StorageError::Catalog(
                crate::product::CatalogError::invalid(
                    "model_selection_required",
                    "The previous interaction has no model selection to inherit.",
                ),
            ));
        }
        let timestamp = monotonic_timestamp(&previous_timestamp);
        let sequence: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM interactions WHERE thread_id=?1",
        )
        .bind(thread_id.value())
        .fetch_one(&mut *tx)
        .await?;
        let result = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,permission_profile_id,model_provider_id,provider_model_id,model_family_id,input_identity,input_digest) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)")
            .bind(thread_id.value()).bind(sequence).bind(input.text).bind(&timestamp).bind(&permission_profile_id)
            .bind(model_selection.as_ref().map(|s| s.provider_id.as_str())).bind(model_selection.as_ref().map(|s| s.model_id.as_str()))
            .bind(model_selection.as_ref().map(|s| s.family_id.value())).bind(input.input_identity).bind(input.input_digest)
            .execute(&mut *tx).await?;
        let id = result.last_insert_rowid();
        for (context_position, context) in input.contexts.iter().enumerate() {
            sqlx::query("INSERT INTO interaction_context_intents(interaction_id,position,target_node_id,source_interaction_node_id,source_layer_id) VALUES (?1,?2,?3,?4,?5)")
                .bind(id).bind(context_position as i64).bind(context.target.node_id).bind(context.target.source_interaction_node_id).bind(context.target.source_layer_id)
                .execute(&mut *tx).await?;
            for (annotation_position, annotation) in context.annotations.iter().enumerate() {
                sqlx::query("INSERT INTO interaction_context_annotations(interaction_id,context_position,position,text) VALUES (?1,?2,?3,?4)")
                    .bind(id).bind(context_position as i64).bind(annotation_position as i64).bind(annotation)
                    .execute(&mut *tx).await?;
            }
        }
        sqlx::query("UPDATE threads SET updated_at=?1 WHERE id=?2")
            .bind(&timestamp)
            .bind(thread_id.value())
            .execute(&mut *tx)
            .await?;
        let interaction = Interaction {
            id: crate::product::InteractionId::from_database(id),
            thread_id,
            sequence,
            text: input.text.into(),
            created_at: timestamp,
            graph_node_id: None,
            completion_status: "not_started".into(),
            harness_configuration_name: None,
            harness_configuration_digest: None,
            permission_profile_id,
            model_selection,
            effective_execution_digest: None,
            effective_permission_receipt: None,
            completion_output: None,
            completion_error: None,
            latest_attempt: None,
        };
        tx.commit().await?;
        Ok(InteractionInputInsertOutcome::Created(interaction))
    }

    pub(crate) async fn interaction_input(
        &self,
        interaction_id: crate::product::InteractionId,
    ) -> Result<Option<DurableInteractionInput>, StorageError> {
        let header: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("SELECT input_identity,input_digest FROM interactions WHERE id=?1")
                .bind(interaction_id.value())
                .fetch_optional(&self.pool)
                .await?;
        let Some((input_identity, input_digest)) = header else {
            return Ok(None);
        };
        let (input_identity, input_digest) = match (input_identity, input_digest) {
            (Some(identity), Some(digest)) => (identity, digest),
            (None, None) => return Ok(None),
            _ => {
                return Err(StorageError::IncompatibleSchema(
                    "interaction input identity is partially populated".into(),
                ));
            }
        };
        let rows = sqlx::query("SELECT position,target_node_id,source_interaction_node_id,source_layer_id FROM interaction_context_intents WHERE interaction_id=?1 ORDER BY position")
            .bind(interaction_id.value()).fetch_all(&self.pool).await?;
        let mut contexts = Vec::with_capacity(rows.len());
        for row in rows {
            let position: i64 = row.try_get(0)?;
            let annotations = sqlx::query_scalar("SELECT text FROM interaction_context_annotations WHERE interaction_id=?1 AND context_position=?2 ORDER BY position")
                .bind(interaction_id.value()).bind(position).fetch_all(&self.pool).await?;
            contexts.push(InteractionContextIntent {
                target: InteractionContextTarget {
                    node_id: row.try_get(1)?,
                    source_interaction_node_id: row.try_get(2)?,
                    source_layer_id: row.try_get(3)?,
                },
                annotations,
            });
        }
        Ok(Some(DurableInteractionInput {
            input_identity,
            input_digest,
            contexts,
        }))
    }

    pub(crate) async fn discard_unbound_interaction_input(
        &self,
        interaction_id: crate::product::InteractionId,
    ) -> Result<bool, StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let thread_id: Option<i64> = sqlx::query_scalar(
            "SELECT thread_id FROM interactions WHERE id=?1 AND graph_node_id IS NULL AND input_identity IS NOT NULL AND completion_status IN ('not_started','submitted','failed')",
        ).bind(interaction_id.value()).fetch_optional(&mut *tx).await?;
        let Some(thread_id) = thread_id else {
            tx.commit().await?;
            return Ok(false);
        };
        sqlx::query("DELETE FROM interactions WHERE id=?1")
            .bind(interaction_id.value())
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE threads SET updated_at=COALESCE((SELECT MAX(created_at) FROM interactions WHERE thread_id=?1),created_at) WHERE id=?1")
            .bind(thread_id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::NewInteractionInput;

    #[tokio::test]
    async fn identified_context_intent_is_atomic_ordered_replayable_and_discard_restores_thread_time()
     {
        let path = std::env::temp_dir().join(format!(
            "relayer-context-intent-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        let thread_id = sqlx::query(
            "INSERT INTO threads(title,created_at,updated_at) VALUES ('Context','1','1')",
        )
        .execute(&store.pool)
        .await
        .unwrap()
        .last_insert_rowid();
        sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status) VALUES (?1,1,'First','1','accepted')")
            .bind(thread_id).execute(&store.pool).await.unwrap();
        let contexts = vec![InteractionContextIntent {
            target: InteractionContextTarget {
                node_id: 7,
                source_interaction_node_id: 3,
                source_layer_id: 5,
            },
            annotations: vec!["  raw bytes stay  ".into(), "second\nline".into()],
        }];
        let input = NewInteractionInput {
            text: "",
            input_identity: "send-1",
            input_digest: "sha256:v1:one",
            contexts: &contexts,
        };
        let created = store
            .insert_interaction_input(
                ThreadId::from_database(thread_id),
                input,
                None,
                false,
                false,
            )
            .await
            .unwrap();
        let interaction = match created {
            InteractionInputInsertOutcome::Created(value) => value,
            _ => panic!("expected create"),
        };
        let loaded = store
            .interaction_input(interaction.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.contexts, contexts);
        let replay = store
            .insert_interaction_input(
                ThreadId::from_database(thread_id),
                NewInteractionInput {
                    text: "",
                    input_identity: "send-1",
                    input_digest: "sha256:v1:one",
                    contexts: &contexts,
                },
                None,
                false,
                false,
            )
            .await
            .unwrap();
        assert!(
            matches!(replay, InteractionInputInsertOutcome::Existing(value) if value.id == interaction.id)
        );
        let conflict = store
            .insert_interaction_input(
                ThreadId::from_database(thread_id),
                NewInteractionInput {
                    text: "changed",
                    input_identity: "send-1",
                    input_digest: "sha256:v1:two",
                    contexts: &contexts,
                },
                None,
                false,
                false,
            )
            .await
            .unwrap_err();
        assert!(matches!(conflict, StorageError::IncompatibleSchema(_)));
        assert!(
            store
                .discard_unbound_interaction_input(interaction.id)
                .await
                .unwrap()
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM interactions WHERE thread_id=?1")
            .bind(thread_id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let updated_at: String = sqlx::query_scalar("SELECT updated_at FROM threads WHERE id=?1")
            .bind(thread_id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(updated_at, "1");
        sqlx::query("DROP TRIGGER interaction_input_identity_pair_update")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE interactions SET input_identity='corrupt',input_digest=NULL WHERE thread_id=?1 AND sequence=1")
            .bind(thread_id).execute(&store.pool).await.unwrap();
        let root_id: i64 =
            sqlx::query_scalar("SELECT id FROM interactions WHERE thread_id=?1 AND sequence=1")
                .bind(thread_id)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert!(matches!(
            store.interaction_input(crate::product::InteractionId::from_database(root_id)).await,
            Err(StorageError::IncompatibleSchema(message)) if message.contains("partially populated")
        ));
        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }
}
