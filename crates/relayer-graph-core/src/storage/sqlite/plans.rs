//! Canonical interaction-owned planning records; never part of response closure.
use crate::{
    GraphError, GraphNode, NodeId, PlanDraft, PlanPublication, RecordState, graph::InteractionScope,
};
use sqlx::SqliteConnection;

pub(crate) async fn enabled(c: &mut SqliteConnection, owner: NodeId) -> Result<bool, GraphError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM interaction_plan_policy WHERE interaction_node_id=?1)",
    )
    .bind(owner.value())
    .fetch_one(c)
    .await?)
}

pub(crate) async fn prepare(
    c: &mut SqliteConnection,
    owner: NodeId,
    requested: bool,
) -> Result<(), GraphError> {
    let initialized: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM completion_states WHERE interaction_node_id=?1)",
    )
    .bind(owner.value())
    .fetch_one(&mut *c)
    .await?;
    if requested && !initialized {
        sqlx::query("INSERT OR IGNORE INTO interaction_plan_policy(interaction_node_id,schema_version) VALUES(?1,1)")
            .bind(owner.value()).execute(c).await?;
    }
    Ok(())
}

pub(crate) async fn require_public_content(
    c: &mut SqliteConnection,
    node: NodeId,
) -> Result<(), GraphError> {
    let internal: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM interaction_plans WHERE node_id=?1)")
            .bind(node.value())
            .fetch_one(c)
            .await?;
    if internal {
        return Err(GraphError::validation(
            "internal_plan_content",
            "nodeId",
            "Internal planning records cannot be used in response topology, actions, or attached input.",
        ));
    }
    Ok(())
}

pub(crate) async fn observe(
    c: &mut SqliteConnection,
    scope: &InteractionScope,
    node: NodeId,
) -> Result<(), GraphError> {
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM completion_states WHERE interaction_node_id=?1 AND lifecycle='active')").bind(scope.root_node_id.value()).fetch_one(&mut *c).await?;
    if !scope.read_only && active && enabled(c, scope.root_node_id).await? {
        sqlx::query("INSERT OR IGNORE INTO interaction_plan_reads(interaction_node_id,plan_node_id) SELECT ?1,node_id FROM interaction_plans WHERE node_id=?2")
            .bind(scope.root_node_id.value()).bind(node.value()).execute(c).await?;
    }
    Ok(())
}

pub(crate) async fn publication(
    c: &mut SqliteConnection,
    scope: &InteractionScope,
    node_id: NodeId,
) -> Result<PlanPublication, GraphError> {
    let node = super::nodes::NodeTable::new(&mut *c)
        .visible(scope, node_id)
        .await?;
    let (owner, revision, reads): (i64,i64,String) = sqlx::query_as("SELECT interaction_node_id,revision,read_plan_node_ids FROM interaction_plans WHERE node_id=?1")
        .bind(node_id.value()).fetch_optional(c).await?.ok_or_else(|| GraphError::NotFound("plan publication".into()))?;
    Ok(PlanPublication {
        node,
        interaction_node_id: NodeId::new(owner)
            .ok_or_else(|| GraphError::Internal("invalid plan owner".into()))?,
        revision: revision as u64,
        read_plan_node_ids: serde_json::from_str(&reads)
            .map_err(|e| GraphError::Internal(e.to_string()))?,
    })
}

pub(crate) async fn insert(
    c: &mut SqliteConnection,
    scope: &InteractionScope,
    draft: &PlanDraft,
    digest: &str,
) -> Result<(PlanPublication, bool), GraphError> {
    if !enabled(c, scope.root_node_id).await? {
        return Err(GraphError::validation(
            "planning_disabled",
            "plan",
            "This interaction was prepared without the planning method.",
        ));
    }
    let existing: Option<(i64,String)> = sqlx::query_as("SELECT node_id,request_digest FROM interaction_plans WHERE interaction_node_id=?1 AND client_key=?2")
        .bind(scope.root_node_id.value()).bind(&draft.client_key).fetch_optional(&mut *c).await?;
    if let Some((id, stored)) = existing {
        if stored != digest {
            return Err(GraphError::validation(
                "idempotency_conflict",
                "clientKey",
                "Published plan keys are immutable. Use a new key for a new checkpoint.",
            ));
        }
        return Ok((
            publication(c, scope, NodeId::new(id).unwrap()).await?,
            false,
        ));
    }
    let revision: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(revision),0)+1 FROM interaction_plans WHERE interaction_node_id=?1",
    )
    .bind(scope.root_node_id.value())
    .fetch_one(&mut *c)
    .await?;
    let reads: Vec<i64> = sqlx::query_scalar("SELECT plan_node_id FROM interaction_plan_reads WHERE interaction_node_id=?1 ORDER BY plan_node_id")
        .bind(scope.root_node_id.value()).fetch_all(&mut *c).await?;
    let node_id = sqlx::query("INSERT INTO nodes(project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key) VALUES(?1,?2,'interaction-plan','route',?3,?4,'accepted',?5,?6)")
        .bind(scope.project_id.map(|id| id.value())).bind(scope.thread_id.value()).bind(&draft.title).bind(&draft.detail)
        .bind(scope.root_node_id.value()).bind(format!("__plan:{}",draft.client_key)).execute(&mut *c).await?.last_insert_rowid();
    sqlx::query("INSERT INTO interaction_plans(node_id,interaction_node_id,revision,client_key,request_digest,read_plan_node_ids) VALUES(?1,?2,?3,?4,?5,?6)")
        .bind(node_id).bind(scope.root_node_id.value()).bind(revision).bind(&draft.client_key).bind(digest)
        .bind(serde_json::to_string(&reads).map_err(|e| GraphError::Internal(e.to_string()))?).execute(&mut *c).await?;
    Ok((
        publication(c, scope, NodeId::new(node_id).unwrap()).await?,
        true,
    ))
}

pub(crate) async fn finalize(
    c: &mut SqliteConnection,
    owner: NodeId,
) -> Result<Option<NodeId>, GraphError> {
    if !enabled(c, owner).await? {
        return Ok(None);
    }
    let id: Option<i64> = sqlx::query_scalar("SELECT node_id FROM interaction_plans WHERE interaction_node_id=?1 ORDER BY revision DESC LIMIT 1")
        .bind(owner.value()).fetch_optional(&mut *c).await?;
    let id = id.ok_or_else(|| GraphError::validation("plan_contribution_required","plan","Publish this interaction's high-level plan contribution before Return, including an unchanged reassessment when appropriate."))?;
    sqlx::query(
        "UPDATE interaction_plan_policy SET final_plan_node_id=?2 WHERE interaction_node_id=?1",
    )
    .bind(owner.value())
    .bind(id)
    .execute(c)
    .await?;
    Ok(NodeId::new(id))
}

pub(crate) async fn published(
    c: &mut SqliteConnection,
) -> Result<Vec<(Option<crate::ProjectId>, crate::ThreadId, GraphNode)>, GraphError> {
    let rows: Vec<(Option<i64>,i64,i64)> = sqlx::query_as("SELECT n.project_id,n.thread_id,n.id FROM interaction_plans p JOIN nodes n ON n.id=p.node_id ORDER BY n.id").fetch_all(&mut *c).await?;
    let mut result = Vec::new();
    for (project, thread, id) in rows {
        let node = super::nodes::NodeTable::new(&mut *c)
            .visible(
                &InteractionScope {
                    project_id: project.and_then(crate::ProjectId::new),
                    thread_id: crate::ThreadId::new(thread).unwrap(),
                    root_node_id: NodeId::new(id).unwrap(),
                    read_only: true,
                    authority_epoch: None,
                },
                NodeId::new(id).unwrap(),
            )
            .await?;
        if node.state != RecordState::Accepted {
            return Err(GraphError::Internal(
                "invalid plan publication state".into(),
            ));
        }
        result.push((
            project.and_then(crate::ProjectId::new),
            crate::ThreadId::new(thread).unwrap(),
            node,
        ));
    }
    Ok(result)
}
