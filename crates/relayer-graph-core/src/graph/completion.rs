mod accept;
mod current;
mod plan;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet, VecDeque};

use crate::{
    ActionKind, GraphAction, GraphDatabase, GraphError, GraphNode, NavigateRelation, NodeId,
    RecordState, ResolvedLayer, SearchIndexRevision, SearchTarget,
    graph::InteractionScope,
    storage::{
        GraphConnection,
        sqlite::{
            actions::ActionTable, completions::CompletionTable, layers, nodes::NodeTable,
            search_index::SearchIndexTable,
        },
    },
};

pub use current::current_transition_request_digest;
pub(crate) use current::{projection_page, projections_after, transition as transition_current};

/// Durable checkpoints around the acknowledgement-level SQLite/Ladybug ordering.
#[cfg(feature = "crash-test-support")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionCrashPoint {
    AfterSqliteClosureWrite,
    AfterSearchClosureWrite,
    AfterSearchCommit,
    AfterSqliteRevisionRecord,
    AfterSqliteCommit,
    AfterResponsePrepared,
}

#[cfg(feature = "crash-test-support")]
pub(crate) fn crash_checkpoint(database: &GraphDatabase, point: CompletionCrashPoint) {
    database.hit_completion_crash_point(point);
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionOutput {
    pub node_id: NodeId,
    pub root_action: GraphAction,
    pub root_layer: ResolvedLayer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_icon_proposal: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedGraphClosure {
    /// Revision pins read with graph content; absent only for older runtimes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail_asset_revisions: Option<BTreeMap<NodeId, u64>>,
    #[serde(default)]
    pub has_persistent_mutations: bool,
    /// Export qualification includes prepared calls not yet registered by Product.
    #[serde(default)]
    pub has_reusable_invocations: bool,
    pub node_id: NodeId,
    pub interaction: GraphNode,
    pub root_action: GraphAction,
    pub root_layer_id: crate::LayerId,
    pub layers: Vec<ResolvedLayer>,
}

/// Trusted coherent export inventory; never an execution permit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationGraphSnapshot {
    pub closures: Vec<Option<AcceptedGraphClosure>>,
    pub invocations: Vec<InvocationGraphSnapshot>,
    pub bound_inputs: Vec<GraphAction>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvocationGraphSnapshot {
    pub invocation: crate::GraphInvocation,
    pub source_action: GraphAction,
    pub parent_node: GraphNode,
    pub submitted_inputs: Vec<crate::InteractionInputChild>,
    pub current: Option<AcceptedGraphPublication>,
    pub detail_asset_revisions: BTreeMap<NodeId, u64>,
}

pub(crate) async fn read_conversation_snapshot(
    database: &GraphDatabase,
    node_ids: &[NodeId],
) -> Result<ConversationGraphSnapshot, GraphError> {
    let mut transaction = database.storage.begin_read().await?;
    let mut closures = Vec::with_capacity(node_ids.len());
    for &node_id in node_ids {
        let scope = NodeTable::new(&mut transaction)
            .interaction_scope(node_id)
            .await?;
        closures.push(read_accepted_closure_on(&mut transaction, &scope, node_id).await?);
    }
    let roots = serde_json::to_string(&node_ids.iter().map(|id| id.value()).collect::<Vec<_>>())
        .map_err(|error| GraphError::Internal(error.to_string()))?;
    let parent_nodes = serde_json::to_string(
        &closures
            .iter()
            .flatten()
            .flat_map(|closure| {
                closure
                    .layers
                    .iter()
                    .flat_map(|layer| layer.nodes.iter().map(|node| node.id.value()))
            })
            .collect::<Vec<_>>(),
    )
    .map_err(|error| GraphError::Internal(error.to_string()))?;
    let call_ids: Vec<i64> = sqlx::query_scalar("WITH RECURSIVE roots(id) AS (SELECT value FROM json_each(?1) UNION SELECT source_completion_id FROM durable_invocations WHERE parent_node_id IN (SELECT value FROM json_each(?2)) UNION SELECT d.child_interaction_node_id FROM durable_invocations d JOIN roots r ON d.source_completion_id=r.id) SELECT DISTINCT d.id FROM durable_invocations d WHERE d.source_completion_id IN (SELECT id FROM roots) OR d.child_interaction_node_id IN (SELECT id FROM roots) ORDER BY d.id")
        .bind(roots).bind(parent_nodes).fetch_all(&mut *transaction).await?;
    let mut invocations = Vec::with_capacity(call_ids.len());
    for id in call_ids {
        let invocation = crate::storage::sqlite::invocations::by_id(&mut transaction, id)
            .await?
            .ok_or_else(|| GraphError::Internal("Invocation vanished from read snapshot".into()))?;
        let source_scope = NodeTable::new(&mut transaction)
            .interaction_scope(invocation.source_completion_id)
            .await?;
        let source_action = ActionTable::new(&mut transaction)
            .record(&source_scope, invocation.source_action_id)
            .await?
            .ok_or_else(|| GraphError::Internal("Invocation source action is missing".into()))?
            .action;
        let parent_node = NodeTable::new(&mut transaction)
            .visible(&source_scope, invocation.parent_node_id)
            .await?;
        let submitted_inputs =
            crate::storage::sqlite::input_children::InputChildTable::new(&mut transaction)
                .children(invocation.child_interaction_node_id)
                .await?;
        let child_scope = NodeTable::new(&mut transaction)
            .interaction_scope(invocation.child_interaction_node_id)
            .await?;
        let current = match invocation.state.current_layer_id {
            Some(layer_id) => Some(
                read_accepted_publication_on(&mut transaction, &child_scope, layer_id, None)
                    .await?,
            ),
            None => None,
        };
        let mut detail_asset_revisions = BTreeMap::new();
        let mut asset_nodes = vec![parent_node.id];
        if let Some(current) = &current {
            for layer in &current.layers {
                asset_nodes.extend(layer.nodes.iter().map(|node| node.id));
            }
        }
        for node_id in asset_nodes {
            let revision =
                crate::storage::sqlite::attached_navigation::revision(&mut transaction, node_id)
                    .await?;
            detail_asset_revisions.insert(node_id, revision);
        }
        invocations.push(InvocationGraphSnapshot {
            invocation,
            source_action,
            parent_node,
            submitted_inputs,
            current,
            detail_asset_revisions,
        });
    }
    let mut requested = Vec::new();
    for closure in closures.iter().flatten() {
        for action in closure.layers.iter().flat_map(|layer| &layer.actions) {
            requested.extend(
                action
                    .input_action_ids
                    .iter()
                    .map(|id| (closure.node_id, *id)),
            );
        }
    }
    for snapshot in &invocations {
        if let Some(current) = &snapshot.current {
            for action in current.layers.iter().flat_map(|layer| &layer.actions) {
                requested.extend(
                    action
                        .input_action_ids
                        .iter()
                        .map(|id| (current.node_id, *id)),
                );
            }
        }
    }
    let mut bound_inputs = Vec::new();
    let mut seen = HashSet::new();
    for (root, id) in requested {
        if !seen.insert(id) {
            continue;
        }
        let scope = NodeTable::new(&mut transaction)
            .interaction_scope(root)
            .await?;
        let action = ActionTable::new(&mut transaction)
            .record(&scope, id)
            .await?
            .ok_or_else(|| GraphError::Internal("Bound input definition is missing".into()))?
            .action;
        if action.kind != ActionKind::Input || action.state != RecordState::Accepted {
            return Err(GraphError::Internal(
                "Published Invoke has an unavailable bound input definition".into(),
            ));
        }
        bound_inputs.push(action);
    }
    transaction.commit().await?;
    Ok(ConversationGraphSnapshot {
        closures,
        invocations,
        bound_inputs,
    })
}

/// One accepted graph publication written to the derived search store.
///
/// Advance has no terminal root action. Return and imported terminal closures do.
/// Current/head/lifecycle facts are intentionally absent from this payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedGraphPublication {
    pub node_id: NodeId,
    pub interaction: GraphNode,
    pub root_action: Option<GraphAction>,
    pub root_layer_id: crate::LayerId,
    pub layers: Vec<ResolvedLayer>,
}

impl From<AcceptedGraphClosure> for AcceptedGraphPublication {
    fn from(closure: AcceptedGraphClosure) -> Self {
        Self {
            node_id: closure.node_id,
            interaction: closure.interaction,
            root_action: Some(closure.root_action),
            root_layer_id: closure.root_layer_id,
            layers: closure.layers,
        }
    }
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
                let target = SearchTarget::new(scope.project_id, scope.thread_id);
                let confirm =
                    canonical_publication_matches(database, &mut transaction, target).await?;
                transaction.commit().await?;
                if confirm {
                    database.search_index.canonical_commit_confirmed(target);
                }
                return Ok(output);
            }
        } else {
            scope.require_active_authority(&mut transaction).await?;
            if let Some(output) = read_output_on(&mut transaction, scope).await? {
                let target = SearchTarget::new(scope.project_id, scope.thread_id);
                let confirm =
                    canonical_publication_matches(database, &mut transaction, target).await?;
                transaction.commit().await?;
                if confirm {
                    database.search_index.canonical_commit_confirmed(target);
                }
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
    #[cfg(feature = "crash-test-support")]
    crash_checkpoint(database, CompletionCrashPoint::AfterResponsePrepared);
    Ok(output)
}

/// Commit accepted publications to Ladybug and record its revision in the
/// caller's still-open canonical SQLite transaction.
pub(crate) async fn index_and_record(
    database: &GraphDatabase,
    transaction: &mut GraphConnection,
    target: SearchTarget,
    publications: Vec<(AcceptedGraphPublication, Vec<SearchTarget>)>,
    expiry: tokio::time::Instant,
) -> Result<(), GraphError> {
    let recorded = SearchIndexTable::new(&mut *transaction)
        .revision(target)
        .await?;
    let stored = deadline(expiry, database.search_index.revision(target)).await?;
    let revision = recorded
        .max(stored)
        .map_or(SearchIndexRevision::FIRST, SearchIndexRevision::next);

    let committed = index_publications(database, target, revision, publications, expiry).await?;
    SearchIndexTable::new(&mut *transaction)
        .record_revision(target, committed)
        .await?;
    #[cfg(feature = "crash-test-support")]
    crash_checkpoint(database, CompletionCrashPoint::AfterSqliteRevisionRecord);
    Ok(())
}

/// Remove imported publications from Ladybug and record the derived revision
/// in the caller's still-open canonical SQLite rollback transaction.
pub(crate) async fn remove_from_index_and_record(
    database: &GraphDatabase,
    transaction: &mut GraphConnection,
    target: SearchTarget,
    publications: Vec<AcceptedGraphPublication>,
    expiry: tokio::time::Instant,
) -> Result<(), GraphError> {
    let recorded = SearchIndexTable::new(&mut *transaction)
        .revision(target)
        .await?;
    let stored = deadline(expiry, database.search_index.revision(target)).await?;
    let revision = recorded
        .max(stored)
        .map_or(SearchIndexRevision::FIRST, SearchIndexRevision::next);
    let publication_identity = format!(
        "sha256:{:x}",
        Sha256::digest(
            serde_json::to_vec(&("remove", &publications)).map_err(|error| {
                GraphError::Internal(format!("search removal identity failed: {error}"))
            })?
        )
    );
    let mut write = deadline(
        expiry,
        database
            .search_index
            .begin_until(target, revision, expiry.into_std()),
    )
    .await?;
    for publication in publications {
        if let Err(error) = deadline(expiry, write.remove(publication)).await {
            let _ = deadline(expiry, write.rollback()).await;
            return Err(error);
        }
    }
    if let Err(error) = database
        .search_index
        .canonical_commit_unknown(target, &publication_identity)
    {
        let _ = deadline(expiry, write.rollback()).await;
        return Err(error);
    }
    let committed = deadline(expiry, write.commit()).await?;
    SearchIndexTable::new(&mut *transaction)
        .record_revision(target, committed)
        .await?;
    Ok(())
}

async fn index_publications(
    database: &GraphDatabase,
    target: SearchTarget,
    revision: SearchIndexRevision,
    publications: Vec<(AcceptedGraphPublication, Vec<SearchTarget>)>,
    expiry: tokio::time::Instant,
) -> Result<SearchIndexRevision, GraphError> {
    let publication_identity = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&publications).map_err(|error| {
            GraphError::Internal(format!("search publication identity failed: {error}"))
        })?)
    );
    let mut write = deadline(
        expiry,
        database
            .search_index
            .begin_until(target, revision, expiry.into_std()),
    )
    .await?;
    for (publication, published_to) in publications {
        if let Err(error) = deadline(expiry, write.apply(publication, published_to)).await {
            let _ = deadline(expiry, write.rollback()).await;
            return Err(error);
        }
    }
    #[cfg(feature = "crash-test-support")]
    crash_checkpoint(database, CompletionCrashPoint::AfterSearchClosureWrite);
    // Ladybug commits before the canonical SQLite transaction. Quarantine the
    // target before the derived commit can become visible so no public query
    // can observe a revision whose canonical acknowledgement is still unknown.
    if let Err(error) = database
        .search_index
        .canonical_commit_unknown(target, &publication_identity)
    {
        let _ = deadline(expiry, write.rollback()).await;
        return Err(error);
    }
    let committed = deadline(expiry, write.commit()).await?;
    #[cfg(feature = "crash-test-support")]
    crash_checkpoint(database, CompletionCrashPoint::AfterSearchCommit);
    Ok(committed)
}

/// Prove that a quarantined Ladybug commit is the same revision SQLite
/// canonically recorded. The caller clears quarantine only after its read
/// transaction commits, so a failed proof can never turn an unknown write into
/// an acknowledged result.
pub(super) async fn canonical_publication_matches(
    database: &GraphDatabase,
    transaction: &mut GraphConnection,
    target: SearchTarget,
) -> Result<bool, GraphError> {
    if !database.search_index.canonical_commit_is_unknown(target) {
        return Ok(false);
    }
    let canonical_revision = SearchIndexTable::new(&mut *transaction)
        .revision(target)
        .await?;
    let stored_revision = database.search_index.revision(target).await?;
    if canonical_revision != stored_revision {
        return Err(GraphError::Internal(
            "search publication is awaiting canonical reconciliation".into(),
        ));
    }
    Ok(true)
}

async fn deadline<T>(
    expiry: tokio::time::Instant,
    work: impl std::future::Future<Output = Result<T, GraphError>>,
) -> Result<T, GraphError> {
    match tokio::time::timeout_at(expiry, work).await {
        Ok(result) => result,
        Err(_) => Err(GraphError::Internal(
            "the search index did not answer within its budget; the write was not saved".into(),
        )),
    }
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
        thread_icon_proposal: sqlx::query_scalar(
            "SELECT icon FROM thread_icon_proposals WHERE interaction_node_id=?1",
        )
        .bind(scope.root_node_id.value())
        .fetch_optional(&mut *connection)
        .await?,
    }))
}

pub(crate) async fn read_accepted_closure(
    database: &GraphDatabase,
    node_id: NodeId,
) -> Result<Option<AcceptedGraphClosure>, GraphError> {
    Ok(read_accepted_closures(database, &[node_id])
        .await?
        .remove(0))
}

pub(crate) async fn read_accepted_closures(
    database: &GraphDatabase,
    node_ids: &[NodeId],
) -> Result<Vec<Option<AcceptedGraphClosure>>, GraphError> {
    read_accepted_closures_between(
        database,
        node_ids,
        #[cfg(test)]
        None,
    )
    .await
}

#[cfg(test)]
type SnapshotReadHook<'a> =
    &'a mut dyn FnMut(usize) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'a>>;

// Tests can commit a concurrent write between roots in this production read loop.
async fn read_accepted_closures_between(
    database: &GraphDatabase,
    node_ids: &[NodeId],
    #[cfg(test)] mut between: Option<SnapshotReadHook<'_>>,
) -> Result<Vec<Option<AcceptedGraphClosure>>, GraphError> {
    let mut transaction = database.storage.begin_read().await?;
    let mut closures = Vec::with_capacity(node_ids.len());
    for &node_id in node_ids {
        let scope = NodeTable::new(&mut transaction)
            .interaction_scope(node_id)
            .await?;
        closures.push(read_accepted_closure_on(&mut transaction, &scope, node_id).await?);
        #[cfg(test)]
        if let Some(hook) = between.as_mut() {
            hook(closures.len() - 1).await;
        }
    }
    transaction.commit().await?;
    Ok(closures)
}

pub(crate) async fn read_accepted_closure_on(
    transaction: &mut GraphConnection,
    scope: &InteractionScope,
    node_id: NodeId,
) -> Result<Option<AcceptedGraphClosure>, GraphError> {
    if node_id != scope.root_node_id {
        return Err(GraphError::Internal(
            "accepted closure node does not match its interaction scope".into(),
        ));
    }
    let Some(output) = read_output_on(transaction, scope).await? else {
        return Ok(None);
    };
    let publication = read_accepted_publication_on(
        transaction,
        scope,
        output.root_layer.layer.id,
        Some(output.root_action),
    )
    .await?;
    let has_persistent_mutations =
        crate::storage::sqlite::attached_navigation::closure_has_mutations(
            transaction,
            node_id,
            &publication.layers,
        )
        .await?;
    let mut detail_asset_revisions = BTreeMap::new();
    let parent_nodes = publication
        .layers
        .iter()
        .flat_map(|layer| layer.nodes.iter().map(|node| node.id.value()))
        .collect::<Vec<_>>();
    let has_reusable_invocations: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM durable_invocations WHERE source_completion_id=?1 OR child_interaction_node_id=?1 OR parent_node_id IN (SELECT value FROM json_each(?2)))")
        .bind(node_id.value()).bind(serde_json::to_string(&parent_nodes).map_err(|error| GraphError::Internal(error.to_string()))?).fetch_one(&mut *transaction).await?;
    for node in publication
        .layers
        .iter()
        .flat_map(|layer| &layer.nodes)
        .chain(std::iter::once(&publication.interaction))
    {
        if let std::collections::btree_map::Entry::Vacant(entry) =
            detail_asset_revisions.entry(node.id)
        {
            let revision =
                crate::storage::sqlite::attached_navigation::revision(transaction, node.id).await?;
            entry.insert(revision);
        }
    }
    Ok(Some(AcceptedGraphClosure {
        detail_asset_revisions: Some(detail_asset_revisions),
        has_persistent_mutations,
        has_reusable_invocations,
        node_id: publication.node_id,
        interaction: publication.interaction,
        root_action: publication.root_action.ok_or_else(|| {
            GraphError::Internal("terminal publication has no root action".into())
        })?,
        root_layer_id: publication.root_layer_id,
        layers: publication.layers,
    }))
}

/// Materialize the complete accepted graph publication through a caller-owned
/// transaction. Advance supplies no root action; Return supplies its newly
/// accepted terminal root action.
pub(crate) async fn read_accepted_publication_on(
    transaction: &mut GraphConnection,
    scope: &InteractionScope,
    root_layer_id: crate::LayerId,
    root_action: Option<GraphAction>,
) -> Result<AcceptedGraphPublication, GraphError> {
    let root_layer = layers::resolve(&mut *transaction, scope, root_layer_id, true).await?;
    let mut pending = VecDeque::from([root_layer]);
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
                    pending.push_back(
                        crate::storage::sqlite::layers::resolve(
                            &mut *transaction,
                            scope,
                            target,
                            true,
                        )
                        .await?,
                    );
                }
            }
        }
        layers.push(layer);
    }
    let interaction = NodeTable::new(&mut *transaction)
        .record(scope.root_node_id)
        .await?
        .ok_or_else(|| GraphError::Internal("accepted interaction node is missing".into()))?
        .node;
    Ok(AcceptedGraphPublication {
        node_id: scope.root_node_id,
        interaction,
        root_action,
        root_layer_id,
        layers,
    })
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    use crate::{ActionDraft, LayerDraft, NodeDraft, ThreadId};
    use serde_json::json;

    #[tokio::test]
    async fn accepted_closures_keep_one_snapshot_across_a_committed_write() {
        let directory = tempfile::tempdir().unwrap();
        let database = GraphDatabase::open(directory.path().join("snapshot.sqlite3"))
            .await
            .unwrap();
        let mut roots = Vec::new();
        let mut nodes = Vec::new();
        for id in 1..=2 {
            let root = database
                .create_interaction(None, ThreadId::new(id).unwrap(), "Root")
                .await
                .unwrap();
            let writer = database.writer_for_subgraph(root.id).await.unwrap();
            let node = writer
                .submit_node(&NodeDraft {
                    client_key: "node".into(),
                    kind: "concept".into(),
                    icon: "box".into(),
                    title: "Node".into(),
                    detail: "before".into(),
                })
                .await
                .unwrap();
            let layer: LayerDraft = serde_json::from_value(json!({"clientKey":"layer","nodes":[node.id],"edges":[],"layout":{"version":1,"placements":[{"nodeId":node.id,"x":0.5,"y":0.5}],"edgeShape":"default"}})).unwrap();
            let layer = writer.submit_layer(&layer).await.unwrap();
            let action: ActionDraft = serde_json::from_value(json!({"clientKey":"response","sourceNodeId":root.id,"kind":"navigate","relation":"expand","label":"Response","variant":"pill","targetLayerId":layer.id})).unwrap();
            writer.add_action(&action).await.unwrap();
            writer.complete(root.id).await.unwrap();
            roots.push(root.id);
            nodes.push(node.id);
        }
        let pending = database
            .create_interaction(None, ThreadId::new(3).unwrap(), "Pending")
            .await
            .unwrap();
        let requested = [roots[0], roots[1], pending.id, roots[0]];
        let mut between = |index| -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + '_>> {
            let database = &database;
            let nodes = &nodes;
            Box::pin(async move {
                if index == 0 {
                    let mut write = database.storage.begin_write().await.unwrap();
                    sqlx::query("UPDATE nodes SET detail='after' WHERE id IN (?1,?2)")
                        .bind(nodes[0].value())
                        .bind(nodes[1].value())
                        .execute(&mut *write)
                        .await
                        .unwrap();
                    write.commit().await.unwrap();
                }
            })
        };
        let closures = read_accepted_closures_between(&database, &requested, Some(&mut between))
            .await
            .unwrap();
        assert!(closures[2].is_none());
        for (position, node) in [(0, nodes[0]), (1, nodes[1]), (3, nodes[0])] {
            let closure = closures[position].as_ref().unwrap();
            assert_eq!(closure.node_id, requested[position]);
            assert_eq!(closure.layers.len(), 1);
            assert_eq!(closure.layers[0].nodes.len(), 1);
            assert_eq!(closure.layers[0].nodes[0].id, node);
            assert_eq!(closure.layers[0].nodes[0].detail, "before");
        }
        let fresh = database.accepted_graph_closures(&roots).await.unwrap();
        assert!(
            fresh
                .iter()
                .all(|closure| closure.as_ref().unwrap().layers[0].nodes[0].detail == "after")
        );
        assert!(
            database
                .accepted_graph_closures(&[])
                .await
                .unwrap()
                .is_empty()
        );
    }
}
