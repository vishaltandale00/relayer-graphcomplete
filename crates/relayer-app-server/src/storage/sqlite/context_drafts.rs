use super::{SqliteProductStore, interactions::monotonic_timestamp};
use crate::{
    product::{NodeContextDraft, NodeContextDraftConfirmation, ThreadId},
    storage::{NewNodeContextDraft, StorageError},
};
use sqlx::{Row, sqlite::SqliteRow};

macro_rules! draft_select {
    ($tail:literal) => {
        concat!(
            "SELECT id,thread_id,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,revision,created_at,updated_at FROM node_context_drafts ",
            $tail
        )
    };
}

impl SqliteProductStore {
    pub(crate) async fn save_node_context_draft(
        &self,
        thread_id: ThreadId,
        draft: NewNodeContextDraft<'_>,
        expected_revision: Option<i64>,
    ) -> Result<NodeContextDraft, StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let previous_timestamp: String = sqlx::query_scalar(
            "SELECT updated_at FROM threads WHERE id=?1 AND conversation_import_id IS NULL",
        )
        .bind(thread_id.value())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            StorageError::IncompatibleSchema(format!("thread {thread_id} is missing or immutable"))
        })?;
        let target_node_json = serde_json::to_string(draft.target_node)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let resolved: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM node_context_draft_resolutions WHERE draft_id=?1)",
        )
        .bind(draft.id)
        .fetch_one(&mut *tx)
        .await?;
        if resolved {
            return Err(context_draft_conflict(
                "context_draft_resolved",
                "This stable node-context draft identity has already been resolved.",
            ));
        }
        let existing = sqlx::query(draft_select!("WHERE id=?1 AND thread_id=?2"))
            .bind(draft.id)
            .bind(thread_id.value())
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(row) = existing {
            let existing = node_context_draft_from_row(&row)?;
            let target_matches =
                existing.target == *draft.target && existing.target_node == *draft.target_node;
            if !target_matches {
                return Err(context_draft_conflict(
                    "context_draft_identity_conflict",
                    "This draft identity is already bound to a different node occurrence.",
                ));
            }
            let lost_response_replay = existing.text == draft.text
                && (expected_revision == Some(existing.revision - 1)
                    || (expected_revision.is_none() && existing.revision == 1));
            if lost_response_replay {
                tx.commit().await?;
                return Ok(existing);
            }
            if expected_revision != Some(existing.revision) {
                return Err(context_draft_conflict(
                    "context_draft_revision_conflict",
                    "This node-context draft changed in another renderer state. Reload it before saving.",
                ));
            }
            let timestamp = monotonic_timestamp(&existing.updated_at);
            sqlx::query(
                "UPDATE node_context_drafts SET text=?1,revision=revision+1,updated_at=?2 WHERE id=?3 AND thread_id=?4 AND revision=?5",
            )
            .bind(draft.text)
            .bind(&timestamp)
            .bind(draft.id)
            .bind(thread_id.value())
            .bind(existing.revision)
            .execute(&mut *tx)
            .await?;
            let row = sqlx::query(draft_select!("WHERE id=?1 AND thread_id=?2"))
                .bind(draft.id)
                .bind(thread_id.value())
                .fetch_one(&mut *tx)
                .await?;
            let result = node_context_draft_from_row(&row)?;
            tx.commit().await?;
            return Ok(result);
        }
        if expected_revision.is_some() {
            return Err(context_draft_conflict(
                "context_draft_revision_conflict",
                "This node-context draft no longer exists. Reload drafts before saving.",
            ));
        }
        let target_claimed: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM node_context_drafts WHERE thread_id=?1 AND target_node_id=?2)",
        )
        .bind(thread_id.value())
        .bind(draft.target.node_id)
        .fetch_one(&mut *tx)
        .await?;
        if target_claimed {
            return Err(context_draft_conflict(
                "context_draft_target_conflict",
                "This node already has an unconfirmed annotation draft.",
            ));
        }
        let timestamp = monotonic_timestamp(&previous_timestamp);
        sqlx::query(
            "INSERT INTO node_context_drafts(id,thread_id,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8,?8)",
        )
        .bind(draft.id)
        .bind(thread_id.value())
        .bind(draft.target.node_id)
        .bind(draft.target.source_interaction_node_id)
        .bind(draft.target.source_layer_id)
        .bind(target_node_json)
        .bind(draft.text)
        .bind(&timestamp)
        .execute(&mut *tx)
        .await?;
        let row = sqlx::query(draft_select!("WHERE id=?1 AND thread_id=?2"))
            .bind(draft.id)
            .bind(thread_id.value())
            .fetch_one(&mut *tx)
            .await?;
        let result = node_context_draft_from_row(&row)?;
        tx.commit().await?;
        Ok(result)
    }

    pub(crate) async fn node_context_drafts(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<NodeContextDraft>, StorageError> {
        let rows = sqlx::query(draft_select!("WHERE thread_id=?1 ORDER BY created_at,id"))
            .bind(thread_id.value())
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(node_context_draft_from_row).collect()
    }

    pub(crate) async fn node_context_draft(
        &self,
        thread_id: ThreadId,
        draft_id: &str,
    ) -> Result<Option<NodeContextDraft>, StorageError> {
        let row = sqlx::query(draft_select!("WHERE id=?1 AND thread_id=?2"))
            .bind(draft_id)
            .bind(thread_id.value())
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(node_context_draft_from_row).transpose()
    }

    pub(crate) async fn node_context_draft_confirmation(
        &self,
        thread_id: ThreadId,
        draft_id: &str,
        expected_revision: i64,
    ) -> Result<Option<NodeContextDraftConfirmation>, StorageError> {
        let row = sqlx::query(
            "SELECT draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at FROM node_context_draft_resolutions WHERE draft_id=?1 AND thread_id=?2",
        )
        .bind(draft_id)
        .bind(thread_id.value())
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        if row.try_get::<String, _>("outcome")? != "confirmed" {
            return Err(context_draft_conflict(
                "context_draft_resolved",
                "This node-context draft was already discarded.",
            ));
        }
        let confirmation = node_context_draft_confirmation_from_row(&row)?;
        if confirmation.draft_revision != expected_revision {
            return Err(context_draft_conflict(
                "context_draft_revision_conflict",
                "This node-context draft was confirmed at a different revision.",
            ));
        }
        Ok(Some(confirmation))
    }

    pub(crate) async fn confirm_node_context_draft(
        &self,
        thread_id: ThreadId,
        draft_id: &str,
        expected_revision: i64,
    ) -> Result<NodeContextDraftConfirmation, StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let resolution = sqlx::query(
            "SELECT draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at FROM node_context_draft_resolutions WHERE draft_id=?1 AND thread_id=?2",
        )
        .bind(draft_id)
        .bind(thread_id.value())
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(row) = resolution {
            if row.try_get::<String, _>("outcome")? != "confirmed" {
                return Err(context_draft_conflict(
                    "context_draft_resolved",
                    "This node-context draft was already discarded.",
                ));
            }
            let confirmation = node_context_draft_confirmation_from_row(&row)?;
            if confirmation.draft_revision != expected_revision {
                return Err(context_draft_conflict(
                    "context_draft_revision_conflict",
                    "This node-context draft was confirmed at a different revision.",
                ));
            }
            tx.commit().await?;
            return Ok(confirmation);
        }
        let row = sqlx::query(draft_select!("WHERE id=?1 AND thread_id=?2"))
            .bind(draft_id)
            .bind(thread_id.value())
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                context_draft_conflict(
                    "context_draft_revision_conflict",
                    "This node-context draft no longer exists. Reload drafts before confirming.",
                )
            })?;
        let draft = node_context_draft_from_row(&row)?;
        if draft.revision != expected_revision {
            return Err(context_draft_conflict(
                "context_draft_revision_conflict",
                "This node-context draft changed before it could be confirmed.",
            ));
        }
        let annotation = draft.text.trim();
        if annotation.is_empty() {
            return Err(StorageError::IncompatibleSchema(
                "node-context draft confirmation requires non-empty text".into(),
            ));
        }
        let target_node_json = serde_json::to_string(&draft.target_node)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let confirmed_at = monotonic_timestamp(&draft.updated_at);
        sqlx::query(
            "INSERT INTO node_context_draft_resolutions(draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at) VALUES (?1,?2,'confirmed',?3,?4,?5,?6,?7,?8,?9)",
        )
        .bind(&draft.id)
        .bind(thread_id.value())
        .bind(draft.revision)
        .bind(draft.target.node_id)
        .bind(draft.target.source_interaction_node_id)
        .bind(draft.target.source_layer_id)
        .bind(target_node_json)
        .bind(annotation)
        .bind(&confirmed_at)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM node_context_drafts WHERE id=?1 AND thread_id=?2")
            .bind(&draft.id)
            .bind(thread_id.value())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(NodeContextDraftConfirmation {
            draft_id: draft.id,
            thread_id,
            target: draft.target,
            target_node: draft.target_node,
            annotation: annotation.into(),
            draft_revision: draft.revision,
            confirmed_at,
        })
    }

    pub(crate) async fn discard_node_context_draft(
        &self,
        thread_id: ThreadId,
        draft_id: &str,
        expected_revision: i64,
    ) -> Result<bool, StorageError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = sqlx::query(draft_select!("WHERE id=?1 AND thread_id=?2"))
            .bind(draft_id)
            .bind(thread_id.value())
            .fetch_optional(&mut *tx)
            .await?;
        let Some(row) = row else {
            let resolution: Option<String> = sqlx::query_scalar(
                "SELECT outcome FROM node_context_draft_resolutions WHERE draft_id=?1 AND thread_id=?2",
            )
            .bind(draft_id)
            .bind(thread_id.value())
            .fetch_optional(&mut *tx)
            .await?;
            if resolution.as_deref() == Some("discarded") {
                tx.commit().await?;
                return Ok(true);
            }
            if resolution.is_some() {
                return Err(context_draft_conflict(
                    "context_draft_resolved",
                    "This node-context draft was already confirmed.",
                ));
            }
            tx.commit().await?;
            return Ok(false);
        };
        let draft = node_context_draft_from_row(&row)?;
        if draft.revision != expected_revision {
            return Err(context_draft_conflict(
                "context_draft_revision_conflict",
                "This node-context draft changed before it could be discarded.",
            ));
        }
        let target_node_json = serde_json::to_string(&draft.target_node)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let resolved_at = monotonic_timestamp(&draft.updated_at);
        sqlx::query(
            "INSERT INTO node_context_draft_resolutions(draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at) VALUES (?1,?2,'discarded',?3,?4,?5,?6,?7,?8,?9)",
        )
        .bind(&draft.id)
        .bind(thread_id.value())
        .bind(draft.revision)
        .bind(draft.target.node_id)
        .bind(draft.target.source_interaction_node_id)
        .bind(draft.target.source_layer_id)
        .bind(target_node_json)
        .bind(&draft.text)
        .bind(resolved_at)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM node_context_drafts WHERE id=?1 AND thread_id=?2")
            .bind(&draft.id)
            .bind(thread_id.value())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(true)
    }
}

fn context_draft_conflict(code: &'static str, message: &str) -> StorageError {
    StorageError::ContextDraftConflict {
        code,
        message: message.into(),
    }
}

fn node_context_draft_from_row(row: &SqliteRow) -> Result<NodeContextDraft, StorageError> {
    let target_node_json: String = row.try_get("target_node_json")?;
    Ok(NodeContextDraft {
        id: row.try_get("id")?,
        thread_id: ThreadId::from_database(row.try_get("thread_id")?),
        target: crate::product::InteractionContextTarget {
            node_id: row.try_get("target_node_id")?,
            source_interaction_node_id: row.try_get("source_interaction_node_id")?,
            source_layer_id: row.try_get("source_layer_id")?,
        },
        target_node: serde_json::from_str(&target_node_json)
            .map_err(|error| StorageError::Serialization(error.to_string()))?,
        text: row.try_get("text")?,
        revision: row.try_get("revision")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn node_context_draft_confirmation_from_row(
    row: &SqliteRow,
) -> Result<NodeContextDraftConfirmation, StorageError> {
    let target_node_json: String = row.try_get("target_node_json")?;
    Ok(NodeContextDraftConfirmation {
        draft_id: row.try_get("draft_id")?,
        thread_id: ThreadId::from_database(row.try_get("thread_id")?),
        target: crate::product::InteractionContextTarget {
            node_id: row.try_get("target_node_id")?,
            source_interaction_node_id: row.try_get("source_interaction_node_id")?,
            source_layer_id: row.try_get("source_layer_id")?,
        },
        target_node: serde_json::from_str(&target_node_json)
            .map_err(|error| StorageError::Serialization(error.to_string()))?,
        annotation: row.try_get("text")?,
        draft_revision: row.try_get("draft_revision")?,
        confirmed_at: row.try_get("resolved_at")?,
    })
}
