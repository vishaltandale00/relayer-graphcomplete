//! Conformance of the v1 parser against the frozen contract fixtures.
//!
//! The fixtures in `fixtures/graph-query-v1/` are frozen by #275, so these are
//! the contract's own cases rather than cases invented to match the code. The
//! parser implements a subset; a case outside it must fail with a stable
//! `query_construct_unsupported`, never be quietly accepted or misreported.

use relayer_graph_core::query::{
    QueryCode, QueryLimits, QueryRequest, RequestTarget, TargetScope, plan_request,
};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/graph-query-v1/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json")
}

fn request(query: &str) -> QueryRequest {
    QueryRequest {
        query_contract_version: 1,
        target: RequestTarget {
            scope: TargetScope::Thread,
            id: 41,
        },
        query: query.into(),
        parameters: serde_json::Map::new(),
    }
}

#[test]
fn every_frozen_positive_case_either_plans_or_is_named_unsupported() {
    let positive = fixture("positive.json");
    let mut planned = Vec::new();
    let mut unsupported = Vec::new();
    for case in positive["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let query = case["query"].as_str().expect("query");
        let mut envelope = request(query);
        if let Some(parameters) = case["parameters"].as_object() {
            envelope.parameters = parameters.clone();
        }
        match plan_request(&envelope, &QueryLimits::default()) {
            Ok(plan) => {
                assert_eq!(plan.query_contract_version, 1);
                assert_eq!(plan.candidate_source, "structural", "{id}");
                assert!(plan.max_traversal_hops <= 2, "{id} exceeded the hop cap");
                assert!(
                    !plan.projection.columns.is_empty(),
                    "{id} projected nothing"
                );
                planned.push(id.to_owned());
            }
            Err(error) => {
                // A case this slice does not cover must say so precisely.
                assert_eq!(
                    error.code,
                    QueryCode::QueryConstructUnsupported,
                    "{id} failed with {} ({}): {}",
                    error.code.as_str(),
                    error.phase.as_str(),
                    error.message
                );
                unsupported.push(id.to_owned());
            }
        }
    }
    // The slice has to actually cover a meaningful part of the contract, not
    // declare everything unsupported and call it conformance.
    eprintln!(
        "v1 parser slice: {} of {} frozen positive cases plan; unsupported: {unsupported:?}",
        planned.len(),
        planned.len() + unsupported.len()
    );
    assert!(
        planned.len() >= 8,
        "only {} of {} frozen cases plan: {planned:?}",
        planned.len(),
        planned.len() + unsupported.len()
    );
    for required in [
        "whole-target-scan",
        "thread-selector",
        "one-hop-connected",
        "two-hop-connected",
        "membership-placement",
        "root-action-query",
    ] {
        assert!(
            planned.contains(&required.to_owned()),
            "{required} must plan"
        );
    }
}

#[test]
fn frozen_negative_cases_are_refused_at_or_before_their_contract_phase() {
    let negative = fixture("negative.json");
    let order = [
        "envelope",
        "parse",
        "plan",
        "authorize",
        "execute",
        "normalize",
        "encode",
    ];
    let mut refused = 0;
    let mut deferred = 0;
    for case in negative["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let query = case["query"].as_str().expect("query");
        let expected_phase = case["expectedError"]["phase"].as_str().expect("phase");
        let mut envelope = request(query);
        if let Some(version) = case["requestVersion"].as_u64() {
            envelope.query_contract_version = version as u32;
        }
        if let Some(parameters) = case["parameters"].as_object() {
            envelope.parameters = parameters.clone();
        }
        let outcome = plan_request(&envelope, &QueryLimits::default());
        // Planning covers envelope, parse and plan. A case the contract rejects
        // later — authorize, execute, normalize, encode — must reach a plan here,
        // because refusing it now would make the parser an oracle for state it is
        // not allowed to see.
        let planning_owns_it = ["envelope", "parse", "plan"].contains(&expected_phase);
        match outcome {
            Err(error) => {
                assert!(
                    planning_owns_it,
                    "{id} was refused at planning but the contract refuses it at {expected_phase}"
                );
                let actual = order
                    .iter()
                    .position(|phase| *phase == error.phase.as_str())
                    .expect("phase");
                let expected = order
                    .iter()
                    .position(|phase| *phase == expected_phase)
                    .expect("phase");
                assert!(
                    actual <= expected,
                    "{id} was refused at {} but the contract refuses it at {expected_phase}",
                    error.phase.as_str()
                );
                refused += 1;
            }
            Ok(_) => {
                assert!(
                    !planning_owns_it,
                    "{id} was accepted but the contract refuses it at {expected_phase}"
                );
                deferred += 1;
            }
        }
    }
    assert_eq!(
        refused + deferred,
        27,
        "every frozen negative case must be accounted for"
    );
    assert!(
        refused >= 20,
        "only {refused} negative cases are refused at planning"
    );
}

#[test]
fn a_forbidden_construct_never_reaches_a_plan() {
    for (query, code) in [
        (
            "MATCH (n:Content) SET n.title = $t RETURN n",
            QueryCode::QueryConstructUnsupported,
        ),
        (
            "CREATE NODE TABLE Forbidden(id INT64)",
            QueryCode::QueryConstructUnsupported,
        ),
        (
            "MATCH (n:Content) RETURN n.title AS t; MATCH (m:Content) RETURN m.title AS u",
            QueryCode::QuerySyntaxInvalid,
        ),
        (
            "MATCH (n:Content) WHERE n.title = 'literal' RETURN n.title AS t",
            QueryCode::QueryConstructForbidden,
        ),
        (
            "MATCH (n:Nope) RETURN n.title AS t",
            QueryCode::UnknownLabel,
        ),
        (
            "MATCH (n:Content) RETURN n.secret AS t",
            QueryCode::UnknownProperty,
        ),
        (
            "MATCH (n:Content)-[r:INVOKE]->(m:Content) RETURN n.title AS t",
            QueryCode::UnknownRelationshipType,
        ),
        (
            "MATCH (n:Content) RETURN n.title AS t, n.kind AS t",
            QueryCode::DuplicateOutputColumn,
        ),
        (
            "MATCH (n:Content) RETURN n.title AS t LIMIT 9",
            QueryCode::RowLimitExceeded,
        ),
    ] {
        let error = plan_request(&request(query), &QueryLimits::default())
            .expect_err(&format!("{query} was accepted"));
        assert_eq!(error.code, code, "{query} -> {}", error.message);
    }
}

#[test]
fn the_envelope_is_checked_before_the_query() {
    // A bad version wins over a syntactically broken query: envelope precedes
    // parse, and an earlier stage wins even when a later failure also exists.
    let mut broken = request("this is not a query");
    broken.query_contract_version = 2;
    let error = plan_request(&broken, &QueryLimits::default()).expect_err("must fail");
    assert_eq!(error.code, QueryCode::UnsupportedQueryContractVersion);
    assert_eq!(error.phase.as_str(), "envelope");
}
