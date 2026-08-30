//! Startup reconciliation of the derived Ladybug store from canonical SQLite.

#![cfg(feature = "ladybug")]

use relayer_graph_core::{
    ActionDraft, ActionKind, GraphDatabase, LayerDraft, LayerLayout, NavigateRelation, NodeDraft,
    NodePlacement, SearchIndex, SearchIndexRevision, SearchTarget, ThreadId,
};
use relayer_graph_server::search_index::LadybugSearchIndex;
use serde_json::json;

async fn accepted_sqlite_graph(path: &std::path::Path) -> GraphDatabase {
    let database = GraphDatabase::open(path).await.unwrap();
    let thread = ThreadId::new(41).unwrap();
    let interaction = database
        .create_interaction(None, thread, "Explain the queue")
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
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: "root".into(),
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
            target_layer_id: Some(layer.id),
            interaction_text: None,
        })
        .await
        .unwrap();
    writer.complete(interaction.id).await.unwrap();
    database
}

#[tokio::test]
async fn missing_store_rebuilds_every_accepted_closure_from_sqlite() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    let canonical = database.search_index_rebuild_snapshot().await.unwrap();
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    assert_eq!(
        database.search_index_revision(target).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );

    let index = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    assert_eq!(
        index.revision(target).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
    assert_eq!(
        index
            .normalized_rows("MATCH (n:Content) RETURN n.title AS title ORDER BY title")
            .await
            .unwrap(),
        vec![
            vec![json!({"type": "string", "value": "Explain the queue"})],
            vec![json!({"type": "string", "value": "Queue"})],
        ]
    );
    assert!(index.layout().active().is_file());
    assert_eq!(
        database.search_index_rebuild_snapshot().await.unwrap(),
        canonical
    );
}

#[tokio::test]
async fn unopenable_active_generation_is_quarantined_and_rebuilt_from_sqlite() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    let first = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    let layout = first.layout().clone();
    let damaged = layout.active_generation().unwrap().unwrap();
    drop(first);

    std::fs::remove_dir_all(&damaged).unwrap();
    std::fs::create_dir(&damaged).unwrap();
    std::fs::write(damaged.join("store"), b"not a Ladybug database").unwrap();

    let rebuilt = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    let replacement = rebuilt.layout().active_generation().unwrap().unwrap();
    assert_ne!(replacement, damaged);
    assert_eq!(
        rebuilt
            .normalized_rows("MATCH (n:Content) RETURN count(n) AS count")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "2"})]]
    );
    let quarantined = std::fs::read_dir(layout.quarantine())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(quarantined.len(), 1);
    assert_eq!(
        std::fs::read(quarantined[0].join("store")).unwrap(),
        b"not a Ladybug database"
    );
    assert_eq!(
        std::fs::read(
            layout
                .rollback()
                .join(damaged.file_name().unwrap())
                .join("store")
        )
        .unwrap(),
        b"not a Ladybug database"
    );
}

#[tokio::test]
async fn incompatible_derived_version_rebuilds_side_by_side_under_the_same_engine_pin() {
    use relayer_graph_core::SearchIndexComponent;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    let first = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    let layout = first.layout().clone();
    let previous = layout.active_generation().unwrap().unwrap();
    drop(first);
    database
        .record_search_index_version(SearchIndexComponent::DerivedIndex, "0")
        .await
        .unwrap();

    let rebuilt = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    assert_ne!(
        rebuilt.layout().active_generation().unwrap().unwrap(),
        previous
    );
    assert!(
        layout
            .quarantine()
            .join(previous.file_name().unwrap())
            .exists()
    );
    assert_eq!(
        database
            .search_index_version(SearchIndexComponent::Engine)
            .await
            .unwrap()
            .as_deref(),
        Some("lbug 0.18.0")
    );
    assert_eq!(
        database
            .search_index_version(SearchIndexComponent::DerivedIndex)
            .await
            .unwrap()
            .as_deref(),
        Some("1")
    );
}

#[tokio::test]
async fn orphan_revision_absent_from_sqlite_is_removed_by_canonical_rebuild() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    let index = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    let orphan = SearchTarget::Thread(ThreadId::new(99).unwrap());
    index
        .begin(orphan, SearchIndexRevision::FIRST)
        .await
        .unwrap()
        .commit()
        .await
        .unwrap();
    assert_eq!(database.search_index_revision(orphan).await.unwrap(), None);
    drop(index);

    let rebuilt = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    assert_eq!(rebuilt.revision(orphan).await.unwrap(), None);
    assert_eq!(
        rebuilt
            .revision(SearchTarget::Thread(ThreadId::new(41).unwrap()))
            .await
            .unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
}

#[tokio::test]
async fn pre_generation_active_bytes_are_quarantined_and_rebuilt() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    let first = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    let layout = first.layout().clone();
    let generation = layout.active_generation().unwrap().unwrap();
    drop(first);

    std::fs::remove_file(layout.active()).unwrap();
    for entry in std::fs::read_dir(&generation).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().into_string().unwrap();
        let suffix = name.strip_prefix("store").unwrap();
        std::fs::rename(entry.path(), layout.root().join(format!("active{suffix}"))).unwrap();
    }
    std::fs::remove_dir(&generation).unwrap();

    let rebuilt = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    assert_eq!(
        rebuilt
            .normalized_rows("MATCH (n:Content) RETURN count(n) AS count")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "2"})]]
    );
    assert!(layout.active().is_file());
    assert!(layout.quarantine().read_dir().unwrap().next().is_some());
}

#[cfg(feature = "crash-test-support")]
#[tokio::test]
async fn forced_validation_failure_leaves_the_prior_active_generation_intact() {
    use relayer_graph_server::search_index::SearchIndexLifecycleFault;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    let first = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    let layout = first.layout().clone();
    let prior_pointer = std::fs::read(layout.active()).unwrap();
    let prior_generation = layout.active_generation().unwrap().unwrap();
    drop(first);

    database
        .record_search_index_version(
            relayer_graph_core::SearchIndexComponent::DerivedIndex,
            "incompatible",
        )
        .await
        .unwrap();
    let error = match LadybugSearchIndex::open_reconciled_with_fault(
        &path,
        &database,
        SearchIndexLifecycleFault::BeforePublish,
    )
    .await
    {
        Ok(_) => panic!("injected validation failure unexpectedly published"),
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("injected rebuilt search validation failure")
    );
    assert_eq!(std::fs::read(layout.active()).unwrap(), prior_pointer);
    assert!(prior_generation.exists());
    assert!(!layout.quarantine().exists());
}
