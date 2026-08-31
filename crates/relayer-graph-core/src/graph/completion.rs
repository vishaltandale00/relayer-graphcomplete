mod accept;
mod current;
mod plan;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};

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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedGraphClosure {
    pub node_id: NodeId,
    pub interaction: GraphNode,
    pub root_action: GraphAction,
    pub root_layer_id: crate::LayerId,
    pub layers: Vec<ResolvedLayer>,
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
    publications: Vec<AcceptedGraphPublication>,
    published_to: Vec<SearchTarget>,
    expiry: tokio::time::Instant,
) -> Result<(), GraphError> {
    let recorded = SearchIndexTable::new(&mut *transaction)
        .revision(target)
        .await?;
    let stored = deadline(expiry, database.search_index.revision(target)).await?;
    let revision = recorded
        .max(stored)
        .map_or(SearchIndexRevision::FIRST, SearchIndexRevision::next);

    let committed = index_publications(
        database,
        target,
        revision,
        publications,
        published_to,
        expiry,
    )
    .await?;
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
    publications: Vec<AcceptedGraphPublication>,
    published_to: Vec<SearchTarget>,
    expiry: tokio::time::Instant,
) -> Result<SearchIndexRevision, GraphError> {
    let publication_identity = format!(
        "sha256:{:x}",
        Sha256::digest(
            serde_json::to_vec(&(&publications, &published_to)).map_err(|error| {
                GraphError::Internal(format!("search publication identity failed: {error}"))
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
        if let Err(error) = deadline(expiry, write.apply(publication, published_to.clone())).await {
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
    let publication = read_accepted_publication_on(
        &mut transaction,
        &scope,
        output.root_layer.layer.id,
        Some(output.root_action),
    )
    .await?;
    let closure = AcceptedGraphClosure {
        node_id: publication.node_id,
        interaction: publication.interaction,
        root_action: publication.root_action.ok_or_else(|| {
            GraphError::Internal("terminal publication has no root action".into())
        })?,
        root_layer_id: publication.root_layer_id,
        layers: publication.layers,
    };
    transaction.commit().await?;
    Ok(Some(closure))
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
    Ok(Some(AcceptedGraphClosure {
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
