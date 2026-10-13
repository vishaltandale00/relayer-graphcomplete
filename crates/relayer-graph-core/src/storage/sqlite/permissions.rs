use crate::{
    ActionId, GraphError, InteractionPermission, InteractionPermissions, NodeId,
    graph::InteractionScope,
};
use sqlx::SqliteConnection;

pub(crate) async fn set_enabled(
    connection: &mut SqliteConnection,
    enabled: bool,
) -> Result<(), GraphError> {
    sqlx::query("UPDATE interaction_permission_config SET enabled=?1 WHERE singleton=1")
        .bind(enabled)
        .execute(connection)
        .await?;
    Ok(())
}

pub(crate) async fn read(
    connection: &mut SqliteConnection,
    interaction: NodeId,
) -> Result<Option<InteractionPermissions>, GraphError> {
    let json: Option<String> = sqlx::query_scalar(
        "SELECT description FROM interaction_permissions WHERE interaction_node_id=?1",
    )
    .bind(interaction.value())
    .fetch_optional(connection)
    .await?;
    json.map(|json| {
        serde_json::from_str(&json).map_err(|_| {
            GraphError::Forbidden("Unsupported interaction permission description.".into())
        })
    })
    .transpose()
}

/// Called exactly during trusted preparation, after context validation and before
/// completion initialization. Recovery never derives authority for old records.
pub(crate) async fn prepare(
    connection: &mut SqliteConnection,
    interaction: NodeId,
) -> Result<(), GraphError> {
    let initialized: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM completion_states WHERE interaction_node_id=?1)",
    )
    .bind(interaction.value())
    .fetch_one(&mut *connection)
    .await?;
    if initialized {
        return Ok(());
    }
    let enabled: bool =
        sqlx::query_scalar("SELECT enabled FROM interaction_permission_config WHERE singleton=1")
            .fetch_one(&mut *connection)
            .await?;
    let action: Option<i64> = sqlx::query_scalar("SELECT leased_action_id FROM nodes WHERE id=?1")
        .bind(interaction.value())
        .fetch_one(&mut *connection)
        .await?;
    let mut permissions = Vec::new();
    if let Some(action) = action {
        let action_id = ActionId::new(action)
            .ok_or_else(|| GraphError::Internal("Invalid invocation identity".into()))?;
        super::actions::ActionTable::new(&mut *connection)
            .require_native_provenance(action_id)
            .await?;
        permissions.push(InteractionPermission::InvokeResolve { action_id });
    }
    let nodes: Vec<i64> = sqlx::query_scalar("SELECT context.target_node_id FROM interaction_context_actions context JOIN nodes target ON target.id=context.target_node_id WHERE context.interaction_node_id=?1 AND NOT EXISTS(SELECT 1 FROM graph_imports imported WHERE imported.thread_id=target.thread_id) ORDER BY context.position")
        .bind(interaction.value()).fetch_all(&mut *connection).await?;
    for node in nodes {
        permissions.push(InteractionPermission::NavigateAdd {
            node_id: NodeId::new(node)
                .ok_or_else(|| GraphError::Internal("Invalid context identity".into()))?,
        });
    }
    // Answers are canonical accepted occurrences, validated before this trusted
    // preparation. Like annotations, they require a response link on their
    // exact source node. Deduplicate shared nodes without granting other writes.
    let answered_nodes: Vec<i64> = sqlx::query_scalar("SELECT DISTINCT input.source_node_id FROM interaction_input_children input JOIN nodes source ON source.id=input.source_node_id WHERE input.parent_interaction_node_id=?1 AND source.state='accepted' AND NOT EXISTS(SELECT 1 FROM graph_imports imported WHERE imported.thread_id=source.thread_id) ORDER BY input.source_node_id")
        .bind(interaction.value()).fetch_all(&mut *connection).await?;
    for node in answered_nodes {
        let permission = InteractionPermission::NavigateAdd {
            node_id: NodeId::new(node)
                .ok_or_else(|| GraphError::Internal("Invalid input source identity".into()))?,
        };
        if !permissions.contains(&permission) {
            permissions.push(permission);
        }
    }
    let description = serde_json::to_string(&InteractionPermissions::V2 {
        enabled,
        permissions,
    })
    .map_err(|error| GraphError::Internal(error.to_string()))?;
    sqlx::query("INSERT INTO interaction_permissions VALUES(?1,?2)")
        .bind(interaction.value())
        .bind(description)
        .execute(connection)
        .await?;
    Ok(())
}

/// One graph-owned authority seam. Tokens select a scope, never its grants.
pub(crate) async fn authorize(
    connection: &mut SqliteConnection,
    scope: &InteractionScope,
    permission: &InteractionPermission,
) -> Result<(), GraphError> {
    scope.require_active_authority(connection).await?;
    if let InteractionPermission::InvokeResolve { action_id } = permission {
        super::actions::ActionTable::new(&mut *connection)
            .require_native_provenance(*action_id)
            .await?;
    }
    if let InteractionPermission::NavigateAdd { node_id } = permission {
        let native: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM nodes n WHERE n.id=?1 AND n.state='accepted' AND n.owner_interaction_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM graph_imports i WHERE i.thread_id=n.thread_id))")
            .bind(node_id.value()).fetch_one(&mut *connection).await?;
        if !native {
            return Err(GraphError::Forbidden(
                "Only a native accepted attached node may receive navigation.".into(),
            ));
        }
        super::nodes::NodeTable::new(&mut *connection)
            .visible(scope, *node_id)
            .await?;
    }
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM completion_states WHERE interaction_node_id=?1 AND lifecycle='active')")
        .bind(scope.root_node_id.value()).fetch_one(&mut *connection).await?;
    let permitted = match super::contracts::read(connection, scope.root_node_id).await? {
        Some(contract) => contract.authorities.contains(permission),
        None => read(connection, scope.root_node_id)
            .await?
            .is_some_and(|snapshot| snapshot.permits(permission)),
    };
    if scope.read_only || !active || !permitted {
        return Err(GraphError::Forbidden(
            "This interaction does not authorize the exact operation.".into(),
        ));
    }
    Ok(())
}

pub(crate) async fn enabled(connection: &mut SqliteConnection) -> Result<bool, GraphError> {
    Ok(
        sqlx::query_scalar("SELECT enabled FROM interaction_permission_config WHERE singleton=1")
            .fetch_one(connection)
            .await?,
    )
}
