use super::currents::CurrentTable;
use crate::{ActionId, GraphError, GraphInvocation, NodeId};
use sqlx::SqliteConnection;
pub(crate) async fn source_active(
    connection: &mut SqliteConnection,
    source: NodeId,
) -> Result<bool, GraphError> {
    Ok(CurrentTable::new(connection).state(source).await?.lifecycle
        == crate::CompletionLifecycle::Active)
}

pub(crate) async fn snapshot(
    connection: &mut SqliteConnection,
    id: i64,
) -> Result<String, GraphError> {
    Ok(
        sqlx::query_scalar("SELECT action_snapshot FROM durable_invocations WHERE id=?1")
            .bind(id)
            .fetch_one(connection)
            .await?,
    )
}
pub(crate) async fn action_owned(
    connection: &mut SqliteConnection,
    action: ActionId,
    source: NodeId,
) -> Result<bool, GraphError> {
    Ok(
        sqlx::query_scalar("SELECT owner_interaction_id=?2 FROM actions WHERE id=?1")
            .bind(action.value())
            .bind(source.value())
            .fetch_one(connection)
            .await?,
    )
}
pub(crate) async fn insert(
    connection: &mut SqliteConnection,
    source: NodeId,
    action: ActionId,
    parent: NodeId,
    key: &str,
    snapshot: &str,
    child: NodeId,
) -> Result<(), GraphError> {
    sqlx::query("INSERT INTO durable_invocations(source_completion_id,source_action_id,parent_node_id,invocation_key,action_snapshot,child_interaction_node_id) VALUES(?1,?2,?3,?4,?5,?6)").bind(source.value()).bind(action.value()).bind(parent.value()).bind(key).bind(snapshot).bind(child.value()).execute(connection).await?;
    Ok(())
}
pub(crate) async fn children(
    connection: &mut SqliteConnection,
    action: ActionId,
) -> Result<Vec<NodeId>, GraphError> {
    let ids: Vec<i64> = sqlx::query_scalar("SELECT child_interaction_node_id FROM durable_invocations WHERE source_action_id=?1 ORDER BY id").bind(action.value()).fetch_all(connection).await?;
    ids.into_iter().map(node).collect()
}
pub(crate) async fn by_id(
    connection: &mut SqliteConnection,
    id: i64,
) -> Result<Option<GraphInvocation>, GraphError> {
    let child: Option<i64> =
        sqlx::query_scalar("SELECT child_interaction_node_id FROM durable_invocations WHERE id=?1")
            .bind(id)
            .fetch_optional(&mut *connection)
            .await?;
    match child {
        Some(child) => for_child(connection, node(child)?).await,
        None => Ok(None),
    }
}

pub(crate) async fn for_key(
    connection: &mut SqliteConnection,
    source: NodeId,
    key: &str,
) -> Result<Option<GraphInvocation>, GraphError> {
    let child: Option<i64> = sqlx::query_scalar("SELECT child_interaction_node_id FROM durable_invocations WHERE source_completion_id=?1 AND invocation_key=?2").bind(source.value()).bind(key).fetch_optional(&mut *connection).await?;
    match child {
        Some(id) => for_child(connection, node(id)?).await,
        None => Ok(None),
    }
}

pub(crate) async fn for_child(
    connection: &mut SqliteConnection,
    child: NodeId,
) -> Result<Option<GraphInvocation>, GraphError> {
    let row: Option<(i64,String,i64,i64,i64,String)> = sqlx::query_as("SELECT id,invocation_key,source_completion_id,source_action_id,parent_node_id,action_snapshot FROM durable_invocations WHERE child_interaction_node_id=?1").bind(child.value()).fetch_optional(&mut *connection).await?;
    let Some((id, invocation_key, source, action, parent, snapshot)) = row else {
        return Ok(None);
    };
    Ok(Some(GraphInvocation {
        id,
        invocation_key,
        source_completion_id: node(source)?,
        source_action_id: ActionId::new(action)
            .ok_or_else(|| GraphError::Internal("Invalid invocation action".into()))?,
        parent_node_id: node(parent)?,
        child_interaction_node_id: child,
        action_snapshot: serde_json::from_str(&snapshot)
            .map_err(|error| GraphError::Internal(error.to_string()))?,
        state: CurrentTable::new(connection).state(child).await?,
    }))
}
fn node(id: i64) -> Result<NodeId, GraphError> {
    NodeId::new(id).ok_or_else(|| GraphError::Internal("Invalid invocation node".into()))
}
