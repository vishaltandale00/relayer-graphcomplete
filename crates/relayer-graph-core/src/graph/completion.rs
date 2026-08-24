mod accept;
mod plan;

use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};

use crate::{
    ActionKind, GraphAction, GraphDatabase, GraphError, NavigateRelation, NodeId, RecordState,
    ResolvedLayer,
    graph::InteractionScope,
    storage::sqlite::{actions::ActionTable, completions::CompletionTable, layers},
};

use self::plan::CompletionPlan;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionOutput {
    pub node_id: NodeId,
    pub root_action: GraphAction,
    pub root_layer: ResolvedLayer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedGraphClosure {
    pub node_id: NodeId,
    pub root_action: GraphAction,
    pub root_layer_id: crate::LayerId,
    pub layers: Vec<ResolvedLayer>,
}

pub(crate) async fn complete(
    database: &GraphDatabase,
    scope: &InteractionScope,
) -> Result<CompletionOutput, GraphError> {
    if let Some(output) = read_output(database, scope).await? {
        return Ok(output);
    }
    let mut transaction = database.storage.begin_write().await?;
    let plan = CompletionPlan::build(&mut transaction, scope).await?;
    accept::apply(&mut transaction, scope, &plan).await?;
    transaction.commit().await?;
    read_output(database, scope)
        .await?
        .ok_or_else(|| GraphError::Internal("accepted completion could not be read".into()))
}

pub(crate) async fn read_output(
    database: &GraphDatabase,
    scope: &InteractionScope,
) -> Result<Option<CompletionOutput>, GraphError> {
    let mut connection = database.storage.acquire().await?;
    read_output_on(&mut connection, scope).await
}

pub(crate) async fn read_output_on(
    connection: &mut crate::storage::GraphConnection,
    scope: &InteractionScope,
) -> Result<Option<CompletionOutput>, GraphError> {
    let Some(action_id) = CompletionTable::new(&mut *connection)
        .root_action(scope.root_node_id)
        .await?
    else {
        return Ok(None);
    };
    let action = ActionTable::new(&mut *connection)
        .record(scope, action_id)
        .await?
        .ok_or_else(|| GraphError::Internal("completion root action is missing".into()))?
        .action;
    if action.state != RecordState::Accepted
        || action.kind != ActionKind::Navigate
        || action.relation != Some(NavigateRelation::Expand)
        || action.source_layer_id.is_some()
    {
        return Err(GraphError::Internal(
            "completion root action is not an accepted root expand action".into(),
        ));
    }
    let layer_id = action
        .target_layer_id
        .ok_or_else(|| GraphError::Internal("completion root action target is missing".into()))?;
    let root_layer = layers::resolve(&mut *connection, scope, layer_id, true).await?;
    Ok(Some(CompletionOutput {
        node_id: scope.root_node_id,
        root_action: action,
        root_layer,
    }))
}

pub(crate) async fn read_accepted_closure(
    database: &GraphDatabase,
    node_id: NodeId,
) -> Result<Option<AcceptedGraphClosure>, GraphError> {
    let mut transaction = database.storage.begin_read().await?;
    let scope = crate::storage::sqlite::nodes::NodeTable::new(&mut transaction)
        .interaction_scope(node_id)
        .await?;
    let Some(output) = read_output_on(&mut transaction, &scope).await? else {
        return Ok(None);
    };
    let root_layer_id = output.root_layer.layer.id;
    let mut pending = VecDeque::from([output.root_layer]);
    let mut visited = HashSet::from([root_layer_id]);
    let mut layers = Vec::new();
    while let Some(layer) = pending.pop_front() {
        for action in &layer.actions {
            if action.state != RecordState::Accepted {
                return Err(GraphError::Internal(format!(
                    "accepted layer {} contains non-accepted action {}",
                    layer.layer.id, action.id
                )));
            }
            if action.kind == ActionKind::Navigate {
                let target = action.target_layer_id.ok_or_else(|| {
                    GraphError::Internal(format!(
                        "accepted navigate action {} has no target layer",
                        action.id
                    ))
                })?;
                if visited.insert(target) {
                    pending
                        .push_back(layers::resolve(&mut transaction, &scope, target, true).await?);
                }
            }
        }
        layers.push(layer);
    }
    let closure = AcceptedGraphClosure {
        node_id: output.node_id,
        root_action: output.root_action,
        root_layer_id,
        layers,
    };
    transaction.commit().await?;
    Ok(Some(closure))
}
