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
use sqlx::{Row, SqliteConnection};

async fn claim_context_confirmations(
    connection: &mut SqliteConnection,
    interaction_id: i64,
    thread_id: i64,
    contexts: &[InteractionContextIntent],
    confirmation_ids: &[String],
) -> Result<(), StorageError> {
    let mut submitted_annotations = contexts
        .iter()
        .flat_map(|context| {
            context.annotations.iter().map(|annotation| {
                (
                    context.target.node_id,
                    context.target.source_interaction_node_id,
                    context.target.source_layer_id,
                    annotation.as_str(),
                )
            })
        })
        .collect::<Vec<_>>();
    for draft_id in confirmation_ids {
        let row = sqlx::query(
            "SELECT target_node_id,source_interaction_node_id,source_layer_id,composer_text,consumed_interaction_id FROM node_context_draft_resolutions WHERE draft_id=?1 AND thread_id=?2 AND outcome='confirmed' AND dismissed_at IS NULL AND (consumed_interaction_id IS NULL OR consumed_interaction_id=?3)",
        )
        .bind(draft_id)
        .bind(thread_id)
        .bind(interaction_id)
        .fetch_optional(&mut *connection)
        .await?
        .ok_or_else(|| StorageError::ContextDraftConflict {
            code: "context_confirmation_not_pending",
            message: "A submitted context confirmation is no longer pending.".into(),
        })?;
        let target = (
            row.try_get::<i64, _>("target_node_id")?,
            row.try_get::<i64, _>("source_interaction_node_id")?,
            row.try_get::<i64, _>("source_layer_id")?,
            row.try_get::<String, _>("composer_text")?,
        );
        let Some(position) = submitted_annotations.iter().position(|candidate| {
            candidate.0 == target.0
                && candidate.1 == target.1
                && candidate.2 == target.2
                && candidate.3 == target.3
        }) else {
            return Err(StorageError::ContextDraftConflict {
                code: "context_confirmation_payload_mismatch",
                message:
                    "A submitted context confirmation does not match the interaction contexts."
                        .into(),
            });
        };
        submitted_annotations.swap_remove(position);
        if row.try_get::<Option<i64>, _>("consumed_interaction_id")? == Some(interaction_id) {
            continue;
        }
        let claimed = sqlx::query(
            "UPDATE node_context_draft_resolutions SET consumed_interaction_id=?1 WHERE draft_id=?2 AND thread_id=?3 AND outcome='confirmed' AND dismissed_at IS NULL AND consumed_interaction_id IS NULL",
        )
        .bind(interaction_id)
        .bind(draft_id)
        .bind(thread_id)
        .execute(&mut *connection)
        .await?;
        if claimed.rows_affected() != 1 {
            return Err(StorageError::ContextDraftConflict {
                code: "context_confirmation_not_pending",
                message: "A submitted context confirmation was consumed concurrently.".into(),
            });
        }
    }
    Ok(())
}

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
            "SELECT i.id,i.thread_id,i.sequence,i.text,i.created_at,i.graph_node_id,i.completion_status,i.harness_configuration_name,i.harness_configuration_digest,i.completion_output_json,i.completion_error,i.permission_profile_id,i.effective_execution_digest,i.effective_permission_receipt_json,i.model_provider_id,i.provider_model_id,i.model_family_id,a.id,a.attempt_number,a.started_at,a.finished_at,a.family_id,a.family_revision,a.harness_configuration_name,a.harness_configuration_revision,a.harness_configuration_digest,a.provider_id,a.adapter_id,a.adapter_implementation_version,a.model_id,a.access_contract,a.outcome,a.failure_category,a.effect_boundary,a.attempt_admission_id,a.admitted_plan_json,a.admitted_plan_digest,i.input_digest FROM interactions i LEFT JOIN interaction_attempts a ON a.id=(SELECT latest.id FROM interaction_attempts latest WHERE latest.interaction_id=i.id ORDER BY latest.attempt_number DESC LIMIT 1) WHERE i.thread_id=?1 AND i.input_identity=?2",
        ).bind(thread_id.value()).bind(input.input_identity).fetch_optional(&mut *tx).await? {
            let stored_digest: String = row.try_get(37)?;
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
            let mut requested_confirmation_ids = input.context_confirmation_ids.to_vec();
            requested_confirmation_ids.sort();
            if requested_confirmation_ids
                .iter()
                .any(|draft_id| draft_id.trim().is_empty())
                || requested_confirmation_ids
                    .windows(2)
                    .any(|ids| ids[0] == ids[1])
            {
                return Err(StorageError::IncompatibleSchema(
                    "context confirmation IDs must be non-empty and unique".into(),
                ));
            }
            let consumed_confirmation_ids: Vec<String> = sqlx::query_scalar(
                "SELECT draft_id FROM node_context_draft_resolutions WHERE consumed_interaction_id=?1 ORDER BY draft_id",
            )
            .bind(existing.id.value())
            .fetch_all(&mut *tx)
            .await?;
            if consumed_confirmation_ids != requested_confirmation_ids {
                let reclaimable = existing.completion_status == "not_started"
                    && consumed_confirmation_ids
                        .iter()
                        .all(|draft_id| requested_confirmation_ids.contains(draft_id));
                if !reclaimable {
                    return Err(StorageError::IncompatibleSchema(
                        "interaction input identity was reused with different context confirmations"
                            .into(),
                    ));
                }
                claim_context_confirmations(
                    &mut tx,
                    existing.id.value(),
                    thread_id.value(),
                    input.contexts,
                    &requested_confirmation_ids,
                )
                .await?;
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
        let submitted_input = if let Some(expected_revision) = input.submitted_input_draft_revision
        {
            let current_revision: Option<i64> =
                sqlx::query_scalar("SELECT revision FROM action_input_drafts WHERE thread_id=?1")
                    .bind(thread_id.value())
                    .fetch_optional(&mut *tx)
                    .await?;
            if current_revision.unwrap_or(0) != expected_revision {
                return Err(StorageError::ActionInputDraftConflict {
                    code: "input_draft_revision_conflict",
                    message: "The committed interaction inputs changed while Send was reserving them. Reload the draft and send again.".into(),
                });
            }
            let rows = sqlx::query(
                "SELECT presenting_interaction_node_id,presenting_layer_id,action_id,action_json,value_json FROM action_input_attachments WHERE thread_id=?1 ORDER BY presenting_interaction_node_id,presenting_layer_id,action_id",
            )
            .bind(thread_id.value())
            .fetch_all(&mut *tx)
            .await?;
            if rows.is_empty() {
                None
            } else {
                let submitted_inputs =
                    rows.iter()
                        .map(submitted_input_from_row)
                        .collect::<Result<Vec<_>, _>>()?;
                let authority_digest = relayer_graph_core::interaction_input_authority_digest(
                    input.text,
                    &submitted_inputs,
                )
                .map_err(|error| StorageError::Serialization(error.to_string()))?;
                if authority_digest != input.input_digest {
                    return Err(StorageError::ActionInputDraftConflict {
                        code: "input_draft_revision_conflict",
                        message: "The committed interaction inputs no longer match the Send snapshot. Reload the draft and send again.".into(),
                    });
                }
                let semantic_digest = relayer_graph_core::interaction_input_semantic_digest(
                    input.text,
                    &submitted_inputs,
                )
                .map_err(|error| StorageError::Serialization(error.to_string()))?;
                Some((expected_revision, semantic_digest))
            }
        } else {
            None
        };
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
        let mut confirmation_ids = input.context_confirmation_ids.to_vec();
        confirmation_ids.sort();
        if confirmation_ids
            .iter()
            .any(|draft_id| draft_id.trim().is_empty())
            || confirmation_ids.windows(2).any(|ids| ids[0] == ids[1])
        {
            return Err(StorageError::IncompatibleSchema(
                "context confirmation IDs must be non-empty and unique".into(),
            ));
        }
        claim_context_confirmations(
            &mut tx,
            id,
            thread_id.value(),
            input.contexts,
            &confirmation_ids,
        )
        .await?;
        if let Some((draft_revision, semantic_digest)) = submitted_input {
            sqlx::query(
                "INSERT INTO interaction_submitted_input_attempts(interaction_id,thread_id,draft_revision,authority_digest,semantic_digest,state,created_at) VALUES (?1,?2,?3,?4,?5,'reserved',?6)",
            )
            .bind(id)
            .bind(thread_id.value())
            .bind(draft_revision)
            .bind(input.input_digest)
            .bind(semantic_digest)
            .bind(&timestamp)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO interaction_submitted_input_attachments(interaction_id,presenting_interaction_node_id,presenting_layer_id,action_id,source_node_id,action_json,value_json,committed_at) SELECT ?1,presenting_interaction_node_id,presenting_layer_id,action_id,source_node_id,action_json,value_json,committed_at FROM action_input_attachments WHERE thread_id=?2",
            )
            .bind(id)
            .bind(thread_id.value())
            .execute(&mut *tx)
            .await?;
            sqlx::query("DELETE FROM action_input_attachments WHERE thread_id=?1")
                .bind(thread_id.value())
                .execute(&mut *tx)
                .await?;
            let advanced = sqlx::query(
                "UPDATE action_input_drafts SET revision=revision+1,updated_at=?1 WHERE thread_id=?2 AND revision=?3",
            )
            .bind(&timestamp)
            .bind(thread_id.value())
            .bind(draft_revision)
            .execute(&mut *tx)
            .await?;
            if advanced.rows_affected() != 1 {
                return Err(StorageError::IncompatibleSchema(
                    "submitted input reservation lost its draft revision".into(),
                ));
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
        type InteractionInputHeader = (Option<String>, Option<String>, Option<i64>, Option<String>);
        let header: Option<InteractionInputHeader> =
            sqlx::query_as("SELECT interaction.input_identity,interaction.input_digest,attempt.draft_revision,attempt.semantic_digest FROM interactions interaction LEFT JOIN interaction_submitted_input_attempts attempt ON attempt.interaction_id=interaction.id WHERE interaction.id=?1")
                .bind(interaction_id.value())
                .fetch_optional(&self.pool)
                .await?;
        let Some((input_identity, input_digest, submitted_input_draft_revision, semantic_digest)) =
            header
        else {
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
        let submitted_rows = sqlx::query(
            "SELECT presenting_interaction_node_id,presenting_layer_id,action_id,action_json,value_json FROM interaction_submitted_input_attachments WHERE interaction_id=?1 ORDER BY presenting_interaction_node_id,presenting_layer_id,action_id",
        )
        .bind(interaction_id.value())
        .fetch_all(&self.pool)
        .await?;
        let submitted_inputs = submitted_rows
            .iter()
            .map(submitted_input_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(DurableInteractionInput {
            input_identity,
            input_digest,
            contexts,
            submitted_inputs,
            submitted_input_draft_revision,
            semantic_digest,
        }))
    }

    pub(crate) async fn submitted_input_evidence(
        &self,
        interaction_id: crate::product::InteractionId,
    ) -> Result<Vec<crate::product::SubmittedInputEvidence>, StorageError> {
        let rows = sqlx::query(
            "SELECT snapshot.presenting_interaction_node_id,snapshot.presenting_layer_id,snapshot.action_id,snapshot.source_node_id,snapshot.action_json,snapshot.value_json,attempt.state FROM interaction_submitted_input_attachments snapshot JOIN interaction_submitted_input_attempts attempt ON attempt.interaction_id=snapshot.interaction_id WHERE snapshot.interaction_id=?1 ORDER BY snapshot.presenting_interaction_node_id,snapshot.presenting_layer_id,snapshot.action_id",
        )
        .bind(interaction_id.value())
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                let submitted = submitted_input_from_row(row)?;
                Ok(crate::product::SubmittedInputEvidence {
                    occurrence: submitted.occurrence,
                    source_node_id: row.try_get("source_node_id")?,
                    action: submitted.action,
                    value: submitted.value,
                    attempt_state: row.try_get("state")?,
                })
            })
            .collect()
    }

    pub(crate) async fn discard_unbound_interaction_input(
        &self,
        interaction_id: crate::product::InteractionId,
    ) -> Result<bool, StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let thread_id: Option<i64> = sqlx::query_scalar(
            "SELECT thread_id FROM interactions WHERE id=?1 AND graph_node_id IS NULL AND input_identity IS NOT NULL AND completion_status IN ('not_started','submitted','failed') AND NOT EXISTS(SELECT 1 FROM interaction_submitted_input_attempts WHERE interaction_id=interactions.id)",
        ).bind(interaction_id.value()).fetch_optional(&mut *tx).await?;
        let Some(thread_id) = thread_id else {
            tx.commit().await?;
            return Ok(false);
        };
        super::context_drafts::ensure_context_confirmation_restore_safe(
            &mut tx,
            interaction_id.value(),
        )
        .await?;
        sqlx::query("DELETE FROM interactions WHERE id=?1")
            .bind(interaction_id.value())
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE threads SET updated_at=COALESCE((SELECT MAX(created_at) FROM interactions WHERE thread_id=?1),created_at) WHERE id=?1")
            .bind(thread_id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }

    pub(crate) async fn interaction_consumes_context_confirmations(
        &self,
        interaction_id: crate::product::InteractionId,
    ) -> Result<bool, StorageError> {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM node_context_draft_resolutions WHERE consumed_interaction_id=?1)",
        )
        .bind(interaction_id.value())
        .fetch_one(&self.pool)
        .await
        .map_err(Into::into)
    }
}

pub(super) fn submitted_input_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<relayer_graph_core::SubmittedInputDraft, StorageError> {
    let action: relayer_graph_core::InputAction =
        serde_json::from_str(&row.try_get::<String, _>("action_json")?)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
    let value: crate::product::ActionInputValue =
        serde_json::from_str(&row.try_get::<String, _>("value_json")?)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
    let value = match value {
        crate::product::ActionInputValue::Text { text } => {
            relayer_graph_core::SubmittedInputValue::Text { text }
        }
        crate::product::ActionInputValue::Selected { selected_keys } => {
            let selected = selected_keys
                .into_iter()
                .map(|key| {
                    action
                        .options
                        .iter()
                        .find(|option| option.key == key)
                        .cloned()
                        .ok_or_else(|| {
                            StorageError::IncompatibleSchema(format!(
                                "submitted input snapshot contains unknown option key {key:?}"
                            ))
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            relayer_graph_core::SubmittedInputValue::Selected { selected }
        }
    };
    Ok(relayer_graph_core::SubmittedInputDraft {
        occurrence: relayer_graph_core::PresentingInputOccurrence {
            presenting_interaction_node_id: relayer_graph_core::NodeId::new(
                row.try_get("presenting_interaction_node_id")?,
            )
            .ok_or_else(|| {
                StorageError::IncompatibleSchema("invalid presenting interaction ID".into())
            })?,
            presenting_layer_id: relayer_graph_core::LayerId::new(
                row.try_get("presenting_layer_id")?,
            )
            .ok_or_else(|| {
                StorageError::IncompatibleSchema("invalid presenting layer ID".into())
            })?,
            action_id: relayer_graph_core::ActionId::new(row.try_get("action_id")?).ok_or_else(
                || StorageError::IncompatibleSchema("invalid input action ID".into()),
            )?,
        },
        action,
        value,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::NewInteractionInput;

    #[tokio::test]
    async fn empty_input_snapshot_is_revision_checked_inside_send_transaction() {
        let path = std::env::temp_dir().join(format!(
            "relayer-empty-input-revision-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        let input_digest = relayer_graph_core::interaction_input_digest("Prompt", &[]).unwrap();
        let clean_thread = sqlx::query(
            "INSERT INTO threads(title,created_at,updated_at) VALUES ('Clean','1','1')",
        )
        .execute(&store.pool)
        .await
        .unwrap()
        .last_insert_rowid();
        let created = store
            .insert_interaction_input(
                ThreadId::from_database(clean_thread),
                NewInteractionInput {
                    text: "Prompt",
                    input_identity: "empty-revision-zero",
                    input_digest: &input_digest,
                    contexts: &[],
                    context_confirmation_ids: &[],
                    submitted_input_draft_revision: Some(0),
                },
                None,
                false,
                false,
            )
            .await
            .unwrap();
        assert!(matches!(created, InteractionInputInsertOutcome::Created(_)));

        let changed_thread = sqlx::query(
            "INSERT INTO threads(title,created_at,updated_at) VALUES ('Changed','1','1')",
        )
        .execute(&store.pool)
        .await
        .unwrap()
        .last_insert_rowid();
        sqlx::query(
            "INSERT INTO action_input_drafts(thread_id,revision,updated_at) VALUES (?1,1,'2')",
        )
        .bind(changed_thread)
        .execute(&store.pool)
        .await
        .unwrap();
        let conflict = store
            .insert_interaction_input(
                ThreadId::from_database(changed_thread),
                NewInteractionInput {
                    text: "Prompt",
                    input_identity: "stale-empty-revision",
                    input_digest: &input_digest,
                    contexts: &[],
                    context_confirmation_ids: &[],
                    submitted_input_draft_revision: Some(0),
                },
                None,
                false,
                false,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            conflict,
            StorageError::ActionInputDraftConflict {
                code: "input_draft_revision_conflict",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn interaction_atomically_consumes_and_unbound_delete_restores_confirmation() {
        let path = std::env::temp_dir().join(format!(
            "relayer-context-confirmation-consume-{}-{}.sqlite3",
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
        sqlx::query("INSERT INTO node_context_draft_resolutions(draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at,composer_text) VALUES ('draft-a',?1,'confirmed',2,7,3,5,?2,'FIFO','2','FIFO')")
            .bind(thread_id)
            .bind(r#"{"id":7,"kind":"concept","icon":"list","title":"Queue","detail":"Tasks","state":"accepted"}"#)
            .execute(&store.pool).await.unwrap();
        let contexts = vec![InteractionContextIntent {
            target: InteractionContextTarget {
                node_id: 7,
                source_interaction_node_id: 3,
                source_layer_id: 5,
            },
            annotations: vec!["FIFO".into()],
        }];
        let confirmation_ids = vec!["draft-a".to_owned()];
        let created = store
            .insert_interaction_input(
                ThreadId::from_database(thread_id),
                NewInteractionInput {
                    text: "Use context",
                    input_identity: "send-confirmed",
                    input_digest: "sha256:confirmed",
                    contexts: &contexts,
                    context_confirmation_ids: &confirmation_ids,
                    submitted_input_draft_revision: None,
                },
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
        assert!(
            store
                .interaction_consumes_context_confirmations(interaction.id)
                .await
                .unwrap()
        );
        assert!(
            store
                .pending_node_context_confirmations(ThreadId::from_database(thread_id),)
                .await
                .unwrap()
                .is_empty()
        );
        sqlx::query("INSERT INTO node_context_drafts(id,thread_id,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,revision,created_at,updated_at) VALUES ('draft-b',?1,7,3,6,?2,'LIFO',1,'3','3')")
            .bind(thread_id)
            .bind(r#"{"id":7,"kind":"concept","icon":"list","title":"Queue","detail":"Tasks","state":"accepted"}"#)
            .execute(&store.pool).await.unwrap();
        let conflict = store
            .confirm_node_context_draft(ThreadId::from_database(thread_id), "draft-b", 1)
            .await
            .unwrap_err();
        assert!(matches!(
            conflict,
            StorageError::ContextDraftConflict {
                code: "context_target_already_confirmed",
                ..
            }
        ));
        sqlx::query("INSERT INTO node_context_draft_resolutions(draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at,composer_text) VALUES ('legacy-conflict',?1,'confirmed',1,7,3,6,?2,'LIFO','3','LIFO')")
            .bind(thread_id)
            .bind(r#"{"id":7,"kind":"concept","icon":"list","title":"Queue","detail":"Tasks","state":"accepted"}"#)
            .execute(&store.pool).await.unwrap();
        let restore_error = store
            .discard_unbound_interaction_input(interaction.id)
            .await
            .unwrap_err();
        assert!(matches!(
            restore_error,
            StorageError::IncompatibleSchema(message)
                if message.contains("multiple occurrences")
        ));
        let still_consumed: Option<i64> = sqlx::query_scalar(
            "SELECT consumed_interaction_id FROM node_context_draft_resolutions WHERE draft_id='draft-a'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(still_consumed, Some(interaction.id.value()));
        let interaction_still_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM interactions WHERE id=?1)")
                .bind(interaction.id.value())
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert!(interaction_still_exists);
        sqlx::query(
            "UPDATE node_context_draft_resolutions SET dismissed_at='4' WHERE draft_id='legacy-conflict'",
        )
        .execute(&store.pool)
        .await
        .unwrap();
        assert!(
            store
                .discard_unbound_interaction_input(interaction.id)
                .await
                .unwrap()
        );
        let restored = store
            .pending_node_context_confirmations(ThreadId::from_database(thread_id))
            .await
            .unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].draft_id, "draft-a");
        assert!(
            !store
                .interaction_consumes_context_confirmations(interaction.id)
                .await
                .unwrap()
        );
        assert!(
            store
                .node_context_draft(ThreadId::from_database(thread_id), "draft-b")
                .await
                .unwrap()
                .is_some()
        );
        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn exact_not_started_replay_reclaims_restored_confirmations() {
        let path = std::env::temp_dir().join(format!(
            "relayer-context-confirmation-reclaim-{}-{}.sqlite3",
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
        sqlx::query("INSERT INTO node_context_draft_resolutions(draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at,composer_text) VALUES ('draft-replay',?1,'confirmed',2,7,3,5,?2,'FIFO','2','FIFO')")
            .bind(thread_id)
            .bind(r#"{"id":7,"kind":"concept","icon":"list","title":"Queue","detail":"Tasks","state":"accepted"}"#)
            .execute(&store.pool).await.unwrap();
        let contexts = vec![InteractionContextIntent {
            target: InteractionContextTarget {
                node_id: 7,
                source_interaction_node_id: 3,
                source_layer_id: 5,
            },
            annotations: vec!["FIFO".into()],
        }];
        let confirmation_ids = vec!["draft-replay".to_owned()];
        let input = || NewInteractionInput {
            text: "Use context",
            input_identity: "send-replay",
            input_digest: "sha256:replay",
            contexts: &contexts,
            context_confirmation_ids: &confirmation_ids,
            submitted_input_draft_revision: None,
        };
        let created = store
            .insert_interaction_input(
                ThreadId::from_database(thread_id),
                input(),
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
        sqlx::query("UPDATE interactions SET completion_status='running' WHERE id=?1")
            .bind(interaction.id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        store
            .return_interaction_to_unsent(interaction.id, "codex-basic")
            .await
            .unwrap();
        assert_eq!(
            store
                .pending_node_context_confirmations(ThreadId::from_database(thread_id))
                .await
                .unwrap()
                .len(),
            1
        );

        let changed_digest = store
            .insert_interaction_input(
                ThreadId::from_database(thread_id),
                NewInteractionInput {
                    input_digest: "sha256:changed",
                    ..input()
                },
                None,
                false,
                false,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            changed_digest,
            StorageError::IncompatibleSchema(_)
        ));
        let replay = store
            .insert_interaction_input(
                ThreadId::from_database(thread_id),
                input(),
                None,
                false,
                false,
            )
            .await
            .unwrap();
        assert!(
            matches!(replay, InteractionInputInsertOutcome::Existing(value) if value.id == interaction.id)
        );
        let consumed_by: Option<i64> = sqlx::query_scalar(
            "SELECT consumed_interaction_id FROM node_context_draft_resolutions WHERE draft_id='draft-replay'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(consumed_by, Some(interaction.id.value()));
        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn each_confirmation_requires_a_distinct_submitted_annotation() {
        let path = std::env::temp_dir().join(format!(
            "relayer-context-confirmation-cardinality-{}-{}.sqlite3",
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
        for draft_id in ["draft-a", "draft-b"] {
            sqlx::query("INSERT INTO node_context_draft_resolutions(draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at,composer_text) VALUES (?1,?2,'confirmed',2,7,3,5,?3,'FIFO','2','FIFO')")
                .bind(draft_id)
                .bind(thread_id)
                .bind(r#"{"id":7,"kind":"concept","icon":"list","title":"Queue","detail":"Tasks","state":"accepted"}"#)
                .execute(&store.pool).await.unwrap();
        }
        let contexts = vec![InteractionContextIntent {
            target: InteractionContextTarget {
                node_id: 7,
                source_interaction_node_id: 3,
                source_layer_id: 5,
            },
            annotations: vec!["FIFO".into()],
        }];
        let confirmation_ids = vec!["draft-a".to_owned(), "draft-b".to_owned()];
        let error = store
            .insert_interaction_input(
                ThreadId::from_database(thread_id),
                NewInteractionInput {
                    text: "Use context",
                    input_identity: "send-duplicate-confirmations",
                    input_digest: "sha256:duplicate-confirmations",
                    contexts: &contexts,
                    context_confirmation_ids: &confirmation_ids,
                    submitted_input_draft_revision: None,
                },
                None,
                false,
                false,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            StorageError::ContextDraftConflict {
                code: "context_confirmation_payload_mismatch",
                ..
            }
        ));
        let interaction_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM interactions WHERE thread_id=?1")
                .bind(thread_id)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(interaction_count, 1);
        assert_eq!(
            store
                .pending_node_context_confirmations(ThreadId::from_database(thread_id))
                .await
                .unwrap()
                .len(),
            2
        );
        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

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
            context_confirmation_ids: &[],
            submitted_input_draft_revision: None,
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
                    context_confirmation_ids: &[],
                    submitted_input_draft_revision: None,
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
                    context_confirmation_ids: &[],
                    submitted_input_draft_revision: None,
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
