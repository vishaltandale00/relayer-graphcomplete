use sqlx::{FromRow, SqliteConnection};

use crate::{
    ActionDraft, ActionId, ActionKind, GraphAction, GraphError, LayerId, NodeId, ProjectId,
    RecordState, graph::InteractionScope,
};

pub(crate) struct ActionTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

pub(crate) struct ActionRecord {
    pub action: GraphAction,
    pub owner: NodeId,
}

#[derive(FromRow)]
struct ActionRow {
    id: i64,
    source_node_id: i64,
    kind: String,
    label: String,
    target_layer_id: Option<i64>,
    interaction_text: Option<String>,
    response: bool,
    state: String,
    owner_interaction_id: i64,
}

impl<'connection> ActionTable<'connection> {
    pub(crate) fn new(connection: &'connection mut SqliteConnection) -> Self {
        Self { connection }
    }

    pub(crate) async fn record(
        &mut self,
        scope: &InteractionScope,
        id: ActionId,
    ) -> Result<Option<ActionRecord>, GraphError> {
        sqlx::query_as::<_, ActionRow>(
            "SELECT id,source_node_id,kind,label,target_layer_id,interaction_text,response,state,owner_interaction_id FROM actions WHERE id=?1 AND ((?2 IS NOT NULL AND project_id=?2) OR (?2 IS NULL AND project_id IS NULL AND thread_id=?3))",
        )
        .bind(id.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_optional(&mut *self.connection)
        .await?
        .map(ActionRecord::try_from)
        .transpose()
    }

    pub(crate) async fn for_source(
        &mut self,
        scope: &InteractionScope,
        source: NodeId,
        owner: Option<NodeId>,
        accepted_only: bool,
    ) -> Result<Vec<ActionRecord>, GraphError> {
        let rows = match (owner, accepted_only) {
            (Some(owner), _) => sqlx::query_as::<_, ActionRow>(
                "SELECT id,source_node_id,kind,label,target_layer_id,interaction_text,response,state,owner_interaction_id FROM actions WHERE source_node_id=?1 AND owner_interaction_id=?2 AND ((?3 IS NOT NULL AND project_id=?3) OR (?3 IS NULL AND project_id IS NULL AND thread_id=?4)) ORDER BY id",
            )
            .bind(source.value())
            .bind(owner.value())
            .bind(scope.project_id.map(ProjectId::value))
            .bind(scope.thread_id.value())
            .fetch_all(&mut *self.connection)
            .await?,
            (None, true) => sqlx::query_as::<_, ActionRow>(
                "SELECT id,source_node_id,kind,label,target_layer_id,interaction_text,response,state,owner_interaction_id FROM actions WHERE source_node_id=?1 AND state='accepted' AND ((?2 IS NOT NULL AND project_id=?2) OR (?2 IS NULL AND project_id IS NULL AND thread_id=?3)) ORDER BY id",
            )
            .bind(source.value())
            .bind(scope.project_id.map(ProjectId::value))
            .bind(scope.thread_id.value())
            .fetch_all(&mut *self.connection)
            .await?,
            (None, false) => sqlx::query_as::<_, ActionRow>(
                "SELECT id,source_node_id,kind,label,target_layer_id,interaction_text,response,state,owner_interaction_id FROM actions WHERE source_node_id=?1 AND (state='accepted' OR owner_interaction_id=?2) AND ((?3 IS NOT NULL AND project_id=?3) OR (?3 IS NULL AND project_id IS NULL AND thread_id=?4)) ORDER BY id",
            )
            .bind(source.value())
            .bind(scope.root_node_id.value())
            .bind(scope.project_id.map(ProjectId::value))
            .bind(scope.thread_id.value())
            .fetch_all(&mut *self.connection)
            .await?,
        };
        rows.into_iter().map(ActionRecord::try_from).collect()
    }

    pub(crate) async fn by_owner_and_key(
        &mut self,
        owner: NodeId,
        source: NodeId,
        client_key: &str,
    ) -> Result<Option<ActionRecord>, GraphError> {
        sqlx::query_as::<_, ActionRow>(
            "SELECT id,source_node_id,kind,label,target_layer_id,interaction_text,response,state,owner_interaction_id FROM actions WHERE owner_interaction_id=?1 AND source_node_id=?2 AND client_key=?3",
        )
        .bind(owner.value())
        .bind(source.value())
        .bind(client_key)
        .fetch_optional(&mut *self.connection)
        .await?
        .map(ActionRecord::try_from)
        .transpose()
    }

    pub(crate) async fn insert_draft(
        &mut self,
        scope: &InteractionScope,
        draft: &ActionDraft,
    ) -> Result<GraphAction, GraphError> {
        let result = sqlx::query(
            "INSERT INTO actions(project_id,thread_id,source_node_id,kind,label,target_layer_id,interaction_text,response,state,owner_interaction_id,client_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'draft',?9,?10)",
        )
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .bind(draft.source_node_id.value())
        .bind(draft.kind.as_str())
        .bind(&draft.label)
        .bind(draft.target_layer_id.map(LayerId::value))
        .bind(&draft.interaction_text)
        .bind(draft.response)
        .bind(scope.root_node_id.value())
        .bind(&draft.client_key)
        .execute(&mut *self.connection)
        .await?;
        Ok(draft_action(
            valid_action_id(result.last_insert_rowid())?,
            draft,
        ))
    }

    pub(crate) async fn update_draft(
        &mut self,
        id: ActionId,
        draft: &ActionDraft,
    ) -> Result<GraphAction, GraphError> {
        sqlx::query("UPDATE actions SET source_node_id=?1,kind=?2,label=?3,target_layer_id=?4,interaction_text=?5,response=?6 WHERE id=?7")
            .bind(draft.source_node_id.value())
            .bind(draft.kind.as_str())
            .bind(&draft.label)
            .bind(draft.target_layer_id.map(LayerId::value))
            .bind(&draft.interaction_text)
            .bind(draft.response)
            .bind(id.value())
            .execute(&mut *self.connection)
            .await?;
        Ok(draft_action(id, draft))
    }

    pub(crate) async fn accept_owned(
        &mut self,
        id: ActionId,
        owner: NodeId,
    ) -> Result<(), GraphError> {
        sqlx::query("UPDATE actions SET state='accepted' WHERE id=?1 AND owner_interaction_id=?2")
            .bind(id.value())
            .bind(owner.value())
            .execute(&mut *self.connection)
            .await?;
        Ok(())
    }
}

impl TryFrom<ActionRow> for ActionRecord {
    type Error = GraphError;

    fn try_from(row: ActionRow) -> Result<Self, Self::Error> {
        Ok(Self {
            action: GraphAction {
                id: valid_action_id(row.id)?,
                source_node_id: valid_node_id(row.source_node_id)?,
                kind: ActionKind::parse(&row.kind)?,
                label: row.label,
                target_layer_id: row.target_layer_id.map(valid_layer_id).transpose()?,
                interaction_text: row.interaction_text,
                response: row.response,
                state: RecordState::parse(&row.state)?,
            },
            owner: valid_node_id(row.owner_interaction_id)?,
        })
    }
}

fn draft_action(id: ActionId, draft: &ActionDraft) -> GraphAction {
    GraphAction {
        id,
        source_node_id: draft.source_node_id,
        kind: draft.kind,
        label: draft.label.clone(),
        target_layer_id: draft.target_layer_id,
        interaction_text: draft.interaction_text.clone(),
        response: draft.response,
        state: RecordState::Draft,
    }
}

fn valid_action_id(value: i64) -> Result<ActionId, GraphError> {
    ActionId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid action ID".into()))
}

fn valid_node_id(value: i64) -> Result<NodeId, GraphError> {
    NodeId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid node ID".into()))
}

fn valid_layer_id(value: i64) -> Result<LayerId, GraphError> {
    LayerId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid layer ID".into()))
}
