//! Frozen-corpus seeding without exposing a Ladybug connection to tests.

use std::{path::Path, time::Duration};

use lbug::{LogicalType, Value as EngineValue};
use relayer_graph_core::query::QueryError;
use serde_json::Value;

use super::store::exec;
use super::{
    LadybugSearchIndex,
    store::{
        LadybugStore, StoreLayout, endpoint_index_rows_for_test, reset_endpoint_index_rows_for_test,
    },
};

/// Exercise the production normalizer with the malformed engine value named by
/// the frozen values corpus. No connection, schema name, or physical query is
/// exposed to the integration test.
pub fn normalization_error(case_id: &str) -> QueryError {
    let value = match case_id {
        "reject-nan" => EngineValue::Double(f64::NAN),
        "reject-positive-infinity" => EngineValue::Double(f64::INFINITY),
        "reject-negative-infinity" => EngineValue::Double(f64::NEG_INFINITY),
        "reject-engine-heterogeneous-list" => EngineValue::List(
            LogicalType::String,
            vec![EngineValue::String("Queue".into()), EngineValue::Int64(1)],
        ),
        "reject-record-shape-list" => EngineValue::List(
            LogicalType::Struct {
                fields: vec![("title".into(), LogicalType::String)],
            },
            vec![
                EngineValue::Struct(vec![("title".into(), EngineValue::String("Queue".into()))]),
                EngineValue::Struct(vec![
                    ("title".into(), EngineValue::String("Worker".into())),
                    ("extra".into(), EngineValue::Bool(true)),
                ]),
            ],
        ),
        "reject-duplicate-record-field" => EngineValue::Struct(vec![
            ("x".into(), EngineValue::Int64(1)),
            ("x".into(), EngineValue::Int64(2)),
        ]),
        "reject-integer-overflow" => EngineValue::Int128(i128::from(i64::MAX) + 1),
        other => panic!("unknown frozen normalization case {other}"),
    };
    super::query::normalization_failure(
        super::value::normalize_value(&value, &super::value::EndpointIds::new()).unwrap_err(),
    )
}

fn list(values: &Value) -> String {
    let items = values
        .as_array()
        .expect("targets")
        .iter()
        .map(|value| format!("'{}'", value.as_str().expect("target")))
        .collect::<Vec<_>>();
    format!("[{}]", items.join(","))
}

fn quote(value: &Value) -> String {
    value.as_str().unwrap_or_default().replace('\'', "\\'")
}

pub fn index_from_supergraph(database: &Path, supergraph: Value) -> LadybugSearchIndex {
    let store = LadybugStore::open(StoreLayout::beside(database), Duration::from_secs(30)).unwrap();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        store.run(move |connection| {
            for content in supergraph["content"].as_array().expect("content") {
                exec(connection, &format!(
                    "CREATE (:Content {{id:'{}',kind:'{}',icon:'{}',title:'{}',detail:'{}',state:'{}',published_targets:{}}})",
                    quote(&content["id"]), quote(&content["kind"]), quote(&content["icon"]),
                    quote(&content["title"]), quote(&content["detail"]), quote(&content["state"]),
                    list(&content["publishedTargets"]),
                ))?;
            }
            for layer in supergraph["layers"].as_array().expect("layers") {
                let has_layout = layer["layoutVersion"].is_number();
                let version = layer["layoutVersion"].as_i64().map_or_else(|| "NULL".into(), |v| v.to_string());
                exec(connection, &format!(
                    "CREATE (:Layer {{id:'{}',state:'{}',layout_version:{version},has_layout:{has_layout},published_targets:{}}})",
                    quote(&layer["id"]), quote(&layer["state"]), list(&layer["publishedTargets"]),
                ))?;
            }
            for edge in supergraph["edges"].as_array().expect("edges") {
                let endpoints = edge["endpoints"].as_array().expect("endpoints");
                exec(connection, &format!(
                    "MATCH (a:Content),(b:Content) WHERE a.id='{}' AND b.id='{}' CREATE (a)-[:CONNECTED {{id:'{}',state:'{}',published_targets:{}}}]->(b)",
                    quote(&endpoints[0]), quote(&endpoints[1]), quote(&edge["id"]), quote(&edge["state"]), list(&edge["publishedTargets"]),
                ))?;
            }
            for layer in supergraph["layers"].as_array().expect("layers") {
                for member in layer["members"].as_array().expect("members") {
                    let has_xy = member["x"].is_number();
                    exec(connection, &format!(
                        "MATCH (l:Layer),(n:Content) WHERE l.id='{}' AND n.id='{}' CREATE (l)-[:CONTAINS {{id:'membership:{}:{}:{}',member_order:{},x:{},y:{},has_xy:{has_xy},published_targets:{}}}]->(n)",
                        quote(&layer["id"]), quote(&member["contentId"]), layer["graphId"].as_i64().unwrap_or(0),
                        member["order"].as_i64().unwrap_or(0), quote(&member["contentId"]).trim_start_matches("content:"),
                        member["order"].as_i64().unwrap_or(0), member["x"].as_f64().unwrap_or(0.0),
                        member["y"].as_f64().unwrap_or(0.0), list(&layer["publishedTargets"]),
                    ))?;
                }
            }
            for action in supergraph["actions"].as_array().expect("actions") {
                let table = match action["relation"].as_str() {
                    Some("expand") => "EXPANDS",
                    Some("reference") => "REFERENCES",
                    _ => continue,
                };
                exec(connection, &format!(
                    "MATCH (n:Content),(l:Layer) WHERE n.id='{}' AND l.id='{}' CREATE (n)-[:{table} {{id:'{}',source_layer_id:'{}',label:'{}',variant:'{}',icon:'{}',description:'{}',relation:'{}',state:'{}',published_targets:{}}}]->(l)",
                    quote(&action["sourceContentId"]), quote(&action["targetLayerId"]), quote(&action["id"]),
                    quote(&action["sourceLayerId"]), quote(&action["label"]), quote(&action["variant"]),
                    quote(&action["icon"]), quote(&action["description"]), quote(&action["relation"]),
                    quote(&action["state"]), list(&action["publishedTargets"]),
                ))?;
            }
            Ok(())
        }).await.unwrap();
    });
    LadybugSearchIndex::from_store(store)
}

pub fn reset_endpoint_scan_count() {
    reset_endpoint_index_rows_for_test();
}

pub fn endpoint_scan_count() -> u64 {
    endpoint_index_rows_for_test()
}
