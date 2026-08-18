mod accept;
mod plan;

use serde::{Deserialize, Serialize};

use crate::{
    ActionKind, GraphAction, GraphDatabase, GraphError, NodeId, RecordState, ResolvedLayer,
    graph::InteractionScope,
    storage::sqlite::{actions::ActionTable, completions::CompletionTable, layers},
};

use self::plan::CompletionPlan;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionOutput {
    pub node_id: NodeId,
    pub root_action: GraphAction,
    pub root_layer: ResolvedLayer,
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
    let Some(action_id) = CompletionTable::new(&mut connection)
        .root_action(scope.root_node_id)
        .await?
    else {
        return Ok(None);
    };
    let action = ActionTable::new(&mut connection)
        .record(scope, action_id)
        .await?
        .ok_or_else(|| GraphError::Internal("completion root action is missing".into()))?
        .action;
    if action.state != RecordState::Accepted
        || action.kind != ActionKind::Navigate
        || !action.response
    {
        return Err(GraphError::Internal(
            "completion root action is not an accepted response navigate action".into(),
        ));
    }
    let layer_id = action
        .target_layer_id
        .ok_or_else(|| GraphError::Internal("completion root action target is missing".into()))?;
    let root_layer = layers::resolve(&mut connection, scope, layer_id, true).await?;
    Ok(Some(CompletionOutput {
        node_id: scope.root_node_id,
        root_action: action,
        root_layer,
    }))
}
