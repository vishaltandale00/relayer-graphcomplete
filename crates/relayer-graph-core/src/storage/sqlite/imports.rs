use sqlx::{FromRow, SqliteConnection};

use crate::{GraphError, ProjectId, SearchTarget, ThreadId};

pub(crate) struct ImportTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

#[derive(FromRow)]
struct ImportTargetRow {
    project_id: Option<i64>,
    thread_id: i64,
}

impl<'connection> ImportTable<'connection> {
    pub(crate) fn new(connection: &'connection mut SqliteConnection) -> Self {
        Self { connection }
    }

    /// The logical publication target reserved by an existing import stage.
    pub(crate) async fn target(&mut self, import_id: &str) -> Result<SearchTarget, GraphError> {
        let row = sqlx::query_as::<_, ImportTargetRow>(
            "SELECT project_id,thread_id FROM graph_imports WHERE import_id=?1",
        )
        .bind(import_id)
        .fetch_one(&mut *self.connection)
        .await?;
        let project_id = row
            .project_id
            .map(|value| {
                ProjectId::new(value)
                    .ok_or_else(|| GraphError::Internal("invalid imported project ID".into()))
            })
            .transpose()?;
        let thread_id = ThreadId::new(row.thread_id).ok_or_else(|| {
            GraphError::Internal("imported conversation has an invalid thread".into())
        })?;
        Ok(SearchTarget::new(project_id, thread_id))
    }

    /// The removal target for an import, if it still exists. Keep the legacy
    /// invalid-project fallback used by removal separate from `target`, whose
    /// stricter validation is part of import finalization.
    pub(crate) async fn removal_target(
        &mut self,
        import_id: &str,
    ) -> Result<Option<(SearchTarget, ThreadId)>, GraphError> {
        let row = sqlx::query_as::<_, ImportTargetRow>(
            "SELECT project_id,thread_id FROM graph_imports WHERE import_id=?1",
        )
        .bind(import_id)
        .fetch_optional(&mut *self.connection)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let project_id = row.project_id.and_then(ProjectId::new);
        let thread_id = ThreadId::new(row.thread_id)
            .ok_or_else(|| GraphError::Internal("graph import has an invalid thread".into()))?;
        Ok(Some((SearchTarget::new(project_id, thread_id), thread_id)))
    }

    /// Check removal authority and return current completion IDs in stable order.
    /// Graph orchestration reads their accepted publications before canonical
    /// rows are staged for deletion.
    pub(crate) async fn prepare_removal(
        &mut self,
        import_id: &str,
        thread_id: ThreadId,
    ) -> Result<Option<Vec<crate::NodeId>>, GraphError> {
        let still_present: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM graph_imports WHERE import_id=?1)")
                .bind(import_id)
                .fetch_one(&mut *self.connection)
                .await?;
        if !still_present {
            return Ok(None);
        }

        let externally_referenced: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM actions a \
             JOIN layers target ON target.id=a.target_layer_id \
             WHERE target.thread_id=?1 AND a.thread_id<>?1)",
        )
        .bind(thread_id.value())
        .fetch_one(&mut *self.connection)
        .await?;
        if externally_referenced {
            return Err(GraphError::Forbidden(
                "imported conversation is referenced by another thread".into(),
            ));
        }

        let current_ids: Vec<i64> = sqlx::query_scalar(
            "SELECT state.interaction_node_id FROM completion_states state \
             JOIN nodes n ON n.id=state.interaction_node_id \
             WHERE n.thread_id=?1 AND state.current_layer_id IS NOT NULL \
             ORDER BY state.interaction_node_id",
        )
        .bind(thread_id.value())
        .fetch_all(&mut *self.connection)
        .await?;
        let current_ids = current_ids
            .into_iter()
            .map(|id| {
                crate::NodeId::new(id).ok_or_else(|| {
                    GraphError::Internal("imported completion has an invalid interaction".into())
                })
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Some(current_ids))
    }

    /// Stage canonical deletion after graph orchestration has captured the
    /// accepted publications, keeping FK checks inside the caller's transaction.
    pub(crate) async fn delete_canonical(
        &mut self,
        import_id: &str,
        thread_id: ThreadId,
    ) -> Result<(), GraphError> {
        for statement in [
            "DELETE FROM graph_projection_outbox WHERE interaction_node_id IN (SELECT id FROM nodes WHERE thread_id=?1)",
            "DELETE FROM current_revisions WHERE interaction_node_id IN (SELECT id FROM nodes WHERE thread_id=?1)",
            "DELETE FROM completion_authorities WHERE interaction_node_id IN (SELECT id FROM nodes WHERE thread_id=?1)",
            "DELETE FROM completion_states WHERE interaction_node_id IN (SELECT id FROM nodes WHERE thread_id=?1)",
            "DELETE FROM interaction_input_children WHERE parent_interaction_node_id IN (SELECT id FROM nodes WHERE thread_id=?1)",
            "DELETE FROM completions WHERE interaction_node_id IN (SELECT id FROM nodes WHERE thread_id=?1)",
            "DELETE FROM layer_actions WHERE layer_id IN (SELECT id FROM layers WHERE thread_id=?1)",
            "DELETE FROM actions WHERE thread_id=?1",
            "DELETE FROM layer_edges WHERE layer_id IN (SELECT id FROM layers WHERE thread_id=?1)",
            "DELETE FROM layer_nodes WHERE layer_id IN (SELECT id FROM layers WHERE thread_id=?1)",
            "DELETE FROM layers WHERE thread_id=?1",
            "DELETE FROM edges WHERE thread_id=?1",
            "DELETE FROM nodes WHERE thread_id=?1",
        ] {
            sqlx::query(statement)
                .bind(thread_id.value())
                .execute(&mut *self.connection)
                .await?;
        }
        sqlx::query("DELETE FROM graph_imports WHERE import_id=?1")
            .bind(import_id)
            .execute(&mut *self.connection)
            .await?;
        Ok(())
    }
}
