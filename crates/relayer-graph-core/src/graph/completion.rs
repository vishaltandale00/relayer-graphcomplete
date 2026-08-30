mod accept;
mod plan;

use serde::{Deserialize, Serialize};
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

use self::plan::CompletionPlan;

/// The six durable boundaries in the acknowledgement-level write ordering.
/// Available only to the explicit #301 crash-proof build.
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
fn crash_checkpoint(database: &GraphDatabase, point: CompletionCrashPoint) {
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
    /// The interaction node the closure hangs off. It is a searchable record in
    /// its own right — the frozen query contract matches on
    /// `interaction.kind = 'user-interaction'` — and it belongs to no layer, so
    /// nothing else in the closure carries it.
    pub interaction: GraphNode,
    pub root_action: GraphAction,
    pub root_layer_id: crate::LayerId,
    pub layers: Vec<ResolvedLayer>,
}

/// Accept a closure into SQLite and the search store as one action.
///
/// `lbug` 0.18.0 offers transactions only as `BEGIN TRANSACTION`/`COMMIT`/
/// `ROLLBACK` query strings, with no prepare/commit split, so two-phase commit is
/// unavailable and true cross-store atomicity cannot be bought at any price.
/// What is achievable is fail-closed ordering, with the search store committing
/// first, inside the still-open SQLite write transaction:
///
/// 1. open the SQLite write transaction and write the closure, uncommitted
/// 2. open the search transaction and write the closure
/// 3. commit the search transaction, yielding revision `R`
/// 4. record `R` in the still-open SQLite transaction
/// 5. commit SQLite
/// 6. acknowledge the author
///
/// Any failure at steps 1 to 3 rolls both stores back, and nothing is saved
/// anywhere. Reporting failure is truthful precisely because nothing committed —
/// which is why the search store commits before SQLite rather than after.
///
/// The window between steps 3 and 5 is irreducible without two-phase commit. A
/// crash there leaves the search store holding a revision SQLite never recorded:
/// an extra copy in the derived store, never a missing one. SQLite is canonical,
/// so #302 detects and removes it at startup.
pub(crate) async fn complete(
    database: &GraphDatabase,
    scope: &InteractionScope,
) -> Result<CompletionOutput, GraphError> {
    if let Some(output) = read_output(database, scope).await? {
        return Ok(output);
    }
    let target = SearchTarget::new(scope.project_id, scope.thread_id);
    // Concurrent submissions to one target index in the order they commit. This
    // orders a target against itself only; SQLite's write lock is global and is
    // held across the search write, so what keeps one target from stalling the
    // rest is the deadline below, not this lock.
    let _order = database.order_writes_to(target).await;

    // Step 1.
    let mut transaction = database.storage.begin_write().await?;
    if CompletionTable::new(&mut transaction)
        .root_action(scope.root_node_id)
        .await?
        .is_some()
    {
        transaction.rollback().await?;
        return read_output(database, scope)
            .await?
            .ok_or_else(|| GraphError::Internal("accepted completion could not be read".into()));
    }
    let plan = CompletionPlan::build(&mut transaction, scope).await?;
    accept::apply(&mut transaction, scope, &plan).await?;

    // The closure is read back through the same open transaction, because it is
    // not committed yet and no other connection can see it.
    let closure = read_accepted_closure_on(&mut transaction, scope, scope.root_node_id)
        .await?
        .ok_or_else(|| GraphError::Internal("accepted closure could not be read".into()))?;
    #[cfg(feature = "crash-test-support")]
    crash_checkpoint(database, CompletionCrashPoint::AfterSqliteClosureWrite);

    // Steps 2, 3 and 4.
    if let Err(error) = index_and_record(
        database,
        &mut transaction,
        target,
        vec![closure],
        crate::publication_targets(scope.project_id, scope.thread_id),
        database.expiry(),
    )
    .await
    {
        transaction.rollback().await?;
        return Err(error);
    }
    // Step 5.
    transaction.commit().await?;
    #[cfg(feature = "crash-test-support")]
    crash_checkpoint(database, CompletionCrashPoint::AfterSqliteCommit);
    // Step 6.
    let output = read_output(database, scope)
        .await?
        .ok_or_else(|| GraphError::Internal("accepted completion could not be read".into()))?;
    #[cfg(feature = "crash-test-support")]
    crash_checkpoint(database, CompletionCrashPoint::AfterResponsePrepared);
    Ok(output)
}

/// Write closures to the search store, commit them, and record the revision in
/// the caller's still-open SQLite transaction — steps 2 to 4 of the ordering.
///
/// Both accept paths share this. A completion passes one closure; an import
/// passes every closure it materialized, so a whole conversation reaches the
/// store as one transaction carrying one revision.
///
/// The caller owns the SQLite transaction and must roll it back on error.
/// Nothing here commits it.
pub(crate) async fn index_and_record(
    database: &GraphDatabase,
    transaction: &mut GraphConnection,
    target: SearchTarget,
    closures: Vec<AcceptedGraphClosure>,
    published_to: Vec<SearchTarget>,
    expiry: tokio::time::Instant,
) -> Result<(), GraphError> {
    // The next revision has to clear both sides, not just SQLite. A write
    // interrupted after the store committed and before SQLite did leaves the
    // store ahead; allocating from SQLite alone would hand these closures a
    // number the store has already used for different content.
    let recorded = SearchIndexTable::new(&mut *transaction)
        .revision(target)
        .await?;
    let stored = deadline(expiry, database.search_index.revision(target)).await?;
    let revision = recorded
        .max(stored)
        .map_or(SearchIndexRevision::FIRST, SearchIndexRevision::next);

    let committed =
        index_closures(database, target, revision, closures, published_to, expiry).await?;
    SearchIndexTable::new(&mut *transaction)
        .record_revision(target, committed)
        .await?;
    #[cfg(feature = "crash-test-support")]
    crash_checkpoint(database, CompletionCrashPoint::AfterSqliteRevisionRecord);
    Ok(())
}

/// Write and commit closures to the search store, under a deadline.
///
/// The deadline is required rather than defensive: the SQLite write lock is held
/// across this call, so an unbounded search write would stall every other writer
/// in the database. On timeout the search transaction is rolled back and the
/// write fails, leaving nothing committed anywhere.
async fn index_closures(
    database: &GraphDatabase,
    target: SearchTarget,
    revision: SearchIndexRevision,
    closures: Vec<AcceptedGraphClosure>,
    published_to: Vec<SearchTarget>,
    expiry: tokio::time::Instant,
) -> Result<SearchIndexRevision, GraphError> {
    // One deadline spans the whole sequence rather than each step, because what
    // is being bounded is how long the global SQLite write lock is held. A
    // per-step budget would let a slow store hold it for a multiple of it.
    let mut write = deadline(expiry, database.search_index.begin(target, revision)).await?;
    // Past this point a failure has to release the search transaction, or the
    // store keeps its write lock and every later write fails behind it. An
    // abandoned write releases its own transaction when it is dropped.
    for closure in closures {
        if let Err(error) = deadline(expiry, write.apply(closure, published_to.clone())).await {
            let _ = deadline(expiry, write.rollback()).await;
            return Err(error);
        }
    }
    #[cfg(feature = "crash-test-support")]
    crash_checkpoint(database, CompletionCrashPoint::AfterSearchClosureWrite);
    // A commit that outlives the deadline is not rolled back, because by then it
    // may already have committed. The caller fails the write and rolls SQLite
    // back, which lands in the same harmless direction as a crash in the step 3
    // to 5 window: an extra copy in the derived store, never a missing one.
    let committed = deadline(expiry, write.commit()).await?;
    #[cfg(feature = "crash-test-support")]
    crash_checkpoint(database, CompletionCrashPoint::AfterSearchCommit);
    Ok(committed)
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

pub(crate) async fn read_output(
    database: &GraphDatabase,
    scope: &InteractionScope,
) -> Result<Option<CompletionOutput>, GraphError> {
    let mut connection = database.storage.acquire().await?;
    read_output_on(&mut connection, scope).await
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
    let scope = NodeTable::new(&mut transaction)
        .interaction_scope(node_id)
        .await?;
    let closure = read_accepted_closure_on(&mut transaction, &scope, node_id).await?;
    transaction.commit().await?;
    Ok(closure)
}

/// Read the accepted closure through a caller-supplied connection.
///
/// The write ordering needs this: it reads the closure back out of its own open
/// write transaction, before that transaction commits, where no other connection
/// can see it.
pub(crate) async fn read_accepted_closure_on(
    transaction: &mut GraphConnection,
    scope: &InteractionScope,
    node_id: NodeId,
) -> Result<Option<AcceptedGraphClosure>, GraphError> {
    let Some(output) = read_output_on(&mut *transaction, scope).await? else {
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
                        .push_back(layers::resolve(&mut *transaction, scope, target, true).await?);
                }
            }
        }
        layers.push(layer);
    }
    let interaction = NodeTable::new(&mut *transaction)
        .record(node_id)
        .await?
        .ok_or_else(|| GraphError::Internal("accepted interaction node is missing".into()))?
        .node;
    Ok(Some(AcceptedGraphClosure {
        node_id: output.node_id,
        interaction,
        root_action: output.root_action,
        root_layer_id,
        layers,
    }))
}
