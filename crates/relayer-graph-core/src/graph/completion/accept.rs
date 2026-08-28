use crate::{
    GraphError,
    graph::InteractionScope,
    storage::{
        GraphConnection,
        sqlite::{
            actions::ActionTable, completions::CompletionTable, edges::EdgeTable,
            layers::LayerTable, nodes::NodeTable,
        },
    },
};

use super::plan::CompletionPlan;

pub(crate) async fn finalize(
    connection: &mut GraphConnection,
    scope: &InteractionScope,
    plan: &CompletionPlan,
) -> Result<(), GraphError> {
    if let Some(lease) = plan.lease {
        ActionTable::new(&mut *connection)
            .resolve_leased_invoke(lease.action_id, plan.root_layer_id()?)
            .await?;
    }
    CompletionTable::new(connection)
        .insert(scope.root_node_id, plan.root_action()?.id)
        .await
}

pub(crate) async fn publish(
    connection: &mut GraphConnection,
    scope: &InteractionScope,
    plan: &CompletionPlan,
    revision: Option<u64>,
) -> Result<(), GraphError> {
    for layer in &plan.layers {
        LayerTable::new(&mut *connection)
            .publish_owned(*layer, scope.root_node_id, revision)
            .await?;
    }
    for node in &plan.nodes {
        NodeTable::new(&mut *connection)
            .publish_owned(*node, scope.root_node_id, revision)
            .await?;
    }
    for edge in &plan.edges {
        EdgeTable::new(&mut *connection)
            .publish_owned(*edge, scope.root_node_id, revision)
            .await?;
    }
    for action in &plan.actions {
        ActionTable::new(&mut *connection)
            .publish_owned(*action, scope.root_node_id, revision)
            .await?;
    }
    for (layer, actions) in &plan.layer_actions {
        LayerTable::new(&mut *connection)
            .snapshot_actions(*layer, scope.root_node_id, actions)
            .await?;
    }
    Ok(())
}
