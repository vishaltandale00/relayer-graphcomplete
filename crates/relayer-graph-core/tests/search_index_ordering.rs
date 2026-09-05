//! The atomic SQLite-to-search-store write ordering.
//!
//! These use test doubles rather than a real engine: the point is what the
//! ordering does when the store fails, stalls, or succeeds, which has to hold for
//! any implementation of the seam. `relayer-graph-server` proves the same
//! ordering against real Ladybug.

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

#[cfg(feature = "crash-test-support")]
use relayer_graph_core::CompletionCrashPoint;
use relayer_graph_core::{
    AcceptedGraphPublication, ActionDraft, ActionId, ActionKind, CompletionLifecycle,
    CurrentTransition, EdgeDraft, GraphDatabase, GraphError, GraphWriter, ImportedAcceptedView,
    ImportedAction, ImportedConversation, ImportedLayer, ImportedLayerLayout, ImportedNode,
    ImportedNodePlacement, ImportedResolvedLayer, ImportedTurn, InteractionInvocation, LayerDraft,
    LayerId, LayerLayout, NavigateRelation, NodeDraft, NodeId, NodePlacement, ProjectId,
    RecordState, SearchIndex, SearchIndexFuture, SearchIndexRevision, SearchIndexWrite,
    SearchTarget, ThreadId,
};

/// What the double should do when a write reaches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Behaviour {
    Commit,
    FailOnBegin,
    FailOnApply,
    StallOnApply,
}

#[derive(Default)]
struct Recorded {
    committed: Vec<(SearchTarget, SearchIndexRevision, usize)>,
    rollbacks: AtomicUsize,
    /// What the store itself holds per target, as distinct from what SQLite
    /// recorded. Seeding this simulates a write interrupted after the store
    /// committed and before SQLite did.
    stored: std::collections::HashMap<SearchTarget, SearchIndexRevision>,
    pending: std::collections::HashMap<SearchTarget, String>,
    /// The targets the last applied closure was published to.
    published: Vec<SearchTarget>,
    root_actions: Vec<bool>,
}

#[derive(Clone)]
struct Double {
    behaviour: Arc<std::sync::Mutex<Behaviour>>,
    recorded: Arc<std::sync::Mutex<Recorded>>,
}

impl Double {
    fn new(behaviour: Behaviour) -> Self {
        Self {
            behaviour: Arc::new(std::sync::Mutex::new(behaviour)),
            recorded: Arc::new(std::sync::Mutex::new(Recorded::default())),
        }
    }

    fn set_behaviour(&self, behaviour: Behaviour) {
        *self.behaviour.lock().unwrap() = behaviour;
    }

    fn committed(&self) -> Vec<(SearchTarget, SearchIndexRevision, usize)> {
        self.recorded.lock().unwrap().committed.clone()
    }

    /// Pretend the store already committed `revision` for `target` while SQLite
    /// recorded nothing — the orphan the irreducible window leaves behind.
    fn seed_stored(&self, target: SearchTarget, revision: SearchIndexRevision) {
        self.recorded
            .lock()
            .unwrap()
            .stored
            .insert(target, revision);
    }

    fn seed_pending(&self, target: SearchTarget, identity: &str) {
        self.recorded
            .lock()
            .unwrap()
            .pending
            .insert(target, identity.to_owned());
    }

    fn pending(&self, target: SearchTarget) -> Option<String> {
        self.recorded.lock().unwrap().pending.get(&target).cloned()
    }

    fn published(&self) -> Vec<SearchTarget> {
        self.recorded.lock().unwrap().published.clone()
    }

    fn rollbacks(&self) -> usize {
        self.recorded
            .lock()
            .unwrap()
            .rollbacks
            .load(Ordering::SeqCst)
    }

    fn root_actions(&self) -> Vec<bool> {
        self.recorded.lock().unwrap().root_actions.clone()
    }
}

impl SearchIndex for Double {
    fn revision(&self, target: SearchTarget) -> SearchIndexFuture<Option<SearchIndexRevision>> {
        let index = self.clone();
        Box::pin(async move { Ok(index.recorded.lock().unwrap().stored.get(&target).copied()) })
    }

    fn begin(
        &self,
        target: SearchTarget,
        revision: SearchIndexRevision,
    ) -> SearchIndexFuture<Box<dyn SearchIndexWrite>> {
        let index = self.clone();
        Box::pin(async move {
            if *index.behaviour.lock().unwrap() == Behaviour::FailOnBegin {
                return Err(GraphError::Internal(
                    "the search store is unwritable".into(),
                ));
            }
            Ok(Box::new(DoubleWrite {
                index,
                target,
                revision,
                layers: 0,
                has_root_action: false,
            }) as Box<dyn SearchIndexWrite>)
        })
    }

    fn canonical_commit_unknown(
        &self,
        target: SearchTarget,
        publication_identity: &str,
    ) -> Result<(), GraphError> {
        let mut recorded = self.recorded.lock().unwrap();
        if let Some(pending) = recorded.pending.get(&target) {
            return if pending == publication_identity {
                Ok(())
            } else {
                Err(GraphError::Internal(
                    "search target is awaiting canonical reconciliation".into(),
                ))
            };
        }
        recorded
            .pending
            .insert(target, publication_identity.to_owned());
        Ok(())
    }

    fn canonical_commit_is_unknown(&self, target: SearchTarget) -> bool {
        self.recorded.lock().unwrap().pending.contains_key(&target)
    }

    fn canonical_commit_confirmed(&self, target: SearchTarget) {
        self.recorded.lock().unwrap().pending.remove(&target);
    }
}

struct DoubleWrite {
    index: Double,
    target: SearchTarget,
    revision: SearchIndexRevision,
    layers: usize,
    has_root_action: bool,
}

impl SearchIndexWrite for DoubleWrite {
    fn apply(
        &mut self,
        closure: AcceptedGraphPublication,
        published_to: Vec<SearchTarget>,
    ) -> SearchIndexFuture<()> {
        let behaviour = *self.index.behaviour.lock().unwrap();
        self.layers = closure.layers.len();
        self.has_root_action = closure.root_action.is_some();
        self.index.recorded.lock().unwrap().published = published_to;
        Box::pin(async move {
            match behaviour {
                Behaviour::FailOnApply => Err(GraphError::Internal(
                    "the search store rejected the closure".into(),
                )),
                Behaviour::StallOnApply => {
                    // Longer than any budget these tests set, so the deadline is
                    // what ends the write.
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    Ok(())
                }
                Behaviour::Commit | Behaviour::FailOnBegin => Ok(()),
            }
        })
    }

    fn remove(&mut self, closure: AcceptedGraphPublication) -> SearchIndexFuture<()> {
        let behaviour = *self.index.behaviour.lock().unwrap();
        self.layers = closure.layers.len();
        self.has_root_action = closure.root_action.is_some();
        Box::pin(async move {
            match behaviour {
                Behaviour::FailOnApply => Err(GraphError::Internal(
                    "the search store rejected the closure removal".into(),
                )),
                Behaviour::StallOnApply => {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    Ok(())
                }
                Behaviour::Commit | Behaviour::FailOnBegin => Ok(()),
            }
        })
    }

    fn commit(self: Box<Self>) -> SearchIndexFuture<SearchIndexRevision> {
        Box::pin(async move {
            let mut recorded = self.index.recorded.lock().unwrap();
            recorded
                .committed
                .push((self.target, self.revision, self.layers));
            recorded.root_actions.push(self.has_root_action);
            recorded.stored.insert(self.target, self.revision);
            Ok(self.revision)
        })
    }

    fn rollback(self: Box<Self>) -> SearchIndexFuture<()> {
        Box::pin(async move {
            self.index
                .recorded
                .lock()
                .unwrap()
                .rollbacks
                .fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
}

/// Accept a small closure through the ordinary path and return whether it
/// succeeded, leaving the database open for inspection.
async fn submit(
    database: &GraphDatabase,
    project: Option<ProjectId>,
    thread: i64,
    key: &str,
) -> Result<(), GraphError> {
    let (interaction, writer) = author(database, project, thread, key).await?;
    writer.complete(interaction).await?;
    Ok(())
}

async fn author(
    database: &GraphDatabase,
    project: Option<ProjectId>,
    thread: i64,
    key: &str,
) -> Result<(NodeId, GraphWriter), GraphError> {
    let interaction = database
        .create_interaction(project, ThreadId::new(thread).unwrap(), "Explain the queue")
        .await?;
    let writer = database.writer_for_subgraph(interaction.id).await?;
    let queue = writer
        .submit_node(&NodeDraft {
            client_key: format!("{key}-queue"),
            kind: "concept".into(),
            icon: "list-tree".into(),
            title: "Queue".into(),
            detail: "Pending work".into(),
        })
        .await?;
    let worker = writer
        .submit_node(&NodeDraft {
            client_key: format!("{key}-worker"),
            kind: "concept".into(),
            icon: "cpu".into(),
            title: "Worker".into(),
            detail: "Claims work".into(),
        })
        .await?;
    let edge = writer
        .create_edge(&EdgeDraft {
            client_key: format!("{key}-edge"),
            endpoints: [queue.id, worker.id],
        })
        .await?;
    let root = writer
        .submit_layer(&LayerDraft {
            client_key: format!("{key}-root"),
            nodes: vec![queue.id, worker.id],
            edges: vec![edge.id],
            layout: Some(LayerLayout::v1(vec![
                NodePlacement {
                    node_id: queue.id,
                    x: 0.2,
                    y: 0.5,
                },
                NodePlacement {
                    node_id: worker.id,
                    x: 0.8,
                    y: 0.5,
                },
            ])),
            size_justification: None,
        })
        .await?;
    writer
        .add_action(&ActionDraft {
            client_key: format!("{key}-response"),
            source_node_id: interaction.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(root.id),
            interaction_text: None,
            input: None,
        })
        .await?;
    Ok((interaction.id, writer))
}

async fn author_current(
    database: &GraphDatabase,
    thread: i64,
    key: &str,
) -> Result<(NodeId, GraphWriter, LayerId), GraphError> {
    let interaction = database
        .create_interaction(
            None,
            ThreadId::new(thread).unwrap(),
            "Publish useful progress",
        )
        .await?;
    let writer = database.writer_for_subgraph(interaction.id).await?;
    let progress = writer
        .submit_node(&NodeDraft {
            client_key: format!("{key}-progress"),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Useful progress".into(),
            detail: "Accepted before terminal return".into(),
        })
        .await?;
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: format!("{key}-current"),
            nodes: vec![progress.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(vec![NodePlacement {
                node_id: progress.id,
                x: 0.5,
                y: 0.5,
            }])),
            size_justification: None,
        })
        .await?;
    Ok((interaction.id, writer, layer.id))
}

struct LeasedReturnFixture {
    source_interaction: NodeId,
    invoke_action: ActionId,
    #[cfg(feature = "crash-test-support")]
    child_interaction: NodeId,
    child_writer: GraphWriter,
    child_layer: LayerId,
}

async fn author_leased_return(
    database: &GraphDatabase,
    thread: i64,
    key: &str,
) -> LeasedReturnFixture {
    let thread_id = ThreadId::new(thread).unwrap();
    let source = database
        .create_interaction(None, thread_id, "Delegate one result")
        .await
        .unwrap();
    let source_writer = database.writer_for_subgraph(source.id).await.unwrap();
    let task = source_writer
        .submit_node(&NodeDraft {
            client_key: format!("{key}-task"),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Delegated task".into(),
            detail: "Waits for the child result".into(),
        })
        .await
        .unwrap();
    let source_layer = source_writer
        .submit_layer(&LayerDraft {
            client_key: format!("{key}-source-layer"),
            nodes: vec![task.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(vec![NodePlacement {
                node_id: task.id,
                x: 0.5,
                y: 0.5,
            }])),
            size_justification: None,
        })
        .await
        .unwrap();
    let invoke = source_writer
        .add_action(&ActionDraft {
            client_key: format!("{key}-invoke"),
            source_node_id: task.id,
            source_layer_id: Some(source_layer.id),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Produce result".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Produce the delegated result".into()),
            input: None,
        })
        .await
        .unwrap();
    source_writer
        .add_action(&ActionDraft {
            client_key: format!("{key}-source-response"),
            source_node_id: source.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(source_layer.id),
            interaction_text: None,
            input: None,
        })
        .await
        .unwrap();
    source_writer.complete(source.id).await.unwrap();

    let child = database
        .create_interaction_with_invocation(
            None,
            thread_id,
            "Delegated result",
            Some(InteractionInvocation {
                source_interaction_node_id: source.id,
                source_action_id: invoke.id,
            }),
        )
        .await
        .unwrap();
    let child_writer = database.writer_for_subgraph(child.id).await.unwrap();
    let answer = child_writer
        .submit_node(&NodeDraft {
            client_key: format!("{key}-answer"),
            kind: "concept".into(),
            icon: "check-circle".into(),
            title: "Delegated result".into(),
            detail: "Ready to return".into(),
        })
        .await
        .unwrap();
    let child_layer = child_writer
        .submit_layer(&LayerDraft {
            client_key: format!("{key}-child-layer"),
            nodes: vec![answer.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(vec![NodePlacement {
                node_id: answer.id,
                x: 0.5,
                y: 0.5,
            }])),
            size_justification: None,
        })
        .await
        .unwrap();
    child_writer
        .transition_current(
            0,
            &format!("{key}-advance"),
            CurrentTransition::Advance {
                layer_id: child_layer.id,
            },
        )
        .await
        .unwrap();
    child_writer
        .add_action(&ActionDraft {
            client_key: format!("{key}-child-response"),
            source_node_id: child.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(child_layer.id),
            interaction_text: None,
            input: None,
        })
        .await
        .unwrap();

    LeasedReturnFixture {
        source_interaction: source.id,
        invoke_action: invoke.id,
        #[cfg(feature = "crash-test-support")]
        child_interaction: child.id,
        child_writer,
        child_layer: child_layer.id,
    }
}

async fn resolved_invoke_target(
    database: &GraphDatabase,
    source_interaction: NodeId,
    invoke_action: ActionId,
) -> Option<LayerId> {
    database
        .writer_for_subgraph(source_interaction)
        .await
        .unwrap()
        .completion_output()
        .await
        .unwrap()
        .unwrap()
        .root_layer
        .actions
        .iter()
        .find(|action| action.id == invoke_action)
        .unwrap()
        .target_layer_id
}

async fn database(index: Double) -> GraphDatabase {
    GraphDatabase::in_memory_with_index(Arc::new(index))
        .await
        .unwrap()
        .with_search_index_budget(Duration::from_millis(200))
}

#[tokio::test]
async fn advance_failure_rolls_back_current_acceptance_and_retry_receipt() {
    let index = Double::new(Behaviour::FailOnApply);
    let database = database(index.clone()).await;
    let target = SearchTarget::Thread(ThreadId::new(11).unwrap());
    let (_, writer, layer_id) = author_current(&database, 11, "failed-advance")
        .await
        .unwrap();

    let refused = writer
        .transition_current(
            0,
            "advance-working-current",
            CurrentTransition::Advance { layer_id },
        )
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("rejected the closure"));
    let current = writer.current_completion().await.unwrap();
    assert_eq!(current.head_revision, 0);
    assert_eq!(current.current_layer_id, None);
    assert_eq!(
        writer.get_layer(layer_id).await.unwrap().layer.state,
        RecordState::Draft
    );
    assert_eq!(database.search_index_revision(target).await.unwrap(), None);
    assert_eq!(index.committed(), vec![]);
    assert_eq!(index.rollbacks(), 1);
}

#[tokio::test]
async fn exact_advance_retry_does_not_reindex_and_stop_or_fail_publish_nothing() {
    for terminal in ["stop", "fail"] {
        let index = Double::new(Behaviour::Commit);
        let database = database(index.clone()).await;
        let (_, writer, layer_id) = author_current(&database, 12, terminal).await.unwrap();
        let first = writer
            .transition_current(
                0,
                "advance-working-current",
                CurrentTransition::Advance { layer_id },
            )
            .await
            .unwrap();
        let replay = writer
            .transition_current(
                0,
                "advance-working-current",
                CurrentTransition::Advance { layer_id },
            )
            .await
            .unwrap();
        assert_eq!(replay, first);
        assert_eq!(index.committed().len(), 1);
        let intent = match terminal {
            "stop" => CurrentTransition::Stop {
                reason: "cancelled_by_user".into(),
            },
            "fail" => CurrentTransition::Fail {
                reason: "provider_crashed".into(),
            },
            _ => unreachable!(),
        };
        writer
            .transition_current(1, &format!("{terminal}-working-current"), intent)
            .await
            .unwrap();
        assert_eq!(
            index.committed().len(),
            1,
            "{terminal} reindexed the current"
        );
        assert_eq!(index.root_actions(), vec![false]);
    }
}

#[tokio::test]
async fn legacy_submit_replay_clears_only_a_matching_ambiguous_canonical_commit() {
    let index = Double::new(Behaviour::Commit);
    let database = database(index.clone()).await;
    let target = SearchTarget::Thread(ThreadId::new(18).unwrap());
    let (interaction, writer) = author(&database, None, 18, "legacy-ambiguous")
        .await
        .unwrap();
    let first = writer.complete(interaction).await.unwrap();

    // Model the only state an ambiguous SQLite COMMIT may leave: both stores
    // hold the same revision, but this process has not confirmed the canonical
    // side and must fail search closed until an exact replay proves it.
    index.seed_pending(target, "ambiguous-commit");
    assert!(index.pending(target).is_some());
    let replay = database
        .writer_for_subgraph(interaction)
        .await
        .unwrap()
        .complete(interaction)
        .await
        .unwrap();

    assert_eq!(replay, first);
    assert_eq!(index.pending(target), None);
    assert_eq!(index.committed().len(), 1, "receipt replay reindexed");
}

#[tokio::test]
async fn return_after_advance_adds_the_terminal_root_action_once() {
    let index = Double::new(Behaviour::Commit);
    let database = database(index.clone()).await;
    let (interaction, writer, layer_id) = author_current(&database, 13, "return").await.unwrap();
    writer
        .transition_current(
            0,
            "advance-working-current",
            CurrentTransition::Advance { layer_id },
        )
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "return-response".into(),
            source_node_id: interaction,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(layer_id),
            interaction_text: None,
            input: None,
        })
        .await
        .unwrap();
    writer
        .transition_current(
            1,
            "return-working-current",
            CurrentTransition::Return { layer_id },
        )
        .await
        .unwrap();

    assert_eq!(index.root_actions(), vec![false, true]);
    assert_eq!(index.committed().len(), 2);
}

#[tokio::test]
async fn leased_return_index_failure_rolls_back_child_completion_and_parent_resolution() {
    let index = Double::new(Behaviour::Commit);
    let database = database(index.clone()).await;
    let fixture = author_leased_return(&database, 14, "leased-failure").await;
    let commits_before_return = index.committed().len();
    assert_eq!(commits_before_return, 2);

    index.set_behaviour(Behaviour::FailOnApply);
    let refused = fixture
        .child_writer
        .transition_current(
            1,
            "leased-return",
            CurrentTransition::Return {
                layer_id: fixture.child_layer,
            },
        )
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("rejected the closure"));

    let retained = fixture.child_writer.current_completion().await.unwrap();
    assert_eq!(retained.lifecycle, CompletionLifecycle::Active);
    assert_eq!(retained.head_revision, 1);
    assert_eq!(retained.current_layer_id, Some(fixture.child_layer));
    assert_eq!(
        fixture.child_writer.completion_output().await.unwrap(),
        None
    );
    assert_eq!(
        resolved_invoke_target(&database, fixture.source_interaction, fixture.invoke_action,).await,
        None
    );
    assert_eq!(index.committed().len(), commits_before_return);
    assert_eq!(index.rollbacks(), 1);

    index.set_behaviour(Behaviour::Commit);
    let returned = fixture
        .child_writer
        .transition_current(
            1,
            "leased-return",
            CurrentTransition::Return {
                layer_id: fixture.child_layer,
            },
        )
        .await
        .unwrap();
    assert_eq!(returned.lifecycle, CompletionLifecycle::Succeeded);
    assert_eq!(
        resolved_invoke_target(&database, fixture.source_interaction, fixture.invoke_action,).await,
        Some(fixture.child_layer)
    );
    let commits_after_return = index.committed().len();
    assert_eq!(commits_after_return, commits_before_return + 1);
    let replay = fixture
        .child_writer
        .transition_current(
            1,
            "leased-return",
            CurrentTransition::Return {
                layer_id: fixture.child_layer,
            },
        )
        .await
        .unwrap();
    assert_eq!(replay, returned);
    assert_eq!(index.committed().len(), commits_after_return);
    assert_eq!(index.root_actions(), vec![true, false, true]);
}

#[cfg(feature = "crash-test-support")]
#[tokio::test]
async fn leased_return_retry_converges_after_search_commit_crash_boundaries() {
    use std::sync::atomic::AtomicBool;

    for point in [
        CompletionCrashPoint::AfterSearchCommit,
        CompletionCrashPoint::AfterSqliteRevisionRecord,
    ] {
        let index = Double::new(Behaviour::Commit);
        let database = database(index.clone()).await;
        let fixture = author_leased_return(&database, 15, &format!("leased-{point:?}")).await;
        let commits_before_return = index.committed().len();
        let fired = Arc::new(AtomicBool::new(false));
        let hook_fired = fired.clone();
        let database = database.with_completion_crash_hook(Arc::new(move |observed| {
            if observed == point && !hook_fired.swap(true, Ordering::SeqCst) {
                panic!("injected leased Return crash after {point:?}");
            }
        }));
        let crashed_writer = database
            .writer_for_subgraph(fixture.child_interaction)
            .await
            .unwrap();
        let child_layer = fixture.child_layer;
        let crashed = tokio::spawn(async move {
            crashed_writer
                .transition_current(
                    1,
                    "leased-return-crash",
                    CurrentTransition::Return {
                        layer_id: child_layer,
                    },
                )
                .await
        })
        .await
        .expect_err("the selected Return boundary must panic");
        assert!(crashed.is_panic(), "{point:?} did not model a crash");
        assert!(fired.load(Ordering::SeqCst), "{point:?} was not reached");
        assert_eq!(index.committed().len(), commits_before_return + 1);

        let retry_writer = database
            .writer_for_subgraph(fixture.child_interaction)
            .await
            .unwrap();
        let retained = retry_writer.current_completion().await.unwrap();
        assert_eq!(retained.lifecycle, CompletionLifecycle::Active);
        assert_eq!(retained.head_revision, 1);
        assert_eq!(retained.current_layer_id, Some(fixture.child_layer));
        assert_eq!(retry_writer.completion_output().await.unwrap(), None);
        assert_eq!(
            resolved_invoke_target(&database, fixture.source_interaction, fixture.invoke_action,)
                .await,
            None
        );

        let returned = retry_writer
            .transition_current(
                1,
                "leased-return-crash",
                CurrentTransition::Return {
                    layer_id: fixture.child_layer,
                },
            )
            .await
            .unwrap();
        assert_eq!(returned.lifecycle, CompletionLifecycle::Succeeded);
        assert_eq!(
            resolved_invoke_target(&database, fixture.source_interaction, fixture.invoke_action,)
                .await,
            Some(fixture.child_layer)
        );
        assert_eq!(index.committed().len(), commits_before_return + 2);
        let replay = retry_writer
            .transition_current(
                1,
                "leased-return-crash",
                CurrentTransition::Return {
                    layer_id: fixture.child_layer,
                },
            )
            .await
            .unwrap();
        assert_eq!(replay, returned);
        assert_eq!(index.committed().len(), commits_before_return + 2);
    }
}

#[cfg(feature = "crash-test-support")]
#[tokio::test]
async fn advance_retry_converges_after_search_commit_crash_boundaries() {
    use std::sync::atomic::AtomicBool;

    for point in [
        CompletionCrashPoint::AfterSearchCommit,
        CompletionCrashPoint::AfterSqliteRevisionRecord,
    ] {
        let index = Double::new(Behaviour::Commit);
        let database = database(index.clone()).await;
        let (interaction, _, layer_id) =
            author_current(&database, 16, &format!("advance-{point:?}"))
                .await
                .unwrap();
        let fired = Arc::new(AtomicBool::new(false));
        let hook_fired = fired.clone();
        let database = database.with_completion_crash_hook(Arc::new(move |observed| {
            if observed == point && !hook_fired.swap(true, Ordering::SeqCst) {
                panic!("injected Advance crash after {point:?}");
            }
        }));
        let crashed_writer = database.writer_for_subgraph(interaction).await.unwrap();
        let crashed = tokio::spawn(async move {
            crashed_writer
                .transition_current(0, "advance-crash", CurrentTransition::Advance { layer_id })
                .await
        })
        .await
        .expect_err("the selected Advance boundary must panic");
        assert!(crashed.is_panic(), "{point:?} did not model a crash");
        assert!(fired.load(Ordering::SeqCst), "{point:?} was not reached");
        assert_eq!(index.committed().len(), 1);

        let retry_writer = database.writer_for_subgraph(interaction).await.unwrap();
        let retained = retry_writer.current_completion().await.unwrap();
        assert_eq!(retained.lifecycle, CompletionLifecycle::Active);
        assert_eq!(retained.head_revision, 0);
        assert_eq!(retained.current_layer_id, None);
        assert_eq!(
            retry_writer.get_layer(layer_id).await.unwrap().layer.state,
            RecordState::Draft
        );

        let advanced = retry_writer
            .transition_current(0, "advance-crash", CurrentTransition::Advance { layer_id })
            .await
            .unwrap();
        assert_eq!(advanced.lifecycle, CompletionLifecycle::Active);
        assert_eq!(advanced.current_layer_id, Some(layer_id));
        assert_eq!(index.committed().len(), 2);
        assert_eq!(
            database
                .search_index_revision(SearchTarget::Thread(ThreadId::new(16).unwrap()))
                .await
                .unwrap(),
            Some(SearchIndexRevision::FIRST.next())
        );
        let replay = retry_writer
            .transition_current(0, "advance-crash", CurrentTransition::Advance { layer_id })
            .await
            .unwrap();
        assert_eq!(replay, advanced);
        assert_eq!(index.committed().len(), 2);
    }
}

#[cfg(feature = "crash-test-support")]
#[tokio::test]
async fn exact_retry_converges_after_every_completion_crash_boundary() {
    use std::sync::atomic::AtomicBool;

    for point in [
        CompletionCrashPoint::AfterSqliteClosureWrite,
        CompletionCrashPoint::AfterSearchClosureWrite,
        CompletionCrashPoint::AfterSearchCommit,
        CompletionCrashPoint::AfterSqliteRevisionRecord,
        CompletionCrashPoint::AfterSqliteCommit,
        CompletionCrashPoint::AfterResponsePrepared,
    ] {
        let index = Double::new(Behaviour::Commit);
        let fired = Arc::new(AtomicBool::new(false));
        let hook_fired = fired.clone();
        let database = database(index.clone())
            .await
            .with_completion_crash_hook(Arc::new(move |observed| {
                if observed == point && !hook_fired.swap(true, Ordering::SeqCst) {
                    panic!("injected crash after {point:?}");
                }
            }));
        let (interaction, writer) = author(&database, None, 1, "crash").await.unwrap();

        let crashed = tokio::spawn(async move { writer.complete(interaction).await })
            .await
            .expect_err("the selected boundary must panic");
        assert!(crashed.is_panic(), "{point:?} did not model a crash");
        assert!(fired.load(Ordering::SeqCst), "{point:?} was not reached");

        let target = SearchTarget::Thread(ThreadId::new(1).unwrap());
        let commits_after_crash = index.committed().len();
        let expected_after_crash = match point {
            CompletionCrashPoint::AfterSqliteClosureWrite
            | CompletionCrashPoint::AfterSearchClosureWrite => 0,
            _ => 1,
        };
        assert_eq!(commits_after_crash, expected_after_crash, "{point:?}");

        let first_retry = database.writer_for_subgraph(interaction).await.unwrap();
        let second_retry = database.writer_for_subgraph(interaction).await.unwrap();
        let (first, second) = tokio::join!(
            first_retry.complete(interaction),
            second_retry.complete(interaction)
        );
        assert_eq!(first.unwrap(), second.unwrap(), "{point:?}");

        let expected_revision = match point {
            CompletionCrashPoint::AfterSearchCommit
            | CompletionCrashPoint::AfterSqliteRevisionRecord => SearchIndexRevision::FIRST.next(),
            _ => SearchIndexRevision::FIRST,
        };
        assert_eq!(
            database.search_index_revision(target).await.unwrap(),
            Some(expected_revision),
            "{point:?} did not converge to the correct receipt"
        );
        assert_eq!(
            index.committed().len(),
            usize::from(expected_revision == SearchIndexRevision::FIRST.next()) + 1,
            "{point:?} indexed more than the one required retry"
        );
    }
}

#[tokio::test]
async fn a_save_commits_to_both_stores_and_records_the_exact_revision() {
    let index = Double::new(Behaviour::Commit);
    let database = database(index.clone()).await;
    let target = SearchTarget::Thread(ThreadId::new(1).unwrap());

    submit(&database, None, 1, "first").await.unwrap();

    let committed = index.committed();
    assert_eq!(committed.len(), 1);
    assert_eq!(committed[0].0, target);
    assert_eq!(committed[0].1, SearchIndexRevision::FIRST);
    assert!(committed[0].2 > 0, "the closure reached the index empty");
    // Step 4: the revision the store committed is the one SQLite records.
    assert_eq!(
        database.search_index_revision(target).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
}

#[tokio::test]
async fn a_store_that_cannot_begin_fails_the_write_with_nothing_saved() {
    let index = Double::new(Behaviour::FailOnBegin);
    let database = database(index.clone()).await;
    let target = SearchTarget::Thread(ThreadId::new(1).unwrap());

    let refused = submit(&database, None, 1, "first").await.unwrap_err();
    assert!(refused.to_string().contains("unwritable"), "{refused}");

    // Nothing committed to either store: no revision, and no accepted closure.
    assert_eq!(index.committed(), vec![]);
    assert_eq!(database.search_index_revision(target).await.unwrap(), None);
    assert!(no_accepted_closure(&database).await);
}

#[tokio::test]
async fn a_store_that_rejects_the_closure_rolls_back_both_stores() {
    let index = Double::new(Behaviour::FailOnApply);
    let database = database(index.clone()).await;
    let target = SearchTarget::Thread(ThreadId::new(1).unwrap());

    let refused = submit(&database, None, 1, "first").await.unwrap_err();
    assert!(
        refused.to_string().contains("rejected the closure"),
        "{refused}"
    );

    assert_eq!(index.committed(), vec![]);
    assert_eq!(
        index.rollbacks(),
        1,
        "the search transaction was not released"
    );
    assert_eq!(database.search_index_revision(target).await.unwrap(), None);
    assert!(no_accepted_closure(&database).await);
}

#[tokio::test]
async fn a_write_that_outlives_its_budget_fails_with_no_partial_state() {
    let index = Double::new(Behaviour::StallOnApply);
    let database = database(index.clone()).await;
    let target = SearchTarget::Thread(ThreadId::new(1).unwrap());

    let refused = submit(&database, None, 1, "first").await.unwrap_err();
    assert!(
        refused.to_string().contains("did not answer within"),
        "a stalled write did not report a timeout: {refused}"
    );

    // Reporting failure is truthful only because nothing committed. That is why
    // the search store commits before SQLite rather than after.
    assert_eq!(index.committed(), vec![]);
    assert_eq!(database.search_index_revision(target).await.unwrap(), None);
    assert!(no_accepted_closure(&database).await);
}

#[tokio::test]
async fn revisions_advance_per_target_and_targets_do_not_share_a_sequence() {
    let index = Double::new(Behaviour::Commit);
    let database = database(index.clone()).await;
    let project = SearchTarget::Project(ProjectId::new(7).unwrap());
    let standalone = SearchTarget::Thread(ThreadId::new(99).unwrap());

    submit(&database, ProjectId::new(7), 41, "a").await.unwrap();
    submit(&database, ProjectId::new(7), 42, "b").await.unwrap();
    submit(&database, None, 99, "c").await.unwrap();

    // Both project threads index into the one project target, so it advances
    // twice while the standalone thread starts its own sequence at one.
    assert_eq!(
        database.search_index_revision(project).await.unwrap(),
        Some(SearchIndexRevision::FIRST.next())
    );
    assert_eq!(
        database.search_index_revision(standalone).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
    let revisions: Vec<_> = index
        .committed()
        .into_iter()
        .map(|(target, revision, _)| (target, revision))
        .collect();
    assert_eq!(
        revisions,
        vec![
            (project, SearchIndexRevision::FIRST),
            (project, SearchIndexRevision::FIRST.next()),
            (standalone, SearchIndexRevision::FIRST),
        ]
    );
}

#[tokio::test]
async fn a_stuck_target_does_not_stall_an_unrelated_target_indefinitely() {
    let index = Double::new(Behaviour::StallOnApply);
    let database = database(index.clone()).await;

    // The SQLite write lock is global and is held across the search write, so a
    // stuck target does hold it — the bound is that it is released within the
    // budget rather than never. Both writes fail, and neither waits forever.
    let started = std::time::Instant::now();
    let (stuck, unrelated) = tokio::join!(
        submit(&database, None, 1, "stuck"),
        submit(&database, None, 2, "unrelated"),
    );
    assert!(stuck.is_err());
    assert!(unrelated.is_err());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "an unrelated target waited on the stuck one for {:?}",
        started.elapsed()
    );
}

async fn no_accepted_closure(database: &GraphDatabase) -> bool {
    for id in 1..=8 {
        if let Some(node) = relayer_graph_core::NodeId::new(id)
            && database
                .accepted_graph_closure(node)
                .await
                .ok()
                .flatten()
                .is_some()
        {
            return false;
        }
    }
    true
}

#[tokio::test]
async fn a_store_left_ahead_of_sqlite_never_has_its_revision_reused() {
    let index = Double::new(Behaviour::Commit);
    let database = database(index.clone()).await;
    let target = SearchTarget::Thread(ThreadId::new(1).unwrap());

    // A previous save committed revision 1 to the store and then failed before
    // SQLite recorded it, so the store is ahead and SQLite holds nothing.
    index.seed_stored(target, SearchIndexRevision::FIRST);
    assert_eq!(database.search_index_revision(target).await.unwrap(), None);

    submit(&database, None, 1, "next").await.unwrap();

    // Allocating from SQLite alone would hand this closure revision 1 again, so
    // one number would describe two different sets of content. It has to clear
    // both sides.
    let committed = index.committed();
    assert_eq!(committed.len(), 1);
    assert_eq!(
        committed[0].1,
        SearchIndexRevision::FIRST.next(),
        "the orphaned revision was handed out a second time"
    );
    assert_eq!(
        database.search_index_revision(target).await.unwrap(),
        Some(SearchIndexRevision::FIRST.next())
    );
}

fn imported_conversation() -> ImportedConversation {
    ImportedConversation {
        import_id: "import-1".into(),
        source_sha256: "sha256:abc".into(),
        project_id: None,
        thread_id: ThreadId::new(9001).unwrap(),
        created_at: "2026-08-24T00:00:00Z".into(),
        turns: vec![ImportedTurn {
            source_turn_id: "turn-1".into(),
            text: "Explain the queue".into(),
            interaction_node_id: None,
            invoke_origin: None,
            contexts: vec![],
            submitted_inputs: vec![],
            accepted_view: Some(ImportedAcceptedView {
                interaction_node_id: "interaction-1".into(),
                root_action: ImportedAction {
                    id: "action-1".into(),
                    client_key: None,
                    source_node_id: "interaction-1".into(),
                    source_layer_id: None,
                    kind: "navigate".into(),
                    relation: Some("expand".into()),
                    label: "Response".into(),
                    variant: "pill".into(),
                    icon: None,
                    description: None,
                    target_layer_id: Some("layer-1".into()),
                    interaction_text: None,
                    input: None,
                },
                root_layer_id: "layer-1".into(),
                layers: vec![ImportedResolvedLayer {
                    layer: ImportedLayer {
                        id: "layer-1".into(),
                        client_key: None,
                        nodes: vec!["node-1".into()],
                        edges: vec![],
                        layout: Some(ImportedLayerLayout {
                            version: 1,
                            placements: vec![ImportedNodePlacement {
                                node_id: "node-1".into(),
                                x: 0.25,
                                y: 0.75,
                            }],
                        }),
                    },
                    nodes: vec![ImportedNode {
                        id: "node-1".into(),
                        client_key: None,
                        kind: "concept".into(),
                        icon: "box".into(),
                        title: "Imported queue".into(),
                        detail: "A queue".into(),
                        authored_detail: None,
                        authored_detail_omitted: false,
                    }],
                    edges: vec![],
                    actions: vec![],
                }],
            }),
        }],
    }
}

#[tokio::test]
async fn an_imported_conversation_is_indexed_with_the_rest_of_the_import() {
    let index = Double::new(Behaviour::Commit);
    let database = database(index.clone()).await;
    let target = SearchTarget::Thread(ThreadId::new(9001).unwrap());

    database
        .import_accepted_conversation(&imported_conversation())
        .await
        .unwrap();

    // An import is an accept path like any other: its closures reach the store
    // and SQLite records the revision they committed under.
    let committed = index.committed();
    assert_eq!(committed.len(), 1, "the import did not reach the index");
    assert_eq!(committed[0].0, target);
    assert_eq!(committed[0].1, SearchIndexRevision::FIRST);
    assert_eq!(
        database.search_index_revision(target).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
}

#[tokio::test]
async fn an_import_the_store_rejects_leaves_nothing_imported() {
    let index = Double::new(Behaviour::FailOnApply);
    let database = database(index.clone()).await;
    let target = SearchTarget::Thread(ThreadId::new(9001).unwrap());

    let refused = database
        .import_accepted_conversation(&imported_conversation())
        .await
        .unwrap_err();
    assert!(
        refused.to_string().contains("rejected the closure"),
        "{refused}"
    );

    // The whole import rolls back, so the author is never told an unsearchable
    // conversation was imported.
    assert_eq!(index.committed(), vec![]);
    assert_eq!(database.search_index_revision(target).await.unwrap(), None);
    assert!(no_accepted_closure(&database).await);
}

#[tokio::test]
async fn imported_conversation_removal_is_acknowledged_only_after_derived_removal() {
    let index = Double::new(Behaviour::Commit);
    let database = database(index.clone()).await;
    let target = SearchTarget::Thread(ThreadId::new(9001).unwrap());

    database
        .import_accepted_conversation(&imported_conversation())
        .await
        .unwrap();
    index.set_behaviour(Behaviour::FailOnApply);

    let refused = database
        .remove_imported_conversation("import-1")
        .await
        .unwrap_err();
    assert!(
        refused.to_string().contains("rejected the closure removal"),
        "{refused}"
    );
    assert!(
        !no_accepted_closure(&database).await,
        "canonical import was removed before its derived projection"
    );
    assert_eq!(
        database.search_index_revision(target).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
    assert_eq!(index.committed().len(), 1);

    index.set_behaviour(Behaviour::Commit);
    database
        .remove_imported_conversation("import-1")
        .await
        .unwrap();
    assert!(no_accepted_closure(&database).await);
    assert_eq!(
        database.search_index_revision(target).await.unwrap(),
        Some(SearchIndexRevision::FIRST.next())
    );
    assert_eq!(index.committed().len(), 2);
}

#[cfg(feature = "crash-test-support")]
#[tokio::test]
async fn import_retry_with_reallocated_ids_remains_quarantined_until_rebuild() {
    use std::sync::atomic::AtomicBool;

    let index = Double::new(Behaviour::Commit);
    let fired = Arc::new(AtomicBool::new(false));
    let hook_fired = fired.clone();
    let database = database(index.clone())
        .await
        .with_completion_crash_hook(Arc::new(move |point| {
            if point == CompletionCrashPoint::AfterSearchCommit
                && !hook_fired.swap(true, Ordering::SeqCst)
            {
                panic!("store committed before imported SQLite rows");
            }
        }));
    let target = SearchTarget::Thread(ThreadId::new(9001).unwrap());
    let crashing_database = database.clone();
    let import = imported_conversation();
    let crashed = tokio::spawn(async move {
        crashing_database
            .import_accepted_conversation(&import)
            .await
    })
    .await
    .expect_err("import must stop after the derived commit");
    assert!(crashed.is_panic());
    assert!(index.pending(target).is_some());

    // These unrelated committed rows move every global SQLite identity that the
    // retried import will allocate, without changing its portable source.
    let _ = author(&database, None, 9002, "unrelated-id-allocation")
        .await
        .unwrap();
    let error = database
        .finalize_imported_conversation("import-1")
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("awaiting canonical reconciliation"),
        "{error}"
    );
    assert!(index.pending(target).is_some());
    assert_eq!(
        database.search_index_revision(target).await.unwrap(),
        None,
        "failed retry must not acknowledge an index revision"
    );
    assert_eq!(
        index.committed().len(),
        1,
        "quarantined retry reached the store"
    );
}

#[tokio::test]
async fn a_closure_in_a_project_is_published_to_its_project_and_its_thread() {
    let index = Double::new(Behaviour::Commit);
    let database = database(index.clone()).await;

    submit(&database, ProjectId::new(7), 41, "a").await.unwrap();

    // Ordering is against the project, but a thread-scoped search has to find it
    // too. Publishing only the project would let thread 41 see all of project 7;
    // publishing only the thread would hide it from a project-scoped search.
    assert_eq!(
        index.published(),
        vec![
            SearchTarget::Project(ProjectId::new(7).unwrap()),
            SearchTarget::Thread(ThreadId::new(41).unwrap()),
        ]
    );
}

#[tokio::test]
async fn a_standalone_thread_publishes_to_its_thread_alone() {
    let index = Double::new(Behaviour::Commit);
    let database = database(index.clone()).await;

    submit(&database, None, 99, "a").await.unwrap();

    assert_eq!(
        index.published(),
        vec![SearchTarget::Thread(ThreadId::new(99).unwrap())]
    );
}
