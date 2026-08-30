//! The Ladybug search index: `relayer-graph-core`'s `SearchIndex` seam,
//! implemented against a real store.
//!
//! This is the promotion of the issue #261 contract probe, which proved the
//! frozen `relayer.graph-query` v1 contract against `lbug` 0.18.0. Its schema and
//! value lowerings live on here as product code; its frozen receipt stays in
//! `docs/evidence/issue-261-ladybug-contract-probe/` as the record of that gate.
//!
//! This crate is the only one that names `lbug`.

pub mod schema;
pub mod store;
pub mod value;

use std::{path::Path, sync::Arc, time::Duration};

use serde_json::Value as JsonValue;

use relayer_graph_core::{
    AcceptedGraphClosure, DEFAULT_SEARCH_INDEX_BUDGET, GraphError, SearchIndex, SearchIndexFuture,
    SearchIndexRevision, SearchIndexWrite, SearchTarget,
};

use self::store::{LadybugStore, StoreLayout, exec};

/// A search index backed by a Ladybug store beside the SQLite file.
#[derive(Clone)]
pub struct LadybugSearchIndex {
    store: Arc<LadybugStore>,
}

impl LadybugSearchIndex {
    /// Open, or create, the store at `<database>.ladybug/active/`.
    pub fn open(database: &Path) -> Result<Self, GraphError> {
        Self::open_with_timeout(database, DEFAULT_SEARCH_INDEX_BUDGET)
    }

    pub fn open_with_timeout(database: &Path, query_timeout: Duration) -> Result<Self, GraphError> {
        let layout = StoreLayout::beside(database);
        let store = LadybugStore::open(layout, query_timeout).map_err(internal)?;
        Ok(Self {
            store: Arc::new(store),
        })
    }

    pub fn layout(&self) -> &StoreLayout {
        self.store.layout()
    }

    /// Run one read-only query and normalize its rows into the frozen
    /// `relayer.graph-query` v1 wire shape.
    ///
    /// The query path proper is #263's, with its own parser, planner and
    /// budgets. This is the narrow read the store is observed through: startup
    /// reconciliation, and the contract tests that keep the promoted value
    /// lowerings honest against a real engine.
    pub async fn normalized_rows(&self, query: &str) -> Result<Vec<Vec<JsonValue>>, GraphError> {
        let query = query.to_owned();
        self.store
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
}

impl SearchIndex for LadybugSearchIndex {
    fn revision(&self, target: SearchTarget) -> SearchIndexFuture<Option<SearchIndexRevision>> {
        let store = self.store.clone();
        Box::pin(async move {
            store
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
        let store = self.store.clone();
        Box::pin(async move {
            // The BEGIN runs whether or not this future is still being awaited,
            // so an abandoned one has to release its own transaction.
            store
                .run_undoable(
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
        Box::pin(async move {
            store
                .run(move |connection| schema::apply_closure(connection, &published_to, &closure))
                .await
                .map_err(internal)
        })
    }

    fn commit(mut self: Box<Self>) -> SearchIndexFuture<SearchIndexRevision> {
        let (store, target, revision) = (self.store.clone(), self.target, self.revision);
        Box::pin(async move {
            let outcome = store
                .run(move |connection| {
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
                    // Ladybug 0.18 can acknowledge COMMIT while relationship
                    // updates still exist only in a WAL state that its own
                    // replay cannot survive an immediate SIGKILL. The author is
                    // not acknowledged until the derived revision is crash-
                    // durable, so force the engine checkpoint inside the same
                    // bounded worker job.
                    exec(connection, "CHECKPOINT")
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
