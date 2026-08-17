use sqlx::SqliteConnection;

use crate::{ActionId, GraphError, NodeId};

pub(crate) struct CompletionTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

impl<'connection> CompletionTable<'connection> {
    pub(crate) fn new(connection: &'connection mut SqliteConnection) -> Self {
        Self { connection }
    }

    pub(crate) async fn root_action(
        &mut self,
        interaction: NodeId,
    ) -> Result<Option<ActionId>, GraphError> {
        sqlx::query_scalar::<_, i64>(
            "SELECT root_action_id FROM completions WHERE interaction_node_id=?1",
        )
        .bind(interaction.value())
        .fetch_optional(&mut *self.connection)
        .await?
        .map(valid_action_id)
        .transpose()
    }

    pub(crate) async fn insert(
        &mut self,
        interaction: NodeId,
        root_action: ActionId,
    ) -> Result<(), GraphError> {
        sqlx::query("INSERT INTO completions(interaction_node_id,root_action_id) VALUES (?1,?2)")
            .bind(interaction.value())
            .bind(root_action.value())
            .execute(&mut *self.connection)
            .await?;
        Ok(())
    }
}

fn valid_action_id(value: i64) -> Result<ActionId, GraphError> {
    ActionId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid action ID".into()))
}
