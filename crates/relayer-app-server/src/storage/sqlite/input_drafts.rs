use super::{SqliteProductStore, interactions::monotonic_timestamp};
use crate::{
    product::{ActionInputAttachment, ActionInputDraft, ActionInputValue, ThreadId},
    storage::{NewActionInputAttachment, StorageError},
};
use sqlx::{Row, sqlite::SqliteRow};

#[derive(serde::Serialize, serde::Deserialize)]
struct SubmittedAttachment {
    occurrence: relayer_graph_core::PresentingInputOccurrence,
    source_node_id: i64,
    action: relayer_graph_core::InputAction,
    value: ActionInputValue,
    committed_at: String,
}

pub(super) fn submission_json(
    attachments: &[ActionInputAttachment],
) -> Result<String, StorageError> {
    serde_json::to_string(
        &attachments
            .iter()
            .map(|input| SubmittedAttachment {
                occurrence: input.occurrence.clone(),
                source_node_id: input.source_node_id,
                action: input.action.clone(),
                value: input.value.clone(),
                committed_at: input.committed_at.clone(),
            })
            .collect::<Vec<_>>(),
    )
    .map_err(|error| StorageError::Serialization(error.to_string()))
}

pub(super) fn submission_attachments(
    thread_id: ThreadId,
    revision: Option<i64>,
    json: &str,
) -> Result<Vec<ActionInputAttachment>, StorageError> {
    let inputs: Vec<SubmittedAttachment> = serde_json::from_str(json)
        .map_err(|error| StorageError::Serialization(error.to_string()))?;
    Ok(inputs
        .into_iter()
        .map(|input| ActionInputAttachment {
            thread_id,
            occurrence: input.occurrence,
            source_node_id: input.source_node_id,
            action: input.action,
            value: input.value,
            committed_at: input.committed_at,
            draft_revision: revision.unwrap_or(0),
        })
        .collect())
}

async fn next_draft_timestamp(
    connection: &mut sqlx::SqliteConnection,
    thread_id: ThreadId,
    thread_timestamp: &str,
) -> Result<String, StorageError> {
    let draft_timestamp: Option<String> =
        sqlx::query_scalar("SELECT updated_at FROM action_input_drafts WHERE thread_id=?1")
            .bind(thread_id.value())
            .fetch_optional(connection)
            .await?;
    let floor = thread_timestamp.parse::<u128>().unwrap_or(0).max(
        draft_timestamp
            .as_deref()
            .unwrap_or("")
            .parse::<u128>()
            .unwrap_or(0),
    );
    let next = floor.checked_add(1).ok_or_else(|| {
        StorageError::IncompatibleSchema("Input confirmation epoch overflow".into())
    })?;
    Ok(monotonic_timestamp(&next.to_string()))
}

// Task-local keeps the deterministic test pause out of other concurrent reads.
#[cfg(test)]
struct DraftReadPause {
    header_read: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}
#[cfg(test)]
tokio::task_local! {
    static DRAFT_READ_PAUSE: std::sync::Arc<DraftReadPause>;
}

impl SqliteProductStore {
    pub(crate) async fn invocation_input_submission(
        &self,
        thread_id: ThreadId,
        source: crate::product::InteractionId,
        action: i64,
        key: &str,
    ) -> Result<Option<(Option<i64>, Vec<ActionInputAttachment>)>, StorageError> {
        let row = sqlx::query("SELECT receipt.input_draft_revision,receipt.attachments_json FROM invocation_input_submission_receipts receipt JOIN action_invocations ai ON ai.result_interaction_id=receipt.result_interaction_id JOIN interactions source ON source.id=ai.source_interaction_id JOIN threads t ON t.id=source.thread_id WHERE source.id=?1 AND source.thread_id=?2 AND ai.action_id=?3 AND ai.invocation_key=?4 AND ai.authoritative=1 AND ai.agent_invoked=0 AND t.conversation_import_id IS NULL")
            .bind(source.value()).bind(thread_id.value()).bind(action).bind(key).fetch_optional(&self.pool).await?;
        row.map(|row| {
            let revision: Option<i64> = row.try_get("input_draft_revision")?;
            Ok((
                revision,
                submission_attachments(
                    thread_id,
                    revision,
                    &row.try_get::<String, _>("attachments_json")?,
                )?,
            ))
        })
        .transpose()
    }

    /// Delete only the exact committed epochs frozen for this submission.
    #[cfg(test)]
    pub(crate) async fn consume_invocation_inputs(
        &self,
        thread_id: ThreadId,
        attachments: &[ActionInputAttachment],
    ) -> Result<ActionInputDraft, StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let draft = consume_invocation_inputs_on(&mut tx, thread_id, attachments).await?;
        tx.commit().await?;
        Ok(draft)
    }

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
        let header =
            sqlx::query("SELECT revision,updated_at FROM action_input_drafts WHERE thread_id=?1")
                .bind(thread_id.value())
                .fetch_optional(&mut *tx)
                .await?;
        let current_revision = header
            .as_ref()
            .map(|row| row.try_get::<i64, _>("revision"))
            .transpose()?
            .unwrap_or(0);
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
        // Confirmation epochs must be strictly distinct even within one millisecond
        // or when a restored thread timestamp is ahead of the local clock.
        let timestamp = next_draft_timestamp(&mut tx, thread_id, &thread_timestamp).await?;
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
        let replay_result_revision: Option<i64> = sqlx::query_scalar(
            "SELECT result_revision FROM action_input_detach_receipts WHERE thread_id=?1 AND presenting_interaction_node_id=?2 AND presenting_layer_id=?3 AND action_id=?4 AND expected_revision=?5",
        )
        .bind(thread_id.value())
        .bind(occurrence.presenting_interaction_node_id.value())
        .bind(occurrence.presenting_layer_id.value())
        .bind(occurrence.action_id.value())
        .bind(expected_revision)
        .fetch_optional(&mut *tx)
        .await?;
        if replay_result_revision == Some(current_revision) {
            tx.commit().await?;
            return load_draft(&self.pool, thread_id).await;
        }
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
        let timestamp = next_draft_timestamp(&mut tx, thread_id, &thread_timestamp).await?;
        sqlx::query("UPDATE action_input_drafts SET revision=revision+1,updated_at=?1 WHERE thread_id=?2 AND revision=?3")
            .bind(&timestamp)
            .bind(thread_id.value())
            .bind(current_revision)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO action_input_detach_receipts(thread_id,presenting_interaction_node_id,presenting_layer_id,action_id,expected_revision,result_revision) VALUES (?1,?2,?3,?4,?5,?6)",
        )
        .bind(thread_id.value())
        .bind(occurrence.presenting_interaction_node_id.value())
        .bind(occurrence.presenting_layer_id.value())
        .bind(occurrence.action_id.value())
        .bind(current_revision)
        .bind(current_revision + 1)
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
    // A revision and its answers are one snapshot. Pool reads could otherwise
    // observe a newer attachment commit after reading an older header.
    let mut tx = pool.begin().await?;
    let header =
        sqlx::query("SELECT revision,updated_at FROM action_input_drafts WHERE thread_id=?1")
            .bind(thread_id.value())
            .fetch_optional(&mut *tx)
            .await?;
    #[cfg(test)]
    if let Ok(pause) = DRAFT_READ_PAUSE.try_with(std::sync::Arc::clone) {
        pause.header_read.notify_one();
        pause.resume.notified().await;
    }
    let draft = load_draft_after_header(&mut tx, thread_id, header).await?;
    tx.commit().await?;
    Ok(draft)
}

async fn load_draft_after_header(
    connection: &mut sqlx::SqliteConnection,
    thread_id: ThreadId,
    header: Option<SqliteRow>,
) -> Result<ActionInputDraft, StorageError> {
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
    .fetch_all(connection)
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

/// Runs inside the caller's submission transaction so binding and consumption
/// cannot be separated by a process exit or a later SQLite failure.
pub(super) async fn consume_invocation_inputs_on(
    connection: &mut sqlx::SqliteConnection,
    thread_id: ThreadId,
    attachments: &[ActionInputAttachment],
) -> Result<ActionInputDraft, StorageError> {
    let timestamp: String = sqlx::query_scalar(
        "SELECT updated_at FROM threads WHERE id=?1 AND conversation_import_id IS NULL",
    )
    .bind(thread_id.value())
    .fetch_optional(&mut *connection)
    .await?
    .ok_or_else(|| {
        StorageError::IncompatibleSchema("Invocation input thread is missing or immutable".into())
    })?;
    let mut changed = false;
    for input in attachments {
        if input.thread_id != thread_id {
            return Err(StorageError::IncompatibleSchema(
                "Invocation input belongs to another thread".into(),
            ));
        }
        let action = serde_json::to_string(&input.action)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let value = serde_json::to_string(&input.value)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let deleted = sqlx::query("DELETE FROM action_input_attachments WHERE thread_id=?1 AND presenting_interaction_node_id=?2 AND presenting_layer_id=?3 AND action_id=?4 AND source_node_id=?5 AND action_json=?6 AND value_json=?7 AND committed_at=?8")
                .bind(thread_id.value()).bind(input.occurrence.presenting_interaction_node_id.value()).bind(input.occurrence.presenting_layer_id.value()).bind(input.occurrence.action_id.value()).bind(input.source_node_id).bind(action).bind(value).bind(&input.committed_at).execute(&mut *connection).await?;
        changed |= deleted.rows_affected() > 0;
    }
    if changed {
        let next = next_draft_timestamp(&mut *connection, thread_id, &timestamp).await?;
        sqlx::query(
            "UPDATE action_input_drafts SET revision=revision+1,updated_at=?1 WHERE thread_id=?2",
        )
        .bind(next)
        .bind(thread_id.value())
        .execute(&mut *connection)
        .await?;
    }
    let header =
        sqlx::query("SELECT revision,updated_at FROM action_input_drafts WHERE thread_id=?1")
            .bind(thread_id.value())
            .fetch_optional(&mut *connection)
            .await?;
    let draft = load_draft_after_header(&mut *connection, thread_id, header).await?;
    Ok(draft)
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
    async fn invocation_consumption_preserves_other_inputs_and_newer_same_value_commit() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Invocation input",
                project_id: None,
                initial_message: "Compare",
                harness_configuration_name: "fixture-task-system",
                permission_profile_id: "ask",
                model_selection: None,
                // Forces the same clock floor for every write without relying on timing.
                timestamp: "9999999999999",
            })
            .await
            .unwrap();
        let action = InputAction {
            control: InputControl::Text,
            prompt: "Destination".into(),
            options: vec![],
            minimum_selections: None,
            unsupported_fields: Default::default(),
        };
        let value = ActionInputValue::Text {
            text: "Kyoto".into(),
        };
        for (id, revision) in [(1, 0), (2, 1), (3, 2)] {
            store
                .commit_action_input_attachment(
                    thread.id,
                    NewActionInputAttachment {
                        occurrence: &occurrence(id),
                        source_node_id: 300,
                        action: &action,
                        value: &value,
                    },
                    revision,
                )
                .await
                .unwrap();
        }
        let captured = store.action_input_draft(thread.id).await.unwrap();
        // Reconfirming exactly the same value is a new epoch and must survive.
        store
            .commit_action_input_attachment(
                thread.id,
                NewActionInputAttachment {
                    occurrence: &occurrence(1),
                    source_node_id: 300,
                    action: &action,
                    value: &value,
                },
                captured.revision,
            )
            .await
            .unwrap();
        let selected = captured
            .attachments
            .iter()
            .filter(|input| input.occurrence.action_id.value() != 3)
            .cloned()
            .collect::<Vec<_>>();
        let cleared = store
            .consume_invocation_inputs(thread.id, &selected)
            .await
            .unwrap();
        assert_eq!(cleared.revision, 5);
        assert_eq!(
            cleared
                .attachments
                .iter()
                .map(|input| input.occurrence.action_id.value())
                .collect::<Vec<_>>(),
            [1, 3]
        );
        assert_ne!(
            cleared.attachments[0].committed_at,
            captured.attachments[0].committed_at
        );
        assert_eq!(
            store
                .consume_invocation_inputs(thread.id, &selected)
                .await
                .unwrap(),
            cleared
        );
        // A consumed/detached occurrence cannot reuse an old confirmation epoch.
        for detach in [false, true] {
            let before = store.action_input_draft(thread.id).await.unwrap();
            let committed = store
                .commit_action_input_attachment(
                    thread.id,
                    NewActionInputAttachment {
                        occurrence: &occurrence(2),
                        source_node_id: 300,
                        action: &action,
                        value: &value,
                    },
                    before.revision,
                )
                .await
                .unwrap();
            let old = committed
                .attachments
                .iter()
                .find(|input| input.occurrence.action_id.value() == 2)
                .unwrap()
                .clone();
            let empty = if detach {
                store
                    .detach_action_input_attachment(thread.id, &occurrence(2), committed.revision)
                    .await
                    .unwrap()
            } else {
                store
                    .consume_invocation_inputs(thread.id, std::slice::from_ref(&old))
                    .await
                    .unwrap()
            };
            let newer = store
                .commit_action_input_attachment(
                    thread.id,
                    NewActionInputAttachment {
                        occurrence: &occurrence(2),
                        source_node_id: 300,
                        action: &action,
                        value: &value,
                    },
                    empty.revision,
                )
                .await
                .unwrap();
            assert_eq!(
                store
                    .consume_invocation_inputs(thread.id, &[old])
                    .await
                    .unwrap(),
                newer
            );
        }
        let cleared = store.action_input_draft(thread.id).await.unwrap();
        store.pool.close().await;
        let reopened = SqliteProductStore::open(directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        assert_eq!(
            reopened.action_input_draft(thread.id).await.unwrap(),
            cleared
        );
    }

    #[tokio::test]
    async fn draft_snapshot_keeps_revision_and_answers_consistent_across_concurrent_commit() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Vacation",
                project_id: None,
                initial_message: "Compare vacations",
                harness_configuration_name: "fixture-task-system",
                permission_profile_id: "ask",
                model_selection: None,
                timestamp: "2026-10-04T00:00:00Z",
            })
            .await
            .unwrap();
        let action = InputAction {
            control: InputControl::Text,
            prompt: "Destination".into(),
            options: vec![],
            minimum_selections: None,
            unsupported_fields: Default::default(),
        };
        let slot = occurrence(300);
        let lisbon = ActionInputValue::Text {
            text: "Lisbon".into(),
        };
        let kyoto = ActionInputValue::Text {
            text: "Kyoto".into(),
        };
        let attachment = |value| NewActionInputAttachment {
            occurrence: &slot,
            source_node_id: 400,
            action: &action,
            value,
        };
        store
            .commit_action_input_attachment(thread.id, attachment(&lisbon), 0)
            .await
            .unwrap();

        // The public loader owns the transaction: pause its real header read,
        // then commit a new value from a separate WAL writer before it resumes.
        let pause = std::sync::Arc::new(DraftReadPause {
            header_read: tokio::sync::Notify::new(),
            resume: tokio::sync::Notify::new(),
        });
        let reader = DRAFT_READ_PAUSE.scope(pause.clone(), store.action_input_draft(thread.id));
        let writer = async {
            pause.header_read.notified().await;
            let committed = store
                .commit_action_input_attachment(thread.id, attachment(&kyoto), 1)
                .await
                .unwrap();
            pause.resume.notify_one();
            committed
        };
        let (frozen, committed) = tokio::join!(reader, writer);
        assert_eq!(committed.revision, 2);
        let frozen = frozen.unwrap();
        assert_eq!(frozen.revision, 1);
        assert_eq!(frozen.attachments[0].draft_revision, 1);
        assert_eq!(frozen.attachments[0].value, lisbon);
        let latest = store.action_input_draft(thread.id).await.unwrap();
        assert_eq!(latest.revision, 2);
        assert_eq!(latest.attachments[0].value, kyoto);
    }

    #[tokio::test]
    async fn committed_slots_are_independent_replay_safe_and_survive_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
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
                unsupported_fields: Default::default(),
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
    async fn restoring_an_identical_committed_value_ignores_its_newer_timestamp() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Restore identical input",
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
            control: InputControl::Text,
            prompt: "Constraint?".into(),
            options: vec![],
            minimum_selections: None,
            unsupported_fields: Default::default(),
        };
        let value = ActionInputValue::Text {
            text: "Keep support load flat".into(),
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
            value: relayer_graph_core::SubmittedInputValue::Text {
                text: "Keep support load flat".into(),
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
                    composer_input_occurrences: None,
                    text: "",
                    input_identity: "send:identical",
                    input_digest: &digest,
                    contexts: &[],
                    context_confirmation_ids: &[],
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
        let recommitted = store
            .commit_action_input_attachment(
                thread.id,
                NewActionInputAttachment {
                    occurrence: &occurrence(300),
                    source_node_id: 400,
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
        assert_eq!(restored.revision, recommitted.revision + 1);
        assert_eq!(restored.attachments.len(), 1);
        assert_eq!(restored.attachments[0].action, action);
        assert_eq!(restored.attachments[0].value, value);
        let failed = store
            .get_interaction(interaction.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            failed.completion_error.as_deref(),
            Some("provider stopped before graph acceptance")
        );
    }

    #[tokio::test]
    async fn ordinary_subset_failure_reopen_restores_only_its_snapshot_and_preserves_bound_edits() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Mixed draft",
                project_id: None,
                initial_message: "Initial",
                harness_configuration_name: "fixture-task-system",
                permission_profile_id: "ask",
                model_selection: None,
                timestamp: "2026-10-07T00:00:00Z",
            })
            .await
            .unwrap();
        let action = InputAction {
            control: InputControl::Text,
            prompt: "Notes".into(),
            options: vec![],
            minimum_selections: None,
            unsupported_fields: Default::default(),
        };
        let mut revision = 0;
        for (id, text) in [(300, "Ordinary notes"), (301, "Bound argument")] {
            revision = store
                .commit_action_input_attachment(
                    thread.id,
                    NewActionInputAttachment {
                        occurrence: &occurrence(id),
                        source_node_id: 400,
                        action: &action,
                        value: &ActionInputValue::Text { text: text.into() },
                    },
                    revision,
                )
                .await
                .unwrap()
                .revision;
        }
        let answer = relayer_graph_core::SubmittedInputDraft {
            occurrence: occurrence(300),
            action: action.clone(),
            value: relayer_graph_core::SubmittedInputValue::Text {
                text: "Ordinary notes".into(),
            },
        };
        let digest = relayer_graph_core::interaction_input_authority_digest(
            "",
            std::slice::from_ref(&answer),
        )
        .unwrap();
        let created = store
            .insert_interaction_input(
                thread.id,
                NewInteractionInput {
                    composer_input_occurrences: Some(&[occurrence(300)]),
                    text: "",
                    input_identity: "mixed-send",
                    input_digest: &digest,
                    contexts: &[],
                    context_confirmation_ids: &[],
                    submitted_input_draft_revision: Some(revision),
                },
                None,
                false,
                false,
            )
            .await
            .unwrap();
        let InteractionInputInsertOutcome::Created(interaction) = created else {
            panic!("expected new input");
        };
        let retained = store.action_input_draft(thread.id).await.unwrap();
        assert_eq!(
            retained
                .attachments
                .iter()
                .map(|a| a.occurrence.action_id.value())
                .collect::<Vec<_>>(),
            vec![301]
        );
        let newer = store
            .commit_action_input_attachment(
                thread.id,
                NewActionInputAttachment {
                    occurrence: &occurrence(301),
                    source_node_id: 400,
                    action: &action,
                    value: &ActionInputValue::Text {
                        text: "Newer bound argument".into(),
                    },
                },
                retained.revision,
            )
            .await
            .unwrap();
        assert!(
            store
                .claim_interaction_preparing(interaction.id)
                .await
                .unwrap()
        );
        assert!(
            store
                .fail_interaction_completion(
                    interaction.id,
                    "fixture-task-system",
                    "Refused before execution"
                )
                .await
                .unwrap()
        );
        store.pool.close().await;
        let reopened = SqliteProductStore::open(path).await.unwrap();
        let restored = reopened.action_input_draft(thread.id).await.unwrap();
        assert!(restored.revision > newer.revision);
        assert_eq!(
            restored
                .attachments
                .iter()
                .map(|a| (a.occurrence.action_id.value(), a.value.clone()))
                .collect::<Vec<_>>(),
            vec![
                (
                    300,
                    ActionInputValue::Text {
                        text: "Ordinary notes".into()
                    }
                ),
                (
                    301,
                    ActionInputValue::Text {
                        text: "Newer bound argument".into()
                    }
                ),
            ]
        );
        assert_eq!(
            reopened
                .interaction_input(interaction.id)
                .await
                .unwrap()
                .unwrap()
                .submitted_inputs,
            vec![answer]
        );
    }

    #[tokio::test]
    async fn send_reserves_an_immutable_snapshot_and_failure_restores_a_new_draft() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
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
                unsupported_fields: Default::default(),
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
                    composer_input_occurrences: None,
                    text: "",
                    input_identity: "send:one",
                    input_digest: &digest,
                    contexts: &[],
                    context_confirmation_ids: &[],
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
                    composer_input_occurrences: None,
                    text: "",
                    input_identity: "send:one",
                    input_digest: &digest,
                    contexts: &[],
                    context_confirmation_ids: &[],
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
                    composer_input_occurrences: None,
                    text: "",
                    input_identity: "send:two",
                    input_digest: &digest,
                    contexts: &[],
                    context_confirmation_ids: &[],
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
