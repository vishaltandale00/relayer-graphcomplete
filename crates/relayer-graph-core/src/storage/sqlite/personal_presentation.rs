use crate::{GraphError, LayerId, NodeId, ThreadId};

use super::SqliteGraphStore;

pub(crate) enum PublishPersonalPresentationResult {
    Published(LayerId),
    InvalidCompletion,
    Immutable,
    Retired,
}

pub(crate) enum AttachPersonalPresentationResult {
    Attached(LayerId),
    TargetNotFound,
    VersionNotPublished,
    VersionRetired,
    Conflict,
}

impl SqliteGraphStore {
    pub(crate) async fn publish_personal_presentation_version(
        &self,
        profile_thread_id: ThreadId,
        version_interaction_node_id: NodeId,
    ) -> Result<PublishPersonalPresentationResult, GraphError> {
        let mut transaction = self.begin_write().await?;
        let root_layer_id = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT root.target_layer_id
            FROM completions completion
            JOIN nodes version ON version.id=completion.interaction_node_id
            JOIN actions root ON root.id=completion.root_action_id
            JOIN layers root_layer ON root_layer.id=root.target_layer_id
            WHERE completion.interaction_node_id=?1
              AND version.thread_id=?2
              AND version.kind='user-interaction'
              AND version.state='accepted'
              AND version.owner_interaction_id IS NULL
              AND root.kind='navigate'
              AND root.relation='expand'
              AND root.state='accepted'
              AND root.source_node_id=version.id
              AND root.source_layer_id IS NULL
              AND root_layer.state='accepted'
              AND root_layer.owner_interaction_id=version.id
            "#,
        )
        .bind(version_interaction_node_id.value())
        .bind(profile_thread_id.value())
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(root_layer_id) = root_layer_id else {
            return Ok(PublishPersonalPresentationResult::InvalidCompletion);
        };
        let root_layer_id = valid_layer_id(root_layer_id)?;

        sqlx::query("INSERT OR IGNORE INTO personal_presentation_profiles(thread_id) VALUES (?1)")
            .bind(profile_thread_id.value())
            .execute(&mut *transaction)
            .await?;
        if let Some((stored_thread, stored_root, retired)) =
            sqlx::query_as::<_, (i64, i64, i64)>(
                "SELECT profile_thread_id,root_layer_id,retired FROM personal_presentation_versions WHERE version_interaction_node_id=?1",
            )
            .bind(version_interaction_node_id.value())
            .fetch_optional(&mut *transaction)
            .await?
        {
            if stored_thread != profile_thread_id.value() || stored_root != root_layer_id.value() {
                return Ok(PublishPersonalPresentationResult::Immutable);
            }
            if retired != 0 {
                return Ok(PublishPersonalPresentationResult::Retired);
            }
        } else {
            sqlx::query(
                "INSERT INTO personal_presentation_versions(version_interaction_node_id,profile_thread_id,root_layer_id) VALUES (?1,?2,?3)",
            )
            .bind(version_interaction_node_id.value())
            .bind(profile_thread_id.value())
            .bind(root_layer_id.value())
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(PublishPersonalPresentationResult::Published(root_layer_id))
    }

    pub(crate) async fn attach_personal_presentation(
        &self,
        interaction_node_id: NodeId,
        version_interaction_node_id: NodeId,
    ) -> Result<AttachPersonalPresentationResult, GraphError> {
        let mut transaction = self.begin_write().await?;
        let target_is_interaction: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM nodes WHERE id=?1 AND kind='user-interaction' AND state='accepted' AND owner_interaction_id IS NULL)",
        )
        .bind(interaction_node_id.value())
        .fetch_one(&mut *transaction)
        .await?;
        if !target_is_interaction {
            return Ok(AttachPersonalPresentationResult::TargetNotFound);
        }

        let Some((root_layer_id, retired)) = sqlx::query_as::<_, (i64, i64)>(
            "SELECT root_layer_id,retired FROM personal_presentation_versions WHERE version_interaction_node_id=?1",
        )
        .bind(version_interaction_node_id.value())
        .fetch_optional(&mut *transaction)
        .await?
        else {
            return Ok(AttachPersonalPresentationResult::VersionNotPublished);
        };
        if retired != 0 {
            return Ok(AttachPersonalPresentationResult::VersionRetired);
        }
        let root_layer_id = valid_layer_id(root_layer_id)?;

        if let Some((stored_version, stored_root)) = sqlx::query_as::<_, (i64, i64)>(
            "SELECT version_interaction_node_id,root_layer_id FROM personal_presentation_attachments WHERE interaction_node_id=?1",
        )
        .bind(interaction_node_id.value())
        .fetch_optional(&mut *transaction)
        .await?
        {
            if valid_node_id(stored_version)? == version_interaction_node_id
                && valid_layer_id(stored_root)? == root_layer_id
            {
                transaction.commit().await?;
                return Ok(AttachPersonalPresentationResult::Attached(root_layer_id));
            }
            return Ok(AttachPersonalPresentationResult::Conflict);
        }

        sqlx::query(
            "INSERT INTO personal_presentation_attachments(interaction_node_id,version_interaction_node_id,root_layer_id) VALUES (?1,?2,?3)",
        )
        .bind(interaction_node_id.value())
        .bind(version_interaction_node_id.value())
        .bind(root_layer_id.value())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(AttachPersonalPresentationResult::Attached(root_layer_id))
    }

    pub(crate) async fn personal_presentation_attachment(
        &self,
        interaction_node_id: NodeId,
    ) -> Result<Option<(NodeId, LayerId)>, GraphError> {
        let mut connection = self.acquire().await?;
        sqlx::query_as::<_, (i64, i64)>(
            "SELECT version_interaction_node_id,root_layer_id FROM personal_presentation_attachments WHERE interaction_node_id=?1",
        )
        .bind(interaction_node_id.value())
        .fetch_optional(&mut *connection)
        .await?
        .map(|(version, root)| Ok((valid_node_id(version)?, valid_layer_id(root)?)))
        .transpose()
    }
}

fn valid_node_id(value: i64) -> Result<NodeId, GraphError> {
    NodeId::new(value).ok_or_else(|| {
        GraphError::Internal("database returned an invalid preference version ID".into())
    })
}

fn valid_layer_id(value: i64) -> Result<LayerId, GraphError> {
    LayerId::new(value).ok_or_else(|| {
        GraphError::Internal("database returned an invalid preference root layer ID".into())
    })
}
