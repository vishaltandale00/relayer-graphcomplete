use std::{fmt, future::Future, pin::Pin, time::Instant};

use serde::{Deserialize, Serialize};

use crate::{AcceptedGraphPublication, GraphError, ProjectId, ThreadId};

/// One canonical accepted closure used to reconstruct the derived search store.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchIndexRebuildClosure {
    pub target: SearchTarget,
    pub published_to: Vec<SearchTarget>,
    pub closure: AcceptedGraphPublication,
}

/// A transactionally consistent SQLite view of everything the derived store
/// must contain after startup reconciliation.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchIndexRebuildSnapshot {
    pub targets: Vec<(SearchTarget, SearchIndexRevision)>,
    pub closures: Vec<SearchIndexRebuildClosure>,
}

/// A boxed future. The seam is used through `dyn SearchIndex`, and an `async fn`
/// in a trait is not dyn-compatible, so the futures are boxed here rather than
/// through an async-trait dependency.
pub type SearchIndexFuture<T> = Pin<Box<dyn Future<Output = Result<T, GraphError>> + Send>>;

/// The unit of search-index ordering: the project a closure belongs to, or its
/// standalone thread when it belongs to no project. Both are columns on `nodes`.
///
/// Ordering is preserved per target rather than globally, so a target whose store
/// is unwritable cannot stall submissions to unrelated targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchTarget {
    Project(ProjectId),
    Thread(ThreadId),
}

impl SearchTarget {
    /// The target a closure belongs to: its project when it has one, and its
    /// standalone thread otherwise.
    pub fn new(project_id: Option<ProjectId>, thread_id: ThreadId) -> Self {
        match project_id {
            Some(project_id) => Self::Project(project_id),
            None => Self::Thread(thread_id),
        }
    }

    /// The discriminant stored in `search_index_targets.target_kind`.
    pub(crate) fn kind(self) -> &'static str {
        match self {
            Self::Project(_) => "project",
            Self::Thread(_) => "thread",
        }
    }

    pub(crate) fn id(self) -> i64 {
        match self {
            Self::Project(project_id) => project_id.value(),
            Self::Thread(thread_id) => thread_id.value(),
        }
    }
}

impl fmt::Display for SearchTarget {
    /// The spelling the frozen query contract uses for a published target, so
    /// what the store holds and what a request names are the same string.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}:{}", self.kind(), self.id())
    }
}

/// Every target a closure is visible to: its project when it has one, and always
/// its thread.
///
/// This is not the same as the ordering target. A closure in thread 41 of project
/// 7 is ordered against `project:7`, but is searchable from both `project:7` and
/// `thread:41` — which is what the frozen contract's own dataset publishes. One
/// target alone would let a thread-scoped search see the whole project.
pub fn publication_targets(
    project_id: Option<ProjectId>,
    thread_id: ThreadId,
) -> Vec<SearchTarget> {
    let mut targets = Vec::with_capacity(2);
    if let Some(project_id) = project_id {
        targets.push(SearchTarget::Project(project_id));
    }
    targets.push(SearchTarget::Thread(thread_id));
    targets
}

/// Which revision of a target's closures the search store holds.
///
/// Ladybug 0.18.0 has no revision of its own, so Relayer allocates the number and
/// writes it on both sides: into the Ladybug transaction, and into SQLite once
/// that transaction has committed. Holding the same number twice is what makes an
/// interrupted write detectable afterwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SearchIndexRevision(i64);

impl SearchIndexRevision {
    /// The revision a target reaches on its first committed closure.
    pub const FIRST: Self = Self(1);

    pub fn new(value: i64) -> Option<Self> {
        (value > 0).then_some(Self(value))
    }

    pub fn value(self) -> i64 {
        self.0
    }

    /// The revision that follows this one. Revisions are dense per target, so a
    /// gap is evidence of a lost write rather than of a skipped number.
    pub fn next(self) -> Self {
        Self(self.0 + 1)
    }
}

impl fmt::Display for SearchIndexRevision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// The write side of the search store, as `relayer-graph-core` sees it.
///
/// The trait is what lets the write ordering span both crates without graph-core
/// naming `lbug`: graph-core owns the SQLite transaction and the ordering, and
/// `relayer-graph-server` owns the engine. That keeps the C++/CMake/OpenSSL
/// toolchain out of graph-core, which `relayer-app-server` also depends on.
pub trait SearchIndex: Send + Sync + 'static {
    /// The revision the store itself holds for a target, or `None` when it holds
    /// none.
    ///
    /// This is not the same as the revision SQLite recorded. When the two differ
    /// the store is ahead, which is the signature of a write interrupted after
    /// the store committed and before SQLite did.
    fn revision(&self, target: SearchTarget) -> SearchIndexFuture<Option<SearchIndexRevision>>;

    /// Open a transaction against the store for one target, which will carry
    /// `revision` when it commits.
    ///
    /// The returned write is owned rather than borrowed from the index, so an
    /// implementation is free to run the engine on its own thread. It has to: the
    /// engine's Rust surface is blocking FFI, and the SQLite write lock is held
    /// across the call, so the write needs a bounded timeout the async runtime
    /// can actually observe.
    fn begin(
        &self,
        target: SearchTarget,
        revision: SearchIndexRevision,
    ) -> SearchIndexFuture<Box<dyn SearchIndexWrite>>;

    /// Open a transaction whose engine work shares the caller's absolute
    /// operation deadline. Implementations without an inner engine timeout may
    /// rely on the outer async deadline and keep the ordinary `begin` behavior.
    fn begin_until(
        &self,
        target: SearchTarget,
        revision: SearchIndexRevision,
        _deadline: Instant,
    ) -> SearchIndexFuture<Box<dyn SearchIndexWrite>> {
        self.begin(target, revision)
    }

    /// Quarantine a publication immediately before its derived-store commit.
    /// Query implementations must fail the target closed until matching
    /// canonical SQLite state is confirmed. An already-quarantined target may
    /// admit only the exact same publication identity; a different retry must
    /// fail until startup reconciliation replaces the derived store.
    fn canonical_commit_unknown(
        &self,
        _target: SearchTarget,
        _publication_identity: &str,
    ) -> Result<(), GraphError> {
        Ok(())
    }

    /// Whether this process has observed an ambiguous canonical commit for the
    /// target and must reconcile it before serving queries.
    fn canonical_commit_is_unknown(&self, _target: SearchTarget) -> bool {
        false
    }

    /// Canonical SQLite durably recorded the store revision. This makes a target
    /// quarantined by [`SearchIndex::canonical_commit_unknown`] queryable again.
    fn canonical_commit_confirmed(&self, _target: SearchTarget) {}
}

/// One open transaction against the search store. Committing or rolling back
/// consumes it, so a write cannot be committed twice or silently abandoned.
pub trait SearchIndexWrite: Send + 'static {
    /// Write one accepted closure into the open transaction, visible to every
    /// target in `published_to`. Nothing is visible to search until the
    /// transaction commits.
    fn apply(
        &mut self,
        publication: AcceptedGraphPublication,
        published_to: Vec<SearchTarget>,
    ) -> SearchIndexFuture<()>;

    /// Remove one canonical publication from the derived store.
    ///
    /// This is used only while rolling back a conversation import whose graph
    /// records are still wholly owned by that import. The removal shares the
    /// same transaction and revision acknowledgement as ordinary publication,
    /// so canonical SQLite can never report the rollback while stale derived
    /// rows remain queryable.
    fn remove(&mut self, publication: AcceptedGraphPublication) -> SearchIndexFuture<()>;

    /// Commit, returning the revision now durable in the store. This is the point
    /// after which a crash leaves an orphan rather than a lost closure.
    fn commit(self: Box<Self>) -> SearchIndexFuture<SearchIndexRevision>;

    /// Abandon the transaction, leaving the store at its previous revision.
    fn rollback(self: Box<Self>) -> SearchIndexFuture<()>;
}

/// The index used when no search store is attached.
///
/// It accepts every write and commits the revision it was given, which is what
/// lets `relayer-graph-core` be built and tested with no Ladybug present. It
/// indexes nothing, so a database opened with it records revisions for a store
/// that does not exist; only `GraphDatabase::open` uses it, and the shipped
/// server supplies a real index instead.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoSearchIndex;

impl SearchIndex for NoSearchIndex {
    fn revision(&self, _target: SearchTarget) -> SearchIndexFuture<Option<SearchIndexRevision>> {
        Box::pin(async { Ok(None) })
    }

    fn begin(
        &self,
        _target: SearchTarget,
        revision: SearchIndexRevision,
    ) -> SearchIndexFuture<Box<dyn SearchIndexWrite>> {
        Box::pin(async move {
            Ok(Box::new(NoSearchIndexWrite { revision }) as Box<dyn SearchIndexWrite>)
        })
    }
}

struct NoSearchIndexWrite {
    revision: SearchIndexRevision,
}

impl SearchIndexWrite for NoSearchIndexWrite {
    fn apply(
        &mut self,
        _publication: AcceptedGraphPublication,
        _published_to: Vec<SearchTarget>,
    ) -> SearchIndexFuture<()> {
        Box::pin(async { Ok(()) })
    }

    fn remove(&mut self, _publication: AcceptedGraphPublication) -> SearchIndexFuture<()> {
        Box::pin(async { Ok(()) })
    }

    fn commit(self: Box<Self>) -> SearchIndexFuture<SearchIndexRevision> {
        let revision = self.revision;
        Box::pin(async move { Ok(revision) })
    }

    fn rollback(self: Box<Self>) -> SearchIndexFuture<()> {
        Box::pin(async { Ok(()) })
    }
}

/// The five versions that decide whether an existing search store may be opened
/// at all. They are held in SQLite, not in the store, so they stay readable
/// exactly when the store is corrupt or version-incompatible and will not open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchIndexComponent {
    Engine,
    StorageFormat,
    RelayerSchema,
    QueryContract,
    DerivedIndex,
}

impl SearchIndexComponent {
    pub const ALL: [Self; 5] = [
        Self::Engine,
        Self::StorageFormat,
        Self::RelayerSchema,
        Self::QueryContract,
        Self::DerivedIndex,
    ];

    /// The value stored in `search_index_versions.component`.
    pub(crate) fn column(self) -> &'static str {
        match self {
            Self::Engine => "engine",
            Self::StorageFormat => "storage_format",
            Self::RelayerSchema => "relayer_schema",
            Self::QueryContract => "query_contract",
            Self::DerivedIndex => "derived_index",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ActionKind, GraphAction, LayerId, NavigateRelation, NodeId, RecordState};

    fn closure() -> AcceptedGraphPublication {
        AcceptedGraphPublication {
            node_id: NodeId::new(1).unwrap(),
            interaction: crate::GraphNode {
                id: NodeId::new(1).unwrap(),
                leased_action_id: None,
                kind: "user-interaction".into(),
                icon: "message-square".into(),
                title: "Explain the queue".into(),
                detail: "Explain the queue".into(),
                authored_detail: None,
                state: RecordState::Accepted,
            },
            root_action: Some(GraphAction {
                id: crate::ActionId::new(1).unwrap(),
                source_node_id: NodeId::new(1).unwrap(),
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(NavigateRelation::Expand),
                label: "Response".into(),
                variant: crate::ActionVariant::default(),
                icon: None,
                description: None,
                target_layer_id: Some(LayerId::new(1).unwrap()),
                interaction_text: None,
                input: None,
                state: RecordState::Accepted,
            }),
            root_layer_id: LayerId::new(1).unwrap(),
            layers: vec![],
        }
    }

    #[test]
    fn a_target_is_its_project_when_it_has_one_and_its_thread_otherwise() {
        let thread = ThreadId::new(4).unwrap();
        assert_eq!(
            SearchTarget::new(ProjectId::new(9), thread),
            SearchTarget::Project(ProjectId::new(9).unwrap())
        );
        assert_eq!(
            SearchTarget::new(None, thread),
            SearchTarget::Thread(thread)
        );
        // A project and a thread that share an integer are different targets, so
        // their revisions never collide in `search_index_targets`.
        assert_ne!(
            SearchTarget::new(ProjectId::new(4), thread),
            SearchTarget::new(None, thread)
        );
    }

    #[test]
    fn revisions_start_at_one_and_advance_densely() {
        assert_eq!(SearchIndexRevision::FIRST.value(), 1);
        assert_eq!(SearchIndexRevision::FIRST.next().value(), 2);
        assert_eq!(SearchIndexRevision::new(0), None);
        assert_eq!(SearchIndexRevision::new(-1), None);
    }

    #[tokio::test]
    async fn the_no_op_index_commits_the_revision_it_was_given() {
        let index = NoSearchIndex;
        let target = SearchTarget::Thread(ThreadId::new(1).unwrap());
        let mut write = index
            .begin(target, SearchIndexRevision::FIRST)
            .await
            .unwrap();
        write.apply(closure(), vec![target]).await.unwrap();
        assert_eq!(write.commit().await.unwrap(), SearchIndexRevision::FIRST);
    }

    #[tokio::test]
    async fn the_no_op_index_can_be_rolled_back() {
        let index = NoSearchIndex;
        let target = SearchTarget::Thread(ThreadId::new(1).unwrap());
        let write = index
            .begin(target, SearchIndexRevision::FIRST)
            .await
            .unwrap();
        write.rollback().await.unwrap();
    }
}
