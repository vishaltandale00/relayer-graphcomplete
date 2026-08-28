use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

const DOCUMENT: &str = include_str!("../../../docs/graph-query-v1.md");
const MANIFEST: &str = include_str!("../../../fixtures/graph-query-v1/manifest.json");
const SUPERGRAPH: &str = include_str!("../../../fixtures/graph-query-v1/supergraph.json");
const POSITIVE: &str = include_str!("../../../fixtures/graph-query-v1/positive.json");
const NEGATIVE: &str = include_str!("../../../fixtures/graph-query-v1/negative.json");
const VALUES: &str = include_str!("../../../fixtures/graph-query-v1/values.json");
const LIMITS: &str = include_str!("../../../fixtures/graph-query-v1/limits.json");

fn parse(source: &str) -> Value {
    serde_json::from_str(source).unwrap()
}

fn objects<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().unwrap()
}

fn strings(value: &Value) -> BTreeSet<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

fn encoded_envelope_bytes(recipe: &Value, extra_filler_ascii_bytes: Option<usize>) -> usize {
    let mut filler_lengths = recipe["fillerAsciiBytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|length| length.as_u64().unwrap() as usize)
        .collect::<Vec<_>>();
    if let Some(extra) = extra_filler_ascii_bytes {
        filler_lengths.push(extra);
    }
    let rows = filler_lengths
        .into_iter()
        .map(|length| serde_json::json!([{ "type": "string", "value": "x".repeat(length) }]))
        .collect::<Vec<_>>();
    serde_json::to_vec(&serde_json::json!({
        "queryContractVersion": 1,
        "columns": [recipe["column"].as_str().unwrap()],
        "rows": rows,
        "truncated": recipe["truncated"].as_bool().unwrap()
    }))
    .unwrap()
    .len()
}

fn top_level_case_ids(
    supergraph: &Value,
    positive: &Value,
    negative: &Value,
    values: &Value,
    limits: &Value,
) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for items in [
        objects(supergraph, "contractAssertions"),
        objects(supergraph, "targetResultGoldens"),
        objects(supergraph, "rejectedGraphFixtures"),
        objects(positive, "cases"),
        objects(negative, "cases"),
        objects(values, "cases"),
        objects(values, "normalizationErrors"),
        objects(limits, "cases"),
    ] {
        for item in items {
            assert!(ids.insert(item["id"].as_str().unwrap().to_owned()));
        }
    }
    assert!(ids.insert(limits["budgetContract"]["id"].as_str().unwrap().to_owned()));
    ids
}

fn validate_fields(fields: &Value) {
    let mut names = BTreeSet::new();
    for field in fields.as_array().unwrap() {
        assert!(names.insert(field["name"].as_str().unwrap()));
        validate_tagged_value(&field["value"]);
    }
}

fn validate_type_descriptor(descriptor: &Value) {
    let kind = descriptor["kind"].as_str().unwrap();
    match kind {
        "null" | "boolean" | "integer" | "float" | "string" | "node" | "layer" | "relationship"
        | "path" => assert_eq!(descriptor.as_object().unwrap().len(), 1),
        "list" => validate_type_descriptor(&descriptor["elementType"]),
        "record" => {
            let mut names = BTreeSet::new();
            for field in objects(descriptor, "fields") {
                assert!(names.insert(field["name"].as_str().unwrap()));
                validate_type_descriptor(&field["type"]);
            }
        }
        other => panic!("unknown type descriptor {other}"),
    }
}

fn value_matches_descriptor(value: &Value, descriptor: &Value) -> bool {
    let kind = descriptor["kind"].as_str().unwrap();
    if value["type"] != kind {
        return false;
    }
    match kind {
        "list" => value["values"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| value_matches_descriptor(item, &descriptor["elementType"])),
        "record" => {
            let values = value["fields"].as_array().unwrap();
            let fields = descriptor["fields"].as_array().unwrap();
            values.len() == fields.len()
                && values.iter().zip(fields).all(|(value_field, type_field)| {
                    value_field["name"] == type_field["name"]
                        && value_matches_descriptor(&value_field["value"], &type_field["type"])
                })
        }
        _ => true,
    }
}

fn validate_plan_expression(expression: &Value) {
    match expression["kind"].as_str().unwrap() {
        "list" => {
            validate_type_descriptor(&expression["elementType"]);
            for item in objects(expression, "items") {
                validate_plan_expression(item);
            }
        }
        "record" => {
            let mut names = BTreeSet::new();
            for field in objects(expression, "fields") {
                assert!(names.insert(field["name"].as_str().unwrap()));
                validate_plan_expression(&field["expression"]);
            }
        }
        "aggregate" => {
            if expression["argument"]["kind"] != "all" {
                validate_plan_expression(&expression["argument"]);
            }
        }
        "property" | "binding" | "parameter" | "all" => {}
        other => panic!("unknown plan expression {other}"),
    }
}

fn validate_tagged_value(value: &Value) {
    let value_type = value["type"].as_str().unwrap();
    match value_type {
        "null" => assert!(value.get("value").is_none()),
        "boolean" => assert!(value["value"].is_boolean()),
        "integer" => {
            let encoded = value["value"].as_str().unwrap();
            let parsed = encoded.parse::<i64>().unwrap();
            assert_eq!(parsed.to_string(), encoded);
        }
        "float" => {
            let number = value["value"].as_f64().unwrap();
            assert!(number.is_finite());
            if number == 0.0 {
                assert!(number.is_sign_positive());
            }
        }
        "string" => assert!(value["value"].is_string()),
        "node" => {
            assert!(value["id"].as_str().unwrap().starts_with("content:"));
            assert_eq!(value["kind"], "Content");
            validate_fields(&value["properties"]);
        }
        "layer" => {
            assert!(value["id"].as_str().unwrap().starts_with("layer:"));
            assert_eq!(value["kind"], "Layer");
            validate_fields(&value["properties"]);
        }
        "relationship" => {
            assert!(value["id"].is_string());
            assert!(value["kind"].is_string());
            assert!(value["start"].is_string());
            assert!(value["end"].is_string());
            assert!(value["directed"].is_boolean());
            validate_fields(&value["properties"]);
            match value["kind"].as_str().unwrap() {
                "CONNECTED" => {
                    assert_eq!(value["directed"], false);
                    assert!(value["start"].as_str().unwrap() < value["end"].as_str().unwrap());
                }
                "CONTAINS" => {
                    assert_eq!(value["directed"], true);
                    assert!(value["start"].as_str().unwrap().starts_with("layer:"));
                    assert!(value["end"].as_str().unwrap().starts_with("content:"));
                }
                "EXPANDS" | "REFERENCES" => assert_eq!(value["directed"], true),
                other => panic!("unknown relationship kind {other}"),
            }
            if matches!(value["kind"].as_str(), Some("EXPANDS" | "REFERENCES")) {
                assert!(value["start"].as_str().unwrap().starts_with("content:"));
                assert!(value["end"].as_str().unwrap().starts_with("layer:"));
                let fields = value["properties"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|field| (field["name"].as_str().unwrap(), &field["value"]))
                    .collect::<BTreeMap<_, _>>();
                let names = value["properties"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|field| field["name"].as_str().unwrap())
                    .collect::<Vec<_>>();
                if fields.contains_key("source_layer_id") {
                    assert_eq!(names.first().copied(), Some("source_layer_id"));
                    assert_eq!(names.get(1).copied(), Some("label"));
                    assert_eq!(names.get(2).copied(), Some("variant"));
                } else {
                    assert_eq!(value["id"], "action:306");
                    assert_eq!(value["start"], "content:6");
                    assert_eq!(names.first().copied(), Some("label"));
                    assert_eq!(names.get(1).copied(), Some("variant"));
                }
                assert_eq!(names.get(names.len() - 2).copied(), Some("relation"));
                assert_eq!(names.last().copied(), Some("state"));
                let expected_relation = match value["kind"].as_str().unwrap() {
                    "EXPANDS" => "expand",
                    "REFERENCES" => "reference",
                    _ => unreachable!(),
                };
                assert_eq!(fields["relation"]["value"], expected_relation);
            }
        }
        "path" => {
            let vertices = value["vertices"].as_array().unwrap();
            let relationships = value["relationships"].as_array().unwrap();
            assert_eq!(vertices.len(), relationships.len() + 1);
            for vertex in vertices {
                validate_tagged_value(vertex);
                assert!(matches!(vertex["type"].as_str(), Some("node" | "layer")));
            }
            let mut relationship_ids = BTreeSet::new();
            for (index, relationship) in relationships.iter().enumerate() {
                validate_tagged_value(relationship);
                assert_eq!(relationship["type"], "relationship");
                assert!(relationship_ids.insert(relationship["id"].as_str().unwrap()));
                let left = vertices[index]["id"].as_str().unwrap();
                let right = vertices[index + 1]["id"].as_str().unwrap();
                let start = relationship["start"].as_str().unwrap();
                let end = relationship["end"].as_str().unwrap();
                assert!((start == left && end == right) || (start == right && end == left));
            }
        }
        "list" => {
            let element_type = &value["elementType"];
            validate_type_descriptor(element_type);
            for item in value["values"].as_array().unwrap() {
                validate_tagged_value(item);
                assert!(value_matches_descriptor(item, element_type));
            }
        }
        "record" => validate_fields(&value["fields"]),
        other => panic!("unknown tagged value type {other}"),
    }
}

#[test]
fn manifest_is_a_complete_inventory_of_the_frozen_contract() {
    let manifest = parse(MANIFEST);
    let supergraph = parse(SUPERGRAPH);
    let positive = parse(POSITIVE);
    let negative = parse(NEGATIVE);
    let values = parse(VALUES);
    let limits = parse(LIMITS);

    for document in [
        &manifest,
        &supergraph,
        &positive,
        &negative,
        &values,
        &limits,
    ] {
        assert_eq!(document["queryContractVersion"], 1);
    }
    assert_eq!(manifest["corpus"], "relayer.graph-query");
    assert_eq!(manifest["status"], "frozen");
    assert_eq!(
        manifest["publicCandidateSources"],
        serde_json::json!(["structural"])
    );
    assert_eq!(manifest["limits"]["defaultRows"], 5);
    assert_eq!(manifest["limits"]["hardRows"], 8);
    assert_eq!(manifest["limits"]["encodedResultBytes"], 16_384);
    assert_eq!(manifest["limits"]["maxTraversalHops"], 2);
    assert_eq!(manifest["limits"]["cursorPagination"], false);

    let required_checkpoints = BTreeSet::from([
        "grammar-and-typed-plan",
        "selector-vs-authority",
        "supergraph-and-occurrence",
        "typed-wire-algebra",
        "ordering-null-numeric-absence",
        "result-limits",
        "budgets-and-error-precedence",
        "compatibility-and-future-seam",
    ]);
    let checkpoints = objects(&manifest, "coverage")
        .iter()
        .map(|entry| entry["checkpoint"].as_str().unwrap())
        .collect::<BTreeSet<_>>();
    assert_eq!(checkpoints, required_checkpoints);

    let all_case_ids = top_level_case_ids(&supergraph, &positive, &negative, &values, &limits);
    let mut covered_ids = BTreeSet::new();
    for entry in objects(&manifest, "coverage") {
        for case_id in entry["cases"].as_array().unwrap() {
            let case_id = case_id.as_str().unwrap();
            assert!(
                all_case_ids.contains(case_id),
                "unknown coverage case {case_id}"
            );
            covered_ids.insert(case_id.to_owned());
        }
    }
    assert_eq!(
        covered_ids, all_case_ids,
        "every corpus case must be inventoried"
    );

    let mut grammar_features = BTreeSet::new();
    for feature in objects(&manifest, "grammarFeatures") {
        assert!(grammar_features.insert(feature["feature"].as_str().unwrap()));
        let cases = feature["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case_id in cases {
            assert!(
                all_case_ids.contains(case_id.as_str().unwrap()),
                "grammar feature references an unknown case"
            );
        }
    }
    assert_eq!(
        grammar_features.len(),
        27,
        "the admitted feature inventory is closed"
    );

    let budget_dimensions = strings(&manifest["budgetDimensions"]);
    let limit_dimensions = objects(&limits["budgetContract"], "dimensions")
        .iter()
        .map(|dimension| dimension["name"].as_str().unwrap().to_owned())
        .collect::<BTreeSet<_>>();
    assert_eq!(budget_dimensions, limit_dimensions);
    assert_eq!(budget_dimensions.len(), 11);

    assert!(DOCUMENT.contains("does not claim compatibility with complete Cypher or ISO GQL"));
    assert!(DOCUMENT.contains("MATCH (n)` is rejected as type-ambiguous"));
    assert!(DOCUMENT.contains("top-level `RETURN [] AS values`"));
    assert!(DOCUMENT.contains("membership:101:0:1"));
    assert!(DOCUMENT.contains("future vector or late-interaction source"));
}

#[test]
fn canonical_supergraph_freezes_identity_occurrence_and_exclusions() {
    let graph = parse(SUPERGRAPH);
    let content_graph_ids = objects(&graph, "content")
        .iter()
        .map(|content| {
            (
                content["id"].as_str().unwrap(),
                content["graphId"].as_i64().unwrap(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let content_kinds = objects(&graph, "content")
        .iter()
        .map(|content| {
            (
                content["id"].as_str().unwrap(),
                content["kind"].as_str().unwrap(),
            )
        })
        .collect::<BTreeMap<_, _>>();

    let mut projected = BTreeSet::new();
    for edge in objects(&graph, "edges") {
        let endpoints = edge["endpoints"].as_array().unwrap();
        assert!(endpoints[0].as_str().unwrap() < endpoints[1].as_str().unwrap());
        assert_eq!(edge["state"], "accepted");
        assert!(projected.insert(edge["id"].as_str().unwrap().to_owned()));
    }

    let mut memberships_by_content: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for layer in objects(&graph, "layers") {
        let layer_graph_id = layer["graphId"].as_i64().unwrap();
        for member in objects(layer, "members") {
            let content_id = member["contentId"].as_str().unwrap();
            let content_graph_id = content_graph_ids[content_id];
            let order = member["order"].as_u64().unwrap();
            let membership_id = format!("membership:{layer_graph_id}:{order}:{content_graph_id}");
            assert!(projected.insert(membership_id));
            memberships_by_content
                .entry(content_id)
                .or_default()
                .insert(layer["id"].as_str().unwrap());
            if layer.get("layoutVersion").is_some() {
                assert!(member["x"].is_number());
                assert!(member["y"].is_number());
            } else {
                assert!(member.get("x").is_none());
                assert!(member.get("y").is_none());
            }
        }
    }
    assert_eq!(
        memberships_by_content["content:1"],
        BTreeSet::from(["layer:101", "layer:102", "layer:106"])
    );

    let mut excluded_actions = BTreeSet::new();
    let mut occurrence_sources = BTreeMap::new();
    for action in objects(&graph, "actions") {
        let action_id = action["id"].as_str().unwrap().to_owned();
        let is_occurrence_action = action["sourceLayerId"].is_string();
        let is_root_action = action["sourceLayerId"].is_null()
            && action["relation"] == "expand"
            && content_kinds[action["sourceContentId"].as_str().unwrap()] == "user-interaction";
        if action["kind"] == "navigate"
            && matches!(action["relation"].as_str(), Some("expand" | "reference"))
            && (is_occurrence_action || is_root_action)
        {
            assert!(projected.insert(action_id.clone()));
            if is_occurrence_action {
                occurrence_sources.insert(action_id, action["sourceLayerId"].as_str().unwrap());
            }
        } else {
            excluded_actions.insert(action_id);
        }
    }
    assert_eq!(occurrence_sources["action:301"], "layer:101");
    assert_eq!(occurrence_sources["action:302"], "layer:102");
    assert_eq!(
        excluded_actions,
        strings(&graph["expectedProjection"]["excludedActionIds"])
    );
    assert_eq!(
        projected,
        strings(&graph["expectedProjection"]["relationshipIds"])
    );
    assert!(
        objects(&graph, "excludedRecords")
            .iter()
            .all(|record| record["state"] != "accepted")
    );

    for record in objects(&graph, "layers")
        .iter()
        .chain(objects(&graph, "edges"))
        .chain(objects(&graph, "actions"))
    {
        assert!(record.get("projectId").is_some());
        assert!(record["threadId"].as_i64().unwrap() > 0);
        assert!(!record["publishedTargets"].as_array().unwrap().is_empty());
    }

    for record in objects(&graph, "content")
        .iter()
        .chain(objects(&graph, "layers"))
        .chain(objects(&graph, "edges"))
        .chain(objects(&graph, "actions"))
    {
        let targets = strings(&record["publishedTargets"]);
        let origin_thread = record["threadId"].as_i64().unwrap();
        assert!(targets.contains(&format!("thread:{origin_thread}")));
        if let Some(project_id) = record["projectId"].as_i64() {
            assert!(targets.contains(&format!("project:{project_id}")));
        } else {
            assert_eq!(targets, BTreeSet::from([format!("thread:{origin_thread}")]));
        }
    }
    let reused = objects(&graph, "content")
        .iter()
        .find(|content| content["id"] == "content:1")
        .unwrap();
    assert_eq!(reused["threadId"], 41);
    assert!(strings(&reused["publishedTargets"]).contains("thread:42"));
    let reuse_layer = objects(&graph, "layers")
        .iter()
        .find(|layer| layer["id"] == "layer:106")
        .unwrap();
    assert!(
        reuse_layer["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|member| member["contentId"] == "content:1")
    );

    let published = |record: &Value, target: &str| {
        record["publishedTargets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == target)
    };
    for (target, expected) in graph["expectedTargets"].as_object().unwrap() {
        let content_ids = objects(&graph, "content")
            .iter()
            .filter(|record| published(record, target))
            .map(|record| record["id"].as_str().unwrap().to_owned())
            .collect::<BTreeSet<_>>();
        let layer_ids = objects(&graph, "layers")
            .iter()
            .filter(|record| published(record, target))
            .map(|record| record["id"].as_str().unwrap().to_owned())
            .collect::<BTreeSet<_>>();
        assert_eq!(content_ids, strings(&expected["contentIds"]));
        assert_eq!(layer_ids, strings(&expected["layerIds"]));

        let edge_ids = objects(&graph, "edges")
            .iter()
            .filter(|edge| {
                published(edge, target)
                    && edge["endpoints"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|endpoint| content_ids.contains(endpoint.as_str().unwrap()))
            })
            .map(|edge| edge["id"].as_str().unwrap().to_owned())
            .collect::<BTreeSet<_>>();
        assert_eq!(edge_ids, strings(&expected["edgeIds"]));

        let action_ids = objects(&graph, "actions")
            .iter()
            .filter(|action| {
                published(action, target)
                    && action["kind"] == "navigate"
                    && content_ids.contains(action["sourceContentId"].as_str().unwrap())
                    && layer_ids.contains(action["targetLayerId"].as_str().unwrap())
            })
            .map(|action| action["id"].as_str().unwrap().to_owned())
            .collect::<BTreeSet<_>>();
        assert_eq!(action_ids, strings(&expected["actionIds"]));

        let mut membership_ids = BTreeSet::new();
        for layer in objects(&graph, "layers")
            .iter()
            .filter(|layer| published(layer, target))
        {
            let layer_id = layer["graphId"].as_i64().unwrap();
            for member in layer["members"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|member| content_ids.contains(member["contentId"].as_str().unwrap()))
            {
                membership_ids.insert(format!(
                    "membership:{layer_id}:{}:{}",
                    member["order"].as_u64().unwrap(),
                    content_graph_ids[member["contentId"].as_str().unwrap()]
                ));
            }
        }
        assert_eq!(membership_ids, strings(&expected["membershipIds"]));
    }

    let content_by_id = objects(&graph, "content")
        .iter()
        .map(|content| (content["id"].as_str().unwrap(), content))
        .collect::<BTreeMap<_, _>>();
    for golden in objects(&graph, "targetResultGoldens") {
        let target = golden["target"].as_str().unwrap();
        let mut titles = content_by_id
            .values()
            .filter(|content| published(content, target))
            .map(|content| content["title"].as_str().unwrap())
            .collect::<Vec<_>>();
        titles.sort_unstable();
        let matched = titles.len();
        titles.truncate(5);
        assert_eq!(
            titles,
            golden["titles"]
                .as_array()
                .unwrap()
                .iter()
                .map(|title| title.as_str().unwrap())
                .collect::<Vec<_>>()
        );
        assert_eq!(golden["truncated"], matched > 5);
        if let Some(expected_matched) = golden.get("matchedRows") {
            assert_eq!(matched as u64, expected_matched.as_u64().unwrap());
        }
        if let Some(origins) = golden.get("originThreadByTitle") {
            for (title, expected_thread) in origins.as_object().unwrap() {
                let content = content_by_id
                    .values()
                    .find(|content| content["title"] == title.as_str())
                    .unwrap();
                assert_eq!(content["threadId"], *expected_thread);
            }
        }
    }

    for fixture in objects(&graph, "rejectedGraphFixtures") {
        match fixture["id"].as_str().unwrap() {
            "graph-edge-self-loop-rejected" => assert_eq!(
                fixture["edge"]["endpoints"][0],
                fixture["edge"]["endpoints"][1]
            ),
            "graph-edge-parallel-rejected" => {
                let mut existing = fixture["existing"]["endpoints"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_str().unwrap())
                    .collect::<Vec<_>>();
                let mut candidate = fixture["candidate"]["endpoints"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_str().unwrap())
                    .collect::<Vec<_>>();
                existing.sort_unstable();
                candidate.sort_unstable();
                assert_eq!(existing, candidate);
            }
            other => panic!("unconsumed rejected graph fixture {other}"),
        }
    }

    let assertions = objects(&graph, "contractAssertions")
        .iter()
        .map(|assertion| assertion["id"].as_str().unwrap())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        assertions,
        BTreeSet::from([
            "connected-is-canonical",
            "excluded-topology",
            "foreign-draft-excluded",
            "root-action-projected"
        ])
    );
}

#[test]
fn positive_goldens_have_closed_plans_and_well_typed_results() {
    let manifest = parse(MANIFEST);
    let graph = parse(SUPERGRAPH);
    let positive = parse(POSITIVE);
    let allowed_relationships = strings(&manifest["requiredRelationshipTypes"]);
    let mut observed_relationships = BTreeSet::new();
    let mut case_ids = BTreeSet::new();

    for case in objects(&positive, "cases") {
        assert!(case_ids.insert(case["id"].as_str().unwrap()));
        assert!(
            case["query"]
                .as_str()
                .is_some_and(|query| !query.is_empty())
        );
        assert!(matches!(
            case["target"]["scope"].as_str(),
            Some("thread" | "project")
        ));
        assert!(case["target"]["id"].as_i64().is_some_and(|id| id > 0));

        let plan = &case["expectedPlan"];
        assert_eq!(plan["queryContractVersion"], 1);
        assert_eq!(plan["candidateSource"], "structural");
        assert!(plan["maxTraversalHops"].as_u64().unwrap() <= 2);
        let mut relationships = Vec::new();
        let mut content_bindings = BTreeSet::new();
        for pattern in objects(plan, "patterns") {
            assert!(pattern["relationships"].as_array().unwrap().len() <= 2);
            for node in objects(pattern, "nodes") {
                if node["label"] == "Content" {
                    content_bindings.insert(node["binding"].as_str().unwrap());
                }
            }
            for relationship in objects(pattern, "relationships") {
                let relationship_type = relationship["type"].as_str().unwrap();
                assert!(allowed_relationships.contains(relationship_type));
                observed_relationships.insert(relationship_type.to_owned());
                relationships.push(relationship);
            }
        }
        let has_occurrence_join = relationships.iter().any(|contains| {
            contains["type"] == "CONTAINS"
                && content_bindings.contains(contains["to"].as_str().unwrap())
                && relationships.iter().any(|navigation| {
                    matches!(navigation["type"].as_str(), Some("EXPANDS" | "REFERENCES"))
                        && navigation["from"] == contains["to"]
                })
        });
        assert_eq!(
            plan["requiresOccurrenceConstraint"].as_bool().unwrap(),
            has_occurrence_join
        );

        let result = &case["expectedResult"];
        for column in objects(&plan["projection"], "columns") {
            validate_plan_expression(&column["expression"]);
        }
        assert_eq!(result["queryContractVersion"], 1);
        let columns = result["columns"].as_array().unwrap();
        assert_eq!(
            columns
                .iter()
                .map(|column| column.as_str().unwrap())
                .collect::<BTreeSet<_>>()
                .len(),
            columns.len()
        );
        let rows = result["rows"].as_array().unwrap();
        assert!(rows.len() <= 8);
        assert!(result["truncated"].is_boolean());
        for row in rows {
            assert_eq!(row.as_array().unwrap().len(), columns.len());
            for value in row.as_array().unwrap() {
                validate_tagged_value(value);
            }
        }

        if case.get("permutationInvariant").is_some() {
            let titles = rows
                .iter()
                .map(|row| row[0]["value"].as_str().unwrap())
                .collect::<Vec<_>>();
            let mut sorted = titles.clone();
            sorted.sort_unstable();
            assert_eq!(titles, sorted);
        }
        if let Some(false_match) = case.get("forbiddenFalseMatch") {
            let action = objects(&graph, "actions")
                .iter()
                .find(|action| action["id"] == false_match["actionId"])
                .unwrap();
            assert_ne!(action["sourceLayerId"], false_match["sourceLayerId"]);
            assert!(rows.iter().all(|row| {
                row.as_array().unwrap().iter().all(|value| {
                    value.get("id") != Some(&false_match["actionId"])
                        || value["properties"].as_array().unwrap().iter().any(|field| {
                            field["name"] == "source_layer_id"
                                && field["value"]["value"] == action["sourceLayerId"]
                        })
                })
            }));
        }
    }

    assert_eq!(observed_relationships, allowed_relationships);
    assert_eq!(case_ids.len(), objects(&positive, "cases").len());
    assert_eq!(manifest["pathMatchMode"], "relationship_unique_trail");

    let by_id = objects(&positive, "cases")
        .iter()
        .map(|case| (case["id"].as_str().unwrap(), case))
        .collect::<BTreeMap<_, _>>();
    assert!(
        by_id["reverse-edge-reuse-no-match"]["expectedResult"]["rows"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let reverse_reuse_relationships =
        &by_id["reverse-edge-reuse-no-match"]["expectedPlan"]["patterns"][0]["relationships"];
    assert_eq!(reverse_reuse_relationships.as_array().unwrap().len(), 2);
    assert_eq!(reverse_reuse_relationships[0]["type"], "CONNECTED");
    assert_eq!(reverse_reuse_relationships[1]["type"], "CONNECTED");
    assert_eq!(
        reverse_reuse_relationships[0]["from"],
        reverse_reuse_relationships[1]["to"]
    );
    assert_eq!(
        reverse_reuse_relationships[0]["to"],
        reverse_reuse_relationships[1]["from"]
    );
    let reverse_path = &by_id["reverse-directed-path"]["expectedResult"]["rows"][0][0];
    assert_eq!(reverse_path["vertices"][0]["id"], "content:1");
    assert_eq!(reverse_path["vertices"][1]["id"], "layer:101");
    assert_eq!(reverse_path["relationships"][0]["start"], "layer:101");
    assert_eq!(reverse_path["relationships"][0]["end"], "content:1");

    let project_content_count = graph["expectedTargets"]["project:7"]["contentIds"]
        .as_array()
        .unwrap()
        .len()
        .to_string();
    assert_eq!(
        by_id["project-selector"]["expectedResult"]["rows"][0][0]["value"],
        project_content_count
    );
}

#[test]
fn tagged_value_goldens_are_lossless_and_canonical() {
    let values = parse(VALUES);
    for case in objects(&values, "cases") {
        if let Some(value) = case.get("value") {
            validate_tagged_value(value);
        }
        if let Some(items) = case.get("values") {
            for value in items.as_array().unwrap() {
                validate_tagged_value(value);
            }
        }
    }
    let cases = objects(&values, "cases")
        .iter()
        .map(|case| (case["id"].as_str().unwrap(), case))
        .collect::<BTreeMap<_, _>>();

    let all_types = cases["all-wire-types"]["values"].as_array().unwrap();
    let observed_type_order = all_types
        .iter()
        .map(|value| value["type"].as_str().unwrap())
        .collect::<Vec<_>>();
    let expected_type_order = values["canonicalTypeOrder"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(observed_type_order, expected_type_order);
    for value in all_types {
        validate_tagged_value(value);
    }

    for value in cases["i64-extrema"]["values"].as_array().unwrap() {
        validate_tagged_value(value);
    }
    for spelling in cases["i64-extrema"]["rejectedSpellings"]
        .as_array()
        .unwrap()
    {
        let spelling = spelling.as_str().unwrap();
        assert!(match spelling.parse::<i64>() {
            Ok(parsed) => parsed.to_string() != spelling,
            Err(_) => true,
        });
    }

    validate_tagged_value(&cases["negative-zero"]["canonical"]);
    validate_tagged_value(&cases["nested-record-list-path"]["value"]);
    validate_tagged_value(&cases["typed-empty-list-parameter"]["value"]);
    assert!(
        cases["typed-empty-list-parameter"]["value"]["values"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    validate_tagged_value(&cases["typed-empty-nested-list"]["value"]);
    validate_tagged_value(&cases["homogeneous-record-list"]["value"]);

    let record_shape_error = objects(&values, "normalizationErrors")
        .iter()
        .find(|error| error["id"] == "reject-record-shape-list")
        .unwrap();
    validate_type_descriptor(&record_shape_error["descriptor"]);
    let inputs = record_shape_error["input"].as_array().unwrap();
    assert!(value_matches_descriptor(
        &inputs[0],
        &record_shape_error["descriptor"]
    ));
    assert!(!value_matches_descriptor(
        &inputs[1],
        &record_shape_error["descriptor"]
    ));
}

#[test]
fn rejection_and_limit_goldens_freeze_errors_and_precedence() {
    let manifest = parse(MANIFEST);
    let negative = parse(NEGATIVE);
    let values = parse(VALUES);
    let limits = parse(LIMITS);
    let allowed_phases = BTreeSet::from([
        "envelope",
        "parse",
        "plan",
        "authorize",
        "execute",
        "normalize",
        "encode",
    ]);
    let allowed_codes = strings(&manifest["errorCodes"]);
    for code in &allowed_codes {
        assert!(
            DOCUMENT.contains(code),
            "normative document omits error code {code}"
        );
    }
    let mut negative_by_id = BTreeMap::new();
    for case in objects(&negative, "cases") {
        let error = &case["expectedError"];
        assert!(allowed_codes.contains(error["code"].as_str().unwrap()));
        assert!(allowed_phases.contains(error["phase"].as_str().unwrap()));
        negative_by_id.insert(case["id"].as_str().unwrap(), case);
    }
    for error in objects(&values, "normalizationErrors") {
        assert_eq!(error["expectedError"]["phase"], "normalize");
        assert!(allowed_codes.contains(error["expectedError"]["code"].as_str().unwrap()));
    }
    for dimension in objects(&limits["budgetContract"], "dimensions") {
        assert!(allowed_codes.contains(dimension["failureCode"].as_str().unwrap()));
        assert!(allowed_phases.contains(dimension["phase"].as_str().unwrap()));
    }
    assert_eq!(
        negative_by_id["parse-before-authorize"]["expectedError"]["phase"],
        "parse"
    );
    assert_eq!(
        negative_by_id["plan-before-authorize"]["expectedError"]["phase"],
        "plan"
    );
    assert_eq!(
        negative_by_id["cancel-before-time"]["expectedError"]["code"],
        "query_cancelled"
    );
    assert_eq!(
        negative_by_id["time-before-expansions"]["expectedError"]["code"],
        "wall_time_exceeded"
    );
    assert_eq!(
        negative_by_id["reject-unlabeled-zero-hop"]["expectedError"]["code"],
        "query_type_mismatch"
    );
    assert_eq!(
        negative_by_id["reject-untyped-empty-list"]["expectedError"]["code"],
        "query_type_mismatch"
    );

    let precedence = manifest["errorPrecedence"].as_array().unwrap();
    assert_eq!(precedence.first().unwrap(), "envelope");
    assert_eq!(precedence.last().unwrap(), "encode");

    for case in objects(&limits, "cases") {
        let explicit_limit = case["explicitLimit"].as_u64();
        if explicit_limit.is_some_and(|limit| limit > 8) {
            assert_eq!(case["expectedError"]["code"], "row_limit_exceeded");
            assert!(allowed_codes.contains(case["expectedError"]["code"].as_str().unwrap()));
            continue;
        }
        assert!(case["returnedRows"].as_u64().unwrap() <= explicit_limit.unwrap_or(5));
        if let Some(recipe) = case.get("canonicalEnvelopeRecipe") {
            let encoded = encoded_envelope_bytes(recipe, None);
            assert_eq!(
                encoded as u64,
                case["expectedCanonicalEncodedBytes"].as_u64().unwrap()
            );
            assert!(encoded <= 16_384);
            if let Some(next_row) = case.get("nextRowFillerAsciiBytes") {
                let with_next =
                    encoded_envelope_bytes(recipe, Some(next_row.as_u64().unwrap() as usize));
                assert_eq!(
                    with_next as u64,
                    case["expectedWithNextRowEncodedBytes"].as_u64().unwrap()
                );
                assert!(with_next > 16_384);
            }
        }
        if let Some(recipe) = case.get("singleRowEnvelopeRecipe") {
            let encoded = encoded_envelope_bytes(recipe, None);
            assert_eq!(
                encoded as u64,
                case["expectedSingleRowEnvelopeBytes"].as_u64().unwrap()
            );
            assert!(encoded > 16_384);
            assert_eq!(case["expectedError"]["code"], "result_row_too_large");
            assert!(allowed_codes.contains(case["expectedError"]["code"].as_str().unwrap()));
        }
        if case["matchedRows"].as_u64().unwrap() > case["returnedRows"].as_u64().unwrap()
            && case["expectedError"].is_null()
        {
            assert_eq!(case["truncated"], true);
        }
    }

    assert_eq!(limits["defaultRows"], 5);
    assert_eq!(limits["hardRows"], 8);
    assert_eq!(limits["encodedResultBytes"], 16_384);
    assert_eq!(limits["budgetContract"]["callerMayLower"], true);
    assert_eq!(limits["budgetContract"]["callerMayRaise"], false);
    assert_eq!(limits["budgetContract"]["limitAffectsWorkBudgets"], false);
}
