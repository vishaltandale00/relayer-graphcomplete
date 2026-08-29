//! End-to-end conformance against the frozen v1 contract.
//!
//! The dataset, the queries and the expected results all come from
//! `fixtures/graph-query-v1/`, frozen by #275. Nothing here is written to match
//! the implementation: a case either reproduces the contract's own bytes or it
//! does not.

#![cfg(feature = "ladybug")]

use relayer_graph_core::{
    ProjectId, SearchTarget, ThreadId,
    query::{QueryLimits, QueryRequest, RequestTarget, TargetScope, plan_request},
};
use relayer_graph_server::search_index::{
    query::execute,
    store::{LadybugStore, StoreLayout, exec},
};
use serde_json::{Value, json};
use std::time::Duration;

fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/graph-query-v1/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json")
}

fn list(values: &Value) -> String {
    let items: Vec<String> = values
        .as_array()
        .expect("targets")
        .iter()
        .map(|value| format!("'{}'", value.as_str().expect("target")))
        .collect();
    format!("[{}]", items.join(","))
}

fn quote(value: &Value) -> String {
    value.as_str().unwrap_or_default().replace('\'', "\\'")
}

/// Load the contract's supergraph into a store using the product schema.
fn load_contract_dataset(store: &LadybugStore) {
    let supergraph = fixture("supergraph.json");
    futures_lite_block(store, move |connection| {
        for content in supergraph["content"].as_array().expect("content") {
            exec(
                connection,
                &format!(
                    "CREATE (:Content {{id:'{}',kind:'{}',icon:'{}',title:'{}',detail:'{}',state:'{}',published_targets:{}}})",
                    quote(&content["id"]),
                    quote(&content["kind"]),
                    quote(&content["icon"]),
                    quote(&content["title"]),
                    quote(&content["detail"]),
                    quote(&content["state"]),
                    list(&content["publishedTargets"]),
                ),
            )?;
        }
        for layer in supergraph["layers"].as_array().expect("layers") {
            let has_layout = layer["layoutVersion"].is_number();
            // A legacy layer with no authored layout stores no version at all.
            let version = match layer["layoutVersion"].as_i64() {
                Some(version) => version.to_string(),
                None => "NULL".to_owned(),
            };
            exec(
                connection,
                &format!(
                    "CREATE (:Layer {{id:'{}',state:'{}',layout_version:{version},has_layout:{has_layout},published_targets:{}}})",
                    quote(&layer["id"]),
                    quote(&layer["state"]),
                    list(&layer["publishedTargets"]),
                ),
            )?;
        }
        for edge in supergraph["edges"].as_array().expect("edges") {
            let endpoints = edge["endpoints"].as_array().expect("endpoints");
            exec(
                connection,
                &format!(
                    "MATCH (a:Content),(b:Content) WHERE a.id='{}' AND b.id='{}' \
                 CREATE (a)-[:CONNECTED {{id:'{}',state:'{}',published_targets:{}}}]->(b)",
                    quote(&endpoints[0]),
                    quote(&endpoints[1]),
                    quote(&edge["id"]),
                    quote(&edge["state"]),
                    list(&edge["publishedTargets"]),
                ),
            )?;
        }
        for layer in supergraph["layers"].as_array().expect("layers") {
            for member in layer["members"].as_array().expect("members") {
                let has_xy = member["x"].is_number();
                exec(
                    connection,
                    &format!(
                        "MATCH (l:Layer),(n:Content) WHERE l.id='{}' AND n.id='{}' \
                     CREATE (l)-[:CONTAINS {{id:'membership:{}:{}:{}',member_order:{},x:{},y:{},has_xy:{has_xy},published_targets:{}}}]->(n)",
                        quote(&layer["id"]),
                        quote(&member["contentId"]),
                        layer["graphId"].as_i64().unwrap_or(0),
                        member["order"].as_i64().unwrap_or(0),
                        quote(&member["contentId"]).trim_start_matches("content:"),
                        member["order"].as_i64().unwrap_or(0),
                        member["x"].as_f64().unwrap_or(0.0),
                        member["y"].as_f64().unwrap_or(0.0),
                        list(&layer["publishedTargets"]),
                    ),
                )?;
            }
        }
        for action in supergraph["actions"].as_array().expect("actions") {
            // Only navigate actions are searchable topology; the contract
            // excludes invoke and interaction.context.
            let table = match action["relation"].as_str() {
                Some("expand") => "EXPANDS",
                Some("reference") => "REFERENCES",
                _ => continue,
            };
            exec(
                connection,
                &format!(
                    "MATCH (n:Content),(l:Layer) WHERE n.id='{}' AND l.id='{}' \
                 CREATE (n)-[:{table} {{id:'{}',source_layer_id:'{}',label:'{}',variant:'{}',icon:'{}',description:'{}',relation:'{}',state:'{}',published_targets:{}}}]->(l)",
                    quote(&action["sourceContentId"]),
                    quote(&action["targetLayerId"]),
                    quote(&action["id"]),
                    quote(&action["sourceLayerId"]),
                    quote(&action["label"]),
                    quote(&action["variant"]),
                    quote(&action["icon"]),
                    quote(&action["description"]),
                    quote(&action["relation"]),
                    quote(&action["state"]),
                    list(&action["publishedTargets"]),
                ),
            )?;
        }
        Ok(())
    });
}

/// The store's worker is async-facing; these tests are synchronous setup, so the
/// job is submitted and awaited on a small runtime.
fn futures_lite_block<F>(store: &LadybugStore, job: F)
where
    F: for<'connection> FnOnce(&lbug::Connection<'connection>) -> anyhow::Result<()>
        + Send
        + 'static,
{
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async { store.run(job).await })
        .expect("load the contract dataset");
}

fn target_of(target: &Value) -> SearchTarget {
    let id = target["id"].as_i64().expect("id");
    match target["scope"].as_str().expect("scope") {
        "project" => SearchTarget::Project(ProjectId::new(id).expect("project")),
        _ => SearchTarget::Thread(ThreadId::new(id).expect("thread")),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn frozen_positive_cases_reproduce_the_contract_results() {
    let directory = tempfile::tempdir().unwrap();
    let layout = StoreLayout::beside(&directory.path().join("graph.db"));
    let store = LadybugStore::open(layout, Duration::from_secs(30)).unwrap();
    tokio::task::block_in_place(|| load_contract_dataset(&store));

    let positive = fixture("positive.json");
    let limits = QueryLimits::default();
    let (mut matched, mut unsupported, mut mismatched) = (Vec::new(), Vec::new(), Vec::new());

    for case in positive["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id").to_owned();
        let request = QueryRequest {
            query_contract_version: 1,
            target: RequestTarget {
                scope: match case["target"]["scope"].as_str() {
                    Some("project") => TargetScope::Project,
                    _ => TargetScope::Thread,
                },
                id: case["target"]["id"].as_i64().unwrap_or(41),
            },
            query: case["query"].as_str().expect("query").into(),
            parameters: case["parameters"].as_object().cloned().unwrap_or_default(),
        };
        let Ok(plan) = plan_request(&request, &limits) else {
            unsupported.push(id);
            continue;
        };
        let authorized = target_of(&case["target"]);
        let parameters = request.parameters.clone();
        let expected = case["expectedResult"].clone();
        let outcome = store
            .run(move |connection| {
                Ok(execute(
                    connection,
                    &plan,
                    &parameters,
                    authorized,
                    &QueryLimits::default(),
                ))
            })
            .await
            .expect("worker");
        match outcome {
            Ok(outcome) if outcome.to_json() == expected => matched.push(id),
            Ok(outcome) => mismatched.push((id, outcome.to_json(), expected)),
            Err(error) => mismatched.push((id, json!({"error": error.message}), expected)),
        }
    }

    eprintln!(
        "v1 conformance: {} matched, {} unsupported, {} mismatched",
        matched.len(),
        unsupported.len(),
        mismatched.len()
    );
    for (id, actual, expected) in &mismatched {
        eprintln!(
            "  {id}\n    expected {}\n    actual   {}",
            serde_json::to_string(expected).unwrap_or_default(),
            serde_json::to_string(actual).unwrap_or_default()
        );
    }
    // Every case this slice admits reproduces the contract's exact bytes. The one
    // it does not admit is IS ABSENT, refused as query_construct_unsupported.
    assert_eq!(
        mismatched.len(),
        0,
        "a case the slice admits no longer reproduces the contract"
    );
    assert_eq!(matched.len(), 19, "matched: {matched:?}");
    assert_eq!(unsupported.len(), 1, "unsupported: {unsupported:?}");
}
