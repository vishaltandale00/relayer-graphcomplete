//! The Ladybug search index against a real store.
//!
//! Promoted from the issue #261 contract probe. The probe proved these lowerings
//! as a one-off binary and froze the output; these run them on every build.

#![cfg(feature = "ladybug")]

use std::sync::Arc;

use relayer_graph_core::{
    AcceptedGraphClosure, ActionDraft, ActionKind, GraphDatabase, ImportedAcceptedView,
    ImportedAction, ImportedConversation, ImportedLayer, ImportedLayerLayout, ImportedNode,
    ImportedNodePlacement, ImportedResolvedLayer, ImportedTurn, LayerDraft, LayerId, LayerLayout,
    NavigateRelation, NodeDraft, NodeId, NodePlacement, ProjectId, SearchIndex,
    SearchIndexRevision, SearchTarget, ThreadId,
};
use relayer_graph_server::search_index::LadybugSearchIndex;
use serde_json::json;

/// Build a real two-node, one-edge, two-layer closure through the ordinary
/// accept path, so the index is fed what the product actually produces.
async fn accepted_closure() -> AcceptedGraphClosure {
    let database = GraphDatabase::in_memory().await.unwrap();
    let interaction = build_and_complete(&database).await;
    database
        .accepted_graph_closure(interaction)
        .await
        .unwrap()
        .unwrap()
}

/// Author a two-node, one-edge, two-layer graph and accept it.
async fn build_and_complete(database: &GraphDatabase) -> NodeId {
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
        .create_edge(&relayer_graph_core::EdgeDraft {
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
            input: None,
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
            input: None,
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
            input: None,
        })
        .await
        .unwrap();
    writer.complete(interaction.id).await.unwrap();
    interaction.id
}

fn index(directory: &tempfile::TempDir) -> LadybugSearchIndex {
    LadybugSearchIndex::open(&directory.path().join("graph.db")).unwrap()
}

fn target() -> SearchTarget {
    SearchTarget::Thread(ThreadId::new(41).unwrap())
}

fn imported_conversation(project_id: Option<ProjectId>) -> ImportedConversation {
    ImportedConversation {
        import_id: "import-1".into(),
        source_sha256: "sha256:abc".into(),
        project_id,
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
async fn the_store_is_a_sibling_of_the_sqlite_file_with_quarantine_reserved() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("graph.db");
    let index = index(&directory);

    let layout = index.layout();
    assert_eq!(layout.root(), directory.path().join("graph.db.ladybug"));
    assert_eq!(layout.active(), layout.root().join("active"));
    assert_eq!(layout.quarantine(), layout.root().join("quarantine"));
    assert!(layout.active().exists(), "the active store was not created");
    // Quarantine is reserved, not created: #302 owns the move into it.
    assert!(!layout.quarantine().exists());
    assert!(
        !database.exists(),
        "the index must not create the SQLite file"
    );
}

#[tokio::test]
async fn a_committed_closure_is_searchable_with_its_identities_intact() {
    let directory = tempfile::tempdir().unwrap();
    let index = index(&directory);
    let closure = accepted_closure().await;

    let mut write = index
        .begin(target(), SearchIndexRevision::FIRST)
        .await
        .unwrap();
    write
        .apply(closure.clone().into(), vec![target()])
        .await
        .unwrap();
    assert_eq!(
        write.commit().await.unwrap(),
        SearchIndexRevision::FIRST,
        "commit must yield the revision it was given"
    );

    let titles = index
        .normalized_rows("MATCH (n:Content) RETURN n.title AS title ORDER BY title")
        .await
        .unwrap();
    assert_eq!(
        titles,
        vec![
            vec![json!({"type": "string", "value": "Explain the queue"})],
            vec![json!({"type": "string", "value": "Queue"})],
            vec![json!({"type": "string", "value": "Worker"})],
        ]
    );

    // Every layer, edge and navigate action in the closure reached the store.
    let counts = index
        .normalized_rows("MATCH (l:Layer) RETURN count(l) AS layers")
        .await
        .unwrap();
    assert_eq!(counts, vec![vec![json!({"type": "integer", "value": "3"})]]);
    let edges = index
        .normalized_rows("MATCH ()-[r:CONNECTED]->() RETURN count(r) AS edges")
        .await
        .unwrap();
    assert_eq!(edges, vec![vec![json!({"type": "integer", "value": "1"})]]);
    let actions = index
        .normalized_rows("MATCH ()-[a:EXPANDS]->() RETURN count(a) AS actions")
        .await
        .unwrap();
    assert_eq!(
        actions,
        vec![vec![json!({"type": "integer", "value": "2"})]]
    );
    let references = index
        .normalized_rows("MATCH ()-[a:REFERENCES]->() RETURN count(a) AS actions")
        .await
        .unwrap();
    assert_eq!(
        references,
        vec![vec![json!({"type": "integer", "value": "1"})]]
    );

    assert_eq!(
        index.revision(target()).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
}

#[tokio::test]
async fn applying_the_same_closure_again_converges_rather_than_duplicating() {
    let directory = tempfile::tempdir().unwrap();
    let index = index(&directory);
    let closure = accepted_closure().await;

    for revision in [
        SearchIndexRevision::FIRST,
        SearchIndexRevision::FIRST.next(),
    ] {
        let mut write = index.begin(target(), revision).await.unwrap();
        write
            .apply(closure.clone().into(), vec![target()])
            .await
            .unwrap();
        write.commit().await.unwrap();
    }

    // This is what makes exact retry after a crash safe: the second application
    // reaches the same state rather than a doubled one.
    for (query, expected) in [
        ("MATCH (n:Content) RETURN count(n) AS n", "3"),
        ("MATCH (l:Layer) RETURN count(l) AS n", "3"),
        ("MATCH ()-[r:CONNECTED]->() RETURN count(r) AS n", "1"),
        ("MATCH ()-[m:CONTAINS]->() RETURN count(m) AS n", "4"),
        ("MATCH ()-[a:EXPANDS]->() RETURN count(a) AS n", "2"),
    ] {
        assert_eq!(
            index.normalized_rows(query).await.unwrap(),
            vec![vec![json!({"type": "integer", "value": expected})]],
            "{query} duplicated on retry"
        );
    }
    assert_eq!(
        index.revision(target()).await.unwrap(),
        Some(SearchIndexRevision::FIRST.next())
    );
}

#[tokio::test]
async fn replaying_a_stable_identity_unions_its_publication_targets() {
    let directory = tempfile::tempdir().unwrap();
    let index = index(&directory);
    let closure = accepted_closure().await;
    let first = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let second = SearchTarget::Thread(ThreadId::new(42).unwrap());

    for (target, revision) in [
        (first, SearchIndexRevision::FIRST),
        (second, SearchIndexRevision::FIRST),
    ] {
        let mut write = index.begin(target, revision).await.unwrap();
        write
            .apply(closure.clone().into(), vec![target])
            .await
            .unwrap();
        write.commit().await.unwrap();
    }

    for target in [first, second] {
        for (query, expected) in [
            ("MATCH (n:Content)", "3"),
            ("MATCH (l:Layer)", "3"),
            ("MATCH ()-[r:CONNECTED]->()", "1"),
            ("MATCH ()-[r:CONTAINS]->()", "4"),
            ("MATCH ()-[r:EXPANDS]->()", "2"),
            ("MATCH ()-[r:REFERENCES]->()", "1"),
        ] {
            let binding = if query.contains("(n:Content)") {
                "n"
            } else if query.contains("(l:Layer)") {
                "l"
            } else {
                "r"
            };
            let rows = index
                .normalized_rows(&format!(
                    "{query} WHERE list_contains({binding}.published_targets, '{target}') \
                     RETURN count({binding}) AS visible"
                ))
                .await
                .unwrap();
            assert_eq!(
                rows,
                vec![vec![json!({"type": "integer", "value": expected})]],
                "replaying the closure erased {query} visibility for {target}"
            );
        }
    }
}

#[tokio::test]
async fn a_rolled_back_write_leaves_the_store_untouched() {
    let directory = tempfile::tempdir().unwrap();
    let index = index(&directory);
    let closure = accepted_closure().await;

    let mut write = index
        .begin(target(), SearchIndexRevision::FIRST)
        .await
        .unwrap();
    write.apply(closure.into(), vec![target()]).await.unwrap();
    write.rollback().await.unwrap();

    assert_eq!(
        index
            .normalized_rows("MATCH (n:Content) RETURN count(n) AS n")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "0"})]]
    );
    assert_eq!(index.revision(target()).await.unwrap(), None);
}

#[tokio::test]
async fn dropping_an_unpolled_commit_releases_the_transaction() {
    let directory = tempfile::tempdir().unwrap();
    let index = index(&directory);
    let closure = accepted_closure().await;

    let mut abandoned = index
        .begin(target(), SearchIndexRevision::FIRST)
        .await
        .unwrap();
    abandoned
        .apply(closure.clone().into(), vec![target()])
        .await
        .unwrap();
    let never_polled = abandoned.commit();
    drop(never_polled);

    let mut retry = index
        .begin(target(), SearchIndexRevision::FIRST)
        .await
        .expect("the dropped commit future must queue rollback before the next BEGIN");
    retry.apply(closure.into(), vec![target()]).await.unwrap();
    retry.commit().await.unwrap();
    assert_eq!(
        index.revision(target()).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
}

#[tokio::test]
async fn a_committed_closure_survives_closing_and_reopening_the_store() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("graph.db");
    let closure = accepted_closure().await;
    {
        let index = LadybugSearchIndex::open(&database).unwrap();
        let mut write = index
            .begin(target(), SearchIndexRevision::FIRST)
            .await
            .unwrap();
        write.apply(closure.into(), vec![target()]).await.unwrap();
        write.commit().await.unwrap();
    }

    let reopened = LadybugSearchIndex::open(&database).unwrap();
    assert_eq!(
        reopened
            .normalized_rows("MATCH (n:Content) RETURN count(n) AS n")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "3"})]]
    );
    assert_eq!(
        reopened.revision(target()).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
}

#[tokio::test]
async fn the_read_path_refuses_a_query_the_engine_does_not_parse_read_only() {
    let directory = tempfile::tempdir().unwrap();
    let index = index(&directory);
    for mutation in [
        "MATCH (n:Content) SET n.title = 'Changed' RETURN n",
        "CREATE NODE TABLE Forbidden(id INT64, PRIMARY KEY(id))",
    ] {
        let refused = index.normalized_rows(mutation).await.unwrap_err();
        assert!(
            refused.to_string().contains("not parsed read-only"),
            "{mutation} was not refused: {refused}"
        );
    }
}

#[tokio::test]
async fn every_v1_value_type_round_trips_losslessly() {
    let directory = tempfile::tempdir().unwrap();
    let index = index(&directory);
    let closure = accepted_closure().await;
    let mut write = index
        .begin(target(), SearchIndexRevision::FIRST)
        .await
        .unwrap();
    write.apply(closure.into(), vec![target()]).await.unwrap();
    write.commit().await.unwrap();

    // Scalars, null, and the i64 extrema, with negative zero canonicalised.
    let scalars = index
        .normalized_rows(
            "MATCH (n:Content) WHERE n.title = 'Queue' \
             RETURN NULL AS null_value, true AS bool_value, \
                    -9223372036854775808 AS min_i64, 9223372036854775807 AS max_i64, \
                    -0.0 AS negative_zero, 'wire' AS string_value",
        )
        .await
        .unwrap();
    assert_eq!(
        scalars,
        vec![vec![
            json!({"type": "null"}),
            json!({"type": "boolean", "value": true}),
            json!({"type": "integer", "value": "-9223372036854775808"}),
            json!({"type": "integer", "value": "9223372036854775807"}),
            json!({"type": "float", "value": 0.0}),
            json!({"type": "string", "value": "wire"}),
        ]]
    );

    // Lists and records keep their element descriptors.
    let structured = index
        .normalized_rows(
            "MATCH (n:Content) WHERE n.title = 'Queue' \
             RETURN [n.title, n.kind] AS pair, {title: n.title} AS record",
        )
        .await
        .unwrap();
    assert_eq!(
        structured,
        vec![vec![
            json!({
                "type": "list",
                "elementType": {"kind": "string"},
                "values": [
                    {"type": "string", "value": "Queue"},
                    {"type": "string", "value": "concept"},
                ],
            }),
            json!({
                "type": "record",
                "fields": [{"name": "title", "value": {"type": "string", "value": "Queue"}}],
            }),
        ]]
    );

    // Nodes, layers, relationships and paths keep their identities and their
    // public properties.
    let graph = index
        .normalized_rows(
            "MATCH p = (l:Layer)-[m:CONTAINS]->(n:Content) WHERE n.title = 'Queue' \
             RETURN n AS node, l AS layer, m AS membership, p AS path",
        )
        .await
        .unwrap();
    let row = graph.first().expect("the membership path was not stored");
    assert_eq!(row[0]["type"], "node");
    assert_eq!(row[0]["kind"], "Content");
    assert!(
        row[0]["id"].as_str().unwrap().starts_with("content:"),
        "node identity was not preserved: {}",
        row[0]
    );
    assert_eq!(row[1]["type"], "layer");
    assert_eq!(row[1]["kind"], "Layer");
    assert_eq!(row[2]["type"], "relationship");
    assert_eq!(row[2]["kind"], "CONTAINS");
    assert_eq!(row[2]["directed"], true);
    assert_eq!(row[2]["start"], row[1]["id"]);
    assert_eq!(row[2]["end"], row[0]["id"]);
    assert_eq!(row[3]["type"], "path");
    assert_eq!(row[3]["vertices"].as_array().unwrap().len(), 2);
    assert_eq!(row[3]["relationships"].as_array().unwrap().len(), 1);

    // An undirected relationship reports canonically ordered endpoints, so one
    // edge is one result rather than two orientations.
    let connected = index
        .normalized_rows("MATCH (a:Content)-[r:CONNECTED]-(b:Content) RETURN r AS edge")
        .await
        .unwrap();
    assert_eq!(connected.len(), 2, "the engine emits both orientations");
    assert_eq!(connected[0][0]["directed"], false);
    assert_eq!(
        connected[0][0]["start"], connected[1][0]["start"],
        "both orientations must normalize to the same endpoint order"
    );
    assert_eq!(connected[0][0]["end"], connected[1][0]["end"]);
}

#[tokio::test]
async fn a_saved_graph_is_searchable_the_moment_the_author_is_told_it_saved() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let search = LadybugSearchIndex::open(&path).unwrap();
    let database = GraphDatabase::open_with_index(&path, Arc::new(search.clone()))
        .await
        .unwrap();

    // Nothing is searchable before the save.
    assert_eq!(
        search
            .normalized_rows("MATCH (n:Content) RETURN count(n) AS n")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "0"})]]
    );

    // `complete` returns only after the closure is committed to both stores.
    let interaction = build_and_complete(&database).await;

    let titles = search
        .normalized_rows("MATCH (n:Content) RETURN n.title AS title ORDER BY title")
        .await
        .unwrap();
    assert_eq!(
        titles,
        vec![
            vec![json!({"type": "string", "value": "Explain the queue"})],
            vec![json!({"type": "string", "value": "Queue"})],
            vec![json!({"type": "string", "value": "Worker"})],
        ],
        "the author was told it saved before search could find it"
    );

    // Node, layer, action and edge identities survive indexing exactly.
    let closure = database
        .accepted_graph_closure(interaction)
        .await
        .unwrap()
        .unwrap();
    let stored = |query: &'static str| {
        let search = search.clone();
        async move {
            search
                .normalized_rows(query)
                .await
                .unwrap()
                .into_iter()
                .map(|row| row[0]["value"].as_str().unwrap().to_owned())
                .collect::<std::collections::BTreeSet<_>>()
        }
    };
    let mut expected_content =
        std::collections::BTreeSet::from([format!("content:{}", closure.interaction.id)]);
    let mut expected_layers = std::collections::BTreeSet::new();
    let mut expected_edges = std::collections::BTreeSet::new();
    let mut expected_expands =
        std::collections::BTreeSet::from([format!("action:{}", closure.root_action.id)]);
    let mut expected_references = std::collections::BTreeSet::new();
    for layer in &closure.layers {
        expected_layers.insert(format!("layer:{}", layer.layer.id));
        for node in &layer.nodes {
            expected_content.insert(format!("content:{}", node.id));
        }
        for edge in &layer.edges {
            expected_edges.insert(format!("edge:{}", edge.id));
        }
        for action in &layer.actions {
            if action.kind == ActionKind::Navigate {
                match action.relation {
                    Some(NavigateRelation::Expand) => {
                        expected_expands.insert(format!("action:{}", action.id));
                    }
                    Some(NavigateRelation::Reference) => {
                        expected_references.insert(format!("action:{}", action.id));
                    }
                    None => {}
                }
            }
        }
    }
    assert_eq!(
        stored("MATCH (n:Content) RETURN n.id AS id").await,
        expected_content
    );
    assert_eq!(
        stored("MATCH (l:Layer) RETURN l.id AS id").await,
        expected_layers
    );
    assert_eq!(
        stored("MATCH ()-[r:CONNECTED]->() RETURN r.id AS id").await,
        expected_edges
    );
    assert_eq!(
        stored("MATCH ()-[a:EXPANDS]->() RETURN a.id AS id").await,
        expected_expands
    );
    assert_eq!(
        stored("MATCH ()-[a:REFERENCES]->() RETURN a.id AS id").await,
        expected_references
    );

    assert_eq!(
        database.search_index_revision(target()).await.unwrap(),
        Some(SearchIndexRevision::FIRST),
        "SQLite must record the exact revision the store committed"
    );
    assert_eq!(
        search.revision(target()).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
}

#[tokio::test]
async fn an_abandoned_write_releases_its_transaction_so_the_next_save_still_works() {
    let directory = tempfile::tempdir().unwrap();
    let index = index(&directory);
    let closure = accepted_closure().await;

    // A deadline that expires, or a cancelled request, drops the write without
    // committing or rolling back. The queued BEGIN has already run by then, so
    // the transaction is open with nobody left to close it.
    let mut abandoned = index
        .begin(target(), SearchIndexRevision::FIRST)
        .await
        .unwrap();
    abandoned
        .apply(closure.clone().into(), vec![target()])
        .await
        .unwrap();
    drop(abandoned);

    // Without the drop rollback this BEGIN fails, and so does every save after
    // it, because the store still has an active transaction.
    let mut write = index
        .begin(target(), SearchIndexRevision::FIRST)
        .await
        .unwrap();
    write.apply(closure.into(), vec![target()]).await.unwrap();
    write.commit().await.unwrap();

    assert_eq!(
        index
            .normalized_rows("MATCH (n:Content) RETURN count(n) AS n")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "3"})]],
        "the abandoned write left content behind"
    );
    assert_eq!(
        index.revision(target()).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
}

#[tokio::test]
async fn the_store_reports_the_revision_it_holds_for_reconciliation() {
    let directory = tempfile::tempdir().unwrap();
    let index = index(&directory);
    let closure = accepted_closure().await;

    assert_eq!(index.revision(target()).await.unwrap(), None);
    let mut write = index
        .begin(target(), SearchIndexRevision::FIRST)
        .await
        .unwrap();
    write.apply(closure.into(), vec![target()]).await.unwrap();
    write.commit().await.unwrap();

    // This is what the write ordering clears its next revision against, and what
    // startup reconciliation compares with the revision SQLite recorded.
    assert_eq!(
        index.revision(target()).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );
    assert_eq!(
        index
            .revision(SearchTarget::Thread(ThreadId::new(42).unwrap()))
            .await
            .unwrap(),
        None,
        "revisions must not leak between targets"
    );
}

#[tokio::test]
async fn an_imported_conversation_is_searchable_against_a_real_store() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let search = LadybugSearchIndex::open(&path).unwrap();
    let database = GraphDatabase::open_with_index(&path, Arc::new(search.clone()))
        .await
        .unwrap();

    // An imported closure is materialized by a different path than an authored
    // one, so the lowering is exercised against its shape too.
    database
        .import_accepted_conversation(&imported_conversation(None))
        .await
        .unwrap();

    let titles = search
        .normalized_rows("MATCH (n:Content) RETURN n.title AS title ORDER BY title")
        .await
        .unwrap();
    assert_eq!(
        titles,
        vec![
            vec![json!({"type": "string", "value": "Explain the queue"})],
            vec![json!({"type": "string", "value": "Imported queue"})],
        ],
        "an imported conversation was not searchable after import"
    );
    // The root action reaches the store, which needs the imported interaction
    // node to have been written first.
    assert_eq!(
        search
            .normalized_rows("MATCH ()-[a:EXPANDS]->() RETURN count(a) AS n")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "1"})]]
    );
    let target = SearchTarget::Thread(ThreadId::new(9001).unwrap());
    assert_eq!(
        database.search_index_revision(target).await.unwrap(),
        Some(SearchIndexRevision::FIRST)
    );

    database
        .remove_imported_conversation("import-1")
        .await
        .unwrap();

    assert_eq!(
        search
            .normalized_rows("MATCH (n:Content) RETURN count(n) AS n")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "0"})]],
        "removed canonical import remained searchable before restart"
    );
    assert_eq!(
        search
            .normalized_rows("MATCH ()-[a:EXPANDS]->() RETURN count(a) AS n")
            .await
            .unwrap(),
        vec![vec![json!({"type": "integer", "value": "0"})]],
        "removed imported relationships remained searchable before restart"
    );
    assert_eq!(
        database.search_index_revision(target).await.unwrap(),
        Some(SearchIndexRevision::FIRST.next()),
        "canonical removal did not acknowledge its derived revision"
    );
}

#[tokio::test]
async fn an_import_referenced_by_another_thread_is_not_removed_from_either_store() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let search = LadybugSearchIndex::open(&path).unwrap();
    let database = GraphDatabase::open_with_index(&path, Arc::new(search.clone()))
        .await
        .unwrap();
    let project = ProjectId::new(7).unwrap();
    let imported = database
        .import_accepted_conversation(&imported_conversation(Some(project)))
        .await
        .unwrap();
    let imported_layer = LayerId::new(imported.turns[0].root_layer_id.unwrap()).unwrap();
    let imported_interaction = NodeId::new(imported.turns[0].graph_node_id.unwrap()).unwrap();

    let interaction = database
        .create_interaction(
            Some(project),
            ThreadId::new(9002).unwrap(),
            "Use the imported queue",
        )
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let answer = writer
        .submit_node(&NodeDraft {
            client_key: "answer".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Queue decision".into(),
            detail: "Uses the imported queue evidence".into(),
        })
        .await
        .unwrap();
    let root = writer
        .submit_layer(&LayerDraft {
            client_key: "root".into(),
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
    writer
        .add_action(&ActionDraft {
            client_key: "imported-evidence".into(),
            source_node_id: answer.id,
            source_layer_id: Some(root.id),
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Reference),
            label: "Imported evidence".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(imported_layer),
            interaction_text: None,
            input: None,
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
            input: None,
        })
        .await
        .unwrap();
    writer.complete(interaction.id).await.unwrap();

    let target = SearchTarget::Project(project);
    let revision = SearchIndexRevision::FIRST.next();
    assert_eq!(
        database.search_index_revision(target).await.unwrap(),
        Some(revision)
    );
    let inventory_queries = [
        "MATCH (n:Content) RETURN n.id,n.published_targets ORDER BY n.id",
        "MATCH (n:Layer) RETURN n.id,n.published_targets ORDER BY n.id",
        "MATCH ()-[r:CONTAINS]->() RETURN r.id,r.published_targets ORDER BY r.id",
        "MATCH ()-[r:EXPANDS]->() RETURN r.id,r.published_targets ORDER BY r.id",
        "MATCH ()-[r:REFERENCES]->() RETURN r.id,r.published_targets ORDER BY r.id",
    ];
    let mut before = Vec::new();
    for query in inventory_queries {
        before.push(search.normalized_rows(query).await.unwrap());
    }
    let references = search
        .normalized_rows_for(
            target,
            "MATCH ()-[r:REFERENCES]->() WHERE list_contains(r.published_targets, 'thread:9002') RETURN count(r) AS n",
        )
        .await
        .unwrap();
    assert_eq!(
        references,
        vec![vec![json!({"type": "integer", "value": "1"})]]
    );

    let refused = database
        .remove_imported_conversation("import-1")
        .await
        .unwrap_err();
    assert!(
        refused.to_string().contains("referenced by another thread"),
        "{refused}"
    );
    assert!(
        database
            .accepted_graph_closure(imported_interaction)
            .await
            .unwrap()
            .is_some(),
        "canonical imported closure changed after rejected removal"
    );
    assert_eq!(
        database.search_index_revision(target).await.unwrap(),
        Some(revision)
    );
    assert_eq!(search.revision(target).await.unwrap(), Some(revision));
    let mut after = Vec::new();
    for query in inventory_queries {
        after.push(search.normalized_rows(query).await.unwrap());
    }
    assert_eq!(after, before, "rejected removal changed derived inventory");
    assert_eq!(
        search
            .normalized_rows_for(
                target,
                "MATCH ()-[r:REFERENCES]->() WHERE list_contains(r.published_targets, 'thread:9002') RETURN count(r) AS n",
            )
            .await
            .unwrap(),
        references,
        "rejected removal changed reference searchability or readiness"
    );
}
