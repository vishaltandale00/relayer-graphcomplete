use std::collections::HashSet;

use sqlx::{FromRow, SqliteConnection};

use crate::{
    ActionId, ActionKind, GraphError, InteractionContext, InteractionContextAction,
    InteractionContextDraft, InteractionContextTarget, InteractionInput, InteractionInputNode,
    NodeId, ProjectId, RecordState, graph::InteractionScope,
};

use super::input_children::InputChildTable;
use super::nodes::NodeTable;

pub(crate) struct ContextTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

#[derive(FromRow)]
struct ContextRow {
    action_id: i64,
    source_node_id: i64,
    target_node_id: i64,
    source_interaction_node_id: i64,
    source_layer_id: i64,
    position: Option<i64>,
}

impl<'connection> ContextTable<'connection> {
    pub(crate) fn new(connection: &'connection mut SqliteConnection) -> Self {
        Self { connection }
    }

    pub(crate) async fn insert_all(
        &mut self,
        scope: &InteractionScope,
        drafts: &[InteractionContextDraft],
    ) -> Result<Vec<InteractionContextAction>, GraphError> {
        let mut targets = HashSet::new();
        let mut result = Vec::with_capacity(drafts.len());
        for (context_index, draft) in drafts.iter().enumerate() {
            if !targets.insert(draft.target.node_id) {
                return Err(GraphError::validation(
                    "duplicate_context_target",
                    format!("contexts[{context_index}].target.nodeId"),
                    "An interaction can attach each target node only once.",
                ));
            }
            for (annotation_index, annotation) in draft.annotations.iter().enumerate() {
                if annotation.trim().is_empty() {
                    return Err(GraphError::validation(
                        "empty_context_annotation",
                        format!("contexts[{context_index}].annotations[{annotation_index}]"),
                        "Context annotations must contain non-whitespace text.",
                    ));
                }
            }
            self.validate_occurrence(
                scope,
                &format!("contexts[{context_index}].target"),
                &draft.target,
            )
            .await?;
        }

        for (position, draft) in drafts.iter().enumerate() {
            let action_id = self.insert(scope, position, draft).await?;
            result.push(InteractionContextAction {
                id: action_id,
                type_id: ActionKind::InteractionContext.as_str().into(),
                source_node_id: scope.root_node_id,
                target: draft.target.clone(),
                annotations: draft.annotations.clone(),
                state: RecordState::Accepted,
            });
        }
        Ok(result)
    }

    pub(crate) async fn canonical_occurrence(
        &mut self,
        scope: &InteractionScope,
        field: &str,
        target: &InteractionContextTarget,
    ) -> Result<InteractionInputNode, GraphError> {
        self.validate_occurrence(scope, field, target).await?;
        Ok(NodeTable::new(&mut *self.connection)
            .visible(scope, target.node_id)
            .await?
            .into())
    }

    async fn validate_occurrence(
        &mut self,
        scope: &InteractionScope,
        field: &str,
        target: &InteractionContextTarget,
    ) -> Result<(), GraphError> {
        let valid: i64 = sqlx::query_scalar(
            r#"
            WITH RECURSIVE reachable_layers(id) AS (
                SELECT root.target_layer_id
                FROM completions completion
                JOIN actions root ON root.id=completion.root_action_id
                WHERE completion.interaction_node_id=?1
                  AND root.kind='navigate'
                  AND root.state='accepted'
                  AND root.target_layer_id IS NOT NULL
                UNION
                SELECT child.target_layer_id
                FROM reachable_layers reachable
                JOIN layer_actions membership ON membership.layer_id=reachable.id
                JOIN actions child ON child.id=membership.action_id
                WHERE child.kind='navigate'
                  AND child.state='accepted'
                  AND child.target_layer_id IS NOT NULL
            )
            SELECT EXISTS(
                SELECT 1
                FROM nodes source_interaction
                JOIN reachable_layers reachable ON reachable.id=?2
                JOIN layers source_layer ON source_layer.id=reachable.id
                JOIN layer_nodes occurrence
                  ON occurrence.layer_id=source_layer.id AND occurrence.node_id=?3
                JOIN nodes target_node ON target_node.id=occurrence.node_id
                WHERE source_interaction.id=?1
                  AND source_interaction.kind='user-interaction'
                  AND source_interaction.state='accepted'
                  AND source_interaction.owner_interaction_id IS NULL
                  AND source_layer.state='accepted'
                  AND target_node.state='accepted'
                  AND ((?4 IS NOT NULL AND source_interaction.project_id=?4 AND target_node.project_id=?4)
                       OR (?4 IS NULL
                           AND source_interaction.project_id IS NULL
                           AND target_node.project_id IS NULL
                           AND source_interaction.thread_id=?5
                           AND target_node.thread_id=?5))
            )
            "#,
        )
        .bind(target.source_interaction_node_id.value())
        .bind(target.source_layer_id.value())
        .bind(target.node_id.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_one(&mut *self.connection)
        .await?;
        if valid == 0 {
            return Err(GraphError::validation(
                "invalid_context_occurrence",
                field,
                "Context must identify an accepted node occurrence in the exact visible accepted source completion.",
            ));
        }
        Ok(())
    }

    async fn insert(
        &mut self,
        scope: &InteractionScope,
        position: usize,
        draft: &InteractionContextDraft,
    ) -> Result<ActionId, GraphError> {
        let inserted = sqlx::query(
            "INSERT INTO actions(project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,state,owner_interaction_id,client_key,type_id) VALUES (?1,?2,?3,NULL,'invoke',NULL,'','pill',NULL,NULL,NULL,NULL,'accepted',?3,?4,'interaction.context')",
        )
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .bind(scope.root_node_id.value())
        .bind(format!("\0interaction.context:{position}"))
        .execute(&mut *self.connection)
        .await?;
        let action_id = valid_action_id(inserted.last_insert_rowid())?;
        sqlx::query(
            "INSERT INTO interaction_context_actions(action_id,interaction_node_id,target_node_id,source_interaction_node_id,source_layer_id,position) VALUES (?1,?2,?3,?4,?5,?6)",
        )
        .bind(action_id.value())
        .bind(scope.root_node_id.value())
        .bind(draft.target.node_id.value())
        .bind(draft.target.source_interaction_node_id.value())
        .bind(draft.target.source_layer_id.value())
        .bind(i64::try_from(position).map_err(|_| GraphError::Internal("context position exceeds SQLite range".into()))?)
        .execute(&mut *self.connection)
        .await?;
        for (annotation_position, annotation) in draft.annotations.iter().enumerate() {
            sqlx::query(
                "INSERT INTO interaction_context_annotations(action_id,position,text) VALUES (?1,?2,?3)",
            )
            .bind(action_id.value())
            .bind(i64::try_from(annotation_position).map_err(|_| {
                GraphError::Internal("context annotation position exceeds SQLite range".into())
            })?)
            .bind(annotation)
            .execute(&mut *self.connection)
            .await?;
        }
        Ok(action_id)
    }

    pub(crate) async fn interaction_input(
        &mut self,
        scope: &InteractionScope,
    ) -> Result<InteractionInput, GraphError> {
        let interaction = NodeTable::new(&mut *self.connection)
            .visible(scope, scope.root_node_id)
            .await?;
        let actions = self.actions(scope).await?;
        let mut contexts = Vec::with_capacity(actions.len());
        for action in actions {
            let target_node = NodeTable::new(&mut *self.connection)
                .visible(scope, action.target.node_id)
                .await?;
            contexts.push(InteractionContext {
                type_id: ActionKind::InteractionContext.as_str().into(),
                target_node: target_node.into(),
                annotations: action.annotations,
            });
        }
        Ok(InteractionInput {
            interaction: interaction.into(),
            contexts,
            submitted_inputs: InputChildTable::new(&mut *self.connection)
                .normalized(scope.root_node_id)
                .await?,
        })
    }

    pub(crate) async fn actions(
        &mut self,
        scope: &InteractionScope,
    ) -> Result<Vec<InteractionContextAction>, GraphError> {
        let rows = sqlx::query_as::<_, ContextRow>(
            "SELECT action.id AS action_id,action.source_node_id,context.target_node_id,context.source_interaction_node_id,context.source_layer_id,context.position FROM actions action JOIN interaction_context_actions context ON context.action_id=action.id WHERE context.interaction_node_id=?1 AND action.source_node_id=?1 AND action.owner_interaction_id=?1 AND action.type_id='interaction.context' AND action.state='accepted' ORDER BY context.position",
        )
        .bind(scope.root_node_id.value())
        .fetch_all(&mut *self.connection)
        .await?;
        let mut actions = Vec::with_capacity(rows.len());
        for (expected_position, row) in rows.into_iter().enumerate() {
            if row.position != i64::try_from(expected_position).ok() {
                return Err(GraphError::Internal(
                    "stored interaction context positions are not contiguous".into(),
                ));
            }
            let action_id = valid_action_id(row.action_id)?;
            let annotations = sqlx::query_scalar::<_, String>(
                "SELECT text FROM interaction_context_annotations WHERE action_id=?1 ORDER BY position",
            )
            .bind(action_id.value())
            .fetch_all(&mut *self.connection)
            .await?;
            actions.push(InteractionContextAction {
                id: action_id,
                type_id: ActionKind::InteractionContext.as_str().into(),
                source_node_id: valid_node_id(row.source_node_id)?,
                target: InteractionContextTarget {
                    node_id: valid_node_id(row.target_node_id)?,
                    source_interaction_node_id: valid_node_id(row.source_interaction_node_id)?,
                    source_layer_id: crate::LayerId::new(row.source_layer_id).ok_or_else(|| {
                        GraphError::Internal("database returned an invalid layer ID".into())
                    })?,
                },
                annotations,
                state: RecordState::Accepted,
            });
        }
        Ok(actions)
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
