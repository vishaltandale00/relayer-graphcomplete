use sqlx::{FromRow, SqliteConnection};

use crate::{
    ActionId, EdgeId, GraphError, GraphLayer, LayerDraft, LayerId, LayerLayout, NodeId,
    NodePlacement, ProjectId, RecordState, ResolvedLayer,
    graph::{InteractionScope, validate_authored_layout},
};

use super::{actions::ActionTable, edges::EdgeTable, nodes::NodeTable};

pub(crate) struct LayerTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

pub(crate) async fn resolve(
    connection: &mut SqliteConnection,
    scope: &InteractionScope,
    id: LayerId,
    accepted_only: bool,
) -> Result<ResolvedLayer, GraphError> {
    let layer = LayerTable::new(&mut *connection).visible(scope, id).await?;
    if accepted_only && layer.state != RecordState::Accepted {
        return Err(GraphError::Forbidden(format!(
            "layer {id} has not been accepted"
        )));
    }

    let mut nodes = Vec::with_capacity(layer.nodes.len());
    for node_id in &layer.nodes {
        let node = NodeTable::new(&mut *connection)
            .visible(scope, *node_id)
            .await?;
        if accepted_only && node.state != RecordState::Accepted {
            return Err(GraphError::Forbidden(format!(
                "node {node_id} has not been accepted"
            )));
        }
        nodes.push(node);
    }

    let mut edges = Vec::with_capacity(layer.edges.len());
    for edge_id in &layer.edges {
        let edge = EdgeTable::new(&mut *connection)
            .visible(scope, *edge_id)
            .await?;
        if accepted_only && edge.state != RecordState::Accepted {
            return Err(GraphError::Forbidden(format!(
                "edge {edge_id} has not been accepted"
            )));
        }
        edges.push(edge);
    }

    let actions = if layer.state == RecordState::Accepted {
        let action_ids = sqlx::query_scalar::<_, i64>(
            "SELECT action_id FROM layer_actions WHERE layer_id=?1 ORDER BY position",
        )
        .bind(layer.id.value())
        .fetch_all(&mut *connection)
        .await?;
        let mut actions = Vec::with_capacity(action_ids.len());
        for action_id in action_ids {
            let action_id = valid_action_id(action_id)?;
            let action = ActionTable::new(&mut *connection)
                .record(scope, action_id)
                .await?
                .ok_or_else(|| {
                    GraphError::Internal(format!("snapshotted action {action_id} is missing"))
                })?
                .action;
            actions.push(action);
        }
        actions
    } else {
        let mut actions = Vec::new();
        for node_id in &layer.nodes {
            actions.extend(
                ActionTable::new(&mut *connection)
                    .for_source(scope, *node_id, None, accepted_only)
                    .await?
                    .into_iter()
                    .filter(|record| {
                        record.action.state == RecordState::Accepted
                            || record.action.source_layer_id == Some(layer.id)
                    })
                    .map(|record| record.action),
            );
        }
        actions
    };

    Ok(ResolvedLayer {
        layer,
        nodes,
        edges,
        actions,
    })
}

pub(crate) struct LayerRecord {
    pub layer: GraphLayer,
    pub owner: NodeId,
}

#[derive(FromRow)]
struct LayerRow {
    id: i64,
    client_key: String,
    state: String,
    owner_interaction_id: i64,
    layout_schema_version: Option<i64>,
}

#[derive(FromRow)]
struct PlacementRow {
    node_id: i64,
    x: f64,
    y: f64,
}

impl<'connection> LayerTable<'connection> {
    pub(crate) fn new(connection: &'connection mut SqliteConnection) -> Self {
        Self { connection }
    }

    pub(crate) async fn record(
        &mut self,
        scope: &InteractionScope,
        id: LayerId,
    ) -> Result<Option<LayerRecord>, GraphError> {
        let row = sqlx::query_as::<_, LayerRow>(
            "SELECT id,client_key,state,owner_interaction_id,layout_schema_version FROM layers WHERE id=?1 AND ((?2 IS NOT NULL AND project_id=?2) OR (?2 IS NULL AND project_id IS NULL AND thread_id=?3))",
        )
        .bind(id.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_optional(&mut *self.connection)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let nodes = sqlx::query_scalar::<_, i64>(
            "SELECT node_id FROM layer_nodes WHERE layer_id=?1 ORDER BY position",
        )
        .bind(id.value())
        .fetch_all(&mut *self.connection)
        .await?
        .into_iter()
        .map(valid_node_id)
        .collect::<Result<Vec<_>, _>>()?;
        let edges = sqlx::query_scalar::<_, i64>(
            "SELECT edge_id FROM layer_edges WHERE layer_id=?1 ORDER BY position",
        )
        .bind(id.value())
        .fetch_all(&mut *self.connection)
        .await?
        .into_iter()
        .map(valid_edge_id)
        .collect::<Result<Vec<_>, _>>()?;
        let placement_rows = sqlx::query_as::<_, PlacementRow>(
            "SELECT node_id,x,y FROM layer_placements WHERE layer_id=?1 ORDER BY position",
        )
        .bind(id.value())
        .fetch_all(&mut *self.connection)
        .await?;
        let layout = stored_layout(row.id, row.layout_schema_version, placement_rows, &nodes)?;
        Ok(Some(LayerRecord {
            layer: GraphLayer {
                id: valid_layer_id(row.id)?,
                client_key: Some(row.client_key),
                nodes,
                edges,
                layout,
                state: RecordState::parse(&row.state)?,
            },
            owner: valid_node_id(row.owner_interaction_id)?,
        }))
    }

    pub(crate) async fn visible(
        &mut self,
        scope: &InteractionScope,
        id: LayerId,
    ) -> Result<GraphLayer, GraphError> {
        match self.record(scope, id).await? {
            Some(record)
                if record.layer.state == RecordState::Accepted
                    || record.owner == scope.root_node_id =>
            {
                Ok(record.layer)
            }
            Some(_) => Err(GraphError::Forbidden(format!(
                "layer {id} is not readable by this interaction"
            ))),
            None => Err(GraphError::NotFound(format!("layer {id}"))),
        }
    }

    pub(crate) async fn by_owner_and_key(
        &mut self,
        owner: NodeId,
        client_key: &str,
    ) -> Result<Option<(LayerId, RecordState)>, GraphError> {
        let row = sqlx::query_as::<_, (i64, String)>(
            "SELECT id,state FROM layers WHERE owner_interaction_id=?1 AND client_key=?2",
        )
        .bind(owner.value())
        .bind(client_key)
        .fetch_optional(&mut *self.connection)
        .await?;
        row.map(|(id, state)| Ok((valid_layer_id(id)?, RecordState::parse(&state)?)))
            .transpose()
    }

    pub(crate) async fn draft_ids_by_owner(
        &mut self,
        owner: NodeId,
    ) -> Result<Vec<LayerId>, GraphError> {
        sqlx::query_scalar::<_, i64>(
            "SELECT id FROM layers WHERE owner_interaction_id=?1 AND state='draft' ORDER BY id",
        )
        .bind(owner.value())
        .fetch_all(&mut *self.connection)
        .await?
        .into_iter()
        .map(valid_layer_id)
        .collect()
    }

    pub(crate) async fn is_reachable_from_root(
        &mut self,
        owner: NodeId,
        target: LayerId,
    ) -> Result<bool, GraphError> {
        let reachable = sqlx::query_scalar::<_, i64>(
            r#"
            WITH RECURSIVE reachable_layers(id) AS (
                SELECT root.target_layer_id
                FROM actions root
                WHERE root.owner_interaction_id=?1
                  AND root.source_node_id=?1
                  AND root.source_layer_id IS NULL
                  AND root.state='draft'
                  AND root.kind='navigate'
                  AND root.target_layer_id IS NOT NULL
                UNION
                SELECT child.target_layer_id
                FROM reachable_layers reachable
                JOIN actions child ON child.source_layer_id=reachable.id
                WHERE child.owner_interaction_id=?1
                  AND child.state='draft'
                  AND child.kind='navigate'
                  AND child.target_layer_id IS NOT NULL
            )
            SELECT EXISTS(SELECT 1 FROM reachable_layers WHERE id=?2)
            "#,
        )
        .bind(owner.value())
        .bind(target.value())
        .fetch_one(&mut *self.connection)
        .await?;
        Ok(reachable != 0)
    }

    pub(crate) async fn stop_owned_draft(
        &mut self,
        id: LayerId,
        owner: NodeId,
    ) -> Result<(), GraphError> {
        let result = sqlx::query(
            "UPDATE layers SET state='stopped' WHERE id=?1 AND owner_interaction_id=?2 AND state='draft'",
        )
        .bind(id.value())
        .bind(owner.value())
        .execute(&mut *self.connection)
        .await?;
        if result.rows_affected() != 1 {
            return Err(GraphError::Internal(format!(
                "draft layer {id} changed while it was being discarded"
            )));
        }
        Ok(())
    }

    pub(crate) async fn upsert_draft(
        &mut self,
        scope: &InteractionScope,
        draft: &LayerDraft,
    ) -> Result<GraphLayer, GraphError> {
        let id = match self
            .by_owner_and_key(scope.root_node_id, &draft.client_key)
            .await?
        {
            Some((id, RecordState::Draft)) => {
                sqlx::query("DELETE FROM layer_nodes WHERE layer_id=?1")
                    .bind(id.value())
                    .execute(&mut *self.connection)
                    .await?;
                sqlx::query("DELETE FROM layer_edges WHERE layer_id=?1")
                    .bind(id.value())
                    .execute(&mut *self.connection)
                    .await?;
                sqlx::query("UPDATE layers SET layout_schema_version=?1 WHERE id=?2")
                    .bind(layout(draft)?.version as i64)
                    .bind(id.value())
                    .execute(&mut *self.connection)
                    .await?;
                id
            }
            Some((_, RecordState::Accepted)) => {
                return Err(GraphError::validation(
                    "immutable_layer",
                    "layer",
                    "This layer was already accepted. Create a new layer instead of editing history.",
                ));
            }
            Some((_, RecordState::Stopped)) => {
                return Err(GraphError::validation(
                    "discarded_layer",
                    "layer",
                    "This layer was discarded and cannot be revived. Create a new layer with a new client key instead.",
                ));
            }
            None => {
                let result = sqlx::query(
                    "INSERT INTO layers(project_id,thread_id,state,owner_interaction_id,client_key,layout_schema_version) VALUES (?1,?2,'draft',?3,?4,?5)",
                )
                .bind(scope.project_id.map(ProjectId::value))
                .bind(scope.thread_id.value())
                .bind(scope.root_node_id.value())
                .bind(&draft.client_key)
                .bind(layout(draft)?.version as i64)
                .execute(&mut *self.connection)
                .await?;
                valid_layer_id(result.last_insert_rowid())?
            }
        };
        for (position, node_id) in draft.nodes.iter().enumerate() {
            sqlx::query("INSERT INTO layer_nodes(layer_id,node_id,position) VALUES (?1,?2,?3)")
                .bind(id.value())
                .bind(node_id.value())
                .bind(position as i64)
                .execute(&mut *self.connection)
                .await?;
        }
        for (position, edge_id) in draft.edges.iter().enumerate() {
            sqlx::query("INSERT INTO layer_edges(layer_id,edge_id,position) VALUES (?1,?2,?3)")
                .bind(id.value())
                .bind(edge_id.value())
                .bind(position as i64)
                .execute(&mut *self.connection)
                .await?;
        }
        for (position, placement) in layout(draft)?.placements.iter().enumerate() {
            sqlx::query(
                "INSERT INTO layer_placements(layer_id,node_id,position,x,y) VALUES (?1,?2,?3,?4,?5)",
            )
            .bind(id.value())
            .bind(placement.node_id.value())
            .bind(position as i64)
            .bind(placement.x)
            .bind(placement.y)
            .execute(&mut *self.connection)
            .await?;
        }
        Ok(GraphLayer {
            id,
            client_key: Some(draft.client_key.clone()),
            nodes: draft.nodes.clone(),
            edges: draft.edges.clone(),
            layout: draft.layout.clone(),
            state: RecordState::Draft,
        })
    }

    pub(crate) async fn publish_owned(
        &mut self,
        id: LayerId,
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
        sqlx::query("UPDATE layers SET state='accepted',published_revision=COALESCE(published_revision,?3) WHERE id=?1 AND owner_interaction_id=?2")
            .bind(id.value())
            .bind(owner.value())
            .bind(revision)
            .execute(&mut *self.connection)
            .await?;
        Ok(())
    }

    pub(crate) async fn snapshot_actions(
        &mut self,
        id: LayerId,
        owner: NodeId,
        actions: &[ActionId],
    ) -> Result<(), GraphError> {
        for (position, action_id) in actions.iter().enumerate() {
            sqlx::query(
                "INSERT INTO layer_actions(layer_id,action_id,position) SELECT ?1,?2,?3 WHERE EXISTS (SELECT 1 FROM layers WHERE id=?1 AND owner_interaction_id=?4 AND state='accepted')",
            )
            .bind(id.value())
            .bind(action_id.value())
            .bind(position as i64)
            .bind(owner.value())
            .execute(&mut *self.connection)
            .await?;
        }
        Ok(())
    }
}

fn layout(draft: &LayerDraft) -> Result<&LayerLayout, GraphError> {
    draft
        .layout
        .as_ref()
        .ok_or_else(|| GraphError::Internal("validated layer draft has no layout".into()))
}

fn stored_layout(
    layer_id: i64,
    version: Option<i64>,
    rows: Vec<PlacementRow>,
    nodes: &[NodeId],
) -> Result<Option<LayerLayout>, GraphError> {
    let Some(version) = version else {
        if rows.is_empty() {
            return Ok(None);
        }
        return Err(GraphError::Internal(format!(
            "legacy layer {layer_id} has stored placements without a layout version"
        )));
    };
    let version = u32::try_from(version).map_err(|_| {
        GraphError::Internal(format!(
            "layer {layer_id} has invalid layout version {version}"
        ))
    })?;
    let placements = rows
        .into_iter()
        .map(|row| {
            Ok(NodePlacement {
                node_id: valid_node_id(row.node_id)?,
                x: row.x,
                y: row.y,
            })
        })
        .collect::<Result<Vec<_>, GraphError>>()?;
    let layout = LayerLayout {
        version,
        placements,
    };
    validate_authored_layout(Some(&layout), nodes).map_err(|error| {
        GraphError::Internal(format!(
            "layer {layer_id} has invalid stored layout: {error}"
        ))
    })?;
    Ok(Some(layout))
}

fn valid_layer_id(value: i64) -> Result<LayerId, GraphError> {
    LayerId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid layer ID".into()))
}

fn valid_node_id(value: i64) -> Result<NodeId, GraphError> {
    NodeId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid node ID".into()))
}

fn valid_edge_id(value: i64) -> Result<EdgeId, GraphError> {
    EdgeId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid edge ID".into()))
}

fn valid_action_id(value: i64) -> Result<ActionId, GraphError> {
    ActionId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid action ID".into()))
}
