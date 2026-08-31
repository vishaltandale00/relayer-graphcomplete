use std::{
    collections::HashMap,
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::sync::{
    Mutex as AsyncMutex, OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock,
};

use crate::{
    AcceptedGraphClosure, AcceptedGraphPublication, CompletionState, CurrentProjectionEvent,
    CurrentProjectionPage, CurrentTransitionReceipt, GraphError, GraphNode, GraphWriter,
    InteractionContextAction, InteractionContextDraft, InteractionContextTarget,
    InteractionInputChild, InteractionInputNode, InteractionInputPreparation,
    InteractionInvocation, NoSearchIndex, NodeId, PERSONAL_PRESENTATION_PROFILE_THREAD_ID,
    PresentingInputOccurrence, ProjectId, SearchIndex, SearchIndexComponent,
    SearchIndexRebuildClosure, SearchIndexRebuildSnapshot, SearchIndexRevision, SearchTarget,
    SubmittedInputDraft, TemporalFeatureConfig, ThreadId,
    graph::{InteractionScope, model::require_nonempty},
    interaction_input_authority_digest, interaction_input_digest,
    query::QueryReadPermit,
    storage::{
        GraphTransaction, SqliteGraphStore,
        sqlite::{
            actions::ActionTable, contexts::ContextTable, currents::CurrentTable,
            input_children::InputChildTable, nodes::NodeTable, search_index::SearchIndexTable,
        },
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
    /// Short publication barrier used only when a reconciled generation swaps.
    /// Ordinary rebuilding does not hold it, so unrelated targets stay usable.
    search_rebuild: Arc<RwLock<()>>,
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
            search_rebuild: Arc::default(),
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
            search_rebuild: Arc::default(),
            #[cfg(feature = "crash-test-support")]
            completion_crash_hook: None,
        })
    }

    pub async fn temporal_features(&self) -> Result<TemporalFeatureConfig, GraphError> {
        let mut transaction = self.storage.begin_read().await?;
        let config = CurrentTable::new(&mut transaction)
            .temporal_features()
            .await?;
        transaction.commit().await?;
        Ok(config)
    }

    pub async fn set_temporal_features(
        &self,
        config: TemporalFeatureConfig,
    ) -> Result<(), GraphError> {
        let mut transaction = self.storage.begin_write().await?;
        CurrentTable::new(&mut transaction)
            .set_temporal_features(config)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// The search store this graph indexes into. Startup reconciliation reads it
    /// without going through the write path.
    pub fn search_index(&self) -> &Arc<dyn SearchIndex> {
        &self.search_index
    }

    /// Attach a reconciled derived store without reopening canonical SQLite.
    pub fn with_search_index(mut self, search_index: Arc<dyn SearchIndex>) -> Self {
        self.search_index = search_index;
        self
    }

    pub(crate) async fn enter_search_publication(&self) -> OwnedRwLockReadGuard<()> {
        self.search_rebuild.clone().read_owned().await
    }

    /// Finish the canonical half of one already-committed search publication.
    /// A failed SQLite COMMIT is ambiguous, so quarantine the target before the
    /// error escapes; an exact retry may safely advance the store and clear it.
    pub(crate) async fn commit_indexed_write(
        &self,
        transaction: GraphTransaction,
        target: SearchTarget,
    ) -> Result<(), GraphError> {
        match transaction.commit().await {
            Ok(()) => {
                self.search_index.canonical_commit_confirmed(target);
                Ok(())
            }
            // The publication boundary quarantines the target before Ladybug
            // commits, so an ambiguous SQLite failure must preserve that exact
            // pending identity rather than overwrite it here.
            Err(error) => Err(error.into()),
        }
    }

    /// Freeze accepted-search publication briefly while startup verifies that a
    /// side-by-side candidate still represents the latest canonical snapshot.
    pub async fn lock_search_rebuild(&self) -> OwnedRwLockWriteGuard<()> {
        self.search_rebuild.clone().write_owned().await
    }

    /// Read the complete canonical rebuild input from one SQLite snapshot.
    pub async fn search_index_rebuild_snapshot(
        &self,
    ) -> Result<SearchIndexRebuildSnapshot, GraphError> {
        let mut transaction = self.storage.begin_read().await?;
        let currents = CurrentTable::new(&mut transaction)
            .published_currents()
            .await?;
        let mut closures = Vec::with_capacity(currents.len());
        for current in currents {
            let node_id = current.completion_id;
            let scope = NodeTable::new(&mut transaction)
                .interaction_scope(node_id)
                .await?;
            let root_action = crate::graph::completion::read_output_on(&mut transaction, &scope)
                .await?
                .map(|output| output.root_action);
            let closure: AcceptedGraphPublication =
                crate::graph::completion::read_accepted_publication_on(
                    &mut transaction,
                    &scope,
                    current.layer_id,
                    root_action,
                )
                .await?;
            closures.push(SearchIndexRebuildClosure {
                target: SearchTarget::new(scope.project_id, scope.thread_id),
                published_to: crate::publication_targets(scope.project_id, scope.thread_id),
                closure,
            });
        }
        let mut targets = SearchIndexTable::new(&mut transaction).revisions().await?;
        let mut known = targets
            .iter()
            .map(|(target, _)| *target)
            .collect::<HashSet<_>>();
        // Search receipts were introduced after accepted graphs already existed.
        // Every canonical closure still establishes an ordering target even when
        // its historical database has no receipt row yet. One deterministic
        // rebuild transaction carries every historical closure for that target.
        for item in &closures {
            if known.insert(item.target) {
                targets.push((item.target, SearchIndexRevision::FIRST));
            }
        }
        targets.sort_by_key(|(target, _)| (target.kind(), target.id()));
        transaction.commit().await?;
        Ok(SearchIndexRebuildSnapshot { targets, closures })
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

    /// Replace the active store's compatibility receipt atomically.
    pub async fn record_search_index_versions(
        &self,
        versions: &[(SearchIndexComponent, String)],
    ) -> Result<(), GraphError> {
        let mut transaction = self.storage.begin_write().await?;
        for (component, version) in versions {
            SearchIndexTable::new(&mut transaction)
                .record_version(*component, version)
                .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Publish the complete rebuild receipt only after the generation pointer
    /// names a reopen-validated store. This also upgrades accepted history from
    /// before target receipts existed.
    pub async fn record_search_index_rebuild_receipt(
        &self,
        targets: &[(SearchTarget, SearchIndexRevision)],
        versions: &[(SearchIndexComponent, String)],
    ) -> Result<(), GraphError> {
        let mut transaction = self.storage.begin_write().await?;
        for (target, revision) in targets {
            SearchIndexTable::new(&mut transaction)
                .record_revision(*target, *revision)
                .await?;
        }
        for (component, version) in versions {
            SearchIndexTable::new(&mut transaction)
                .record_version(*component, version)
                .await?;
        }
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
        if invocation.is_none() {
            require_nonempty(text, "text")?;
        }
        let mut transaction = self.storage.begin_write().await?;
        let node = NodeTable::new(&mut transaction)
            .insert_interaction(project_id, thread_id, text, invocation)
            .await?;
        initialize_completion(&mut transaction, &node, project_id, thread_id).await?;
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
        initialize_completion(&mut transaction, &node, project_id, thread_id).await?;
        let scope = InteractionScope {
            project_id,
            thread_id,
            root_node_id: node.id,
            read_only: false,
            authority_epoch: None,
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
        if let Some(node) = NodeTable::new(&mut transaction)
            .identified_interaction(project_id, thread_id, input_identity, input_digest)
            .await?
        {
            initialize_completion(&mut transaction, &node, project_id, thread_id).await?;
            let scope = InteractionScope {
                project_id,
                thread_id,
                root_node_id: node.id,
                read_only: false,
                authority_epoch: None,
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
        let node = NodeTable::new(&mut transaction)
            .insert_interaction(project_id, thread_id, text, None)
            .await?;
        initialize_completion(&mut transaction, &node, project_id, thread_id).await?;
        NodeTable::new(&mut transaction)
            .set_input_identity(node.id, input_identity, input_digest)
            .await?;
        let scope = InteractionScope {
            project_id,
            thread_id,
            root_node_id: node.id,
            read_only: false,
            authority_epoch: None,
        };
        let actions = ContextTable::new(&mut transaction)
            .insert_all(&scope, contexts)
            .await?;
        transaction.commit().await?;
        Ok((node, actions))
    }

    pub async fn create_identified_interaction_with_inputs(
        &self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
        input: InteractionInputPreparation<'_>,
    ) -> Result<(GraphNode, Vec<InteractionInputChild>), GraphError> {
        reject_reserved_profile_thread(thread_id)?;
        let InteractionInputPreparation {
            attempt_key: input_identity,
            authority_digest,
            contexts,
            submitted_inputs: attachments,
        } = input;
        require_nonempty(input_identity, "attemptKey")?;
        require_nonempty(authority_digest, "authorityDigest")?;
        let computed_digest =
            interaction_input_authority_digest(text, attachments).map_err(|error| {
                GraphError::Internal(format!("could not digest submitted input: {error}"))
            })?;
        if authority_digest != computed_digest {
            return Err(GraphError::validation(
                "interaction_input_digest_mismatch",
                "authorityDigest",
                "The supplied authority digest does not match the exact message and submitted inputs.",
            ));
        }
        if text.trim().is_empty()
            && attachments.is_empty()
            && !contexts
                .iter()
                .flat_map(|context| &context.annotations)
                .any(|annotation| !annotation.trim().is_empty())
        {
            return Err(GraphError::validation(
                "interaction_input_required",
                "interaction",
                "Supply nonempty root text or at least one valid child.",
            ));
        }

        let mut transaction = self.storage.begin_write().await?;
        let mut nodes = NodeTable::new(&mut transaction);
        let identified = nodes
            .identified_interaction(project_id, thread_id, input_identity, authority_digest)
            .await
            .map_err(|error| match error {
                GraphError::Validation {
                    code: "interaction_input_conflict",
                    ..
                } => GraphError::validation(
                    "interaction_input_attempt_conflict",
                    "attemptKey",
                    "Recover the existing attempt instead of reusing its key with different input.",
                ),
                other => other,
            })?;
        if let Some(node) = identified {
            initialize_completion(&mut transaction, &node, project_id, thread_id).await?;
            let scope = InteractionScope {
                project_id,
                thread_id,
                root_node_id: node.id,
                read_only: false,
                authority_epoch: None,
            };
            let persisted_contexts = ContextTable::new(&mut transaction)
                .actions(&scope)
                .await?
                .into_iter()
                .map(|action| InteractionContextDraft {
                    target: action.target,
                    annotations: action.annotations,
                })
                .collect::<Vec<_>>();
            let children = InputChildTable::new(&mut transaction)
                .children(node.id)
                .await?;
            let persisted_attachments = children
                .iter()
                .map(|child| SubmittedInputDraft {
                    occurrence: child.occurrence.clone(),
                    action: child.action.clone(),
                    value: child.value.clone(),
                })
                .collect::<Vec<_>>();
            let mut supplied = attachments.to_vec();
            for attachment in &mut supplied {
                attachment.value = attachment.value.canonicalized();
            }
            supplied.sort_by_key(|attachment| attachment.occurrence.clone());
            if persisted_contexts != contexts || persisted_attachments != supplied {
                return Err(GraphError::validation(
                    "interaction_input_attempt_conflict",
                    "attemptKey",
                    "Recover the existing attempt instead of reusing its key with different input.",
                ));
            }
            transaction.commit().await?;
            return Ok((node, children));
        }

        let node = nodes
            .insert_interaction(project_id, thread_id, text, None)
            .await?;
        nodes
            .set_input_identity(node.id, input_identity, authority_digest)
            .await?;
        initialize_completion(&mut transaction, &node, project_id, thread_id).await?;
        let scope = InteractionScope {
            project_id,
            thread_id,
            root_node_id: node.id,
            read_only: false,
            authority_epoch: None,
        };
        ContextTable::new(&mut transaction)
            .insert_all(&scope, contexts)
            .await?;
        let children = InputChildTable::new(&mut transaction)
            .validate_and_insert_all(&scope, text, input_identity, authority_digest, attachments)
            .await?;
        transaction.commit().await?;
        Ok((node, children))
    }

    pub async fn writer_for_subgraph(&self, node_id: NodeId) -> Result<GraphWriter, GraphError> {
        let mut transaction = self.storage.begin_write().await?;
        let scope = NodeTable::new(&mut transaction)
            .interaction_scope(node_id)
            .await?;
        initialize_completion_scope(&mut transaction, &scope).await?;
        transaction.commit().await?;
        Ok(GraphWriter::new(self.clone(), scope))
    }

    pub async fn writer_for_completion_authority(
        &self,
        node_id: NodeId,
        authority_epoch: u64,
    ) -> Result<GraphWriter, GraphError> {
        let mut scope = {
            let mut connection = self.storage.acquire().await?;
            NodeTable::new(&mut connection)
                .interaction_scope(node_id)
                .await?
        };
        scope.authority_epoch = Some(authority_epoch);
        Ok(GraphWriter::new(self.clone(), scope))
    }

    pub async fn activate_completion_authority(&self, node_id: NodeId) -> Result<u64, GraphError> {
        let mut transaction = self.storage.begin_write().await?;
        NodeTable::new(&mut transaction)
            .interaction_scope(node_id)
            .await?;
        let epoch = CurrentTable::new(&mut transaction)
            .activate_authority(node_id)
            .await?;
        transaction.commit().await?;
        Ok(epoch)
    }

    pub async fn cutover_completion_authority(&self, node_id: NodeId) -> Result<(), GraphError> {
        let mut transaction = self.storage.begin_write().await?;
        CurrentTable::new(&mut transaction)
            .cutover_authority(node_id)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Mint the search entitlement from canonical interaction provenance. A
    /// public target is only a selector and never supplies authority.
    pub async fn query_read_permit(
        &self,
        interaction_node_id: NodeId,
        authority_epoch: u64,
    ) -> Result<QueryReadPermit, GraphError> {
        let mut transaction = self.storage.begin_read().await?;
        let mut scope = NodeTable::new(&mut transaction)
            .interaction_scope(interaction_node_id)
            .await?;
        scope.authority_epoch = Some(authority_epoch);
        scope.require_active_authority(&mut transaction).await?;
        let readable_threads = match scope.project_id {
            Some(project_id) => {
                NodeTable::new(&mut transaction)
                    .accepted_project_threads(project_id)
                    .await?
            }
            None => vec![scope.thread_id],
        };
        transaction.commit().await?;
        Ok(QueryReadPermit::canonical_scope(
            scope.thread_id,
            scope.project_id,
            readable_threads,
        ))
    }

    pub async fn accepted_graph_closure(
        &self,
        node_id: NodeId,
    ) -> Result<Option<AcceptedGraphClosure>, GraphError> {
        crate::graph::completion::read_accepted_closure(self, node_id).await
    }

    pub async fn current_completion(&self, node_id: NodeId) -> Result<CompletionState, GraphError> {
        self.writer_for_subgraph(node_id)
            .await?
            .current_completion()
            .await
    }

    pub async fn current_projection_events(
        &self,
        after_sequence: u64,
        limit: u32,
    ) -> Result<Vec<CurrentProjectionEvent>, GraphError> {
        crate::graph::completion::projections_after(self, after_sequence, limit).await
    }

    pub async fn current_projection_page(
        &self,
        completion_ids: &[NodeId],
        after_sequence: u64,
        limit: u32,
    ) -> Result<CurrentProjectionPage, GraphError> {
        crate::graph::completion::projection_page(self, completion_ids, after_sequence, limit).await
    }

    pub async fn current_transition_receipt(
        &self,
        node_id: NodeId,
        operation_key: &str,
    ) -> Result<Option<CurrentTransitionReceipt>, GraphError> {
        let mut transaction = self.storage.begin_read().await?;
        NodeTable::new(&mut transaction)
            .interaction_scope(node_id)
            .await?;
        let receipt = CurrentTable::new(&mut transaction)
            .receipt(node_id, operation_key)
            .await?;
        transaction.commit().await?;
        Ok(receipt)
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

    pub async fn canonical_input_action_occurrence(
        &self,
        destination_project_id: Option<crate::ProjectId>,
        destination_thread_id: crate::ThreadId,
        occurrence: &PresentingInputOccurrence,
    ) -> Result<crate::GraphAction, GraphError> {
        let scope = {
            let mut connection = self.storage.acquire().await?;
            NodeTable::new(&mut connection)
                .interaction_scope(occurrence.presenting_interaction_node_id)
                .await
                .map_err(|error| match error {
                    GraphError::Forbidden(_) | GraphError::NotFound(_) => GraphError::validation(
                        "input_occurrence_not_accepted",
                        "attachments[0].presentingInteractionNodeId",
                        "Reopen an action from accepted history.",
                    ),
                    other => other,
                })?
        };
        let visible = match destination_project_id {
            Some(project_id) => scope.project_id == Some(project_id),
            None => scope.project_id.is_none() && scope.thread_id == destination_thread_id,
        };
        if !visible {
            return Err(GraphError::validation(
                "input_occurrence_not_visible",
                "attachments[0]",
                "Remove an occurrence unavailable to this destination graph scope.",
            ));
        }
        let mut connection = self.storage.acquire().await?;
        ActionTable::new(&mut connection)
            .canonical_input_occurrence(&scope, occurrence, false)
            .await
            .map_err(first_attachment_error)
    }

    pub async fn close(&self) {
        self.storage.close().await;
    }
}

pub(crate) async fn initialize_completion(
    connection: &mut crate::storage::GraphConnection,
    node: &GraphNode,
    project_id: Option<ProjectId>,
    thread_id: ThreadId,
) -> Result<(), GraphError> {
    let scope = InteractionScope {
        project_id,
        thread_id,
        root_node_id: node.id,
        read_only: false,
        authority_epoch: None,
    };
    initialize_completion_scope(connection, &scope).await
}

async fn initialize_completion_scope(
    connection: &mut crate::storage::GraphConnection,
    scope: &InteractionScope,
) -> Result<(), GraphError> {
    let (entitlement, digest) = scope.read_entitlement();
    CurrentTable::new(connection)
        .initialize(scope.root_node_id, !scope.read_only, &entitlement, &digest)
        .await
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

fn first_attachment_error(error: GraphError) -> GraphError {
    match error {
        GraphError::Validation {
            code,
            path,
            message,
        } => {
            let suffix = path.strip_prefix("occurrence").unwrap_or(&path);
            GraphError::validation(code, format!("attachments[0]{suffix}"), message)
        }
        GraphError::ValidationIssues { message, issues } => GraphError::ValidationIssues {
            message,
            issues: issues
                .into_iter()
                .map(|issue| {
                    let suffix = issue.path.strip_prefix("occurrence").unwrap_or(&issue.path);
                    crate::ValidationIssue {
                        code: issue.code,
                        path: format!("attachments[0]{suffix}"),
                        message: issue.message,
                    }
                })
                .collect(),
        },
        other => other,
    }
}
