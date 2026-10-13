use crate::{
    ActionId, CompletionContract, CompletionContractAnswer, CompletionContractContext,
    CompletionContractInput, CompletionInvocationReference, CompletionReturnRequirement,
    GraphError, InteractionPermission, InteractionPermissions, NodeId, graph::InteractionScope,
};
use sqlx::SqliteConnection;

pub(crate) async fn read(
    connection: &mut SqliteConnection,
    interaction: NodeId,
) -> Result<Option<CompletionContract>, GraphError> {
    let marker: Option<String> = sqlx::query_scalar(
        "SELECT completion_contract_digest FROM completion_states WHERE interaction_node_id=?1",
    )
    .bind(interaction.value())
    .fetch_optional(&mut *connection)
    .await?
    .flatten();
    let description: Option<String> = sqlx::query_scalar(
        "SELECT description FROM completion_contracts WHERE interaction_node_id=?1",
    )
    .bind(interaction.value())
    .fetch_optional(&mut *connection)
    .await?;
    match (marker, description) {
        (None, None) => Ok(None),
        (Some(marker), Some(description)) => {
            let contract: CompletionContract =
                serde_json::from_str(&description).map_err(|_| {
                    GraphError::Forbidden("Unsupported CompletionContract description.".into())
                })?;
            contract.validate()?;
            if contract.interaction_node_id != interaction || contract.digest != marker {
                return Err(GraphError::Forbidden(
                    "CompletionContract identity mismatch.".into(),
                ));
            }
            let text: String = sqlx::query_scalar("SELECT detail FROM nodes WHERE id=?1")
                .bind(interaction.value())
                .fetch_one(&mut *connection)
                .await?;
            let scope = super::nodes::NodeTable::new(&mut *connection)
                .interaction_scope(interaction)
                .await?;
            let contexts = super::contexts::ContextTable::new(&mut *connection)
                .actions(&scope)
                .await?
                .into_iter()
                .map(|c| CompletionContractContext {
                    node_id: c.target.node_id,
                    annotations: c.annotations,
                })
                .collect::<Vec<_>>();
            let answers = super::input_children::InputChildTable::new(&mut *connection)
                .children(interaction)
                .await?
                .into_iter()
                .map(|c| CompletionContractAnswer {
                    source_node_id: c.source_node_id,
                    source_action_id: c.occurrence.action_id,
                    question: c.action,
                    value: c.value,
                })
                .collect::<Vec<_>>();
            if contract.input.text != text
                || contract.input.context != contexts
                || contract.input.answers != answers
                || contract.input.invocation_references
                    != invocation_references(connection, interaction).await?
            {
                return Err(GraphError::Forbidden(
                    "CompletionContract input mismatch.".into(),
                ));
            }
            Ok(Some(contract))
        }
        _ => Err(GraphError::Forbidden(
            "Missing CompletionContract for sealed interaction.".into(),
        )),
    }
}

pub(crate) async fn prepare(
    connection: &mut SqliteConnection,
    scope: &InteractionScope,
) -> Result<(), GraphError> {
    let existing: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM completion_states WHERE interaction_node_id=?1)",
    )
    .bind(scope.root_node_id.value())
    .fetch_one(&mut *connection)
    .await?;
    if existing {
        read(connection, scope.root_node_id).await?;
        return Ok(());
    }
    let node = super::nodes::NodeTable::new(&mut *connection)
        .visible(scope, scope.root_node_id)
        .await?;
    let context = super::contexts::ContextTable::new(&mut *connection)
        .actions(scope)
        .await?
        .into_iter()
        .map(|c| CompletionContractContext {
            node_id: c.target.node_id,
            annotations: c.annotations,
        })
        .collect();
    let answers = super::input_children::InputChildTable::new(&mut *connection)
        .children(scope.root_node_id)
        .await?
        .into_iter()
        .map(|c| CompletionContractAnswer {
            source_node_id: c.source_node_id,
            source_action_id: c.occurrence.action_id,
            question: c.action,
            value: c.value,
        })
        .collect();
    let permissions = super::permissions::read(connection, scope.root_node_id).await?;
    let mut authorities = match &permissions {
        Some(
            InteractionPermissions::V1 {
                enabled: true,
                permissions,
            }
            | InteractionPermissions::V2 {
                enabled: true,
                permissions,
            },
        ) => permissions.clone(),
        _ => Vec::new(),
    };
    let invocation_references = invocation_references(connection, scope.root_node_id).await?;
    for invocation in &invocation_references {
        let integration = InteractionPermission::NavigateAdd {
            node_id: invocation.parent_node_id,
        };
        if !authorities.contains(&integration) {
            authorities.push(integration);
        }
    }
    let return_requirements = authorities
        .iter()
        .filter_map(|p| match p {
            InteractionPermission::NavigateAdd { node_id } => {
                Some(CompletionReturnRequirement::NavigateResponse { node_id: *node_id })
            }
            _ => None,
        })
        .collect();
    let contract = CompletionContract {
        schema_version: 1,
        interaction_node_id: scope.root_node_id,
        input: CompletionContractInput {
            text: node.detail,
            context,
            answers,
            invocation_references,
        },
        authorities,
        return_requirements,
        digest: String::new(),
    }
    .seal()?;
    let description =
        serde_json::to_string(&contract).map_err(|e| GraphError::Internal(e.to_string()))?;
    sqlx::query("INSERT INTO completion_contracts(interaction_node_id,description) VALUES (?1,?2)")
        .bind(scope.root_node_id.value())
        .bind(description)
        .execute(connection)
        .await?;
    Ok(())
}

async fn invocation_references(
    connection: &mut SqliteConnection,
    child: NodeId,
) -> Result<Vec<CompletionInvocationReference>, GraphError> {
    let rows: Vec<(i64,i64,i64,i64,String)> = sqlx::query_as("SELECT id,source_completion_id,source_action_id,parent_node_id,action_snapshot FROM durable_invocations WHERE child_interaction_node_id=?1 ORDER BY id").bind(child.value()).fetch_all(connection).await?;
    rows.into_iter()
        .map(|(invocation_id, source, action, parent, snapshot)| {
            Ok(CompletionInvocationReference {
                invocation_id,
                source_completion_id: NodeId::new(source)
                    .ok_or_else(|| GraphError::Internal("Invalid invocation source".into()))?,
                source_action_id: ActionId::new(action)
                    .ok_or_else(|| GraphError::Internal("Invalid invocation action".into()))?,
                parent_node_id: NodeId::new(parent)
                    .ok_or_else(|| GraphError::Internal("Invalid invocation parent".into()))?,
                action_snapshot: serde_json::from_str(&snapshot)
                    .map_err(|e| GraphError::Internal(e.to_string()))?,
            })
        })
        .collect()
}

pub(crate) async fn pin(
    connection: &mut SqliteConnection,
    interaction: NodeId,
) -> Result<(), GraphError> {
    sqlx::query("UPDATE completion_states SET completion_contract_digest=json_extract((SELECT description FROM completion_contracts WHERE interaction_node_id=?1),'$.digest') WHERE interaction_node_id=?1 AND completion_contract_digest IS NULL")
        .bind(interaction.value()).execute(connection).await?;
    Ok(())
}
