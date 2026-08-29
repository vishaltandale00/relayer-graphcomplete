//! The Ladybug search index: `relayer-graph-core`'s `SearchIndex` seam,
//! implemented against a real store.
//!
//! This is the promotion of the issue #261 contract probe, which proved the
//! frozen `relayer.graph-query` v1 contract against `lbug` 0.18.0. Its schema and
//! value lowerings live on here as product code; its frozen receipt stays in
//! `docs/evidence/issue-261-ladybug-contract-probe/` as the record of that gate.
//!
//! This crate is the only one that names `lbug`.

mod lifecycle;
pub mod query;
pub mod schema;
pub mod store;
pub mod value;

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{
        Arc, RwLock as StdRwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use serde_json::Value as JsonValue;
use tokio::sync::{Notify, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock as AsyncRwLock};

use relayer_graph_core::{
    AcceptedGraphClosure, DEFAULT_SEARCH_INDEX_BUDGET, GraphError, SearchIndex, SearchIndexFuture,
    SearchIndexRevision, SearchIndexWrite, SearchTarget,
};

use self::store::{LadybugStore, StoreLayout, exec};

/// A search index backed by a Ladybug store beside the SQLite file.
#[derive(Clone)]
pub struct LadybugSearchIndex {
    runtime: Arc<LadybugRuntime>,
    #[cfg(feature = "crash-test-support")]
    post_commit_crash_hook: Option<Arc<dyn Fn() + Send + Sync + 'static>>,
}

struct LadybugRuntime {
    store: StdRwLock<Arc<LadybugStore>>,
    layout: StoreLayout,
    operations: Arc<AsyncRwLock<()>>,
    readiness: StdRwLock<HashMap<SearchTarget, SearchTargetReadiness>>,
    reconciling: AtomicBool,
    epoch: AtomicU64,
    notify: Notify,
    background_hold: AtomicBool,
    background_gate: Notify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchTargetReadiness {
    Ready,
    Rebuilding,
    Failed,
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
                reconciling: AtomicBool::new(false),
                epoch: AtomicU64::new(0),
                notify: Notify::new(),
                background_hold: AtomicBool::new(false),
                background_gate: Notify::new(),
            }),
            #[cfg(feature = "crash-test-support")]
            post_commit_crash_hook: None,
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

    fn require_ready(&self, target: SearchTarget) -> Result<(), GraphError> {
        match self.target_readiness(target) {
            SearchTargetReadiness::Ready => Ok(()),
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
    pub async fn normalized_rows(&self, query: &str) -> Result<Vec<Vec<JsonValue>>, GraphError> {
        self.normalized_rows_on(self.current_store(), query).await
    }

    pub async fn normalized_rows_for(
        &self,
        target: SearchTarget,
        query: &str,
    ) -> Result<Vec<Vec<JsonValue>>, GraphError> {
        self.require_ready(target)?;
        let _operation = self.runtime.operations.clone().read_owned().await;
        self.require_ready(target)?;
        self.normalized_rows_on(self.current_store(), query).await
    }

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
                            .map(|value| value::normalize_value(value, &endpoints))
                            .collect()
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
            index.require_ready(target)?;
            let _operation = index.runtime.operations.clone().read_owned().await;
            index.require_ready(target)?;
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
            index.require_ready(target)?;
            let operation = index.runtime.operations.clone().read_owned().await;
            index.require_ready(target)?;
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
        closure: AcceptedGraphClosure,
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
