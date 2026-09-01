//! End-to-end conformance against the frozen v1 contract.
//!
//! The dataset, the queries and the expected results all come from
//! `fixtures/graph-query-v1/`, frozen by #275. Nothing here is written to match
//! the implementation: a case either reproduces the contract's own bytes or it
//! does not.

#![cfg(all(feature = "ladybug", feature = "crash-test-support"))]

use relayer_graph_core::{
    ActionDraft, ActionKind, GraphDatabase, LayerDraft, LayerLayout, NavigateRelation, NodeDraft,
    NodePlacement, ProjectId, SearchTarget, ThreadId,
    query::{
        QueryBudget, QueryCode, QueryPhase, QueryReadPermit, QueryRequest, RequestTarget,
        TargetScope,
    },
};
use relayer_graph_server::search_index::{
    GraphQueryFailure, LadybugSearchIndex, QueryCancellation, SearchTargetReadiness,
    contract_test_support::{
        endpoint_scan_count, index_from_supergraph, normalization_error, reset_endpoint_scan_count,
    },
};
use serde_json::{Value, json};
use std::sync::Arc;

fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/graph-query-v1/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json")
}

fn target_of(target: &Value) -> SearchTarget {
    let id = target["id"].as_i64().expect("id");
    match target["scope"].as_str().expect("scope") {
        "project" => SearchTarget::Project(ProjectId::new(id).expect("project")),
        _ => SearchTarget::Thread(ThreadId::new(id).expect("thread")),
    }
}

fn contract_index() -> (tempfile::TempDir, LadybugSearchIndex) {
    let directory = tempfile::tempdir().unwrap();
    let index = tokio::task::block_in_place(|| {
        index_from_supergraph(
            &directory.path().join("graph.db"),
            fixture("supergraph.json"),
        )
    });
    (directory, index)
}

fn request_for(case: &Value) -> QueryRequest {
    QueryRequest {
        query_contract_version: case["requestVersion"].as_u64().unwrap_or(1) as u32,
        target: RequestTarget {
            scope: match case["target"]["scope"].as_str() {
                Some("project") => TargetScope::Project,
                _ => TargetScope::Thread,
            },
            id: case["target"]["id"].as_i64().unwrap_or(41),
        },
        query: case["query"].as_str().expect("query").into(),
        parameters: case["parameters"].as_object().cloned().unwrap_or_default(),
        budget: QueryBudget::default(),
    }
}

fn request_json(request: &QueryRequest) -> Vec<u8> {
    serde_json::to_vec(request).expect("request envelope")
}

fn thread_request(
    query: &str,
    parameters: serde_json::Map<String, Value>,
    budget: QueryBudget,
) -> QueryRequest {
    QueryRequest {
        query_contract_version: 1,
        target: RequestTarget {
            scope: TargetScope::Thread,
            id: 41,
        },
        query: query.into(),
        parameters,
        budget,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn frozen_positive_cases_reproduce_the_contract_results() {
    let (_directory, index) = contract_index();

    let positive = fixture("positive.json");
    let (mut matched, mut mismatched) = (Vec::new(), Vec::new());

    for case in positive["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id").to_owned();
        let request = request_for(case);
        let authorized = target_of(&case["target"]);
        let permit = QueryReadPermit::for_contract_test(authorized);
        let expected = case["expectedResult"].clone();
        let outcome = index
            .query(
                &permit,
                &request_json(&request),
                QueryCancellation::default(),
            )
            .await
            .map(|result| result.outcome);
        match outcome {
            Ok(outcome) if outcome.to_json() == expected => matched.push(id),
            Ok(outcome) => mismatched.push((id, outcome.to_json(), expected)),
            Err(error) => mismatched.push((id, json!({"error": format!("{error:?}")}), expected)),
        }
    }

    eprintln!(
        "v1 conformance: {} matched, {} mismatched",
        matched.len(),
        mismatched.len()
    );
    for (id, actual, expected) in &mismatched {
        eprintln!(
            "  {id}\n    expected {}\n    actual   {}",
            serde_json::to_string(expected).unwrap_or_default(),
            serde_json::to_string(actual).unwrap_or_default()
        );
    }
    // Every frozen positive case reproduces the contract's exact result.
    assert_eq!(
        mismatched.len(),
        0,
        "a case the slice admits no longer reproduces the contract"
    );
    assert_eq!(matched.len(), 20, "matched: {matched:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn frozen_negative_cases_return_exact_stable_errors() {
    let (_directory, index) = contract_index();
    let negative = fixture("negative.json");
    let mut failures = Vec::new();
    for case in negative["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let mut request = request_for(case);
        let requested_target = match request.target.scope {
            TargetScope::Project => {
                SearchTarget::Project(ProjectId::new(request.target.id).unwrap())
            }
            TargetScope::Thread => SearchTarget::Thread(ThreadId::new(request.target.id).unwrap()),
        };
        let permitted_target = if id == "reject-inaccessible-target" {
            SearchTarget::Thread(ThreadId::new(41).unwrap())
        } else {
            requested_target
        };
        let permit = if id == "reject-foreign-draft" {
            QueryReadPermit::foreign_draft_contract_test(permitted_target)
        } else {
            QueryReadPermit::for_contract_test(permitted_target)
        };
        let cancellation = QueryCancellation::default();
        match id {
            "cancel-before-time" => {
                request.budget.wall_time_ms = Some(0);
                cancellation.cancel();
            }
            "time-before-expansions" => {
                request.budget.wall_time_ms = Some(0);
                request.budget.examined_expansions = Some(0);
            }
            "limit-does-not-bound-work" => request.budget.intermediate_rows = Some(0),
            _ => {}
        }
        let actual = index
            .query(&permit, &request_json(&request), cancellation)
            .await
            .expect_err(id);
        let relayer_graph_server::search_index::GraphQueryFailure::Contract(actual) = actual else {
            failures.push(format!("{id}: non-contract error {actual:?}"));
            continue;
        };
        let expected = &case["expectedError"];
        let expected_code: QueryCode = serde_json::from_value(expected["code"].clone()).unwrap();
        let expected_phase: QueryPhase = serde_json::from_value(expected["phase"].clone()).unwrap();
        let expected_path = expected["path"].as_str().unwrap();
        if (actual.code, actual.phase, actual.path.as_str())
            != (expected_code, expected_phase, expected_path)
        {
            failures.push(format!(
                "{id}: expected {expected_code:?}/{expected_phase:?}/{expected_path}, got {:?}/{:?}/{}",
                actual.code, actual.phase, actual.path
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn frozen_issue_354_hardening_corpus_conforms_through_real_ladybug() {
    let (_directory, index) = contract_index();
    let corpus = fixture("hardening-354.json");
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);

    for case in corpus["positiveCases"].as_array().expect("positiveCases") {
        let outcome = index
            .query(
                &permit,
                &request_json(&request_for(case)),
                QueryCancellation::default(),
            )
            .await
            .unwrap_or_else(|error| panic!("{}: {error:?}", case["id"]));
        assert_eq!(
            outcome.outcome.to_json(),
            case["expectedResult"],
            "{}",
            case["id"]
        );
    }

    for case in corpus["negativeCases"].as_array().expect("negativeCases") {
        let error = index
            .query(
                &permit,
                &request_json(&request_for(case)),
                QueryCancellation::default(),
            )
            .await
            .expect_err(case["id"].as_str().expect("id"));
        let GraphQueryFailure::Contract(error) = error else {
            panic!("{} returned a non-contract failure", case["id"]);
        };
        let expected = &case["expectedError"];
        assert_eq!(
            error.code.as_str(),
            expected["code"].as_str().unwrap(),
            "{}",
            case["id"]
        );
        assert_eq!(
            error.phase.as_str(),
            expected["phase"].as_str().unwrap(),
            "{}",
            case["id"]
        );
        assert_eq!(
            error.path,
            expected["path"].as_str().unwrap(),
            "{}",
            case["id"]
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn raw_envelope_and_complete_parameter_planning_precede_authority_and_readiness() {
    let (_directory, index) = contract_index();
    let damaged = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(damaged);
    index.set_contract_test_readiness(damaged, SearchTargetReadiness::Rebuilding);

    let duplicate = br#"{
      "queryContractVersion":1,
      "target":{"scope":"thread","id":41},
      "query":"MATCH (n:Content) RETURN n",
      "parameters":{"x":{"type":"string","value":"one"},"x":{"type":"string","value":"two"}},
      "budget":{}
    }"#;
    let duplicate = index
        .query(&permit, duplicate, QueryCancellation::default())
        .await
        .unwrap_err();
    assert!(matches!(
        duplicate,
        GraphQueryFailure::Contract(ref error)
            if error.code == QueryCode::InvalidRequest && error.phase == QueryPhase::Envelope
    ));

    for request in [
        thread_request(
            "MATCH (n:Content) RETURN $missing AS value",
            Default::default(),
            Default::default(),
        ),
        thread_request(
            "MATCH (n:Content) RETURN n LIMIT $missing",
            Default::default(),
            Default::default(),
        ),
        thread_request(
            "MATCH (n:Content) RETURN $value AS value",
            serde_json::Map::from_iter([("value".into(), json!({"type":"node"}))]),
            Default::default(),
        ),
        thread_request(
            "MATCH (n:Content) RETURN $value AS value",
            serde_json::Map::from_iter([(
                "value".into(),
                json!({
                    "type":"relationship", "id":"edge:201", "kind":"CONNECTED",
                    "start":"content:2", "end":"content:1", "directed":false,
                    "properties":[]
                }),
            )]),
            Default::default(),
        ),
    ] {
        let failure = index
            .query(
                &permit,
                &request_json(&request),
                QueryCancellation::default(),
            )
            .await
            .unwrap_err();
        assert!(matches!(
            failure,
            GraphQueryFailure::Contract(ref error) if error.phase < QueryPhase::Authorize
        ));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_numeric_aggregate_types_precede_target_authorization() {
    let (_directory, index) = contract_index();
    let permit =
        QueryReadPermit::for_contract_test(SearchTarget::Thread(ThreadId::new(41).unwrap()));
    let cases = [
        ("MATCH (n:Content) RETURN sum(n) AS value", None),
        ("MATCH (n:Content) RETURN avg(n.title) AS value", None),
        (
            "MATCH (n:Content) RETURN sum($value) AS value",
            Some(json!({"type":"string","value":"not numeric"})),
        ),
    ];
    for (query, parameter) in cases {
        let mut request = thread_request(
            query,
            parameter
                .map(|value| serde_json::Map::from_iter([("value".into(), value)]))
                .unwrap_or_default(),
            Default::default(),
        );
        request.target.id = 99;
        let failure = index
            .query(
                &permit,
                &request_json(&request),
                QueryCancellation::default(),
            )
            .await
            .unwrap_err();
        assert!(matches!(
            failure,
            GraphQueryFailure::Contract(ref error)
                if error.code == QueryCode::InvalidAggregate
                    && error.phase == QueryPhase::Plan
                    && error.path == "query.return[0]"
        ));
    }
}

#[test]
fn frozen_values_normalization_errors_have_exact_stable_codes() {
    let values = fixture("values.json");
    for case in values["normalizationErrors"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let actual = normalization_error(id);
        let expected: QueryCode =
            serde_json::from_value(case["expectedError"]["code"].clone()).unwrap();
        assert_eq!(actual.code, expected, "{id}");
        assert_eq!(actual.phase, QueryPhase::Normalize, "{id}");
        assert_eq!(actual.path, "result", "{id}");
    }
    let overflow = normalization_error("reject-integer-overflow");
    assert_eq!(overflow.code, QueryCode::IntegerOverflow);
    assert_eq!(overflow.phase, QueryPhase::Normalize);
}

#[tokio::test(flavor = "multi_thread")]
async fn full_tagged_value_corpus_round_trips_when_used_as_parameters() {
    let (_directory, index) = contract_index();
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);
    let fixture = fixture("values.json");
    let mut values = fixture["cases"][0]["values"].as_array().unwrap().clone();
    values.extend(fixture["cases"][1]["values"].as_array().unwrap().clone());
    values.push(json!({"type":"float","value":-0.0}));
    for index in [3_usize, 4, 5, 6] {
        values.push(fixture["cases"][index]["value"].clone());
    }

    for expected in values {
        let request = thread_request(
            "MATCH (n:Content) RETURN $value AS value LIMIT 1",
            serde_json::Map::from_iter([("value".into(), expected.clone())]),
            Default::default(),
        );
        let result = index
            .query(
                &permit,
                &request_json(&request),
                QueryCancellation::default(),
            )
            .await
            .unwrap_or_else(|error| panic!("{expected}: {error:?}"));
        let mut canonical = expected;
        if canonical["type"] == "float" && canonical["value"].as_f64() == Some(0.0) {
            canonical["value"] = json!(0.0);
        }
        assert_eq!(result.outcome.rows[0][0], canonical);
    }

    for spelling in fixture["cases"][1]["rejectedSpellings"].as_array().unwrap() {
        let request = thread_request(
            "MATCH (n:Content) RETURN $value AS value LIMIT 1",
            serde_json::Map::from_iter([(
                "value".into(),
                json!({"type":"integer","value":spelling}),
            )]),
            Default::default(),
        );
        let failure = index
            .query(
                &permit,
                &request_json(&request),
                QueryCancellation::default(),
            )
            .await
            .unwrap_err();
        assert!(matches!(
            failure,
            GraphQueryFailure::Contract(ref error)
                if error.code == QueryCode::InvalidRequest && error.phase == QueryPhase::Envelope
        ));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn joined_occurrence_trail_orientation_and_internal_parameter_boundaries_are_exact() {
    let (_directory, index) = contract_index();
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);

    let occurrence = thread_request(
        "MATCH (l:Layer)-[:CONTAINS]->(n:Content), (n)-[:EXPANDS]->(t:Layer) RETURN l AS layer",
        Default::default(),
        Default::default(),
    );
    let result = index
        .query(
            &permit,
            &request_json(&occurrence),
            QueryCancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(result.outcome.rows.len(), 1);
    assert_eq!(result.outcome.rows[0][0]["id"], "layer:101");

    let trail = thread_request(
        "MATCH (a:Content)-[out:CONNECTED]-(b:Content), (b)-[back:CONNECTED]-(a) WHERE a.title = $title RETURN a.title AS title",
        serde_json::Map::from_iter([("title".into(), json!({"type":"string","value":"Queue"}))]),
        Default::default(),
    );
    let result = index
        .query(&permit, &request_json(&trail), QueryCancellation::default())
        .await
        .unwrap();
    assert!(result.outcome.rows.is_empty());

    let orientation = thread_request(
        "MATCH (a:Content)-[r:CONNECTED]-(b:Content) WHERE a.kind = $kind AND b.kind = $kind RETURN r AS edge LIMIT 8",
        serde_json::Map::from_iter([("kind".into(), json!({"type":"string","value":"concept"}))]),
        Default::default(),
    );
    let result = index
        .query(
            &permit,
            &request_json(&orientation),
            QueryCancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(result.outcome.rows.len(), 1);
    assert_eq!(result.outcome.rows[0][0]["id"], "edge:201");
    assert_eq!(result.outcome.rows[0][0]["start"], "content:1");
    assert_eq!(result.outcome.rows[0][0]["end"], "content:2");

    let collision = thread_request(
        "MATCH (n:Content) RETURN $__relayer_target AS value LIMIT 1",
        serde_json::Map::from_iter([(
            "__relayer_target".into(),
            json!({"type":"string","value":"caller-value"}),
        )]),
        Default::default(),
    );
    let result = index
        .query(
            &permit,
            &request_json(&collision),
            QueryCancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(
        result.outcome.rows[0][0],
        json!({"type":"string","value":"caller-value"})
    );

    let generated_collision = thread_request(
        "MATCH (relayer_rel_0_0:Content)-[:CONNECTED]-(b:Content) WHERE relayer_rel_0_0.title = $title RETURN b.title AS title",
        serde_json::Map::from_iter([("title".into(), json!({"type":"string","value":"Queue"}))]),
        Default::default(),
    );
    let result = index
        .query(
            &permit,
            &request_json(&generated_collision),
            QueryCancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(
        result.outcome.rows,
        vec![vec![json!({"type":"string","value":"Worker"})]]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn collected_graph_values_use_relayer_recursive_order_and_precise_descriptor() {
    let (_directory, index) = contract_index();
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);
    let request = thread_request(
        "MATCH (l:Layer) RETURN collect(l) AS layers",
        Default::default(),
        Default::default(),
    );
    let result = index
        .query(
            &permit,
            &request_json(&request),
            QueryCancellation::default(),
        )
        .await
        .unwrap();
    let list = &result.outcome.rows[0][0];
    assert_eq!(list["type"], "list");
    assert_eq!(list["elementType"], json!({"kind":"layer"}));
    let identities = list["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        identities,
        vec!["layer:101", "layer:102", "layer:103", "layer:104",]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn graph_and_composite_min_max_use_relayer_canonical_order() {
    let (_directory, index) = contract_index();
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);
    let cases = [
        ("MATCH (n:Content) RETURN min(n) AS value", "content:1"),
        ("MATCH (n:Content) RETURN max(n) AS value", "content:6"),
        ("MATCH (l:Layer) RETURN min(l) AS value", "layer:101"),
        ("MATCH (l:Layer) RETURN max(l) AS value", "layer:104"),
    ];
    for (query, expected_id) in cases {
        let result = index
            .query(
                &permit,
                &request_json(&thread_request(
                    query,
                    Default::default(),
                    Default::default(),
                )),
                QueryCancellation::default(),
            )
            .await
            .unwrap();
        assert_eq!(result.outcome.rows[0][0]["id"], expected_id, "{query}");
    }

    for (function, expected_title) in [("min", "Evidence"), ("max", "Worker")] {
        for expression in ["[n.title, n.kind]", "{title:n.title, kind:n.kind}"] {
            let query = format!("MATCH (n:Content) RETURN {function}({expression}) AS value");
            let result = index
                .query(
                    &permit,
                    &request_json(&thread_request(
                        &query,
                        Default::default(),
                        Default::default(),
                    )),
                    QueryCancellation::default(),
                )
                .await
                .unwrap();
            let value = &result.outcome.rows[0][0];
            let title = if value["type"] == "list" {
                &value["values"][0]["value"]
            } else {
                &value["fields"][0]["value"]["value"]
            };
            assert_eq!(title, expected_title, "{query}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn signed_integer_sum_overflow_fails_in_normalization() {
    let (_directory, index) = contract_index();
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);
    let request = thread_request(
        "MATCH (n:Content) RETURN sum($value) AS value",
        serde_json::Map::from_iter([(
            "value".into(),
            json!({"type":"integer","value":i64::MAX.to_string()}),
        )]),
        Default::default(),
    );

    let failure = index
        .query(
            &permit,
            &request_json(&request),
            QueryCancellation::default(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        failure,
        GraphQueryFailure::Contract(ref error)
            if error.code == QueryCode::IntegerOverflow
                && error.phase == QueryPhase::Normalize
                && error.path == "result"
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn work_budgets_count_structural_candidates_before_filters_and_aggregates() {
    let (_directory, index) = contract_index();
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);
    let impossible = serde_json::Map::from_iter([(
        "title".into(),
        json!({"type":"string","value":"never matches"}),
    )]);
    for query in [
        "MATCH (a:Content)-[:CONNECTED]-(b:Content) WHERE a.title = $title RETURN b AS value",
        "MATCH (a:Content)-[:CONNECTED]-(b:Content) WHERE a.title = $title RETURN count(b) AS value",
    ] {
        let request = thread_request(
            query,
            impossible.clone(),
            QueryBudget {
                examined_expansions: Some(0),
                intermediate_rows: Some(0),
                ..Default::default()
            },
        );
        let failure = index
            .query(
                &permit,
                &request_json(&request),
                QueryCancellation::default(),
            )
            .await
            .unwrap_err();
        assert!(matches!(
            failure,
            GraphQueryFailure::Contract(ref error)
                if error.code == QueryCode::ExaminedExpansionsExceeded
        ));
    }

    let aggregate = thread_request(
        "MATCH (n:Content) RETURN count(n) AS value",
        Default::default(),
        QueryBudget {
            intermediate_rows: Some(0),
            ..Default::default()
        },
    );
    let failure = index
        .query(
            &permit,
            &request_json(&aggregate),
            QueryCancellation::default(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        failure,
        GraphQueryFailure::Contract(ref error)
            if error.code == QueryCode::IntermediateRowsExceeded
    ));

    let thread_42 = SearchTarget::Thread(ThreadId::new(42).unwrap());
    let permit_42 = QueryReadPermit::for_contract_test(thread_42);
    let mut dead_end = thread_request(
        "MATCH (a:Content)-[:CONNECTED]-(b:Content)-[:CONNECTED]-(c:Content) RETURN c AS value",
        Default::default(),
        QueryBudget {
            examined_expansions: Some(0),
            ..Default::default()
        },
    );
    dead_end.target.id = 42;
    let failure = index
        .query(
            &permit_42,
            &request_json(&dead_end),
            QueryCancellation::default(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        failure,
        GraphQueryFailure::Contract(ref error)
            if error.code == QueryCode::ExaminedExpansionsExceeded
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn expansion_budget_does_not_truncate_cartesian_results() {
    let directory = tempfile::tempdir().unwrap();
    let mut supergraph = fixture("supergraph.json");
    let actions = supergraph["actions"].as_array_mut().unwrap();
    for (id, layer) in [
        ("action:901", "layer:101"),
        ("action:902", "layer:102"),
        ("action:903", "layer:104"),
    ] {
        actions.push(json!({
            "id": id,
            "graphId": 901,
            "kind": "navigate",
            "relation": "expand",
            "sourceContentId": "content:1",
            "sourceLayerId": "layer:101",
            "targetLayerId": layer,
            "label": "Budget fixture",
            "variant": "card",
            "icon": "zoom-in",
            "description": "Exercise joined work accounting",
            "state": "accepted",
            "projectId": 7,
            "threadId": 41,
            "publishedTargets": ["project:7", "thread:41"]
        }));
    }
    let index = tokio::task::block_in_place(|| {
        index_from_supergraph(&directory.path().join("graph.db"), supergraph)
    });
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);
    let request = thread_request(
        "MATCH (a:Content)-[:EXPANDS]->(b:Layer), (a)-[:EXPANDS]->(c:Layer) RETURN b AS left, c AS right LIMIT 8",
        Default::default(),
        QueryBudget {
            examined_expansions: Some(10),
            intermediate_rows: Some(12),
            ..Default::default()
        },
    );

    let result = index
        .query(
            &permit,
            &request_json(&request),
            QueryCancellation::default(),
        )
        .await
        .unwrap();

    assert_eq!(result.outcome.rows.len(), 8);
    assert!(result.outcome.truncated);
}

#[tokio::test(flavor = "multi_thread")]
async fn encoded_result_budget_applies_to_the_zero_row_envelope() {
    let (_directory, index) = contract_index();
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);
    let request = thread_request(
        "MATCH (n:Content) WHERE n.title = $never RETURN n.title AS title",
        serde_json::Map::from_iter([("never".into(), json!({"type":"string","value":"never"}))]),
        QueryBudget {
            encoded_result_bytes: Some(1),
            ..Default::default()
        },
    );

    let failure = index
        .query(
            &permit,
            &request_json(&request),
            QueryCancellation::default(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        failure,
        GraphQueryFailure::Contract(ref error)
            if error.code == QueryCode::ResultRowTooLarge
                && error.phase == QueryPhase::Encode
                && error.path == "result"
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn endpoint_normalization_never_scans_an_unrelated_target() {
    let directory = tempfile::tempdir().unwrap();
    let mut supergraph = fixture("supergraph.json");
    for id in 20_000..20_032 {
        supergraph["content"].as_array_mut().unwrap().push(json!({
            "id": format!("content:{id}"),
            "kind": "concept",
            "icon": "dot",
            "title": format!("Unrelated {id}"),
            "detail": "Must not be scanned by thread 41",
            "state": "accepted",
            "publishedTargets": ["thread:99"],
        }));
    }
    let index = tokio::task::block_in_place(|| {
        index_from_supergraph(&directory.path().join("graph.db"), supergraph)
    });
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);
    let parameters =
        serde_json::Map::from_iter([("title".into(), json!({"type":"string","value":"Queue"}))]);
    let budget = QueryBudget {
        intermediate_rows: Some(5),
        ..Default::default()
    };
    reset_endpoint_scan_count();

    let scalar = thread_request(
        "MATCH (n:Content) WHERE n.title = $title RETURN n.title AS title",
        parameters.clone(),
        budget.clone(),
    );
    let scalar = index
        .query(
            &permit,
            &request_json(&scalar),
            QueryCancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(
        scalar.outcome.rows,
        vec![vec![json!({"type":"string","value":"Queue"})]]
    );

    let relationship = thread_request(
        "MATCH (a:Content)-[r:CONNECTED]-(b:Content) WHERE a.title = $title RETURN r AS edge",
        parameters,
        budget,
    );
    let relationship = index
        .query(
            &permit,
            &request_json(&relationship),
            QueryCancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(relationship.outcome.rows.len(), 1);
    assert_eq!(relationship.outcome.rows[0][0]["id"], "edge:201");
    assert_eq!(endpoint_scan_count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn authorization_precedes_per_target_readiness_and_one_target_does_not_stall_another() {
    let (_directory, index) = contract_index();
    let damaged = SearchTarget::Project(ProjectId::new(7).unwrap());
    let ready = SearchTarget::Thread(ThreadId::new(41).unwrap());
    index.set_contract_test_readiness(damaged, SearchTargetReadiness::Rebuilding);

    let project_case = &fixture("positive.json")["cases"][2];
    let failure = index
        .query(
            &QueryReadPermit::for_contract_test(damaged),
            &request_json(&request_for(project_case)),
            QueryCancellation::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(
        failure,
        GraphQueryFailure::TargetNotReady {
            target: damaged,
            readiness: SearchTargetReadiness::Rebuilding,
        }
    );

    let denied = index
        .query(
            &QueryReadPermit::for_contract_test(ready),
            &request_json(&request_for(project_case)),
            QueryCancellation::default(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        denied,
        GraphQueryFailure::Contract(ref error) if error.code == QueryCode::ScopeNotGranted
    ));

    let thread_case = &fixture("positive.json")["cases"][1];
    index
        .query(
            &QueryReadPermit::for_contract_test(ready),
            &request_json(&request_for(thread_case)),
            QueryCancellation::default(),
        )
        .await
        .expect("unrelated ready target remains queryable");
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_and_outer_deadline_leave_the_store_reusable() {
    let (_directory, index) = contract_index();
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);
    let case = &fixture("positive.json")["cases"][1];

    let cancelled = QueryCancellation::default();
    cancelled.cancel();
    let failure = index
        .query(&permit, &request_json(&request_for(case)), cancelled)
        .await
        .unwrap_err();
    assert!(matches!(
        failure,
        GraphQueryFailure::Contract(ref error) if error.code == QueryCode::QueryCancelled
    ));

    let mut expired = request_for(case);
    expired.budget.wall_time_ms = Some(0);
    let failure = index
        .query(
            &permit,
            &request_json(&expired),
            QueryCancellation::default(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        failure,
        GraphQueryFailure::Contract(ref error) if error.code == QueryCode::WallTimeExceeded
    ));

    let recovered = index
        .query(
            &permit,
            &request_json(&request_for(case)),
            QueryCancellation::default(),
        )
        .await
        .expect("later query uses the same store after cancellation and deadline");
    assert!(!recovered.outcome.rows.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_interrupts_only_its_owned_in_flight_job() {
    let directory = tempfile::tempdir().unwrap();
    let index = Arc::new(tokio::task::block_in_place(|| {
        index_from_supergraph(
            &directory.path().join("graph.db"),
            fixture("supergraph.json"),
        )
    }));
    let permit =
        QueryReadPermit::for_contract_test(SearchTarget::Thread(ThreadId::new(41).unwrap()));
    let request = request_json(&thread_request(
        "MATCH (n:Content) RETURN n.title AS title",
        Default::default(),
        Default::default(),
    ));

    let a_cancel = QueryCancellation::default();
    a_cancel.hold_after_started_for_test();
    let a = {
        let index = index.clone();
        let permit = permit.clone();
        let cancellation = a_cancel.clone();
        let request = request.clone();
        tokio::spawn(async move { index.query(&permit, &request, cancellation).await })
    };
    a_cancel.wait_until_started().await;

    let b_cancel = QueryCancellation::default();
    b_cancel.cancel();
    let b = index
        .query(&permit, &request, b_cancel)
        .await
        .expect_err("queued pre-cancelled B");
    assert!(matches!(
        b,
        GraphQueryFailure::Contract(ref error) if error.code == QueryCode::QueryCancelled
    ));
    a_cancel.release_after_started_for_test();
    let a = a.await.unwrap().expect("B cannot interrupt active A");
    assert_eq!(a.outcome.rows.len(), 5);

    let in_flight_cancel = QueryCancellation::default();
    in_flight_cancel.hold_after_started_for_test();
    let active = {
        let index = index.clone();
        let permit = permit.clone();
        let cancellation = in_flight_cancel.clone();
        let request = request.clone();
        tokio::spawn(async move { index.query(&permit, &request, cancellation).await })
    };
    in_flight_cancel.wait_until_started().await;
    in_flight_cancel.cancel();
    let cancelled = active.await.unwrap().expect_err("active job cancelled");
    assert!(matches!(
        cancelled,
        GraphQueryFailure::Contract(ref error) if error.code == QueryCode::QueryCancelled
    ));
    in_flight_cancel.release_after_started_for_test();

    let recovered = index
        .query(&permit, &request, QueryCancellation::default())
        .await
        .expect("the same worker is reusable after its owned interrupt");
    assert_eq!(recovered.outcome.rows.len(), 5);
}

#[tokio::test(flavor = "multi_thread")]
async fn active_wall_deadline_interrupts_its_owned_job_and_reuses_the_worker() {
    let (_directory, index) = contract_index();
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);
    let cancellation = QueryCancellation::default();
    cancellation.hold_after_started_for_test();
    let request = request_json(&thread_request(
        "MATCH (n:Content) RETURN n.title AS title",
        Default::default(),
        QueryBudget {
            wall_time_ms: Some(100),
            ..Default::default()
        },
    ));
    let active = {
        let index = index.clone();
        let cancellation = cancellation.clone();
        tokio::spawn(async move { index.query(&permit, &request, cancellation).await })
    };
    cancellation.wait_until_started().await;
    let failure = active
        .await
        .unwrap()
        .expect_err("held active query reaches its wall deadline");
    assert!(matches!(
        failure,
        GraphQueryFailure::Contract(ref error)
            if error.code == QueryCode::WallTimeExceeded
                && error.path == "budget.wall_time_ms"
    ));
    cancellation.release_after_started_for_test();

    let recovered = index
        .query(
            &QueryReadPermit::for_contract_test(target),
            &request_json(&thread_request(
                "MATCH (n:Content) RETURN n.title AS title",
                Default::default(),
                Default::default(),
            )),
            QueryCancellation::default(),
        )
        .await
        .expect("the worker is reusable after an active deadline interrupt");
    assert_eq!(recovered.outcome.rows.len(), 5);
}

#[tokio::test(flavor = "multi_thread")]
async fn tagged_scalar_list_and_record_parameters_round_trip_through_ladybug() {
    let (_directory, index) = contract_index();
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);
    let values = vec![
        json!({"type":"null"}),
        json!({"type":"boolean","value":false}),
        json!({"type":"integer","value":i64::MIN.to_string()}),
        json!({"type":"integer","value":i64::MAX.to_string()}),
        json!({"type":"float","value":-0.0}),
        json!({"type":"string","value":"queue"}),
        json!({"type":"list","elementType":{"kind":"string"},"values":[]}),
        json!({"type":"record","fields":[
            {"name":"title","value":{"type":"string","value":"Queue"}},
            {"name":"count","value":{"type":"integer","value":"1"}}
        ]}),
    ];
    for expected in values {
        let mut parameters = serde_json::Map::new();
        parameters.insert("value".into(), expected.clone());
        let request = QueryRequest {
            query_contract_version: 1,
            target: RequestTarget {
                scope: TargetScope::Thread,
                id: 41,
            },
            query: "MATCH (n:Content) RETURN $value AS value LIMIT 1".into(),
            parameters,
            budget: QueryBudget::default(),
        };
        let result = index
            .query(
                &permit,
                &request_json(&request),
                QueryCancellation::default(),
            )
            .await
            .unwrap();
        let mut canonical = expected;
        if canonical["type"] == "float" && canonical["value"].as_f64() == Some(0.0) {
            canonical["value"] = json!(0.0);
        }
        assert_eq!(result.outcome.rows[0][0], canonical);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn representative_cold_and_warm_queries_stay_below_the_contract_target() {
    let (_directory, index) = contract_index();
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);
    let case = &fixture("positive.json")["cases"][1];
    let cold = index
        .query(
            &permit,
            &request_json(&request_for(case)),
            QueryCancellation::default(),
        )
        .await
        .unwrap();
    let warm = index
        .query(
            &permit,
            &request_json(&request_for(case)),
            QueryCancellation::default(),
        )
        .await
        .unwrap();
    assert!(cold.diagnostics.cold);
    assert!(!warm.diagnostics.cold);
    assert!(
        cold.diagnostics.elapsed_micros < 250_000,
        "cold: {:?}",
        cold.diagnostics
    );
    assert!(
        warm.diagnostics.elapsed_micros < 250_000,
        "warm: {:?}",
        warm.diagnostics
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn every_caller_narrowed_budget_fails_at_its_own_stable_boundary() {
    let (_directory, index) = contract_index();
    let target = SearchTarget::Thread(ThreadId::new(41).unwrap());
    let permit = QueryReadPermit::for_contract_test(target);
    let cases = vec![
        (
            "query_bytes",
            "MATCH (n:Content) RETURN n",
            QueryBudget {
                query_bytes: Some(1),
                ..Default::default()
            },
            QueryCode::QueryBytesExceeded,
        ),
        (
            "ast_depth",
            "MATCH (n:Content) RETURN [n.title] AS value",
            QueryBudget {
                ast_depth: Some(0),
                ..Default::default()
            },
            QueryCode::AstDepthExceeded,
        ),
        (
            "variables",
            "MATCH (n:Content) RETURN n",
            QueryBudget {
                variables: Some(0),
                ..Default::default()
            },
            QueryCode::VariableLimitExceeded,
        ),
        (
            "pattern_parts",
            "MATCH (n:Content) RETURN n",
            QueryBudget {
                pattern_parts: Some(0),
                ..Default::default()
            },
            QueryCode::PatternPartLimitExceeded,
        ),
        (
            "traversal_hops",
            "MATCH (a:Content)-[:CONNECTED]-(b:Content) RETURN b",
            QueryBudget {
                traversal_hops: Some(0),
                ..Default::default()
            },
            QueryCode::TraversalLimitExceeded,
        ),
        (
            "examined_expansions",
            "MATCH (a:Content)-[:CONNECTED]-(b:Content) RETURN b",
            QueryBudget {
                examined_expansions: Some(0),
                ..Default::default()
            },
            QueryCode::ExaminedExpansionsExceeded,
        ),
        (
            "intermediate_rows",
            "MATCH (n:Content) RETURN n",
            QueryBudget {
                intermediate_rows: Some(0),
                ..Default::default()
            },
            QueryCode::IntermediateRowsExceeded,
        ),
        (
            "wall_time_ms",
            "MATCH (n:Content) RETURN n",
            QueryBudget {
                wall_time_ms: Some(0),
                ..Default::default()
            },
            QueryCode::WallTimeExceeded,
        ),
        (
            "result_rows",
            "MATCH (n:Content) RETURN n LIMIT 1",
            QueryBudget {
                result_rows: Some(0),
                ..Default::default()
            },
            QueryCode::RowLimitExceeded,
        ),
        (
            "encoded_result_bytes",
            "MATCH (n:Content) RETURN n.title AS title LIMIT 1",
            QueryBudget {
                encoded_result_bytes: Some(1),
                ..Default::default()
            },
            QueryCode::ResultRowTooLarge,
        ),
    ];
    for (name, query, budget, expected) in cases {
        let request = QueryRequest {
            query_contract_version: 1,
            target: RequestTarget {
                scope: TargetScope::Thread,
                id: 41,
            },
            query: query.into(),
            parameters: Default::default(),
            budget,
        };
        let failure = index
            .query(
                &permit,
                &request_json(&request),
                QueryCancellation::default(),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(failure, GraphQueryFailure::Contract(ref error) if error.code == expected),
            "{name}: {failure:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn acknowledged_completion_is_immediately_queryable_through_the_real_publication_boundary() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("graph.db");
    let sqlite_only = GraphDatabase::open(&database_path).await.unwrap();
    let index = Arc::new(
        LadybugSearchIndex::open_reconciled(&database_path, &sqlite_only)
            .await
            .unwrap(),
    );
    let graph = sqlite_only.with_search_index(index.clone());

    let interaction = graph
        .create_interaction(None, ThreadId::new(41).unwrap(), "Explain")
        .await
        .unwrap();
    let permit = graph.query_read_permit(interaction.id, 0).await.unwrap();
    let writer = graph.writer_for_subgraph(interaction.id).await.unwrap();
    let node = writer
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
            nodes: vec![node.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(vec![NodePlacement {
                node_id: node.id,
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
            input: None,
        })
        .await
        .unwrap();
    writer.complete(interaction.id).await.unwrap();

    let request = QueryRequest {
        query_contract_version: 1,
        target: RequestTarget {
            scope: TargetScope::Thread,
            id: 41,
        },
        query: "MATCH (n:Content) WHERE n.title = $title RETURN n.title AS title".into(),
        parameters: serde_json::Map::from_iter([(
            "title".into(),
            json!({"type":"string","value":"Queue"}),
        )]),
        budget: QueryBudget::default(),
    };
    let result = index
        .query(
            &permit,
            &request_json(&request),
            QueryCancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(
        result.outcome.rows,
        vec![vec![json!({"type":"string","value":"Queue"})]]
    );
}
