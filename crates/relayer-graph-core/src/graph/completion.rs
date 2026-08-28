mod accept;
mod current;
mod plan;

use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};

use crate::{
    ActionKind, GraphAction, GraphDatabase, GraphError, NavigateRelation, NodeId, RecordState,
    ResolvedLayer,
    graph::InteractionScope,
    storage::sqlite::{actions::ActionTable, completions::CompletionTable, layers},
};

pub use current::current_transition_request_digest;
pub(crate) use current::{projection_page, projections_after, transition as transition_current};

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
    let (target, expected_revision) = {
        let mut transaction = database.storage.begin_read().await?;
        let state = crate::storage::sqlite::currents::CurrentTable::new(&mut transaction)
            .state(scope.root_node_id)
            .await?;
        if state.lifecycle != crate::CompletionLifecycle::Active
            && !state.temporal_features.root_current_write
        {
            // Preserve the legacy graph.submit idempotency contract while the
            // temporal writer is dark for this completion. Once enabled, a
            // terminal broker cannot read accepted output.
            scope.require_generation_authority(&mut transaction).await?;
            if let Some(output) = read_output_on(&mut transaction, scope).await? {
                transaction.commit().await?;
                return Ok(output);
            }
        } else {
            scope.require_active_authority(&mut transaction).await?;
            if let Some(output) = read_output_on(&mut transaction, scope).await? {
                transaction.commit().await?;
                return Ok(output);
            }
        }
        if state.lifecycle != crate::CompletionLifecycle::Active {
            return Err(GraphError::validation(
                "terminal_completion",
                "completion",
                "This completion ended without accepted output.",
            ));
        }
        let actions = ActionTable::new(&mut transaction)
            .for_source(scope, scope.root_node_id, Some(scope.root_node_id), false)
            .await?;
        if actions.len() != 1 {
            return Err(GraphError::validation(
                "root_action_count",
                "interactionNode",
                format!(
                    "The interaction needs exactly one new root action; found {}.",
                    actions.len()
                ),
            ));
        }
        let target = actions[0].action.target_layer_id.ok_or_else(|| {
            GraphError::validation(
                "missing_target_layer",
                "rootAction.targetLayerId",
                "The root expand action needs a target layer.",
            )
        })?;
        transaction.commit().await?;
        (target, state.head_revision)
    };
    transition_current(
        database,
        scope,
        expected_revision,
        "legacy-flat-submit-v1",
        &crate::CurrentTransition::Return { layer_id: target },
    )
    .await?;
    // This is the response of the already-authorized Return operation, not a
    // later terminal model read. Revalidate the exact generation in the same
    // snapshot that materializes its committed output so a concurrent cutover
    // cannot retire the broker between validation and read.
    let mut transaction = database.storage.begin_read().await?;
    scope.require_generation_authority(&mut transaction).await?;
    let output = read_output_on(&mut transaction, scope)
        .await?
        .ok_or_else(|| GraphError::Internal("accepted completion could not be read".into()))?;
    transaction.commit().await?;
    Ok(output)
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
