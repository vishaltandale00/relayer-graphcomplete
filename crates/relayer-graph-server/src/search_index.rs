//! The Ladybug search index: `relayer-graph-core`'s `SearchIndex` seam,
//! implemented against a real store.
//!
//! This is the promotion of the issue #261 contract probe, which proved the
//! frozen `relayer.graph-query` v1 contract against `lbug` 0.18.0. Its schema and
//! value lowerings live on here as product code; its frozen receipt stays in
//! `docs/evidence/issue-261-ladybug-contract-probe/` as the record of that gate.
//!
//! This crate is the only one that names `lbug`.

#[cfg(feature = "crash-test-support")]
#[doc(hidden)]
pub mod contract_test_support;
mod lifecycle;
mod query;
pub(crate) mod schema;
pub(crate) mod store;
pub(crate) mod value;

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{
        Arc, RwLock as StdRwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

#[cfg(feature = "crash-test-support")]
use std::sync::{Condvar, Mutex};

#[cfg(feature = "crash-test-support")]
use serde_json::Value as JsonValue;
use tokio::sync::{Notify, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock as AsyncRwLock};

use relayer_graph_core::{
    AcceptedGraphPublication, DEFAULT_SEARCH_INDEX_BUDGET, GraphError, SearchIndex,
    SearchIndexFuture, SearchIndexRevision, SearchIndexWrite, SearchTarget,
    query::{PreparedQuery, QueryCode, QueryError, QueryReadPermit, prepare_request_json},
};

pub use self::query::QueryOutcome;

use self::store::{LadybugStore, StoreLayout, exec};

/// A search index backed by a Ladybug store beside the SQLite file.
#[derive(Clone)]
pub struct LadybugSearchIndex {
    runtime: Arc<LadybugRuntime>,
    #[cfg(feature = "crash-test-support")]
    post_commit_crash_hook: Option<Arc<dyn Fn() + Send + Sync + 'static>>,
    #[cfg(feature = "crash-test-support")]
    contract_test_wall_time: Option<Duration>,
}

struct LadybugRuntime {
    store: StdRwLock<Arc<LadybugStore>>,
    layout: StoreLayout,
    operations: Arc<AsyncRwLock<()>>,
    readiness: StdRwLock<HashMap<SearchTarget, SearchTargetReadiness>>,
    pending_publications: StdRwLock<HashMap<SearchTarget, String>>,
    reconciling: AtomicBool,
    epoch: AtomicU64,
    query_count: AtomicU64,
    notify: Notify,
    background_hold: AtomicBool,
    background_gate: Notify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchTargetReadiness {
    Ready,
    CanonicalUnknown,
    Rebuilding,
    Failed,
}

#[derive(Clone, Default)]
pub struct QueryCancellation {
    inner: Arc<QueryCancellationInner>,
}

#[derive(Default)]
struct QueryCancellationInner {
    cancelled: AtomicBool,
    notify: Notify,
    started: AtomicBool,
    started_notify: Notify,
    #[cfg(feature = "crash-test-support")]
    hold_after_started: Mutex<bool>,
    #[cfg(feature = "crash-test-support")]
    hold_after_started_gate: Condvar,
}

impl QueryCancellation {
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::Release);
        self.inner.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::Acquire)
    }

    fn mark_started(&self) {
        self.inner.started.store(true, Ordering::Release);
        self.inner.started_notify.notify_waiters();
    }

    #[cfg(feature = "crash-test-support")]
    fn wait_at_started_gate(&self) {
        let mut held = self
            .inner
            .hold_after_started
            .lock()
            .expect("query start gate poisoned");
        while *held {
            held = self
                .inner
                .hold_after_started_gate
                .wait(held)
                .expect("query start gate poisoned");
        }
    }

    #[cfg(feature = "crash-test-support")]
    #[doc(hidden)]
    pub fn hold_after_started_for_test(&self) {
        *self
            .inner
            .hold_after_started
            .lock()
            .expect("query start gate poisoned") = true;
    }

    #[cfg(feature = "crash-test-support")]
    #[doc(hidden)]
    pub fn release_after_started_for_test(&self) {
        *self
            .inner
            .hold_after_started
            .lock()
            .expect("query start gate poisoned") = false;
        self.inner.hold_after_started_gate.notify_all();
    }

    #[cfg(feature = "crash-test-support")]
    #[doc(hidden)]
    pub async fn wait_until_started(&self) {
        loop {
            let notified = self.inner.started_notify.notified();
            if self.inner.started.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }

    async fn cancelled(&self) {
        loop {
            let notified = self.inner.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GraphQueryFailure {
    Contract(QueryError),
    TargetNotReady {
        target: SearchTarget,
        readiness: SearchTargetReadiness,
    },
}

impl From<QueryError> for GraphQueryFailure {
    fn from(error: QueryError) -> Self {
        Self::Contract(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryDiagnostics {
    pub target: SearchTarget,
    pub cold: bool,
    pub elapsed_micros: u128,
    pub pattern_parts: usize,
    pub traversal_hops: usize,
    pub returned_rows: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphQueryResult {
    pub outcome: QueryOutcome,
    pub diagnostics: QueryDiagnostics,
}

#[cfg(feature = "crash-test-support")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchIndexLifecycleFault {
    BeforePublish,
    ReplacePointerAfterOpen,
    ReplacePointerBeforePublish,
    HoldLogicalRebuild,
    DelayBeforeFinalOpen,
}

impl LadybugSearchIndex {
    /// Open, or create, the store at `<database>.ladybug/active/`.
    pub fn open(database: &Path) -> Result<Self, GraphError> {
        Self::open_with_timeout(database, DEFAULT_SEARCH_INDEX_BUDGET)
    }

    pub fn open_with_timeout(database: &Path, query_timeout: Duration) -> Result<Self, GraphError> {
        let layout = StoreLayout::beside(database);
        let store = LadybugStore::open(layout, query_timeout).map_err(internal)?;
        Ok(Self::from_store(store))
    }

    /// Open a validated store whose exact contents were reconciled against the
    /// canonical SQLite graph before it can answer product work.
    pub async fn open_reconciled(
        database: &Path,
        graph: &relayer_graph_core::GraphDatabase,
    ) -> Result<Self, GraphError> {
        lifecycle::open_reconciled(
            database,
            graph,
            DEFAULT_SEARCH_INDEX_BUDGET,
            relayer_graph_core::DEFAULT_IMPORT_INDEX_BUDGET,
            None,
        )
        .await
    }

    #[cfg(feature = "crash-test-support")]
    pub async fn open_reconciled_with_fault(
        database: &Path,
        graph: &relayer_graph_core::GraphDatabase,
        fault: SearchIndexLifecycleFault,
    ) -> Result<Self, GraphError> {
        lifecycle::open_reconciled(
            database,
            graph,
            DEFAULT_SEARCH_INDEX_BUDGET,
            relayer_graph_core::DEFAULT_IMPORT_INDEX_BUDGET,
            Some(fault),
        )
        .await
    }

    #[cfg(feature = "crash-test-support")]
    pub async fn open_reconciled_with_rebuild_budget(
        database: &Path,
        graph: &relayer_graph_core::GraphDatabase,
        fault: SearchIndexLifecycleFault,
        rebuild_budget: Duration,
    ) -> Result<Self, GraphError> {
        lifecycle::open_reconciled(
            database,
            graph,
            DEFAULT_SEARCH_INDEX_BUDGET,
            rebuild_budget,
            Some(fault),
        )
        .await
    }

    fn from_store(store: LadybugStore) -> Self {
        let layout = store.layout().clone();
        Self {
            runtime: Arc::new(LadybugRuntime {
                store: StdRwLock::new(Arc::new(store)),
                layout,
                operations: Arc::new(AsyncRwLock::new(())),
                readiness: StdRwLock::new(HashMap::new()),
                pending_publications: StdRwLock::new(HashMap::new()),
                reconciling: AtomicBool::new(false),
                epoch: AtomicU64::new(0),
                query_count: AtomicU64::new(0),
                notify: Notify::new(),
                background_hold: AtomicBool::new(false),
                background_gate: Notify::new(),
            }),
            #[cfg(feature = "crash-test-support")]
            post_commit_crash_hook: None,
            #[cfg(feature = "crash-test-support")]
            contract_test_wall_time: None,
        }
    }

    #[cfg(feature = "crash-test-support")]
    pub fn with_post_commit_crash_hook(
        mut self,
        hook: Arc<dyn Fn() + Send + Sync + 'static>,
    ) -> Self {
        self.post_commit_crash_hook = Some(hook);
        self
    }

    /// Run requests that leave `budget.wall_time_ms` unset under `wall_time`
    /// instead of the contract's product budget. Frozen-corpus conformance
    /// asserts result bytes, not latency, and a scheduling stall on a shared
    /// runner must not read as a semantic mismatch. A request that narrows
    /// `wall_time_ms` keeps its own bound, so the deadline tests and the
    /// budget-precedence corpus still prove the product budget.
    #[cfg(feature = "crash-test-support")]
    #[doc(hidden)]
    pub fn with_contract_test_wall_time(mut self, wall_time: Duration) -> Self {
        self.contract_test_wall_time = Some(wall_time);
        self
    }

    /// The wall-time budget for one query: the contract limit already
    /// narrowed to the caller's request.
    #[cfg(not(feature = "crash-test-support"))]
    fn wall_time_for(&self, prepared: &PreparedQuery) -> Duration {
        prepared.limits().wall_time
    }

    #[cfg(feature = "crash-test-support")]
    fn wall_time_for(&self, prepared: &PreparedQuery) -> Duration {
        match self.contract_test_wall_time {
            Some(wall_time) if prepared.budget().wall_time_ms.is_none() => wall_time,
            _ => prepared.limits().wall_time,
        }
    }

    #[cfg(feature = "crash-test-support")]
    #[doc(hidden)]
    pub fn layout(&self) -> &StoreLayout {
        &self.runtime.layout
    }

    fn current_store(&self) -> Arc<LadybugStore> {
        self.runtime
            .store
            .read()
            .expect("Ladybug store lock poisoned")
            .clone()
    }

    fn require_store_available(&self, target: SearchTarget) -> Result<(), GraphError> {
        match self.target_readiness(target) {
            SearchTargetReadiness::Ready | SearchTargetReadiness::CanonicalUnknown => Ok(()),
            SearchTargetReadiness::Rebuilding => Err(GraphError::Internal(format!(
                "search target {target} is rebuilding"
            ))),
            SearchTargetReadiness::Failed => Err(GraphError::Internal(format!(
                "search target {target} rebuild failed"
            ))),
        }
    }

    #[cfg(feature = "crash-test-support")]
    fn require_queryable(&self, target: SearchTarget) -> Result<(), GraphError> {
        match self.target_readiness(target) {
            SearchTargetReadiness::Ready => Ok(()),
            SearchTargetReadiness::CanonicalUnknown => Err(GraphError::Internal(format!(
                "search target {target} is awaiting canonical reconciliation"
            ))),
            SearchTargetReadiness::Rebuilding => Err(GraphError::Internal(format!(
                "search target {target} is rebuilding"
            ))),
            SearchTargetReadiness::Failed => Err(GraphError::Internal(format!(
                "search target {target} rebuild failed"
            ))),
        }
    }

    pub fn target_readiness(&self, target: SearchTarget) -> SearchTargetReadiness {
        self.runtime
            .readiness
            .read()
            .expect("search readiness lock poisoned")
            .get(&target)
            .copied()
            .unwrap_or(SearchTargetReadiness::Ready)
    }

    #[cfg(feature = "crash-test-support")]
    #[doc(hidden)]
    pub fn set_contract_test_readiness(
        &self,
        target: SearchTarget,
        readiness: SearchTargetReadiness,
    ) {
        self.runtime
            .readiness
            .write()
            .expect("search readiness lock poisoned")
            .insert(target, readiness);
    }

    fn query_readiness(&self, target: SearchTarget) -> Result<(), GraphQueryFailure> {
        let readiness = self.target_readiness(target);
        if readiness == SearchTargetReadiness::Ready {
            Ok(())
        } else {
            Err(GraphQueryFailure::TargetNotReady { target, readiness })
        }
    }

    /// Execute the complete v1 boundary in its required authority order.
    /// Parsing and planning happen before the sealed permit is intersected;
    /// readiness and a pinned store generation are touched only after that.
    pub async fn query(
        &self,
        permit: &QueryReadPermit,
        request_json: &[u8],
        cancellation: QueryCancellation,
    ) -> Result<GraphQueryResult, GraphQueryFailure> {
        let prepared = prepare_request_json(request_json)?;
        self.execute_prepared(permit, prepared, cancellation).await
    }

    /// Execute the exact preflight value produced by graph core. The transport
    /// can therefore preserve contract precedence without making this engine
    /// reparse or replan a semantically divergent request.
    pub(crate) async fn execute_prepared(
        &self,
        permit: &QueryReadPermit,
        prepared: PreparedQuery,
        cancellation: QueryCancellation,
    ) -> Result<GraphQueryResult, GraphQueryFailure> {
        let target = permit.authorize(prepared.target())?;
        let readiness_target = permit.readiness_target(target);
        self.query_readiness(readiness_target)?;
        let operation = self.runtime.operations.clone().read_owned().await;
        self.query_readiness(readiness_target)?;
        let store = self.current_store();
        let started = Instant::now();
        let deadline = started + self.wall_time_for(&prepared);
        let cold = self.runtime.query_count.fetch_add(1, Ordering::AcqRel) == 0;
        let parameters = prepared.parameters().clone();
        let plan = prepared.plan().clone();
        let limits = prepared.limits().clone();
        let worker_plan = plan.clone();
        let worker_limits = limits.clone();
        let worker_cancellation = cancellation.clone();
        let job_id = store.reserve_interruptible_job();
        let work = store.run_interruptible_until(job_id, deadline, move |connection| {
            worker_cancellation.mark_started();
            #[cfg(feature = "crash-test-support")]
            worker_cancellation.wait_at_started_gate();
            Ok(query::execute(
                connection,
                &worker_plan,
                &parameters,
                target,
                &worker_limits,
                &worker_cancellation,
            ))
        });
        let outcome = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                store.interrupt_job(job_id).map_err(query::engine_failure)?;
                Err(QueryError::new(
                    QueryCode::QueryCancelled,
                    "budget.cancellation",
                    "the query was cancelled",
                ))
            },
            result = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), work) => {
                match result {
                    Err(_) => {
                        store.interrupt_job(job_id).map_err(query::engine_failure)?;
                        Err(QueryError::new(
                            QueryCode::WallTimeExceeded,
                            "budget.wall_time_ms",
                            "the query exceeded its wall-time budget",
                        ))
                    },
                    Ok(Err(error)) => Err(query::engine_failure(error)),
                    Ok(Ok(result)) => result,
                }
            }
        }?;
        drop(operation);
        // A publication may have entered its Ladybug-first commit window while
        // this query was running. Recheck after the engine work so a result
        // cannot escape while canonical SQLite acknowledgement is unknown.
        self.query_readiness(readiness_target)?;
        Ok(GraphQueryResult {
            diagnostics: QueryDiagnostics {
                target,
                cold,
                elapsed_micros: started.elapsed().as_micros(),
                pattern_parts: plan.patterns.len(),
                traversal_hops: plan.max_traversal_hops,
                returned_rows: outcome.rows.len(),
                truncated: outcome.truncated,
            },
            outcome,
        })
    }

    pub async fn wait_until_reconciled(&self) -> Result<(), GraphError> {
        loop {
            let notified = self.runtime.notify.notified();
            if !self.runtime.reconciling.load(Ordering::Acquire) {
                break;
            }
            notified.await;
        }
        if self
            .runtime
            .readiness
            .read()
            .expect("search readiness lock poisoned")
            .values()
            .any(|state| *state == SearchTargetReadiness::Failed)
        {
            return Err(GraphError::Internal(
                "one or more search targets failed to rebuild".into(),
            ));
        }
        Ok(())
    }

    fn mark_rebuilding(&self, targets: HashSet<SearchTarget>) {
        self.runtime
            .pending_publications
            .write()
            .expect("pending search publication lock poisoned")
            .retain(|target, _| !targets.contains(target));
        let mut readiness = self
            .runtime
            .readiness
            .write()
            .expect("search readiness lock poisoned");
        for target in targets {
            readiness.insert(target, SearchTargetReadiness::Rebuilding);
        }
        self.runtime.reconciling.store(true, Ordering::Release);
    }

    fn finish_rebuild(&self, success: bool) {
        let mut readiness = self
            .runtime
            .readiness
            .write()
            .expect("search readiness lock poisoned");
        for state in readiness.values_mut() {
            if *state == SearchTargetReadiness::Rebuilding {
                *state = if success {
                    SearchTargetReadiness::Ready
                } else {
                    SearchTargetReadiness::Failed
                };
            }
        }
        self.runtime.reconciling.store(false, Ordering::Release);
        self.runtime.notify.notify_waiters();
    }

    async fn lock_operations(&self) -> OwnedRwLockWriteGuard<()> {
        self.runtime.operations.clone().write_owned().await
    }

    fn install_store(&self, store: LadybugStore) {
        *self
            .runtime
            .store
            .write()
            .expect("Ladybug store lock poisoned") = Arc::new(store);
    }

    fn epoch(&self) -> u64 {
        self.runtime.epoch.load(Ordering::Acquire)
    }

    async fn wait_for_background_gate(&self) {
        loop {
            let notified = self.runtime.background_gate.notified();
            if !self.runtime.background_hold.load(Ordering::Acquire) {
                break;
            }
            notified.await;
        }
    }

    #[cfg(feature = "crash-test-support")]
    pub fn resume_logical_rebuild(&self) {
        self.runtime.background_hold.store(false, Ordering::Release);
        self.runtime.background_gate.notify_waiters();
    }

    /// Run one read-only query and normalize its rows into the frozen
    /// `relayer.graph-query` v1 wire shape.
    ///
    /// The query path proper is #263's, with its own parser, planner and
    /// budgets. This is the narrow read the store is observed through: startup
    /// reconciliation, and the contract tests that keep the promoted value
    /// lowerings honest against a real engine.
    #[cfg(feature = "crash-test-support")]
    #[doc(hidden)]
    pub async fn normalized_rows(&self, query: &str) -> Result<Vec<Vec<JsonValue>>, GraphError> {
        self.normalized_rows_on(self.current_store(), query).await
    }

    #[cfg(feature = "crash-test-support")]
    #[doc(hidden)]
    pub async fn normalized_rows_for(
        &self,
        target: SearchTarget,
        query: &str,
    ) -> Result<Vec<Vec<JsonValue>>, GraphError> {
        self.require_queryable(target)?;
        let _operation = self.runtime.operations.clone().read_owned().await;
        self.require_queryable(target)?;
        self.normalized_rows_on(self.current_store(), query).await
    }

    #[cfg(feature = "crash-test-support")]
    async fn normalized_rows_on(
        &self,
        store: Arc<LadybugStore>,
        query: &str,
    ) -> Result<Vec<Vec<JsonValue>>, GraphError> {
        let query = query.to_owned();
        store
            .run(move |connection| {
                let endpoints = store::endpoint_index(connection)?;
                store::rows(connection, &query)?
                    .iter()
                    .map(|row| {
                        row.iter()
                            .map(|value| {
                                value::normalize_value(value, &endpoints)
                                    .map_err(anyhow::Error::from)
                            })
                            .collect::<anyhow::Result<Vec<_>>>()
                    })
                    .collect()
            })
            .await
            .map_err(internal)
    }

    pub(crate) async fn revision_count(&self) -> Result<usize, GraphError> {
        self.current_store()
            .run(schema::revision_count)
            .await
            .map_err(internal)
    }

    pub(crate) async fn revision_targets(&self) -> Result<Vec<String>, GraphError> {
        self.current_store()
            .run(schema::revision_targets)
            .await
            .map_err(internal)
    }

    pub(crate) async fn inventory(&self) -> Result<schema::SearchInventory, GraphError> {
        self.current_store()
            .run(schema::physical_inventory)
            .await
            .map_err(internal)
    }

    #[cfg(feature = "crash-test-support")]
    pub async fn inject_lifecycle_corruption(&self, query: &str) -> Result<(), GraphError> {
        let query = query.to_owned();
        self.current_store()
            .run(move |connection| exec(connection, &query))
            .await
            .map_err(internal)
    }
}

impl SearchIndex for LadybugSearchIndex {
    fn revision(&self, target: SearchTarget) -> SearchIndexFuture<Option<SearchIndexRevision>> {
        let index = self.clone();
        Box::pin(async move {
            index.require_store_available(target)?;
            let _operation = index.runtime.operations.clone().read_owned().await;
            index.require_store_available(target)?;
            index
                .current_store()
                .run(move |connection| schema::read_revision(connection, target))
                .await
                .map_err(internal)
        })
    }

    fn begin(
        &self,
        target: SearchTarget,
        revision: SearchIndexRevision,
    ) -> SearchIndexFuture<Box<dyn SearchIndexWrite>> {
        self.begin_until(
            target,
            revision,
            Instant::now() + DEFAULT_SEARCH_INDEX_BUDGET,
        )
    }

    fn begin_until(
        &self,
        target: SearchTarget,
        revision: SearchIndexRevision,
        deadline: Instant,
    ) -> SearchIndexFuture<Box<dyn SearchIndexWrite>> {
        let index = self.clone();
        #[cfg(feature = "crash-test-support")]
        let post_commit_crash_hook = self.post_commit_crash_hook.clone();
        Box::pin(async move {
            index.require_store_available(target)?;
            let operation = index.runtime.operations.clone().read_owned().await;
            index.require_store_available(target)?;
            let store = index.current_store();
            // The BEGIN runs whether or not this future is still being awaited,
            // so an abandoned one has to release its own transaction.
            store
                .run_undoable_until(
                    deadline,
                    |connection| exec(connection, "BEGIN TRANSACTION"),
                    |connection| {
                        let _ = exec(connection, "ROLLBACK");
                    },
                )
                .await
                .map_err(internal)?;
            Ok(Box::new(LadybugWrite {
                store,
                target,
                revision,
                deadline,
                _operation: operation,
                runtime: index.runtime.clone(),
                #[cfg(feature = "crash-test-support")]
                post_commit_crash_hook,
                settled: false,
            }) as Box<dyn SearchIndexWrite>)
        })
    }

    fn canonical_commit_unknown(
        &self,
        target: SearchTarget,
        publication_identity: &str,
    ) -> Result<(), GraphError> {
        let readiness = self
            .runtime
            .readiness
            .read()
            .expect("search readiness lock poisoned")
            .get(&target)
            .copied()
            .unwrap_or(SearchTargetReadiness::Ready);
        let mut pending = self
            .runtime
            .pending_publications
            .write()
            .expect("pending search publication lock poisoned");
        if readiness == SearchTargetReadiness::CanonicalUnknown {
            if pending.get(&target).map(String::as_str) == Some(publication_identity) {
                return Ok(());
            }
            return Err(GraphError::Internal(format!(
                "search target {target} is awaiting canonical reconciliation"
            )));
        }
        if readiness != SearchTargetReadiness::Ready {
            return Err(GraphError::Internal(format!(
                "search target {target} is not ready for publication"
            )));
        }
        pending.insert(target, publication_identity.to_owned());
        self.runtime
            .readiness
            .write()
            .expect("search readiness lock poisoned")
            .insert(target, SearchTargetReadiness::CanonicalUnknown);
        Ok(())
    }

    fn canonical_commit_is_unknown(&self, target: SearchTarget) -> bool {
        self.target_readiness(target) == SearchTargetReadiness::CanonicalUnknown
    }

    fn canonical_commit_confirmed(&self, target: SearchTarget) {
        self.runtime
            .pending_publications
            .write()
            .expect("pending search publication lock poisoned")
            .remove(&target);
        let mut readiness = self
            .runtime
            .readiness
            .write()
            .expect("search readiness lock poisoned");
        if readiness.get(&target) == Some(&SearchTargetReadiness::CanonicalUnknown) {
            readiness.insert(target, SearchTargetReadiness::Ready);
        }
    }
}

/// One open Ladybug transaction. `lbug` 0.18.0 exposes transactions only as
/// `BEGIN TRANSACTION`/`COMMIT`/`ROLLBACK` query strings, with no prepare/commit
/// split, which is why two-phase commit across SQLite and Ladybug is unavailable
/// and the write ordering commits Ladybug first instead.
struct LadybugWrite {
    store: Arc<LadybugStore>,
    target: SearchTarget,
    revision: SearchIndexRevision,
    deadline: Instant,
    _operation: OwnedRwLockReadGuard<()>,
    runtime: Arc<LadybugRuntime>,
    #[cfg(feature = "crash-test-support")]
    post_commit_crash_hook: Option<Arc<dyn Fn() + Send + Sync + 'static>>,
    /// Whether the transaction has been committed or rolled back. An unsettled
    /// write that is dropped was abandoned — a deadline expired, or the request
    /// was cancelled — and has to release its transaction itself.
    settled: bool,
}

impl Drop for LadybugWrite {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        // Nothing is left to await with, so the rollback is queued and forgotten.
        // It runs ahead of any later BEGIN, because the worker takes its jobs in
        // order.
        self.store.detach(|connection| {
            let _ = exec(connection, "ROLLBACK");
        });
    }
}

impl SearchIndexWrite for LadybugWrite {
    fn apply(
        &mut self,
        closure: AcceptedGraphPublication,
        published_to: Vec<SearchTarget>,
    ) -> SearchIndexFuture<()> {
        let store = self.store.clone();
        let deadline = self.deadline;
        Box::pin(async move {
            store
                .run_until(deadline, move |connection| {
                    schema::apply_closure(connection, &published_to, &closure)
                })
                .await
                .map_err(internal)
        })
    }

    fn remove(&mut self, closure: AcceptedGraphPublication) -> SearchIndexFuture<()> {
        let store = self.store.clone();
        let deadline = self.deadline;
        Box::pin(async move {
            store
                .run_until(deadline, move |connection| {
                    schema::remove_closure(connection, &closure)
                })
                .await
                .map_err(internal)
        })
    }

    fn commit(mut self: Box<Self>) -> SearchIndexFuture<SearchIndexRevision> {
        let (store, target, revision, deadline) = (
            self.store.clone(),
            self.target,
            self.revision,
            self.deadline,
        );
        let runtime = self.runtime.clone();
        #[cfg(feature = "crash-test-support")]
        let post_commit_crash_hook = self.post_commit_crash_hook.clone();
        Box::pin(async move {
            let outcome = store
                .run_until(deadline, move |connection| {
                    // The revision is written inside the transaction, so it
                    // becomes durable with the closure it describes or not at all.
                    if let Err(error) = schema::write_revision(connection, target, revision) {
                        let _ = exec(connection, "ROLLBACK");
                        return Err(error);
                    }
                    if let Err(error) = exec(connection, "COMMIT") {
                        let _ = exec(connection, "ROLLBACK");
                        return Err(error);
                    }
                    #[cfg(feature = "crash-test-support")]
                    if let Some(hook) = post_commit_crash_hook {
                        hook();
                    }
                    // COMMIT plus immediate searchability is the acknowledged
                    // boundary. A forced data-file checkpoint is both outside
                    // that contract and above the interactive latency budget;
                    // startup rebuild handles an ahead or unopenable WAL state.
                    Ok(())
                })
                .await
                .map_err(internal);
            // Keep the write unsettled inside the future. If the caller's
            // deadline expires before this future is ever polled, or while the
            // worker job is running, dropping the future drops `self` and queues
            // a rollback behind the job. Once the job answers, its own error
            // path has rolled back any still-open transaction.
            self.settled = true;
            outcome?;
            runtime.epoch.fetch_add(1, Ordering::AcqRel);
            Ok(revision)
        })
    }

    fn rollback(mut self: Box<Self>) -> SearchIndexFuture<()> {
        self.settled = true;
        let store = self.store.clone();
        Box::pin(async move {
            store
                .run(|connection| exec(connection, "ROLLBACK"))
                .await
                .map_err(internal)
        })
    }
}

fn internal(error: anyhow::Error) -> GraphError {
    GraphError::Internal(format!("search index failed: {error:#}"))
}
