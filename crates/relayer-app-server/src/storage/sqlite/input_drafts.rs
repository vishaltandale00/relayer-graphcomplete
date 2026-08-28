use super::{SqliteProductStore, interactions::monotonic_timestamp};
use crate::{
    product::{ActionInputAttachment, ActionInputDraft, ActionInputValue, ThreadId},
    storage::{NewActionInputAttachment, StorageError},
};
use sqlx::{Row, sqlite::SqliteRow};

impl SqliteProductStore {
    pub(crate) async fn action_input_draft(
        &self,
        thread_id: ThreadId,
    ) -> Result<ActionInputDraft, StorageError> {
        if !self.thread_exists_and_mutable(thread_id).await? {
            return Err(StorageError::IncompatibleSchema(format!(
                "thread {thread_id} is missing or immutable"
            )));
        }
        load_draft(&self.pool, thread_id).await
    }

    pub(crate) async fn commit_action_input_attachment(
        &self,
        thread_id: ThreadId,
        attachment: NewActionInputAttachment<'_>,
        expected_revision: i64,
    ) -> Result<ActionInputDraft, StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let thread_timestamp: String = sqlx::query_scalar(
            "SELECT updated_at FROM threads WHERE id=?1 AND conversation_import_id IS NULL",
        )
        .bind(thread_id.value())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            StorageError::IncompatibleSchema(format!("thread {thread_id} is missing or immutable"))
        })?;
        let current_revision: Option<i64> =
            sqlx::query_scalar("SELECT revision FROM action_input_drafts WHERE thread_id=?1")
                .bind(thread_id.value())
                .fetch_optional(&mut *tx)
                .await?;
        let current_revision = current_revision.unwrap_or(0);
        let action_json = serde_json::to_string(attachment.action)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let value_json = serde_json::to_string(attachment.value)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let existing = sqlx::query(
            "SELECT action_json,value_json FROM action_input_attachments WHERE thread_id=?1 AND presenting_interaction_node_id=?2 AND presenting_layer_id=?3 AND action_id=?4",
        )
        .bind(thread_id.value())
        .bind(attachment.occurrence.presenting_interaction_node_id.value())
        .bind(attachment.occurrence.presenting_layer_id.value())
        .bind(attachment.occurrence.action_id.value())
        .fetch_optional(&mut *tx)
        .await?;
        let lost_response_replay = existing.as_ref().is_some_and(|row| {
            row.try_get::<String, _>("action_json").ok().as_deref() == Some(action_json.as_str())
                && row.try_get::<String, _>("value_json").ok().as_deref()
                    == Some(value_json.as_str())
                && expected_revision == current_revision.saturating_sub(1)
        });
        if lost_response_replay {
            tx.commit().await?;
            return load_draft(&self.pool, thread_id).await;
        }
        if expected_revision != current_revision {
            return Err(input_draft_conflict(
                "input_draft_revision_conflict",
                "This interaction-input draft changed in another renderer state. Reload it before committing.",
            ));
        }
        let timestamp = monotonic_timestamp(&thread_timestamp);
        if current_revision == 0 {
            sqlx::query(
                "INSERT INTO action_input_drafts(thread_id,revision,updated_at) VALUES (?1,1,?2)",
            )
            .bind(thread_id.value())
            .bind(&timestamp)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query("UPDATE action_input_drafts SET revision=revision+1,updated_at=?1 WHERE thread_id=?2 AND revision=?3")
                .bind(&timestamp)
                .bind(thread_id.value())
                .bind(current_revision)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            "INSERT INTO action_input_attachments(thread_id,presenting_interaction_node_id,presenting_layer_id,action_id,source_node_id,action_json,value_json,committed_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(thread_id,presenting_interaction_node_id,presenting_layer_id,action_id) DO UPDATE SET source_node_id=excluded.source_node_id,action_json=excluded.action_json,value_json=excluded.value_json,committed_at=excluded.committed_at",
        )
        .bind(thread_id.value())
        .bind(attachment.occurrence.presenting_interaction_node_id.value())
        .bind(attachment.occurrence.presenting_layer_id.value())
        .bind(attachment.occurrence.action_id.value())
        .bind(attachment.source_node_id)
        .bind(action_json)
        .bind(value_json)
        .bind(&timestamp)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        load_draft(&self.pool, thread_id).await
    }

    pub(crate) async fn detach_action_input_attachment(
        &self,
        thread_id: ThreadId,
        occurrence: &relayer_graph_core::PresentingInputOccurrence,
        expected_revision: i64,
    ) -> Result<ActionInputDraft, StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let thread_timestamp: String = sqlx::query_scalar(
            "SELECT updated_at FROM threads WHERE id=?1 AND conversation_import_id IS NULL",
        )
        .bind(thread_id.value())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            StorageError::IncompatibleSchema(format!("thread {thread_id} is missing or immutable"))
        })?;
        let current_revision: i64 =
            sqlx::query_scalar("SELECT revision FROM action_input_drafts WHERE thread_id=?1")
                .bind(thread_id.value())
                .fetch_optional(&mut *tx)
                .await?
                .unwrap_or(0);
        if expected_revision != current_revision {
            return Err(input_draft_conflict(
                "input_draft_revision_conflict",
                "This interaction-input draft changed in another renderer state. Reload it before detaching.",
            ));
        }
        let deleted = sqlx::query(
            "DELETE FROM action_input_attachments WHERE thread_id=?1 AND presenting_interaction_node_id=?2 AND presenting_layer_id=?3 AND action_id=?4",
        )
        .bind(thread_id.value())
        .bind(occurrence.presenting_interaction_node_id.value())
        .bind(occurrence.presenting_layer_id.value())
        .bind(occurrence.action_id.value())
        .execute(&mut *tx)
        .await?;
        if deleted.rows_affected() == 0 {
            tx.commit().await?;
            return load_draft(&self.pool, thread_id).await;
        }
        let timestamp = monotonic_timestamp(&thread_timestamp);
        sqlx::query("UPDATE action_input_drafts SET revision=revision+1,updated_at=?1 WHERE thread_id=?2 AND revision=?3")
            .bind(&timestamp)
            .bind(thread_id.value())
            .bind(current_revision)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        load_draft(&self.pool, thread_id).await
    }

    async fn thread_exists_and_mutable(&self, thread_id: ThreadId) -> Result<bool, StorageError> {
        Ok(sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1 AND conversation_import_id IS NULL)",
        )
        .bind(thread_id.value())
        .fetch_one(&self.pool)
        .await?)
    }
}

async fn load_draft(
    pool: &sqlx::SqlitePool,
    thread_id: ThreadId,
) -> Result<ActionInputDraft, StorageError> {
    let header =
        sqlx::query("SELECT revision,updated_at FROM action_input_drafts WHERE thread_id=?1")
            .bind(thread_id.value())
            .fetch_optional(pool)
            .await?;
    let Some(header) = header else {
        return Ok(ActionInputDraft {
            thread_id,
            revision: 0,
            attachments: vec![],
            updated_at: String::new(),
        });
    };
    let revision: i64 = header.try_get("revision")?;
    let updated_at: String = header.try_get("updated_at")?;
    let rows = sqlx::query(
        "SELECT presenting_interaction_node_id,presenting_layer_id,action_id,source_node_id,action_json,value_json,committed_at FROM action_input_attachments WHERE thread_id=?1 ORDER BY presenting_interaction_node_id,presenting_layer_id,action_id",
    )
    .bind(thread_id.value())
    .fetch_all(pool)
    .await?;
    Ok(ActionInputDraft {
        thread_id,
        revision,
        attachments: rows
            .iter()
            .map(|row| attachment_from_row(thread_id, revision, row))
            .collect::<Result<_, _>>()?,
        updated_at,
    })
}

fn attachment_from_row(
    thread_id: ThreadId,
    draft_revision: i64,
    row: &SqliteRow,
) -> Result<ActionInputAttachment, StorageError> {
    Ok(ActionInputAttachment {
        thread_id,
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
        source_node_id: row.try_get("source_node_id")?,
        action: serde_json::from_str(&row.try_get::<String, _>("action_json")?)
            .map_err(|error| StorageError::Serialization(error.to_string()))?,
        value: serde_json::from_str::<ActionInputValue>(&row.try_get::<String, _>("value_json")?)
            .map_err(|error| StorageError::Serialization(error.to_string()))?,
        draft_revision,
        committed_at: row.try_get("committed_at")?,
    })
}

fn input_draft_conflict(code: &'static str, message: &str) -> StorageError {
    StorageError::ActionInputDraftConflict {
        code,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::NewThreadRecord;
    use crate::storage::{InteractionInputInsertOutcome, NewInteractionInput};
    use relayer_graph_core::{
        ActionId, InputAction, InputControl, InputOption, LayerId, NodeId,
        PresentingInputOccurrence,
    };

    fn occurrence(action_id: i64) -> PresentingInputOccurrence {
        PresentingInputOccurrence {
            presenting_interaction_node_id: NodeId::new(100).unwrap(),
            presenting_layer_id: LayerId::new(200).unwrap(),
            action_id: ActionId::new(action_id).unwrap(),
        }
    }

    #[tokio::test]
    async fn committed_slots_are_independent_replay_safe_and_survive_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Inputs",
                project_id: None,
                initial_message: "Initial",
                harness_configuration_name: "fixture-task-system",
                permission_profile_id: "ask",
                model_selection: None,
                timestamp: "2026-08-28T00:00:00Z",
            })
            .await
            .unwrap();
        let action = InputAction {
            control: InputControl::SingleSelect,
            prompt: "Choose".into(),
            options: vec![InputOption {
                key: "one".into(),
                label: "One".into(),
            }],
            minimum_selections: None,
            unsupported_fields: Default::default(),
        };
        let first_value = ActionInputValue::Selected {
            selected_keys: vec!["one".into()],
        };
        let first = store
            .commit_action_input_attachment(
                thread.id,
                NewActionInputAttachment {
                    occurrence: &occurrence(300),
                    source_node_id: 400,
                    action: &action,
                    value: &first_value,
                },
                0,
            )
            .await
            .unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(first.attachments.len(), 1);

        let replay = store
            .commit_action_input_attachment(
                thread.id,
                NewActionInputAttachment {
                    occurrence: &occurrence(300),
                    source_node_id: 400,
                    action: &action,
                    value: &first_value,
                },
                0,
            )
            .await
            .unwrap();
        assert_eq!(replay.revision, 1);

        let second = store
            .commit_action_input_attachment(
                thread.id,
                NewActionInputAttachment {
                    occurrence: &occurrence(301),
                    source_node_id: 400,
                    action: &action,
                    value: &first_value,
                },
                1,
            )
            .await
            .unwrap();
        assert_eq!(second.revision, 2);
        assert_eq!(second.attachments.len(), 2);
        drop(store);

        let reopened = SqliteProductStore::open(&path).await.unwrap();
        let restored = reopened.action_input_draft(thread.id).await.unwrap();
        assert_eq!(restored.revision, 2);
        assert_eq!(
            restored
                .attachments
                .iter()
                .map(|item| item.occurrence.action_id.value())
                .collect::<Vec<_>>(),
            vec![300, 301]
        );
        let detached = reopened
            .detach_action_input_attachment(thread.id, &occurrence(300), 2)
            .await
            .unwrap();
        assert_eq!(detached.revision, 3);
        assert_eq!(detached.attachments[0].occurrence.action_id.value(), 301);
    }

    #[tokio::test]
    async fn send_reserves_an_immutable_snapshot_and_failure_restores_a_new_draft() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                title: "Crash safe input",
                project_id: None,
                initial_message: "Initial",
                harness_configuration_name: "fixture-task-system",
                permission_profile_id: "ask",
                model_selection: None,
                timestamp: "2026-08-28T00:00:00Z",
            })
            .await
            .unwrap();
        let action = InputAction {
            control: InputControl::SingleSelect,
            prompt: "Choose".into(),
            options: vec![InputOption {
                key: "one".into(),
                label: "One".into(),
            }],
            minimum_selections: None,
            unsupported_fields: Default::default(),
        };
        let value = ActionInputValue::Selected {
            selected_keys: vec!["one".into()],
        };
        let committed = store
            .commit_action_input_attachment(
                thread.id,
                NewActionInputAttachment {
                    occurrence: &occurrence(300),
                    source_node_id: 400,
                    action: &action,
                    value: &value,
                },
                0,
            )
            .await
            .unwrap();
        let submitted = relayer_graph_core::SubmittedInputDraft {
            occurrence: occurrence(300),
            action: action.clone(),
            value: relayer_graph_core::SubmittedInputValue::Selected {
                selected: action.options.clone(),
            },
        };
        let digest = relayer_graph_core::interaction_input_authority_digest(
            "",
            std::slice::from_ref(&submitted),
        )
        .unwrap();
        let created = store
            .insert_interaction_input(
                thread.id,
                NewInteractionInput {
                    text: "",
                    input_identity: "send:one",
                    input_digest: &digest,
                    contexts: &[],
                    submitted_input_draft_revision: Some(committed.revision),
                },
                None,
                false,
                false,
            )
            .await
            .unwrap();
        let interaction = match created {
            InteractionInputInsertOutcome::Created(interaction) => interaction,
            _ => panic!("expected a new immutable attempt"),
        };
        let fresh = store.action_input_draft(thread.id).await.unwrap();
        assert_eq!(fresh.revision, committed.revision + 1);
        assert!(fresh.attachments.is_empty());
        let durable = store
            .interaction_input(interaction.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            durable.submitted_inputs.as_slice(),
            std::slice::from_ref(&submitted)
        );
        assert!(durable.semantic_digest.is_some());
        let duplicate = store
            .insert_interaction_input(
                thread.id,
                NewInteractionInput {
                    text: "",
                    input_identity: "send:one",
                    input_digest: &digest,
                    contexts: &[],
                    submitted_input_draft_revision: Some(committed.revision),
                },
                None,
                false,
                false,
            )
            .await
            .unwrap();
        assert!(matches!(
            duplicate,
            InteractionInputInsertOutcome::Existing(existing) if existing.id == interaction.id
        ));

        assert!(
            store
                .claim_interaction_preparing(interaction.id)
                .await
                .unwrap()
        );
        let semantic_digest = durable.semantic_digest.unwrap();
        let child = relayer_graph_core::InteractionInputChild {
            id: relayer_graph_core::InteractionInputChildId::new(1).unwrap(),
            parent_interaction_node_id: NodeId::new(500).unwrap(),
            occurrence: submitted.occurrence.clone(),
            source_node_id: NodeId::new(400).unwrap(),
            action: action.clone(),
            value: submitted.value.clone(),
            attempt_key: "send:one".into(),
            authority_digest: digest.clone(),
            semantic_digest,
        };
        let mut changed_source = child.clone();
        changed_source.source_node_id = NodeId::new(401).unwrap();
        let changed_source_error = store
            .bind_prepared_interaction(crate::product::PreparedInteractionBinding {
                interaction_id: interaction.id,
                graph_node_id: 500,
                harness_configuration_name: "fixture-task-system",
                harness_configuration_digest: "sha256:fixture",
                effective_execution_digest: "sha256:execution",
                effective_permission_receipt: &serde_json::json!({}),
                input_children: &[changed_source],
            })
            .await
            .unwrap_err();
        assert!(changed_source_error.to_string().contains(
            "graph child receipt changed the reserved root, source, attempt, or digest binding"
        ));
        assert!(
            store
                .bind_prepared_interaction(crate::product::PreparedInteractionBinding {
                    interaction_id: interaction.id,
                    graph_node_id: 500,
                    harness_configuration_name: "fixture-task-system",
                    harness_configuration_digest: "sha256:fixture",
                    effective_execution_digest: "sha256:execution",
                    effective_permission_receipt: &serde_json::json!({}),
                    input_children: &[child],
                })
                .await
                .unwrap()
        );
        assert!(
            store
                .claim_interaction_running(interaction.id, "fixture-task-system")
                .await
                .unwrap()
        );
        let newer_edit = store
            .commit_action_input_attachment(
                thread.id,
                NewActionInputAttachment {
                    occurrence: &occurrence(300),
                    source_node_id: 401,
                    action: &action,
                    value: &value,
                },
                fresh.revision,
            )
            .await
            .unwrap();
        assert!(
            store
                .fail_interaction_completion(
                    interaction.id,
                    "fixture-task-system",
                    "provider stopped before graph acceptance",
                )
                .await
                .unwrap()
        );
        let restored = store.action_input_draft(thread.id).await.unwrap();
        assert_eq!(restored.revision, newer_edit.revision + 1);
        assert_eq!(restored.attachments.len(), 1);
        assert_eq!(restored.attachments[0].source_node_id, 401);
        let immutable_state: String = sqlx::query_scalar(
            "SELECT state FROM interaction_submitted_input_attempts WHERE interaction_id=?1",
        )
        .bind(interaction.id.value())
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(immutable_state, "failed");
        let failed = store
            .get_interaction(interaction.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(failed.completion_status, "failed");
        assert!(
            failed
                .completion_error
                .as_deref()
                .unwrap()
                .contains("A newer committed value was preserved")
        );

        let second = store
            .insert_interaction_input(
                thread.id,
                NewInteractionInput {
                    text: "",
                    input_identity: "send:two",
                    input_digest: &digest,
                    contexts: &[],
                    submitted_input_draft_revision: Some(restored.revision),
                },
                None,
                false,
                false,
            )
            .await
            .unwrap();
        let second = match second {
            InteractionInputInsertOutcome::Created(interaction) => interaction,
            _ => panic!("a send after failure must reserve a new immutable attempt"),
        };
        assert_ne!(second.id, interaction.id);
        assert!(store.claim_interaction_preparing(second.id).await.unwrap());
        let second_durable = store.interaction_input(second.id).await.unwrap().unwrap();
        let second_child = relayer_graph_core::InteractionInputChild {
            id: relayer_graph_core::InteractionInputChildId::new(2).unwrap(),
            parent_interaction_node_id: NodeId::new(501).unwrap(),
            occurrence: submitted.occurrence,
            source_node_id: NodeId::new(401).unwrap(),
            action,
            value: submitted.value,
            attempt_key: "send:two".into(),
            authority_digest: digest,
            semantic_digest: second_durable.semantic_digest.unwrap(),
        };
        assert!(
            store
                .bind_prepared_interaction(crate::product::PreparedInteractionBinding {
                    interaction_id: second.id,
                    graph_node_id: 501,
                    harness_configuration_name: "fixture-task-system",
                    harness_configuration_digest: "sha256:fixture",
                    effective_execution_digest: "sha256:execution",
                    effective_permission_receipt: &serde_json::json!({}),
                    input_children: &[second_child],
                })
                .await
                .unwrap()
        );
        assert!(
            store
                .claim_interaction_running(second.id, "fixture-task-system")
                .await
                .unwrap()
        );
        store
            .accept_interaction_completion(crate::product::AcceptedInteractionCompletion {
                interaction_id: second.id,
                graph_node_id: 501,
                harness_configuration_name: "fixture-task-system",
                harness_configuration_digest: "sha256:fixture",
                effective_execution_digest: "sha256:execution",
                effective_permission_receipt: &serde_json::json!({}),
                output: &serde_json::json!({ "nodeId": 501 }),
            })
            .await
            .unwrap();
        assert!(
            store
                .action_input_draft(thread.id)
                .await
                .unwrap()
                .attachments
                .is_empty()
        );
        assert!(
            !store
                .fail_interaction_completion(second.id, "fixture-task-system", "late cancel")
                .await
                .unwrap()
        );
        assert!(
            store
                .action_input_draft(thread.id)
                .await
                .unwrap()
                .attachments
                .is_empty()
        );
    }
}
