//! Startup reconciliation of the derived Ladybug store from canonical SQLite.

#![cfg(feature = "ladybug")]

use relayer_graph_core::{
    ActionDraft, ActionKind, GraphDatabase, LayerDraft, LayerLayout, NavigateRelation, NodeDraft,
    NodePlacement, SearchIndex, SearchIndexRevision, SearchTarget, ThreadId,
};
use relayer_graph_server::search_index::LadybugSearchIndex;
use serde_json::json;
use sqlx::{Connection, Executor, SqliteConnection};

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

#[cfg(feature = "crash-test-support")]
async fn add_second_accepted_target(database: &GraphDatabase) {
    let thread = ThreadId::new(42).unwrap();
    let interaction = database
        .create_interaction(None, thread, "Explain the worker")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let worker = writer
        .submit_node(&NodeDraft {
            client_key: "worker".into(),
            kind: "concept".into(),
            icon: "cpu".into(),
            title: "Worker".into(),
            detail: "Processes work".into(),
        })
        .await
        .unwrap();
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: "worker-root".into(),
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
    writer
        .add_action(&ActionDraft {
            client_key: "worker-response".into(),
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
        database.search_index_revision(target).await.unwrap(),
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
async fn accepted_history_without_search_receipts_is_rebuilt_and_receipted() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let url = format!("sqlite://{}", path.display());
    let mut connection = SqliteConnection::connect(&url).await.unwrap();
    connection
        .execute("DELETE FROM search_index_targets")
        .await
        .unwrap();
    drop(connection);
    assert_eq!(database.search_index_revision(target).await.unwrap(), None);

    let index = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    assert_eq!(
        index.revision(target).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
    assert_eq!(
        database.search_index_revision(target).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
    assert_eq!(
        index
            .normalized_rows("MATCH (n:Content) RETURN count(n)")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "2"})]]
    );
}

#[cfg(feature = "crash-test-support")]
#[tokio::test]
async fn same_revision_missing_and_extra_topology_is_never_accepted_as_ready() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    let first = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    first
        .inject_lifecycle_corruption("MATCH ()-[r:EXPANDS]->() DELETE r")
        .await
        .unwrap();
    first
        .inject_lifecycle_corruption("MATCH (n:Content) WHERE n.title = 'Queue' DETACH DELETE n")
        .await
        .unwrap();
    drop(first);

    let repaired = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    repaired.wait_until_reconciled().await.unwrap();
    for (query, expected) in [
        ("MATCH (n:Content) RETURN count(n)", "2"),
        ("MATCH ()-[r:CONTAINS]->() RETURN count(r)", "1"),
        ("MATCH ()-[r:EXPANDS]->() RETURN count(r)", "1"),
    ] {
        assert_eq!(
            repaired.normalized_rows(query).await.unwrap(),
            vec![vec![json!({"type": "integer", "value": expected})]]
        );
    }
    repaired
        .inject_lifecycle_corruption(
            "CREATE (:Content {id: 'content:999', kind: 'concept', icon: 'x', title: 'Extra', detail: 'x', state: 'accepted', published_targets: ['thread:41']})",
        )
        .await
        .unwrap();
    repaired
        .inject_lifecycle_corruption(
            "MATCH (a:Content), (b:Content) WHERE a.id = 'content:1' AND b.id = 'content:999' CREATE (a)-[:CONNECTED {id: 'edge:999', state: 'accepted', published_targets: ['thread:41']}]->(b)",
        )
        .await
        .unwrap();
    drop(repaired);

    let repaired = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    repaired.wait_until_reconciled().await.unwrap();
    for (query, expected) in [
        ("MATCH (n:Content) RETURN count(n)", "2"),
        ("MATCH ()-[r:CONNECTED]->() RETURN count(r)", "0"),
    ] {
        assert_eq!(
            repaired.normalized_rows(query).await.unwrap(),
            vec![vec![json!({"type": "integer", "value": expected})]]
        );
    }
}

#[cfg(feature = "crash-test-support")]
#[tokio::test]
async fn same_revision_property_mutation_and_identical_relationship_duplicate_are_rebuilt() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    let first = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    first
        .inject_lifecycle_corruption(
            "MATCH (n:Content) WHERE n.title = 'Queue' SET n.detail = 'corrupted detail'",
        )
        .await
        .unwrap();
    first
        .inject_lifecycle_corruption(
            "MATCH (l:Layer), (n:Content) WHERE l.id = 'layer:1' AND n.id = 'content:2' CREATE (l)-[:CONTAINS {id: 'membership:1:2', member_order: 0, x: 0.5, y: 0.5, has_xy: true, published_targets: ['thread:41']}]->(n)",
        )
        .await
        .unwrap();
    assert_eq!(
        first
            .normalized_rows("MATCH ()-[r:CONTAINS]->() RETURN count(r)")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "2"})]]
    );
    drop(first);

    let repaired = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    repaired.wait_until_reconciled().await.unwrap();
    assert_eq!(
        repaired
            .normalized_rows("MATCH (n:Content) WHERE n.title = 'Queue' RETURN n.detail")
            .await
            .unwrap(),
        vec![vec![json!({"type": "string", "value": "Pending work"})]]
    );
    assert_eq!(
        repaired
            .normalized_rows("MATCH ()-[r:CONTAINS]->() RETURN count(r)")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "1"})]]
    );
}

#[cfg(feature = "crash-test-support")]
#[tokio::test]
async fn logical_damage_blocks_only_its_target_while_unaffected_target_stays_usable() {
    use relayer_graph_server::search_index::{SearchIndexLifecycleFault, SearchTargetReadiness};

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    add_second_accepted_target(&database).await;
    let first = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    first
        .inject_lifecycle_corruption(
            "MATCH (n:Content) WHERE list_contains(n.published_targets, 'thread:41') DETACH DELETE n",
        )
        .await
        .unwrap();
    drop(first);

    let index = LadybugSearchIndex::open_reconciled_with_fault(
        &path,
        &database,
        SearchIndexLifecycleFault::HoldLogicalRebuild,
    )
    .await
    .unwrap();
    let damaged = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let unaffected = SearchTarget::Thread(ThreadId::new(42).unwrap());
    assert_eq!(
        index.target_readiness(damaged),
        SearchTargetReadiness::Rebuilding
    );
    assert_eq!(
        index.target_readiness(unaffected),
        SearchTargetReadiness::Ready
    );
    assert!(
        index
            .normalized_rows_for(damaged, "MATCH (n:Content) RETURN count(n)")
            .await
            .unwrap_err()
            .to_string()
            .contains("rebuilding")
    );
    assert_eq!(
        index
            .normalized_rows_for(
                unaffected,
                "MATCH (n:Content) WHERE list_contains(n.published_targets, 'thread:42') RETURN count(n)",
            )
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "2"})]]
    );
    index
        .begin(unaffected, SearchIndexRevision::FIRST.next())
        .await
        .unwrap()
        .rollback()
        .await
        .unwrap();

    index.resume_logical_rebuild();
    index.wait_until_reconciled().await.unwrap();
    assert_eq!(
        index.target_readiness(damaged),
        SearchTargetReadiness::Ready
    );
    assert_eq!(
        index
            .normalized_rows_for(
                damaged,
                "MATCH (n:Content) WHERE list_contains(n.published_targets, 'thread:41') RETURN count(n)",
            )
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "2"})]]
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
    rebuilt.wait_until_reconciled().await.unwrap();
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
async fn pointer_to_missing_generation_recovers_globally_from_sqlite() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    let first = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    let missing = first.layout().active_generation().unwrap().unwrap();
    drop(first);
    std::fs::remove_dir_all(&missing).unwrap();

    let rebuilt = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    assert_ne!(
        rebuilt.layout().active_generation().unwrap().unwrap(),
        missing
    );
    assert_eq!(
        rebuilt
            .normalized_rows("MATCH (n:Content) RETURN count(n)")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "2"})]]
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
    rebuilt.wait_until_reconciled().await.unwrap();
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

#[cfg(feature = "crash-test-support")]
#[tokio::test]
async fn one_rebuild_deadline_includes_receipt_and_final_active_open() {
    use std::time::Duration;

    use relayer_graph_core::SearchIndexComponent;
    use relayer_graph_server::search_index::SearchIndexLifecycleFault;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    drop(
        LadybugSearchIndex::open_reconciled(&path, &database)
            .await
            .unwrap(),
    );
    database
        .record_search_index_version(SearchIndexComponent::DerivedIndex, "force-rebuild")
        .await
        .unwrap();

    let error = match LadybugSearchIndex::open_reconciled_with_rebuild_budget(
        &path,
        &database,
        SearchIndexLifecycleFault::DelayBeforeFinalOpen,
        Duration::from_millis(25),
    )
    .await
    {
        Ok(_) => panic!("post-publication delay escaped the rebuild deadline"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("exceeded"), "{error}");

    // The timeout may occur after atomic pointer publication. That state is
    // deliberately restart-safe: the next ordinary open validates the selected
    // generation and converges without trusting a partial acknowledgement.
    let recovered = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    assert_eq!(
        recovered
            .normalized_rows("MATCH (n:Content) RETURN count(n)")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "2"})]]
    );
}

#[cfg(feature = "crash-test-support")]
#[tokio::test]
async fn active_pointer_replacement_after_open_is_detected_and_rebuilt() {
    use relayer_graph_server::search_index::SearchIndexLifecycleFault;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    drop(
        LadybugSearchIndex::open_reconciled(&path, &database)
            .await
            .unwrap(),
    );

    let repaired = LadybugSearchIndex::open_reconciled_with_fault(
        &path,
        &database,
        SearchIndexLifecycleFault::ReplacePointerAfterOpen,
    )
    .await
    .unwrap();
    assert_eq!(
        repaired
            .normalized_rows("MATCH (n:Content) RETURN count(n)")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "2"})]]
    );
    assert_eq!(
        std::fs::read_dir(repaired.layout().quarantine())
            .unwrap()
            .count(),
        2,
        "both the opened and raced generations are retained as evidence"
    );
}

#[cfg(feature = "crash-test-support")]
#[tokio::test]
async fn active_pointer_replacement_before_publish_fails_closed_without_overwriting_it() {
    use relayer_graph_core::SearchIndexComponent;
    use relayer_graph_server::search_index::SearchIndexLifecycleFault;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = accepted_sqlite_graph(&path).await;
    let first = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    let layout = first.layout().clone();
    let prior_pointer = std::fs::read(layout.active()).unwrap();
    drop(first);
    database
        .record_search_index_version(SearchIndexComponent::DerivedIndex, "force-rebuild")
        .await
        .unwrap();

    let error = match LadybugSearchIndex::open_reconciled_with_fault(
        &path,
        &database,
        SearchIndexLifecycleFault::ReplacePointerBeforePublish,
    )
    .await
    {
        Ok(_) => panic!("a pointer race must fail closed"),
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("changed during canonical rebuild"),
        "{error}"
    );
    let raced_pointer = std::fs::read(layout.active()).unwrap();
    assert_ne!(raced_pointer, prior_pointer);

    // No competing-process protocol is invented here. The single primary's
    // next startup treats the raced bytes as untrusted and converges from the
    // canonical SQLite snapshot.
    let recovered = LadybugSearchIndex::open_reconciled(&path, &database)
        .await
        .unwrap();
    assert_eq!(
        recovered
            .normalized_rows("MATCH (n:Content) RETURN count(n)")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "2"})]]
    );
}

#[cfg(all(feature = "crash-test-support", unix))]
#[tokio::test]
async fn symlink_pointer_and_generation_are_rejected_without_following_them() {
    use std::os::unix::fs::symlink;

    for symlink_generation in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("graph.db");
        let database = accepted_sqlite_graph(&path).await;
        let first = LadybugSearchIndex::open_reconciled(&path, &database)
            .await
            .unwrap();
        let layout = first.layout().clone();
        let generation = layout.active_generation().unwrap().unwrap();
        drop(first);

        if symlink_generation {
            let displaced = directory.path().join("displaced-generation");
            std::fs::rename(&generation, &displaced).unwrap();
            symlink(&displaced, &generation).unwrap();
        } else {
            let external = directory.path().join("external-pointer");
            std::fs::rename(layout.active(), &external).unwrap();
            symlink(&external, layout.active()).unwrap();
        }
        let error = match LadybugSearchIndex::open_reconciled(&path, &database).await {
            Ok(_) => panic!("symlinked Ladybug path was followed"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("symlink")
                || error.to_string().contains("confined plain directory"),
            "{error}"
        );
    }
}

#[cfg(all(feature = "crash-test-support", unix))]
#[tokio::test]
async fn quarantined_rollback_is_an_independent_durable_copy() {
    use std::os::unix::fs::MetadataExt;

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
    std::fs::write(damaged.join("store"), b"damaged independent bytes").unwrap();

    drop(
        LadybugSearchIndex::open_reconciled(&path, &database)
            .await
            .unwrap(),
    );
    let name = damaged.file_name().unwrap();
    let quarantined = layout.quarantine().join(name).join("store");
    let rollback = layout.rollback().join(name).join("store");
    assert_ne!(
        std::fs::metadata(&quarantined).unwrap().ino(),
        std::fs::metadata(&rollback).unwrap().ino()
    );
    std::fs::write(&quarantined, b"changed quarantine").unwrap();
    assert_eq!(
        std::fs::read(rollback).unwrap(),
        b"damaged independent bytes"
    );
}
