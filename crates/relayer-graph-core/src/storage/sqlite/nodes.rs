use sqlx::{FromRow, SqliteConnection};

use crate::{
    GraphError, GraphNode, NodeDraft, NodeId, ProjectId, RecordState, ThreadId,
    graph::InteractionScope,
};

pub(crate) struct NodeTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

pub(crate) struct NodeRecord {
    pub node: GraphNode,
    pub owner: Option<NodeId>,
}

#[derive(FromRow)]
struct NodeRow {
    id: i64,
    kind: String,
    icon: String,
    title: String,
    detail: String,
    state: String,
    owner_interaction_id: Option<i64>,
}

#[derive(FromRow)]
struct InteractionScopeRow {
    project_id: Option<i64>,
    thread_id: i64,
    kind: String,
    state: String,
    owner_interaction_id: Option<i64>,
    imported: i64,
}

impl<'connection> NodeTable<'connection> {
    pub(crate) fn new(connection: &'connection mut SqliteConnection) -> Self {
        Self { connection }
    }

    pub(crate) async fn insert_interaction(
        &mut self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
    ) -> Result<GraphNode, GraphError> {
        let result = sqlx::query(
            "INSERT INTO nodes(project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key) VALUES (?1,?2,'user-interaction','user',?3,?3,'accepted',NULL,NULL)",
        )
        .bind(project_id.map(ProjectId::value))
        .bind(thread_id.value())
        .bind(text)
        .execute(&mut *self.connection)
        .await?;
        Ok(GraphNode {
            id: valid_node_id(result.last_insert_rowid())?,
            kind: "user-interaction".into(),
            icon: "user".into(),
            title: text.into(),
            detail: text.into(),
            state: RecordState::Accepted,
        })
    }

    pub(crate) async fn interaction_scope(
        &mut self,
        node_id: NodeId,
    ) -> Result<InteractionScope, GraphError> {
        let row = sqlx::query_as::<_, InteractionScopeRow>(
            "SELECT n.project_id,n.thread_id,n.kind,n.state,n.owner_interaction_id,EXISTS(SELECT 1 FROM graph_imports gi WHERE gi.thread_id=n.thread_id) AS imported FROM nodes n WHERE n.id=?1",
        )
        .bind(node_id.value())
        .fetch_optional(&mut *self.connection)
        .await?;
        match row {
            Some(row)
                if row.kind == "user-interaction"
                    && row.state == "accepted"
                    && row.owner_interaction_id.is_none() =>
            {
                Ok(InteractionScope {
                    project_id: row.project_id.map(valid_project_id).transpose()?,
                    thread_id: valid_thread_id(row.thread_id)?,
                    root_node_id: node_id,
                    read_only: row.imported != 0,
                })
            }
            _ => Err(GraphError::Forbidden(
                "graph writer requires an accepted user-interaction node".into(),
            )),
        }
    }

    pub(crate) async fn by_owner_and_key(
        &mut self,
        owner: NodeId,
        client_key: &str,
    ) -> Result<Option<NodeRecord>, GraphError> {
        self.fetch_optional(
            "SELECT id,kind,icon,title,detail,state,owner_interaction_id FROM nodes WHERE owner_interaction_id=?1 AND client_key=?2",
            owner.value(),
            Some(client_key),
        )
        .await
    }

    pub(crate) async fn visible(
        &mut self,
        scope: &InteractionScope,
        id: NodeId,
    ) -> Result<GraphNode, GraphError> {
        let row = sqlx::query_as::<_, NodeRow>(
            "SELECT id,kind,icon,title,detail,state,owner_interaction_id FROM nodes WHERE id=?1 AND ((?2 IS NOT NULL AND project_id=?2) OR (?2 IS NULL AND project_id IS NULL AND thread_id=?3))",
        )
        .bind(id.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_optional(&mut *self.connection)
        .await?;
        match row.map(NodeRecord::try_from).transpose()? {
            Some(record)
                if record.node.state == RecordState::Accepted
                    || (record.node.state == RecordState::Draft
                        && record.owner == Some(scope.root_node_id)) =>
            {
                Ok(record.node)
            }
            Some(_) => Err(GraphError::Forbidden(format!(
                "node {id} is not readable by this interaction"
            ))),
            None => {
                let exists = sqlx::query_scalar::<_, i64>("SELECT 1 FROM nodes WHERE id=?1")
                    .bind(id.value())
                    .fetch_optional(&mut *self.connection)
                    .await?
                    .is_some();
                if exists {
                    Err(GraphError::Forbidden(format!(
                        "node {id} is not readable by this interaction"
                    )))
                } else {
                    Err(GraphError::NotFound(format!("node {id}")))
                }
            }
        }
    }

    pub(crate) async fn record(&mut self, id: NodeId) -> Result<Option<NodeRecord>, GraphError> {
        self.fetch_optional(
            "SELECT id,kind,icon,title,detail,state,owner_interaction_id FROM nodes WHERE id=?1",
            id.value(),
            None,
        )
        .await
    }

    pub(crate) async fn insert_draft(
        &mut self,
        scope: &InteractionScope,
        draft: &NodeDraft,
    ) -> Result<GraphNode, GraphError> {
        let result = sqlx::query(
            "INSERT INTO nodes(project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key) VALUES (?1,?2,?3,?4,?5,?6,'draft',?7,?8)",
        )
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .bind(&draft.kind)
        .bind(&draft.icon)
        .bind(&draft.title)
        .bind(&draft.detail)
        .bind(scope.root_node_id.value())
        .bind(&draft.client_key)
        .execute(&mut *self.connection)
        .await?;
        Ok(draft_node(
            valid_node_id(result.last_insert_rowid())?,
            draft,
        ))
    }

    pub(crate) async fn update_draft(
        &mut self,
        id: NodeId,
        draft: &NodeDraft,
    ) -> Result<GraphNode, GraphError> {
        sqlx::query("UPDATE nodes SET kind=?1,icon=?2,title=?3,detail=?4 WHERE id=?5")
            .bind(&draft.kind)
            .bind(&draft.icon)
            .bind(&draft.title)
            .bind(&draft.detail)
            .bind(id.value())
            .execute(&mut *self.connection)
            .await?;
        Ok(draft_node(id, draft))
    }

    pub(crate) async fn neighbors(
        &mut self,
        scope: &InteractionScope,
        id: NodeId,
    ) -> Result<Vec<GraphNode>, GraphError> {
        let rows = sqlx::query_as::<_, NodeRow>(
            r#"
            SELECT n.id,n.kind,n.icon,n.title,n.detail,n.state,n.owner_interaction_id
            FROM edges e
            JOIN nodes n ON n.id = CASE WHEN e.left_id = ?1 THEN e.right_id ELSE e.left_id END
            WHERE e.state='accepted'
              AND (e.left_id=?1 OR e.right_id=?1)
              AND n.state='accepted'
              AND ((?2 IS NOT NULL AND e.project_id=?2) OR (?2 IS NULL AND e.project_id IS NULL AND e.thread_id=?3))
            ORDER BY n.id
            "#,
        )
        .bind(id.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_all(&mut *self.connection)
        .await?;
        rows.into_iter()
            .map(NodeRecord::try_from)
            .map(|record| record.map(|record| record.node))
            .collect()
    }

    pub(crate) async fn accept_owned(
        &mut self,
        id: NodeId,
        owner: NodeId,
    ) -> Result<(), GraphError> {
        sqlx::query("UPDATE nodes SET state='accepted' WHERE id=?1 AND owner_interaction_id=?2")
            .bind(id.value())
            .bind(owner.value())
            .execute(&mut *self.connection)
            .await?;
        Ok(())
    }

    async fn fetch_optional(
        &mut self,
        sql: &str,
        first: i64,
        second: Option<&str>,
    ) -> Result<Option<NodeRecord>, GraphError> {
        let mut query = sqlx::query_as::<_, NodeRow>(sql).bind(first);
        if let Some(second) = second {
            query = query.bind(second);
        }
        query
            .fetch_optional(&mut *self.connection)
            .await?
            .map(NodeRecord::try_from)
            .transpose()
    }
}

impl TryFrom<NodeRow> for NodeRecord {
    type Error = GraphError;

    fn try_from(row: NodeRow) -> Result<Self, Self::Error> {
        Ok(Self {
            node: GraphNode {
                id: valid_node_id(row.id)?,
                kind: row.kind,
                icon: row.icon,
                title: row.title,
                detail: row.detail,
                state: RecordState::parse(&row.state)?,
            },
            owner: row.owner_interaction_id.map(valid_node_id).transpose()?,
        })
    }
}

fn draft_node(id: NodeId, draft: &NodeDraft) -> GraphNode {
    GraphNode {
        id,
        kind: draft.kind.clone(),
        icon: draft.icon.clone(),
        title: draft.title.clone(),
        detail: draft.detail.clone(),
        state: RecordState::Draft,
    }
}

fn valid_node_id(value: i64) -> Result<NodeId, GraphError> {
    NodeId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid node ID".into()))
}

fn valid_project_id(value: i64) -> Result<ProjectId, GraphError> {
    ProjectId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid project ID".into()))
}

fn valid_thread_id(value: i64) -> Result<ThreadId, GraphError> {
    ThreadId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid thread ID".into()))
}
