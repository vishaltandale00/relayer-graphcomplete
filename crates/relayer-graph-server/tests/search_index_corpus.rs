#![cfg(feature = "ladybug")]

#[path = "support/search_index_corpus.rs"]
mod corpus;

use std::sync::Arc;

use corpus::{CORPUS_VERSION, CorpusShape, author_and_complete, cases, manifest_sha256};
use relayer_graph_core::{GraphDatabase, ProjectId, SearchIndex, SearchTarget, ThreadId};
use relayer_graph_server::search_index::LadybugSearchIndex;

#[test]
fn corpus_is_reproducible_from_its_version_and_seed() {
    let first = manifest_sha256(corpus::DEFAULT_SEED, corpus::DEFAULT_SAMPLES);
    assert_eq!(
        first,
        manifest_sha256(corpus::DEFAULT_SEED, corpus::DEFAULT_SAMPLES)
    );
    assert_ne!(
        first,
        manifest_sha256(corpus::DEFAULT_SEED + 1, corpus::DEFAULT_SAMPLES)
    );
    assert_eq!(CORPUS_VERSION, 1);
    assert_eq!(corpus::DEFAULT_WARMUPS, 10);
}

#[test]
fn corpus_keeps_the_declared_boundary_weighting() {
    let generated = cases(corpus::DEFAULT_SEED, corpus::DEFAULT_SAMPLES);
    let ordinary = generated
        .iter()
        .filter(|case| case.shape == CorpusShape::Ordinary)
        .count();
    let recursive = generated
        .iter()
        .filter(|case| case.shape == CorpusShape::Recursive)
        .count();
    let stress = generated
        .iter()
        .filter(|case| case.shape == CorpusShape::LegalStress)
        .count();
    assert!(ordinary >= 120, "ordinary={ordinary}");
    assert!(recursive >= 25, "recursive={recursive}");
    assert!(stress >= 10, "stress={stress}");
}

#[tokio::test]
async fn every_shape_reaches_real_ladybug_through_writer_complete() {
    let directory = tempfile::tempdir().unwrap();
    let sqlite = directory.path().join("graph.db");
    let index = Arc::new(LadybugSearchIndex::open(&sqlite).unwrap());
    let database = GraphDatabase::open_with_index(&sqlite, index.clone())
        .await
        .unwrap();
    let generated = cases(corpus::DEFAULT_SEED, corpus::DEFAULT_SAMPLES);

    for shape in [
        CorpusShape::Ordinary,
        CorpusShape::Recursive,
        CorpusShape::LegalStress,
    ] {
        let case = generated.iter().find(|case| case.shape == shape).unwrap();
        let (output, counts) = author_and_complete(&database, case).await.unwrap();
        assert_eq!(output.node_id, output.root_action.source_node_id);
        assert_eq!(
            output.root_layer.layer.id,
            output.root_action.target_layer_id.unwrap()
        );
        assert_eq!(counts.layers, case.layer_widths.len());
        assert_eq!(counts.nodes, case.layer_widths.iter().sum::<usize>() + 1);

        let ordering_target = match case.project_id {
            Some(project_id) => SearchTarget::Project(ProjectId::new(project_id).unwrap()),
            None => SearchTarget::Thread(ThreadId::new(case.thread_id).unwrap()),
        };
        assert!(
            database
                .search_index_revision(ordering_target)
                .await
                .unwrap()
                .is_some()
        );
        assert!(index.revision(ordering_target).await.unwrap().is_some());
    }

    let rows = index
        .normalized_rows("MATCH (n:Content) WHERE n.title = 'Corpus 0.0' RETURN count(n) AS n")
        .await
        .unwrap();
    assert_eq!(rows[0][0]["value"], "3");
}
