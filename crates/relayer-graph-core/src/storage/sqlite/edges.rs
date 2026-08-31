use sqlx::{FromRow, SqliteConnection};

use crate::{
    EdgeDraft, EdgeId, GraphEdge, GraphError, NodeId, ProjectId, RecordState,
    graph::InteractionScope,
};

pub(crate) struct EdgeTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

#[derive(FromRow)]
struct EdgeRow {
    id: i64,
    left_id: i64,
    right_id: i64,
    state: String,
    owner_interaction_id: i64,
}

pub(crate) struct EdgeRecord {
    pub edge: GraphEdge,
    pub owner: NodeId,
}

impl<'connection> EdgeTable<'connection> {
    pub(crate) fn new(connection: &'connection mut SqliteConnection) -> Self {
        Self { connection }
    }

    pub(crate) async fn visible(
        &mut self,
        scope: &InteractionScope,
        id: EdgeId,
    ) -> Result<GraphEdge, GraphError> {
        let row = sqlx::query_as::<_, EdgeRow>(
            "SELECT id,left_id,right_id,state,owner_interaction_id FROM edges WHERE id=?1 AND ((?2 IS NOT NULL AND project_id=?2) OR (?2 IS NULL AND project_id IS NULL AND thread_id=?3))",
        )
        .bind(id.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_optional(&mut *self.connection)
        .await?;
        match row.map(EdgeRecord::try_from).transpose()? {
            Some(record)
                if record.edge.state == RecordState::Accepted
                    || (record.edge.state == RecordState::Draft
                        && record.owner == scope.root_node_id) =>
            {
                Ok(record.edge)
            }
            Some(_) => Err(GraphError::Forbidden(format!(
                "edge {id} is not readable by this interaction"
            ))),
            None => Err(GraphError::NotFound(format!("edge {id}"))),
        }
    }

    pub(crate) async fn by_owner_and_key(
        &mut self,
        owner: NodeId,
        client_key: &str,
    ) -> Result<Option<EdgeRecord>, GraphError> {
        sqlx::query_as::<_, EdgeRow>(
            "SELECT id,left_id,right_id,state,owner_interaction_id FROM edges WHERE owner_interaction_id=?1 AND client_key=?2",
        )
        .bind(owner.value())
        .bind(client_key)
        .fetch_optional(&mut *self.connection)
        .await?
        .map(EdgeRecord::try_from)
        .transpose()
    }

    pub(crate) async fn duplicate(
        &mut self,
        scope: &InteractionScope,
        endpoints: [NodeId; 2],
    ) -> Result<Option<EdgeId>, GraphError> {
        let value = sqlx::query_scalar::<_, i64>(
            "SELECT id FROM edges WHERE left_id=?1 AND right_id=?2 AND ((?3 IS NOT NULL AND project_id=?3) OR (?3 IS NULL AND project_id IS NULL AND thread_id=?4)) AND (state='accepted' OR owner_interaction_id=?5) LIMIT 1",
        )
        .bind(endpoints[0].value())
        .bind(endpoints[1].value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .bind(scope.root_node_id.value())
        .fetch_optional(&mut *self.connection)
        .await?;
        value.map(valid_edge_id).transpose()
    }

    pub(crate) async fn accepted_duplicate(
        &mut self,
        scope: &InteractionScope,
        id: EdgeId,
        endpoints: [NodeId; 2],
    ) -> Result<Option<EdgeId>, GraphError> {
        let value = sqlx::query_scalar::<_, i64>(
            "SELECT id FROM edges WHERE id<>?1 AND left_id=?2 AND right_id=?3 AND state='accepted' AND ((?4 IS NOT NULL AND project_id=?4) OR (?4 IS NULL AND project_id IS NULL AND thread_id=?5)) LIMIT 1",
        )
        .bind(id.value())
        .bind(endpoints[0].value())
        .bind(endpoints[1].value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_optional(&mut *self.connection)
        .await?;
        value.map(valid_edge_id).transpose()
    }

    pub(crate) async fn insert_draft(
        &mut self,
        scope: &InteractionScope,
        draft: &EdgeDraft,
        endpoints: [NodeId; 2],
    ) -> Result<GraphEdge, GraphError> {
        let result = sqlx::query(
            "INSERT INTO edges(project_id,thread_id,left_id,right_id,state,owner_interaction_id,client_key) VALUES (?1,?2,?3,?4,'draft',?5,?6)",
        )
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .bind(endpoints[0].value())
        .bind(endpoints[1].value())
        .bind(scope.root_node_id.value())
        .bind(&draft.client_key)
        .execute(&mut *self.connection)
        .await?;
        Ok(GraphEdge {
            id: valid_edge_id(result.last_insert_rowid())?,
            endpoints,
            state: RecordState::Draft,
        })
    }

    pub(crate) async fn publish_owned(
        &mut self,
        id: EdgeId,
        owner: NodeId,
        revision: Option<u64>,
    ) -> Result<(), GraphError> {
        let revision = revision
            .map(|value| {
                i64::try_from(value).map_err(|_| {
                    GraphError::Internal("completion revision exceeds SQLite range".into())
                })
            })
            .transpose()?;
        sqlx::query("UPDATE edges SET state='accepted',published_revision=COALESCE(published_revision,?3) WHERE id=?1 AND owner_interaction_id=?2")
            .bind(id.value())
            .bind(owner.value())
            .bind(revision)
            .execute(&mut *self.connection)
            .await?;
        Ok(())
    }
}

impl TryFrom<EdgeRow> for EdgeRecord {
    type Error = GraphError;

    fn try_from(row: EdgeRow) -> Result<Self, Self::Error> {
        Ok(Self {
            edge: GraphEdge {
                id: valid_edge_id(row.id)?,
                endpoints: [valid_node_id(row.left_id)?, valid_node_id(row.right_id)?],
                state: RecordState::parse(&row.state)?,
            },
            owner: valid_node_id(row.owner_interaction_id)?,
        })
    }
}

fn valid_edge_id(value: i64) -> Result<EdgeId, GraphError> {
    EdgeId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid edge ID".into()))
}

fn valid_node_id(value: i64) -> Result<NodeId, GraphError> {
    NodeId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid node ID".into()))
}
