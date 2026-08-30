use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::{
    AcceptedGraphClosure, GraphError, GraphNode, GraphWriter, InteractionContextAction,
    InteractionContextDraft, InteractionContextTarget, InteractionInputNode, InteractionInvocation,
    NoSearchIndex, NodeId, PERSONAL_PRESENTATION_PROFILE_THREAD_ID, ProjectId, SearchIndex,
    SearchIndexComponent, SearchIndexRevision, SearchTarget, ThreadId,
    graph::{InteractionScope, model::require_nonempty},
    interaction_input_digest,
    storage::{
        SqliteGraphStore,
        sqlite::{contexts::ContextTable, nodes::NodeTable, search_index::SearchIndexTable},
    },
};

/// How long a search-index write may take before the save fails.
///
/// This is a ceiling, not a target: the SQLite write lock is held across the
/// search write, so an unbounded one would stall every other writer. It matches
/// the SQLite busy timeout, and #303 measures the latency that actually matters.
pub const DEFAULT_SEARCH_INDEX_BUDGET: Duration = Duration::from_secs(5);

/// How long indexing an imported conversation may take before the import fails.
///
/// An import is bulk and one-shot rather than interactive: it materializes every
/// turn of a conversation and indexes them as one transaction, so it needs a
/// ceiling of its own rather than the one sized for a single save.
pub const DEFAULT_IMPORT_INDEX_BUDGET: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct GraphDatabase {
    pub(crate) storage: SqliteGraphStore,
    pub(crate) search_index: Arc<dyn SearchIndex>,
    pub(crate) search_index_budget: Duration,
    pub(crate) import_index_budget: Duration,
    /// One lock per logical target, so concurrent submissions to one target
    /// index in the order they commit while unrelated targets stay independent.
    write_order: Arc<Mutex<HashMap<SearchTarget, Arc<AsyncMutex<()>>>>>,
    #[cfg(feature = "crash-test-support")]
    pub(crate) completion_crash_hook:
        Option<Arc<dyn Fn(crate::CompletionCrashPoint) + Send + Sync + 'static>>,
}

impl GraphDatabase {
    /// Open a graph with no search store attached. Accepted closures are recorded
    /// in SQLite but indexed nowhere; the shipped server uses
    /// [`GraphDatabase::open_with_index`] instead.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, GraphError> {
        Self::open_with_index(path, Arc::new(NoSearchIndex)).await
    }

    /// Open a graph that indexes every accepted closure into `search_index`.
    pub async fn open_with_index(
        path: impl AsRef<Path>,
        search_index: Arc<dyn SearchIndex>,
    ) -> Result<Self, GraphError> {
        Ok(Self {
            storage: SqliteGraphStore::open(path).await?,
            search_index,
            search_index_budget: DEFAULT_SEARCH_INDEX_BUDGET,
            import_index_budget: DEFAULT_IMPORT_INDEX_BUDGET,
            write_order: Arc::default(),
            #[cfg(feature = "crash-test-support")]
            completion_crash_hook: None,
        })
    }

    pub async fn in_memory() -> Result<Self, GraphError> {
        Self::in_memory_with_index(Arc::new(NoSearchIndex)).await
    }

    pub async fn in_memory_with_index(
        search_index: Arc<dyn SearchIndex>,
    ) -> Result<Self, GraphError> {
        Ok(Self {
            storage: SqliteGraphStore::in_memory().await?,
            search_index,
            search_index_budget: DEFAULT_SEARCH_INDEX_BUDGET,
            import_index_budget: DEFAULT_IMPORT_INDEX_BUDGET,
            write_order: Arc::default(),
            #[cfg(feature = "crash-test-support")]
            completion_crash_hook: None,
        })
    }

    /// The search store this graph indexes into. Startup reconciliation reads it
    /// without going through the write path.
    pub fn search_index(&self) -> &Arc<dyn SearchIndex> {
        &self.search_index
    }

    /// Bound how long a search-index write may take before the save fails.
    pub fn with_search_index_budget(mut self, budget: Duration) -> Self {
        self.search_index_budget = budget;
        self
    }

    /// When the search-index work for a save that starts now must be done. One
    /// deadline covers the whole sequence, because what it bounds is how long the
    /// global SQLite write lock is held.
    pub(crate) fn expiry(&self) -> tokio::time::Instant {
        tokio::time::Instant::now() + self.search_index_budget
    }

    /// The deadline for indexing a whole imported conversation.
    pub(crate) fn import_expiry(&self) -> tokio::time::Instant {
        tokio::time::Instant::now() + self.import_index_budget
    }

    /// Bound how long indexing an imported conversation may take.
    pub fn with_import_index_budget(mut self, budget: Duration) -> Self {
        self.import_index_budget = budget;
        self
    }

    /// Install a one-shot-test observer at the six durable completion boundaries.
    ///
    /// This API does not exist in ordinary product builds. It is enabled only by
    /// the explicit crash-proof feature used by #301's deterministic harness.
    #[cfg(feature = "crash-test-support")]
    pub fn with_completion_crash_hook(
        mut self,
        hook: Arc<dyn Fn(crate::CompletionCrashPoint) + Send + Sync + 'static>,
    ) -> Self {
        self.completion_crash_hook = Some(hook);
        self
    }

    #[cfg(feature = "crash-test-support")]
    pub(crate) fn hit_completion_crash_point(&self, point: crate::CompletionCrashPoint) {
        if let Some(hook) = &self.completion_crash_hook {
            hook(point);
        }
    }

    /// Take this target's place in line. Submissions to one target are ordered
    /// against each other and against nothing else.
    pub(crate) async fn order_writes_to(&self, target: SearchTarget) -> OwnedMutexGuard<()> {
        let lock = {
            let mut write_order = self
                .write_order
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // Locks are only ever cloned under this guard, so an entry nobody
            // else holds is idle and can go. Without this the map keeps one
            // entry per target for the life of the process.
            write_order.retain(|_, lock| Arc::strong_count(lock) > 1);
            write_order.entry(target).or_default().clone()
        };
        lock.lock_owned().await
    }

    /// The last revision this target is known to have committed to the search
    /// store, or `None` when it has never been indexed.
    pub async fn search_index_revision(
        &self,
        target: SearchTarget,
    ) -> Result<Option<SearchIndexRevision>, GraphError> {
        let mut connection = self.storage.acquire().await?;
        SearchIndexTable::new(&mut connection)
            .revision(target)
            .await
    }

    /// Read one tracked search-store version. These are answered from SQLite
    /// alone, so they stay available exactly when the store is corrupt or
    /// version-incompatible and cannot be opened.
    pub async fn search_index_version(
        &self,
        component: SearchIndexComponent,
    ) -> Result<Option<String>, GraphError> {
        let mut connection = self.storage.acquire().await?;
        SearchIndexTable::new(&mut connection)
            .version(component)
            .await
    }

    pub async fn record_search_index_version(
        &self,
        component: SearchIndexComponent,
        version: &str,
    ) -> Result<(), GraphError> {
        let mut transaction = self.storage.begin_write().await?;
        SearchIndexTable::new(&mut transaction)
            .record_version(component, version)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn create_interaction(
        &self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
    ) -> Result<GraphNode, GraphError> {
        self.create_interaction_with_invocation(project_id, thread_id, text, None)
            .await
    }

    pub async fn create_interaction_with_invocation(
        &self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
        invocation: Option<InteractionInvocation>,
    ) -> Result<GraphNode, GraphError> {
        reject_reserved_profile_thread(thread_id)?;
        require_nonempty(text, "text")?;
        let mut transaction = self.storage.begin_write().await?;
        let node = NodeTable::new(&mut transaction)
            .insert_interaction(project_id, thread_id, text, invocation)
            .await?;
        transaction.commit().await?;
        Ok(node)
    }

    pub async fn create_interaction_with_context(
        &self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
        contexts: &[InteractionContextDraft],
    ) -> Result<(GraphNode, Vec<InteractionContextAction>), GraphError> {
        reject_reserved_profile_thread(thread_id)?;
        if text.trim().is_empty()
            && !contexts
                .iter()
                .flat_map(|context| &context.annotations)
                .any(|annotation| !annotation.trim().is_empty())
        {
            return Err(GraphError::validation(
                "missing_interaction_input",
                "text",
                "An interaction needs non-whitespace message text or at least one non-whitespace context annotation.",
            ));
        }
        let mut transaction = self.storage.begin_write().await?;
        let node = NodeTable::new(&mut transaction)
            .insert_interaction(project_id, thread_id, text, None)
            .await?;
        let scope = InteractionScope {
            project_id,
            thread_id,
            root_node_id: node.id,
            read_only: false,
        };
        let actions = ContextTable::new(&mut transaction)
            .insert_all(&scope, contexts)
            .await?;
        transaction.commit().await?;
        Ok((node, actions))
    }

    pub async fn create_identified_interaction_with_context(
        &self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
        input_identity: &str,
        input_digest: &str,
        contexts: &[InteractionContextDraft],
    ) -> Result<(GraphNode, Vec<InteractionContextAction>), GraphError> {
        reject_reserved_profile_thread(thread_id)?;
        self.create_identified_interaction_with_context_inner(
            project_id,
            thread_id,
            text,
            input_identity,
            input_digest,
            contexts,
        )
        .await
    }

    pub async fn create_personal_presentation_interaction(
        &self,
        text: &str,
        input_identity: &str,
        input_digest: &str,
    ) -> Result<GraphNode, GraphError> {
        if !input_identity.starts_with("relayer.personal-presentation:") {
            return Err(GraphError::validation(
                "invalid_personal_presentation_identity",
                "inputIdentity",
                "A personal-presentation interaction needs the reserved identity prefix.",
            ));
        }
        let thread_id = ThreadId::new(PERSONAL_PRESENTATION_PROFILE_THREAD_ID)
            .expect("the reserved profile thread identity is positive");
        let (node, actions) = self
            .create_identified_interaction_with_context_inner(
                None,
                thread_id,
                text,
                input_identity,
                input_digest,
                &[],
            )
            .await?;
        debug_assert!(actions.is_empty());
        Ok(node)
    }

    async fn create_identified_interaction_with_context_inner(
        &self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
        input_identity: &str,
        input_digest: &str,
        contexts: &[InteractionContextDraft],
    ) -> Result<(GraphNode, Vec<InteractionContextAction>), GraphError> {
        require_nonempty(input_identity, "inputIdentity")?;
        require_nonempty(input_digest, "inputDigest")?;
        let computed_digest = interaction_input_digest(text, contexts).map_err(|error| {
            GraphError::Internal(format!("could not digest interaction input: {error}"))
        })?;
        if input_digest != computed_digest {
            return Err(GraphError::validation(
                "interaction_input_digest_mismatch",
                "inputDigest",
                "The supplied interaction input digest does not match the exact message and ordered context.",
            ));
        }
        let mut transaction = self.storage.begin_write().await?;
        let mut nodes = NodeTable::new(&mut transaction);
        if let Some(node) = nodes
            .identified_interaction(thread_id, input_identity, input_digest)
            .await?
        {
            let scope = InteractionScope {
                project_id,
                thread_id,
                root_node_id: node.id,
                read_only: false,
            };
            let actions = ContextTable::new(&mut transaction).actions(&scope).await?;
            let persisted = actions
                .iter()
                .map(|action| InteractionContextDraft {
                    target: action.target.clone(),
                    annotations: action.annotations.clone(),
                })
                .collect::<Vec<_>>();
            let persisted_digest =
                interaction_input_digest(&node.detail, &persisted).map_err(|error| {
                    GraphError::Internal(format!(
                        "could not verify stored interaction input: {error}"
                    ))
                })?;
            if persisted_digest != input_digest {
                return Err(GraphError::Internal(
                    "stored interaction input does not match its durable digest".into(),
                ));
            }
            transaction.commit().await?;
            return Ok((node, actions));
        }
        if text.trim().is_empty()
            && !contexts
                .iter()
                .flat_map(|context| &context.annotations)
                .any(|annotation| !annotation.trim().is_empty())
        {
            return Err(GraphError::validation(
                "missing_interaction_input",
                "text",
                "An interaction needs non-whitespace message text or at least one non-whitespace context annotation.",
            ));
        }
        let node = nodes
            .insert_interaction(project_id, thread_id, text, None)
            .await?;
        nodes
            .set_input_identity(node.id, input_identity, input_digest)
            .await?;
        let scope = InteractionScope {
            project_id,
            thread_id,
            root_node_id: node.id,
            read_only: false,
        };
        let actions = ContextTable::new(&mut transaction)
            .insert_all(&scope, contexts)
            .await?;
        transaction.commit().await?;
        Ok((node, actions))
    }

    pub async fn writer_for_subgraph(&self, node_id: NodeId) -> Result<GraphWriter, GraphError> {
        let scope = {
            let mut connection = self.storage.acquire().await?;
            NodeTable::new(&mut connection)
                .interaction_scope(node_id)
                .await?
        };
        Ok(GraphWriter::new(self.clone(), scope))
    }

    pub async fn accepted_graph_closure(
        &self,
        node_id: NodeId,
    ) -> Result<Option<AcceptedGraphClosure>, GraphError> {
        crate::graph::completion::read_accepted_closure(self, node_id).await
    }

    pub async fn interaction_invocation(
        &self,
        node_id: NodeId,
    ) -> Result<Option<InteractionInvocation>, GraphError> {
        let mut connection = self.storage.acquire().await?;
        Ok(NodeTable::new(&mut connection)
            .interaction_lease(node_id)
            .await?
            .map(|lease| InteractionInvocation {
                source_interaction_node_id: lease.source_interaction_id,
                source_action_id: lease.action_id,
            }))
    }

    pub async fn interaction_input_identity(
        &self,
        node_id: NodeId,
    ) -> Result<Option<(String, String)>, GraphError> {
        let mut connection = self.storage.acquire().await?;
        NodeTable::new(&mut connection)
            .interaction_input_identity(node_id)
            .await
    }

    pub async fn interaction_context_actions(
        &self,
        node_id: NodeId,
    ) -> Result<Vec<InteractionContextAction>, GraphError> {
        let scope = {
            let mut connection = self.storage.acquire().await?;
            NodeTable::new(&mut connection)
                .interaction_scope(node_id)
                .await?
        };
        let mut connection = self.storage.acquire().await?;
        ContextTable::new(&mut connection).actions(&scope).await
    }

    pub async fn canonical_interaction_context_occurrence(
        &self,
        target: &InteractionContextTarget,
    ) -> Result<InteractionInputNode, GraphError> {
        let scope = {
            let mut connection = self.storage.acquire().await?;
            NodeTable::new(&mut connection)
                .interaction_scope(target.source_interaction_node_id)
                .await
                .map_err(|error| match error {
                    GraphError::Forbidden(_) | GraphError::NotFound(_) => GraphError::validation(
                        "invalid_context_occurrence",
                        "target",
                        "Context must identify an accepted node occurrence in the exact visible accepted source completion.",
                    ),
                    other => other,
                })?
        };
        let mut connection = self.storage.acquire().await?;
        ContextTable::new(&mut connection)
            .canonical_occurrence(&scope, "target", target)
            .await
    }

    pub async fn close(&self) {
        self.storage.close().await;
    }
}

fn reject_reserved_profile_thread(thread_id: ThreadId) -> Result<(), GraphError> {
    if thread_id.value() == PERSONAL_PRESENTATION_PROFILE_THREAD_ID {
        return Err(GraphError::validation(
            "reserved_personal_presentation_thread",
            "threadId",
            "The personal-presentation profile thread is reserved for its dedicated control boundary.",
        ));
    }
    Ok(())
}
