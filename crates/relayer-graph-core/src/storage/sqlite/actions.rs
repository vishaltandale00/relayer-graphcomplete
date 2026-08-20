use sqlx::{FromRow, SqliteConnection};

use crate::{
    ActionDraft, ActionId, ActionKind, ActionVariant, GraphAction, GraphError, LayerId,
    NavigateRelation, NodeId, ProjectId, RecordState, graph::InteractionScope,
};

pub(crate) struct ActionTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

pub(crate) struct ActionRecord {
    pub action: GraphAction,
}

#[derive(FromRow)]
struct ActionRow {
    id: i64,
    source_node_id: i64,
    source_layer_id: Option<i64>,
    kind: String,
    relation: Option<String>,
    label: String,
    variant: String,
    icon: Option<String>,
    description: Option<String>,
    target_layer_id: Option<i64>,
    interaction_text: Option<String>,
    state: String,
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
            "SELECT id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,state FROM actions WHERE id=?1 AND ((?2 IS NOT NULL AND project_id=?2) OR (?2 IS NULL AND project_id IS NULL AND thread_id=?3))",
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
                "SELECT id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,state FROM actions WHERE source_node_id=?1 AND owner_interaction_id=?2 AND ((?3 IS NOT NULL AND project_id=?3) OR (?3 IS NULL AND project_id IS NULL AND thread_id=?4)) ORDER BY id",
            )
            .bind(source.value())
            .bind(owner.value())
            .bind(scope.project_id.map(ProjectId::value))
            .bind(scope.thread_id.value())
            .fetch_all(&mut *self.connection)
            .await?,
            (None, true) => sqlx::query_as::<_, ActionRow>(
                "SELECT id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,state FROM actions WHERE source_node_id=?1 AND state='accepted' AND ((?2 IS NOT NULL AND project_id=?2) OR (?2 IS NULL AND project_id IS NULL AND thread_id=?3)) ORDER BY id",
            )
            .bind(source.value())
            .bind(scope.project_id.map(ProjectId::value))
            .bind(scope.thread_id.value())
            .fetch_all(&mut *self.connection)
            .await?,
            (None, false) => sqlx::query_as::<_, ActionRow>(
                "SELECT id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,state FROM actions WHERE source_node_id=?1 AND (state='accepted' OR owner_interaction_id=?2) AND ((?3 IS NOT NULL AND project_id=?3) OR (?3 IS NULL AND project_id IS NULL AND thread_id=?4)) ORDER BY id",
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
            "SELECT id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,state FROM actions WHERE owner_interaction_id=?1 AND source_node_id=?2 AND client_key=?3",
        )
        .bind(owner.value())
        .bind(source.value())
        .bind(client_key)
        .fetch_optional(&mut *self.connection)
        .await?
        .map(ActionRecord::try_from)
        .transpose()
    }

    pub(crate) async fn for_source_layer(
        &mut self,
        scope: &InteractionScope,
        layer: LayerId,
    ) -> Result<Vec<ActionRecord>, GraphError> {
        sqlx::query_as::<_, ActionRow>(
            "SELECT id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,state FROM actions WHERE owner_interaction_id=?1 AND source_layer_id=?2 AND ((?3 IS NOT NULL AND project_id=?3) OR (?3 IS NULL AND project_id IS NULL AND thread_id=?4)) ORDER BY id",
        )
        .bind(scope.root_node_id.value())
        .bind(layer.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_all(&mut *self.connection)
        .await?
        .into_iter()
        .map(ActionRecord::try_from)
        .collect()
    }

    pub(crate) async fn relations_for_owned_target(
        &mut self,
        owner: NodeId,
        target: LayerId,
    ) -> Result<Vec<NavigateRelation>, GraphError> {
        sqlx::query_scalar::<_, String>(
            "SELECT relation FROM actions WHERE owner_interaction_id=?1 AND kind='navigate' AND target_layer_id=?2 AND relation IS NOT NULL ORDER BY id",
        )
        .bind(owner.value())
        .bind(target.value())
        .fetch_all(&mut *self.connection)
        .await?
        .into_iter()
        .map(|relation| NavigateRelation::parse(&relation))
        .collect()
    }

    pub(crate) async fn insert_draft(
        &mut self,
        scope: &InteractionScope,
        draft: &ActionDraft,
    ) -> Result<GraphAction, GraphError> {
        let result = sqlx::query(
            "INSERT INTO actions(project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,state,owner_interaction_id,client_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'draft',?13,?14)",
        )
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .bind(draft.source_node_id.value())
        .bind(draft.source_layer_id.map(LayerId::value))
        .bind(draft.kind.as_str())
        .bind(draft.relation.map(NavigateRelation::as_str))
        .bind(&draft.label)
        .bind(draft.variant.as_str())
        .bind(&draft.icon)
        .bind(&draft.description)
        .bind(draft.target_layer_id.map(LayerId::value))
        .bind(&draft.interaction_text)
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
        sqlx::query("UPDATE actions SET source_node_id=?1,source_layer_id=?2,kind=?3,relation=?4,label=?5,variant=?6,icon=?7,description=?8,target_layer_id=?9,interaction_text=?10 WHERE id=?11")
            .bind(draft.source_node_id.value())
            .bind(draft.source_layer_id.map(LayerId::value))
            .bind(draft.kind.as_str())
            .bind(draft.relation.map(NavigateRelation::as_str))
            .bind(&draft.label)
            .bind(draft.variant.as_str())
            .bind(&draft.icon)
            .bind(&draft.description)
            .bind(draft.target_layer_id.map(LayerId::value))
            .bind(&draft.interaction_text)
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
                source_layer_id: row.source_layer_id.map(valid_layer_id).transpose()?,
                kind: ActionKind::parse(&row.kind)?,
                relation: row
                    .relation
                    .as_deref()
                    .map(NavigateRelation::parse)
                    .transpose()?,
                label: row.label,
                variant: ActionVariant::parse(&row.variant)?,
                icon: row.icon,
                description: row.description,
                target_layer_id: row.target_layer_id.map(valid_layer_id).transpose()?,
                interaction_text: row.interaction_text,
                state: RecordState::parse(&row.state)?,
            },
        })
    }
}

fn draft_action(id: ActionId, draft: &ActionDraft) -> GraphAction {
    GraphAction {
        id,
        source_node_id: draft.source_node_id,
        source_layer_id: draft.source_layer_id,
        kind: draft.kind,
        relation: draft.relation,
        label: draft.label.clone(),
        variant: draft.variant.clone(),
        icon: draft.icon.clone(),
        description: draft.description.clone(),
        target_layer_id: draft.target_layer_id,
        interaction_text: draft.interaction_text.clone(),
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
