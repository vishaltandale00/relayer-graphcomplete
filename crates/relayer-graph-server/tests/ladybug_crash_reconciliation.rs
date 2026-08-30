//! Real-process proof for the irreducible Ladybug-first crash window.

#![cfg(all(
    feature = "ladybug",
    feature = "crash-test-support",
    target_os = "macos",
    target_arch = "aarch64"
))]

use std::{
    fs::File,
    os::unix::process::ExitStatusExt,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};

use relayer_graph_core::{
    ActionDraft, ActionKind, EdgeDraft, GraphDatabase, LayerDraft, LayerLayout, NavigateRelation,
    NodeDraft, NodeId, NodePlacement, SearchIndex, SearchIndexRevision, SearchTarget, ThreadId,
};
use relayer_graph_server::search_index::LadybugSearchIndex;
use serde_json::json;

const CHILD_MODE: &str = "RELAYER_TEST_LADYBUG_CRASH_CHILD";
const DATABASE_PATH: &str = "RELAYER_TEST_LADYBUG_CRASH_DATABASE";
const MARKER_PATH: &str = "RELAYER_TEST_LADYBUG_CRASH_MARKER";
const INTERACTION_ID: &str = "RELAYER_TEST_LADYBUG_CRASH_INTERACTION";

async fn author(database: &GraphDatabase) -> NodeId {
    let interaction = database
        .create_interaction(None, ThreadId::new(41).unwrap(), "Explain the queue")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let queue = writer
        .submit_node(&NodeDraft {
            client_key: "queue".into(),
            kind: "concept".into(),
            icon: "list-tree".into(),
            title: "Queue".into(),
            detail: "Pending work".into(),
        })
        .await
        .unwrap();
    let worker = writer
        .submit_node(&NodeDraft {
            client_key: "worker".into(),
            kind: "concept".into(),
            icon: "cpu".into(),
            title: "Worker".into(),
            detail: "Claims work".into(),
        })
        .await
        .unwrap();
    let edge = writer
        .create_edge(&EdgeDraft {
            client_key: "queue-worker".into(),
            endpoints: [queue.id, worker.id],
        })
        .await
        .unwrap();
    let child = writer
        .submit_layer(&LayerDraft {
            client_key: "child".into(),
            nodes: vec![worker.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(vec![NodePlacement {
                node_id: worker.id,
                x: 0.5,
                y: 0.5,
            }])),
            size_justification: None,
        })
        .await
        .unwrap();
    let reference_child = writer
        .submit_layer(&LayerDraft {
            client_key: "reference-child".into(),
            nodes: vec![queue.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(vec![NodePlacement {
                node_id: queue.id,
                x: 0.5,
                y: 0.5,
            }])),
            size_justification: None,
        })
        .await
        .unwrap();
    let root = writer
        .submit_layer(&LayerDraft {
            client_key: "root".into(),
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
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "details".into(),
            source_node_id: worker.id,
            source_layer_id: Some(root.id),
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Details".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(reference_child.id),
            interaction_text: None,
        })
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "reference-details".into(),
            source_node_id: queue.id,
            source_layer_id: Some(root.id),
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Reference),
            label: "Reference details".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(child.id),
            interaction_text: None,
        })
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "response".into(),
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
        .await
        .unwrap();
    interaction.id
}

fn required_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).expect("child path environment"))
}

#[tokio::test]
async fn real_kill_child() {
    if std::env::var_os(CHILD_MODE).is_none() {
        return;
    }
    let database_path = required_path(DATABASE_PATH);
    let marker_path = required_path(MARKER_PATH);
    let interaction = NodeId::new(
        std::env::var(INTERACTION_ID)
            .expect("interaction environment")
            .parse()
            .expect("interaction integer"),
    )
    .expect("positive interaction");
    let index = Arc::new(
        LadybugSearchIndex::open(&database_path)
            .unwrap()
            .with_post_commit_crash_hook(Arc::new(move || {
                File::create(&marker_path)
                    .and_then(|file| file.sync_all())
                    .expect("publish durable crash marker");
                loop {
                    std::thread::park();
                }
            })),
    );
    let database = GraphDatabase::open_with_index(&database_path, index)
        .await
        .unwrap();
    database
        .writer_for_subgraph(interaction)
        .await
        .unwrap()
        .complete(interaction)
        .await
        .expect("parent kills this process before completion returns");
}

async fn wait_for_marker(path: &Path, child: &mut std::process::Child) {
    let expiry = Instant::now() + Duration::from_secs(15);
    while Instant::now() < expiry {
        if path.exists() {
            return;
        }
        if let Some(status) = child.try_wait().expect("poll child") {
            panic!("crash child exited before its marker: {status}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let _ = child.kill();
    let _ = child.wait();
    panic!("crash child did not reach the Ladybug commit boundary");
}

async fn assert_complete_topology(index: &LadybugSearchIndex) {
    for (query, expected) in [
        ("MATCH (n:Content) RETURN count(n) AS count", "3"),
        ("MATCH (l:Layer) RETURN count(l) AS count", "3"),
        ("MATCH ()-[r:CONNECTED]->() RETURN count(r) AS count", "1"),
        ("MATCH ()-[r:CONTAINS]->() RETURN count(r) AS count", "4"),
        ("MATCH ()-[r:EXPANDS]->() RETURN count(r) AS count", "2"),
        ("MATCH ()-[r:REFERENCES]->() RETURN count(r) AS count", "1"),
    ] {
        assert_eq!(
            index.normalized_rows(query).await.unwrap(),
            vec![vec![json!({"type": "integer", "value": expected})]],
            "crash recovery lost or duplicated topology for {query}"
        );
    }
}

#[tokio::test]
async fn sigkill_after_ladybug_commit_leaves_a_detectable_orphan_and_retry_converges() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("graph.db");
    let marker_path = directory.path().join("ladybug-committed.marker");
    let interaction = {
        let index = Arc::new(LadybugSearchIndex::open(&database_path).unwrap());
        let database = GraphDatabase::open_with_index(&database_path, index)
            .await
            .unwrap();
        author(&database).await
    };

    let executable = std::env::current_exe().unwrap();
    let mut child = Command::new(executable)
        .args(["--exact", "real_kill_child", "--nocapture"])
        .env(CHILD_MODE, "1")
        .env(DATABASE_PATH, &database_path)
        .env(MARKER_PATH, &marker_path)
        .env(INTERACTION_ID, interaction.value().to_string())
        .spawn()
        .unwrap();
    wait_for_marker(&marker_path, &mut child).await;
    child.kill().expect("send SIGKILL");
    let status = child.wait().expect("reap crash child");
    assert_eq!(
        status.signal(),
        Some(9),
        "Child::kill must be a real SIGKILL"
    );

    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let sqlite_only = GraphDatabase::open(&database_path).await.unwrap();
    assert!(
        sqlite_only
            .accepted_graph_closure(interaction)
            .await
            .unwrap()
            .is_none(),
        "SQLite must not expose an uncommitted closure"
    );
    assert_eq!(
        sqlite_only.search_index_revision(target).await.unwrap(),
        None
    );
    drop(sqlite_only);

    // Depending on exactly which post-COMMIT WAL state the SIGKILL preserved,
    // the selected generation is either unopenable or observably ahead. Both
    // are damage signatures; neither is allowed to become a stale success.
    if let Ok(orphaned) = LadybugSearchIndex::open(&database_path) {
        assert_eq!(
            orphaned.revision(target).await.unwrap(),
            Some(SearchIndexRevision::FIRST)
        );
        assert_complete_topology(&orphaned).await;
    }

    let sqlite_only = GraphDatabase::open(&database_path).await.unwrap();
    let index = Arc::new(
        LadybugSearchIndex::open_reconciled(&database_path, &sqlite_only)
            .await
            .unwrap(),
    );
    assert_eq!(index.revision(target).await.unwrap(), None);
    assert!(
        index
            .layout()
            .quarantine()
            .read_dir()
            .unwrap()
            .next()
            .is_some(),
        "the damaged or ahead generation must be quarantined"
    );
    let database = sqlite_only.with_search_index(index.clone());
    database
        .writer_for_subgraph(interaction)
        .await
        .unwrap()
        .complete(interaction)
        .await
        .unwrap();
    assert!(
        database
            .accepted_graph_closure(interaction)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        database.search_index_revision(target).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
    assert_eq!(
        index.revision(target).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
    assert_complete_topology(&index).await;
}
