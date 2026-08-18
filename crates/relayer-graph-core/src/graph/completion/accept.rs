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

pub(crate) async fn apply(
    connection: &mut GraphConnection,
    scope: &InteractionScope,
    plan: &CompletionPlan,
) -> Result<(), GraphError> {
    for layer in &plan.layers {
        LayerTable::new(&mut *connection)
            .accept_owned(*layer, scope.root_node_id)
            .await?;
    }
    for node in &plan.nodes {
        NodeTable::new(&mut *connection)
            .accept_owned(*node, scope.root_node_id)
            .await?;
    }
    for edge in &plan.edges {
        EdgeTable::new(&mut *connection)
            .accept_owned(*edge, scope.root_node_id)
            .await?;
    }
    for action in &plan.actions {
        ActionTable::new(&mut *connection)
            .accept_owned(*action, scope.root_node_id)
            .await?;
    }
    for (layer, actions) in &plan.layer_actions {
        LayerTable::new(&mut *connection)
            .snapshot_actions(*layer, scope.root_node_id, actions)
            .await?;
    }
    CompletionTable::new(connection)
        .insert(scope.root_node_id, plan.root_action.id)
        .await
}
