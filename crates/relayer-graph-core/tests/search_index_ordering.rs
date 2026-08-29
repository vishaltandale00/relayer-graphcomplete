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

use relayer_graph_core::{
    AcceptedGraphClosure, ActionDraft, ActionKind, EdgeDraft, GraphDatabase, GraphError,
    ImportedAcceptedView, ImportedAction, ImportedConversation, ImportedLayer, ImportedLayerLayout,
    ImportedNode, ImportedNodePlacement, ImportedResolvedLayer, ImportedTurn, LayerDraft,
    LayerLayout, NavigateRelation, NodeDraft, NodePlacement, ProjectId, SearchIndex,
    SearchIndexFuture, SearchIndexRevision, SearchIndexWrite, SearchTarget, ThreadId,
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
    /// The targets the last applied closure was published to.
    published: Vec<SearchTarget>,
}

#[derive(Clone)]
struct Double {
    behaviour: Behaviour,
    recorded: Arc<std::sync::Mutex<Recorded>>,
}

impl Double {
    fn new(behaviour: Behaviour) -> Self {
        Self {
            behaviour,
            recorded: Arc::new(std::sync::Mutex::new(Recorded::default())),
        }
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
            if index.behaviour == Behaviour::FailOnBegin {
                return Err(GraphError::Internal(
                    "the search store is unwritable".into(),
                ));
            }
            Ok(Box::new(DoubleWrite {
                index,
                target,
                revision,
                layers: 0,
            }) as Box<dyn SearchIndexWrite>)
        })
    }
}

struct DoubleWrite {
    index: Double,
    target: SearchTarget,
    revision: SearchIndexRevision,
    layers: usize,
}

impl SearchIndexWrite for DoubleWrite {
    fn apply(
        &mut self,
        closure: AcceptedGraphClosure,
        published_to: Vec<SearchTarget>,
    ) -> SearchIndexFuture<()> {
        let behaviour = self.index.behaviour;
        self.layers = closure.layers.len();
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

    fn commit(self: Box<Self>) -> SearchIndexFuture<SearchIndexRevision> {
        Box::pin(async move {
            self.index.recorded.lock().unwrap().committed.push((
                self.target,
                self.revision,
                self.layers,
            ));
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
        })
        .await?;
    writer.complete(interaction.id).await?;
    Ok(())
}

async fn database(index: Double) -> GraphDatabase {
    GraphDatabase::in_memory_with_index(Arc::new(index))
        .await
        .unwrap()
        .with_search_index_budget(Duration::from_millis(200))
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
            accepted_view: Some(ImportedAcceptedView {
                interaction_node_id: "interaction-1".into(),
                root_action: ImportedAction {
                    id: "action-1".into(),
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
                },
                root_layer_id: "layer-1".into(),
                layers: vec![ImportedResolvedLayer {
                    layer: ImportedLayer {
                        id: "layer-1".into(),
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
                        kind: "concept".into(),
                        icon: "box".into(),
                        title: "Imported queue".into(),
                        detail: "A queue".into(),
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
