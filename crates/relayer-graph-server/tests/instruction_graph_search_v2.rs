#![cfg(feature = "ladybug")]

use std::{collections::BTreeSet, path::Path, sync::Arc};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use relayer_graph_core::{GraphDatabase, InstructionGraphDefinition, InstructionGraphManifest};
use relayer_graph_server::search_index::LadybugSearchIndex;
use relayer_graph_server::{CreateInteractionResponse, ServerState, router};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const CORPUS: &str = include_str!("../../../fixtures/instruction-graph-v2.json");
const CASES: &str = include_str!("../../../fixtures/instruction-graph-v2-search-cases.json");
const SEARCH_ROUTE: &str = "/api/graph/instruction-graph/search";

async fn post(app: &Router, uri: &str, token: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn search_request(query: &str, parameters: Value) -> Value {
    json!({
        "queryContractVersion": 1,
        "query": query,
        "parameters": parameters,
        "budget": {},
        "reason": {"purpose": "search", "detail": "Deterministic instruction retrieval benchmark"}
    })
}

fn title_request(title: &str) -> Value {
    search_request(
        "MATCH (n:Content) WHERE n.title = $title RETURN n.title AS title, n.kind AS kind, n.state AS state, n.icon AS icon",
        json!({"title": {"type": "string", "value": title}}),
    )
}

fn prerequisite_keys(manifest: &InstructionGraphManifest, root_key: &str) -> BTreeSet<String> {
    let root = manifest.modules.iter().find(|m| m.key == root_key).unwrap();
    let mut pending = root.prerequisites.clone();
    let mut visited = BTreeSet::new();
    while let Some(id) = pending.pop() {
        let module = manifest.modules.iter().find(|m| m.node_id == id).unwrap();
        if visited.insert(module.key.clone()) {
            pending.extend(module.prerequisites.iter().copied());
        }
    }
    visited
}

/// Search precision is deliberately not inferred from exact canonical-title lookups.
/// The same real production route measures natural-phrase misses separately.
#[tokio::test]
async fn actual_v2_corpus_search_is_bounded_exact_and_dependency_complete() {
    let fixture: Value = serde_json::from_str(CORPUS).unwrap();
    let cases: Value = serde_json::from_str(CASES).unwrap();
    let definition: InstructionGraphDefinition = serde_json::from_value(json!({
        "digest": fixture["digest"],
        "retrievalContractVersion": fixture["retrievalContractVersion"],
        "modules": fixture["modules"]
    }))
    .unwrap();
    assert_eq!(fixture["retrievalContractVersion"], 2);
    assert!(
        definition.modules.len() > 8,
        "Directory cap needs the real multi-chunk corpus"
    );

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let sqlite = GraphDatabase::open(&path).await.unwrap();
    let index = Arc::new(
        LadybugSearchIndex::open_reconciled(Path::new(&path), &sqlite)
            .await
            .unwrap(),
    );
    let graph = sqlite.with_search_index(index.clone());
    let app = router(ServerState::new(graph.clone(), "control").with_search_index(index));
    let manifest = graph
        .ensure_instruction_graph(fixture["versionKey"].as_str().unwrap(), definition.clone())
        .await
        .unwrap();
    let (status, task) = post(
        &app,
        "/api/control/interactions",
        "control",
        json!({"threadId": 21, "text": "Instruction search benchmark", "graphCapabilityProfile": {"search": "query-v1"}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{task}");
    let task: CreateInteractionResponse = serde_json::from_value(task).unwrap();
    graph
        .attach_instruction_graph(task.node.id, &manifest.version_key, &manifest.digest)
        .await
        .unwrap();

    let mut exact_passed = 0;
    for module in &definition.modules {
        let (status, body) = post(
            &app,
            SEARCH_ROUTE,
            &task.graph_token,
            title_request(&module.title),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}: {body}", module.key);
        assert_eq!(body["truncated"], false, "{}: {body}", module.key);
        assert_eq!(
            body["rows"],
            json!([[{"type":"string","value":module.title}, {"type":"string","value":"harness-instruction"}, {"type":"string","value":"accepted"}, {"type":"string","value":"book-open"}]]),
            "{}: {body}",
            module.key
        );
        exact_passed += 1;
    }

    let phrases = cases["naturalExactMisses"].as_array().unwrap();
    let mut natural_hits = 0;
    for phrase in phrases {
        let (status, body) = post(
            &app,
            SEARCH_ROUTE,
            &task.graph_token,
            title_request(phrase.as_str().unwrap()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{phrase}: {body}");
        natural_hits += body["rows"].as_array().unwrap().len();
        assert_eq!(
            body["rows"],
            json!([]),
            "Exact lookup is not semantic matching: {phrase}: {body}"
        );
        assert_eq!(body["truncated"], false);
    }

    let unsupported = cases["unsupportedTextQueries"].as_array().unwrap();
    for case in unsupported {
        let request = search_request(
            case["query"].as_str().unwrap(),
            json!({"phrase":{"type":"string","value":"dark mode"},"score":{"type":"float","value":0.8}}),
        );
        let (status, body) = post(&app, SEARCH_ROUTE, &task.graph_token, request).await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}: {body}",
            case["name"]
        );
        assert!(body.get("rows").is_none(), "{}: {body}", case["name"]);
        assert!(
            body["error"]["code"]
                .as_str()
                .unwrap()
                .starts_with("query_"),
            "{}: {body}",
            case["name"]
        );
    }

    let projections = cases["bodyProjectionQueries"].as_array().unwrap();
    for query in projections {
        let (status, body) = post(
            &app,
            SEARCH_ROUTE,
            &task.graph_token,
            search_request(query.as_str().unwrap(), json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{query}: {body}");
        assert_eq!(body["error"]["code"], "invalid_request", "{query}: {body}");
        assert!(body.get("rows").is_none(), "{query}: {body}");
    }

    let mut row_caps = Vec::new();
    for (limit, expected_rows) in [(None, 5), (Some(8), 8)] {
        let mut query =
            "MATCH (n:Content) WHERE n.kind = $kind RETURN n.title AS title ORDER BY title"
                .to_string();
        if let Some(limit) = limit {
            query.push_str(&format!(" LIMIT {limit}"));
        }
        let (status, body) = post(
            &app,
            SEARCH_ROUTE,
            &task.graph_token,
            search_request(
                &query,
                json!({"kind":{"type":"string","value":"harness-instruction"}}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["rows"].as_array().unwrap().len(),
            expected_rows,
            "{body}"
        );
        assert_eq!(body["truncated"], true, "{body}");
        row_caps.push(expected_rows);
    }
    let (status, body) = post(
        &app,
        SEARCH_ROUTE,
        &task.graph_token,
        search_request(
            "MATCH (n:Content) RETURN n.title AS title LIMIT 9",
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "row_limit_exceeded", "{body}");

    let mut foreign = definition.clone();
    foreign.modules[0].title = "Foreign instruction corpus sentinel".into();
    foreign.digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&foreign.modules).unwrap())
    );
    graph
        .ensure_instruction_graph("benchmark-foreign-v2", foreign)
        .await
        .unwrap();
    let (status, body) = post(
        &app,
        SEARCH_ROUTE,
        &task.graph_token,
        title_request("Foreign instruction corpus sentinel"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["rows"], json!([]), "Unpinned corpus leaked: {body}");

    let dependencies = cases["dependencyCases"].as_array().unwrap();
    assert!(
        !dependencies.is_empty(),
        "Versioned dependency gold cases are required"
    );
    for case in dependencies {
        let root_key = case["rootKey"].as_str().unwrap();
        let expected: BTreeSet<_> = case["prerequisiteKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            prerequisite_keys(&manifest, root_key),
            expected,
            "{root_key}: manifest closure differs from reviewed gold"
        );
        for key in expected {
            let module = manifest.modules.iter().find(|m| m.key == key).unwrap();
            let (status, body) = post(
                &app,
                SEARCH_ROUTE,
                &task.graph_token,
                title_request(&module.title),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{root_key}/{key}: {body}");
            assert_eq!(
                body["rows"].as_array().unwrap().len(),
                1,
                "{root_key}/{key}: {body}"
            );
        }
    }

    println!(
        "instruction_graph_search_v2_benchmark={}",
        json!({
            "corpusVersionKey": manifest.version_key,
            "corpusDigest": manifest.digest,
            "exactTitleLookups": {"passed": exact_passed, "total": definition.modules.len()},
            "naturalPhraseExactMatches": {"hits": natural_hits, "phrases": phrases.len(), "interpretation": "Exact title equality supplies no natural-language relevance matching"},
            "unsupportedTextQueriesRejected": unsupported.len(),
            "bodyProjectionsRejected": projections.len(),
            "truncatedDirectoryRows": row_caps,
        "aboveHardRowCapRejected": true,
            "foreignCorpusMatches": 0,
            "manifestDependencyGoldCases": dependencies.len(),
            "semanticRelevance": "unmeasured"
        })
    );
}
