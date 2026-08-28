use lbug::{Connection, Database, InternalID, LogicalType, NodeVal, RelVal, SystemConfig, Value};
use serde_json::{json, Value as JsonValue};
use std::collections::BTreeMap;
use std::path::Path;

type ProbeResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const POSITIVE_CASES: &[(&str, &str, &[&str], usize)] = &[
    ("whole-target-scan", "MATCH (n:Content) WHERE n.t41 RETURN n.title AS title ORDER BY title LIMIT 6", &["title"], 5),
    ("thread-selector", "MATCH (n:Content) WHERE n.t41 AND n.title = 'Queue' RETURN n.title AS title LIMIT 6", &["title"], 5),
    ("project-selector", "MATCH (n:Content) WHERE n.p7 RETURN count(n) AS count LIMIT 6", &["count"], 5),
    ("one-hop-connected", "MATCH p=(a:Content)-[r:CONNECTED]-(b:Content) WHERE r.t41 AND a.title = 'Queue' RETURN p AS path LIMIT 6", &["path"], 5),
    ("two-hop-connected", "MATCH (a:Content)-[r1:CONNECTED]-(b:Content)-[r2:CONNECTED]-(c:Content) WHERE r1.p7 AND r2.p7 AND r1.id <> r2.id AND a.title = 'Queue' RETURN c.title AS title LIMIT 6", &["title"], 5),
    ("layer-action-path", "MATCH p=(l:Layer)-[m:CONTAINS]->(n:Content)-[a:EXPANDS]->(child:Layer) WHERE m.t41 AND a.t41 AND l.state = 'accepted' AND a.source_layer_id = l.id RETURN p AS path LIMIT 6", &["path"], 5),
    ("reused-content-occurrence", "MATCH (l:Layer)-[m:CONTAINS]->(n:Content)-[a:REFERENCES]->(target:Layer) WHERE m.t41 AND a.t41 AND l.layout_version = 1 AND a.source_layer_id = l.id RETURN l AS source, a AS action LIMIT 6", &["source", "action"], 5),
    ("membership-placement", "MATCH (l:Layer)-[m:CONTAINS]->(n:Content) WHERE m.t41 AND n.title = 'Queue' RETURN m.member_order AS member_order, m.x AS x, m.y AS y ORDER BY member_order LIMIT 6", &["order", "x", "y"], 5),
    ("connected-no-double-count", "MATCH (a:Content)-[r:CONNECTED]-(b:Content) WHERE r.p7 AND a.id < b.id RETURN count(r) AS count LIMIT 6", &["count"], 5),
    ("explicit-order-null-last", "MATCH (l:Layer) WHERE l.p7 RETURN l.layout_version AS version ORDER BY l.has_layout DESC, version ASC LIMIT 6", &["version"], 5),
    ("implicit-canonical-order", "MATCH (n:Content) WHERE n.t41 RETURN n.title AS title ORDER BY title LIMIT 6", &["title"], 5),
    ("property-absence", "MATCH (l:Layer) WHERE l.p7 AND NOT l.has_layout RETURN l AS layer LIMIT 6", &["layer"], 5),
    ("distinct-list-record-comparisons-comment-semicolon", "MATCH (n:Content) WHERE n.t41 AND n.title = 'Queue' AND n.title <> 'Worker' AND n.title > 'A' AND n.title >= 'Queue' AND n.title < 'Z' AND n.title <= 'Queue' RETURN DISTINCT [n.title,n.kind] AS pair, {title:n.title,kind:n.kind} AS item, [[n.title],[]] AS nested LIMIT 6", &["pair", "item", "nested"], 5),
    ("aggregate-allowlist", "MATCH (l:Layer)-[m:CONTAINS]->(n:Content) WHERE m.p7 RETURN count(*) AS count_all, count(DISTINCT m.id) AS count_distinct, min(m.member_order) AS min_order, max(m.member_order) AS max_order, sum(m.member_order) AS sum_order, avg(m.member_order) AS avg_order, list_sort(collect(m.member_order)) AS orders LIMIT 6", &["count_all", "count", "min", "max", "sum", "avg", "orders"], 5),
    ("reverse-directed-limit-parameter-null-test", "MATCH (n:Content)<-[m:CONTAINS]-(l:Layer) WHERE m.p7 AND m.has_xy AND m.y > 0.0 RETURN n.title AS title ORDER BY title DESC LIMIT 3", &["title"], 2),
    ("reverse-directed-path", "MATCH p=(n:Content)<-[m:CONTAINS]-(l:Layer) WHERE m.t41 AND n.title = 'Queue' RETURN p AS path ORDER BY l.id LIMIT 2", &["path"], 1),
    ("disconnected-contains-navigation-no-occurrence-constraint", "MATCH (l:Layer)-[m:CONTAINS]->(member:Content), (source:Content)-[a:EXPANDS]->(target:Layer) WHERE m.t41 AND a.t41 AND member.title = 'Evidence' AND source.title = 'Queue' RETURN member.title AS member, target AS target LIMIT 6", &["member", "target"], 5),
    ("root-action-query", "MATCH (interaction:Content)-[a:EXPANDS]->(root:Layer) WHERE a.t41 AND interaction.kind = 'user-interaction' AND a.source_layer_id = '' RETURN a AS action LIMIT 6", &["action"], 5),
    ("reverse-edge-reuse-no-match", "MATCH p=(a:Content)-[out:CONNECTED]-(b:Content)-[back:CONNECTED]-(a) WHERE out.t41 AND back.t41 AND out.id <> back.id AND a.title = 'Queue' RETURN p AS path LIMIT 6", &["path"], 5),
    ("structural-candidate-source", "MATCH (n:Content) WHERE n.t41 RETURN n.kind AS kind ORDER BY n.id LIMIT 2", &["kind"], 1),
];

fn rows(conn: &Connection<'_>, query: &str) -> ProbeResult<Vec<Vec<Value>>> {
    let prepared = conn.prepare(query)?;
    if !prepared.is_read_only() {
        return Err(format!("query was not parsed read-only: {query}").into());
    }
    let mut result = conn.query(query)?;
    Ok((&mut result).map(|row| row.to_vec()).collect())
}

fn property<'a>(properties: &'a [(String, Value)], name: &str) -> ProbeResult<&'a Value> {
    properties
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .ok_or_else(|| format!("missing physical property {name}").into())
}

fn string_property(properties: &[(String, Value)], name: &str) -> ProbeResult<String> {
    match property(properties, name)? {
        Value::String(value) => Ok(value.clone()),
        value => Err(format!("physical property {name} was not a string: {value:?}").into()),
    }
}

fn list_descriptor(logical_type: &LogicalType) -> ProbeResult<JsonValue> {
    Ok(match logical_type {
        LogicalType::String => json!({"kind": "string"}),
        LogicalType::Int64 => json!({"kind": "integer"}),
        LogicalType::Double | LogicalType::Float => json!({"kind": "float"}),
        LogicalType::Bool => json!({"kind": "boolean"}),
        LogicalType::Node => json!({"kind": "node"}),
        LogicalType::Rel => json!({"kind": "relationship"}),
        LogicalType::RecursiveRel => json!({"kind": "path"}),
        LogicalType::List { child_type } => {
            json!({"kind": "list", "elementType": list_descriptor(child_type)?})
        }
        LogicalType::Struct { fields } => json!({
            "kind": "record",
            "fields": fields.iter().map(|(name, value)| Ok(json!({
                "name": name,
                "type": list_descriptor(value)?,
            }))).collect::<ProbeResult<Vec<_>>>()?,
        }),
        other => return Err(format!("unsupported v1 list descriptor: {other:?}").into()),
    })
}

fn normalize_node(node: &NodeVal) -> ProbeResult<JsonValue> {
    let properties = node.get_properties();
    let id = string_property(properties, "id")?;
    let (value_type, public_names) = match node.get_label_name().as_str() {
        "Content" => ("node", &["kind", "icon", "title", "detail", "state"][..]),
        "Layer" => ("layer", &["state", "layout_version"][..]),
        label => return Err(format!("unexpected node label {label}").into()),
    };
    let mut public_properties = Vec::new();
    for name in public_names {
        if *name == "layout_version"
            && matches!(property(properties, "has_layout")?, Value::Bool(false))
        {
            continue;
        }
        public_properties.push(json!({
            "name": name,
            "value": normalize_value(property(properties, name)?, &BTreeMap::new())?,
        }));
    }
    Ok(json!({
        "type": value_type,
        "id": id,
        "kind": node.get_label_name(),
        "properties": public_properties,
    }))
}

fn normalize_relationship(
    relationship: &RelVal,
    endpoint_ids: &BTreeMap<InternalID, String>,
) -> ProbeResult<JsonValue> {
    let properties = relationship.get_properties();
    let id = string_property(properties, "id")?;
    let kind = relationship.get_label_name().as_str();
    let mut start = endpoint_ids
        .get(relationship.get_src_node())
        .ok_or("relationship source identity was not indexed")?
        .clone();
    let mut end = endpoint_ids
        .get(relationship.get_dst_node())
        .ok_or("relationship destination identity was not indexed")?
        .clone();
    let directed = kind != "CONNECTED";
    if !directed && start > end {
        std::mem::swap(&mut start, &mut end);
    }
    let names: &[(&str, &str)] = match kind {
        "CONNECTED" => &[("state", "state")],
        "CONTAINS" => &[("order", "member_order"), ("x", "x"), ("y", "y")],
        "EXPANDS" | "REFERENCES" => &[
            ("source_layer_id", "source_layer_id"),
            ("label", "label"),
            ("variant", "variant"),
            ("icon", "icon"),
            ("description", "description"),
            ("relation", "relation"),
            ("state", "state"),
        ],
        other => return Err(format!("unexpected relationship kind {other}").into()),
    };
    let has_xy =
        !matches!(kind, "CONTAINS") || matches!(property(properties, "has_xy")?, Value::Bool(true));
    let mut public_properties = Vec::new();
    for (public_name, physical_name) in names {
        if kind == "CONTAINS" && !has_xy && matches!(*public_name, "x" | "y") {
            continue;
        }
        let value = property(properties, physical_name)?;
        if matches!(value, Value::String(value) if value.is_empty()) {
            continue;
        }
        public_properties.push(json!({
            "name": public_name,
            "value": normalize_value(value, endpoint_ids)?,
        }));
    }
    Ok(json!({
        "type": "relationship",
        "id": id,
        "kind": kind,
        "start": start,
        "end": end,
        "directed": directed,
        "properties": public_properties,
    }))
}

fn normalize_value(
    value: &Value,
    endpoint_ids: &BTreeMap<InternalID, String>,
) -> ProbeResult<JsonValue> {
    Ok(match value {
        Value::Null(_) => json!({"type": "null"}),
        Value::Bool(value) => json!({"type": "boolean", "value": value}),
        Value::Int64(value) => json!({"type": "integer", "value": value.to_string()}),
        Value::Int128(value) => {
            let value = i64::try_from(*value).map_err(|_| "engine integer exceeded i64")?;
            json!({"type": "integer", "value": value.to_string()})
        }
        Value::Double(value) => {
            if !value.is_finite() {
                return Err("engine returned a nonfinite float".into());
            }
            let value = if *value == 0.0 { 0.0 } else { *value };
            json!({"type": "float", "value": value})
        }
        Value::Float(value) => {
            if !value.is_finite() {
                return Err("engine returned a nonfinite float".into());
            }
            let value = if *value == 0.0 { 0.0 } else { *value };
            json!({"type": "float", "value": value})
        }
        Value::String(value) => json!({"type": "string", "value": value}),
        Value::List(logical_type, values) => json!({
            "type": "list",
            "elementType": list_descriptor(logical_type)?,
            "values": values.iter().map(|value| normalize_value(value, endpoint_ids)).collect::<ProbeResult<Vec<_>>>()?,
        }),
        Value::Struct(fields) => json!({
            "type": "record",
            "fields": fields.iter().map(|(name, value)| Ok(json!({
                "name": name,
                "value": normalize_value(value, endpoint_ids)?,
            }))).collect::<ProbeResult<Vec<_>>>()?,
        }),
        Value::Node(node) => normalize_node(node)?,
        Value::Rel(relationship) => normalize_relationship(relationship, endpoint_ids)?,
        Value::RecursiveRel { nodes, rels } => json!({
            "type": "path",
            "vertices": nodes.iter().map(normalize_node).collect::<ProbeResult<Vec<_>>>()?,
            "relationships": rels.iter().map(|relationship| normalize_relationship(relationship, endpoint_ids)).collect::<ProbeResult<Vec<_>>>()?,
        }),
        other => return Err(format!("unsupported v1 engine value: {other:?}").into()),
    })
}

fn endpoint_index(conn: &Connection<'_>) -> ProbeResult<BTreeMap<InternalID, String>> {
    let mut index = BTreeMap::new();
    for query in ["MATCH (n:Content) RETURN n", "MATCH (n:Layer) RETURN n"] {
        for row in rows(conn, query)? {
            let Value::Node(node) = &row[0] else {
                return Err("endpoint index query returned a non-node".into());
            };
            index.insert(
                node.get_node_id().clone(),
                string_property(node.get_properties(), "id")?,
            );
        }
    }
    Ok(index)
}

fn expected_results() -> ProbeResult<BTreeMap<String, JsonValue>> {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../../fixtures/graph-query-v1/positive.json"
    ))?;
    let mut expected = BTreeMap::new();
    for case in fixture["cases"]
        .as_array()
        .ok_or("positive cases missing")?
    {
        expected.insert(
            case["id"]
                .as_str()
                .ok_or("positive case id missing")?
                .into(),
            case["expectedResult"].clone(),
        );
    }
    Ok(expected)
}

fn execute_positive_case(
    conn: &Connection<'_>,
    query: &str,
    columns: &[&str],
    row_cap: usize,
    endpoint_ids: &BTreeMap<InternalID, String>,
) -> ProbeResult<JsonValue> {
    let prepared = conn.prepare(query)?;
    if !prepared.is_read_only() {
        return Err(format!("query was not parsed read-only: {query}").into());
    }
    let mut result = conn.query(query)?;
    if result.get_column_names().len() != columns.len() {
        return Err(format!("engine returned the wrong column count for {query}").into());
    }
    let mut normalized_rows = (&mut result)
        .map(|row| {
            row.iter()
                .map(|value| normalize_value(value, endpoint_ids))
                .collect::<ProbeResult<Vec<_>>>()
        })
        .collect::<ProbeResult<Vec<_>>>()?;
    let truncated = normalized_rows.len() > row_cap;
    normalized_rows.truncate(row_cap);
    Ok(json!({
        "queryContractVersion": 1,
        "columns": columns,
        "rows": normalized_rows,
        "truncated": truncated,
    }))
}

fn exec(conn: &Connection<'_>, query: &str) -> ProbeResult {
    conn.query(query)?;
    Ok(())
}

fn create_schema(conn: &Connection<'_>) -> ProbeResult {
    exec(conn, "CREATE NODE TABLE Content(id STRING, kind STRING, icon STRING, title STRING, detail STRING, state STRING, p7 BOOL, t41 BOOL, t42 BOOL, t99 BOOL, PRIMARY KEY(id))")?;
    exec(conn, "CREATE NODE TABLE Layer(id STRING, state STRING, layout_version INT64, has_layout BOOL, p7 BOOL, t41 BOOL, t42 BOOL, t99 BOOL, PRIMARY KEY(id))")?;
    exec(conn, "CREATE REL TABLE CONNECTED(FROM Content TO Content, id STRING, state STRING, p7 BOOL, t41 BOOL, t42 BOOL, t99 BOOL)")?;
    exec(conn, "CREATE REL TABLE CONTAINS(FROM Layer TO Content, id STRING, member_order INT64, x DOUBLE, y DOUBLE, has_xy BOOL, p7 BOOL, t41 BOOL, t42 BOOL, t99 BOOL)")?;
    for relation in ["EXPANDS", "REFERENCES"] {
        exec(conn, &format!("CREATE REL TABLE {relation}(FROM Content TO Layer, id STRING, source_layer_id STRING, label STRING, variant STRING, icon STRING, description STRING, relation STRING, state STRING, p7 BOOL, t41 BOOL, t42 BOOL, t99 BOOL)"))?;
    }
    Ok(())
}

fn load_fixture(conn: &Connection<'_>) -> ProbeResult {
    exec(conn, "BEGIN TRANSACTION")?;
    for query in [
        "CREATE (:Content {id:'content:6',kind:'user-interaction',icon:'message-square',title:'Explain queue',detail:'Explain the queue',state:'accepted',p7:true,t41:true,t42:false,t99:false})",
        "CREATE (:Content {id:'content:1',kind:'concept',icon:'list-tree',title:'Queue',detail:'Pending work',state:'accepted',p7:true,t41:true,t42:true,t99:false})",
        "CREATE (:Content {id:'content:2',kind:'concept',icon:'cpu',title:'Worker',detail:'Claims work',state:'accepted',p7:true,t41:true,t42:false,t99:false})",
        "CREATE (:Content {id:'content:3',kind:'result',icon:'circle-check',title:'Result',detail:'Completed work',state:'accepted',p7:true,t41:true,t42:false,t99:false})",
        "CREATE (:Content {id:'content:4',kind:'evidence',icon:'book-open',title:'Evidence',detail:'Supporting material',state:'accepted',p7:true,t41:true,t42:false,t99:false})",
        "CREATE (:Content {id:'content:7',kind:'concept',icon:'cpu',title:'Cross-thread worker',detail:'Authored in another thread',state:'accepted',p7:true,t41:false,t42:true,t99:false})",
        "CREATE (:Content {id:'content:5',kind:'concept',icon:'box',title:'Standalone',detail:'Isolated thread',state:'accepted',p7:false,t41:false,t42:false,t99:true})",
        "CREATE (:Layer {id:'layer:101',state:'accepted',layout_version:1,has_layout:true,p7:true,t41:true,t42:false,t99:false})",
        "CREATE (:Layer {id:'layer:102',state:'accepted',layout_version:1,has_layout:true,p7:true,t41:true,t42:false,t99:false})",
        "CREATE (:Layer {id:'layer:103',state:'accepted',layout_version:1,has_layout:true,p7:true,t41:true,t42:false,t99:false})",
        "CREATE (:Layer {id:'layer:104',state:'accepted',has_layout:false,p7:true,t41:true,t42:false,t99:false})",
        "CREATE (:Layer {id:'layer:105',state:'accepted',layout_version:1,has_layout:true,p7:false,t41:false,t42:false,t99:true})",
        "CREATE (:Layer {id:'layer:106',state:'accepted',layout_version:1,has_layout:true,p7:true,t41:false,t42:true,t99:false})",
    ] { exec(conn, query)?; }
    for (a, b, id, p7, t41, t42) in [
        ("content:1", "content:2", "edge:201", true, true, false),
        ("content:2", "content:3", "edge:202", true, true, false),
        ("content:1", "content:7", "edge:203", true, false, true),
    ] {
        exec(conn, &format!("MATCH (a:Content),(b:Content) WHERE a.id='{a}' AND b.id='{b}' CREATE (a)-[:CONNECTED {{id:'{id}',state:'accepted',p7:{p7},t41:{t41},t42:{t42},t99:false}}]->(b)"))?;
    }
    for (layer, content, order, x, y, has_xy, p7, t41, t42, t99) in [
        (
            "layer:101",
            "content:1",
            0,
            0.2,
            0.5,
            true,
            true,
            true,
            false,
            false,
        ),
        (
            "layer:101",
            "content:2",
            1,
            0.8,
            0.5,
            true,
            true,
            true,
            false,
            false,
        ),
        (
            "layer:102",
            "content:1",
            0,
            0.25,
            0.25,
            true,
            true,
            true,
            false,
            false,
        ),
        (
            "layer:102",
            "content:4",
            1,
            0.75,
            0.75,
            true,
            true,
            true,
            false,
            false,
        ),
        (
            "layer:103",
            "content:3",
            0,
            0.5,
            0.5,
            true,
            true,
            true,
            false,
            false,
        ),
        (
            "layer:104",
            "content:2",
            0,
            0.0,
            0.0,
            false,
            true,
            true,
            false,
            false,
        ),
        (
            "layer:105",
            "content:5",
            0,
            0.5,
            0.5,
            true,
            false,
            false,
            false,
            true,
        ),
        (
            "layer:106",
            "content:7",
            0,
            0.2,
            0.5,
            true,
            true,
            false,
            true,
            false,
        ),
        (
            "layer:106",
            "content:1",
            1,
            0.8,
            0.5,
            true,
            true,
            false,
            true,
            false,
        ),
    ] {
        let xy = if has_xy {
            format!("x:{x},y:{y},")
        } else {
            String::new()
        };
        let layer_graph_id = layer.strip_prefix("layer:").ok_or("invalid layer id")?;
        let content_graph_id = content
            .strip_prefix("content:")
            .ok_or("invalid content id")?;
        exec(conn, &format!("MATCH (l:Layer),(n:Content) WHERE l.id='{layer}' AND n.id='{content}' CREATE (l)-[:CONTAINS {{id:'membership:{layer_graph_id}:{order}:{content_graph_id}',member_order:{order},{xy}has_xy:{has_xy},p7:{p7},t41:{t41},t42:{t42},t99:{t99}}}]->(n)"))?;
    }
    for (rel, id, source, source_layer, target, label, variant, icon, description) in [
        (
            "EXPANDS",
            "action:301",
            "content:1",
            "layer:101",
            "layer:103",
            "Deep dive",
            "card",
            "zoom-in",
            "Develop the queue",
        ),
        (
            "REFERENCES",
            "action:302",
            "content:1",
            "layer:102",
            "layer:103",
            "Supporting result",
            "pill",
            "",
            "",
        ),
        (
            "EXPANDS",
            "action:306",
            "content:6",
            "",
            "layer:101",
            "Response",
            "pill",
            "",
            "",
        ),
    ] {
        let relation = if rel == "EXPANDS" {
            "expand"
        } else {
            "reference"
        };
        exec(conn, &format!("MATCH (n:Content),(l:Layer) WHERE n.id='{source}' AND l.id='{target}' CREATE (n)-[:{rel} {{id:'{id}',source_layer_id:'{source_layer}',label:'{label}',variant:'{variant}',icon:'{icon}',description:'{description}',relation:'{relation}',state:'accepted',p7:true,t41:true,t42:false,t99:false}}]->(l)"))?;
    }
    exec(conn, "COMMIT")?;
    Ok(())
}

fn prove_values(conn: &Connection<'_>) -> ProbeResult {
    let values = rows(conn, "MATCH (a:Content)-[r:CONNECTED]-(b:Content) WHERE a.id='content:1' AND b.id='content:2' RETURN NULL AS null_value, true AS bool_value, -9223372036854775808 AS min_i64, 9223372036854775807 AS max_i64, -0.0 AS negative_zero, 'wire' AS string_value, [1,2] AS list_value, {title:a.title,counts:[1]} AS record_value, a AS node_value, r AS rel_value, [a,b] AS nodes_value, [r] AS rels_value")?;
    let row = values.first().ok_or("wire-value query returned no row")?;
    if row.len() != 12
        || !matches!(row[0], Value::Null(_))
        || row[1] != Value::Bool(true)
        || row[2] != Value::Int64(i64::MIN)
        || row[3] != Value::Int64(i64::MAX)
        || !matches!(row[4], Value::Double(value) if value == 0.0 && value.is_sign_negative())
        || row[5] != Value::String("wire".into())
        || !matches!(row[6], Value::List(_, _))
        || !matches!(row[7], Value::Struct(_))
        || !matches!(&row[8], Value::Node(node) if node.get_label_name() == "Content" && node.get_properties().iter().any(|(name, value)| name == "id" && value == &Value::String("content:1".into())))
        || !matches!(&row[9], Value::Rel(rel) if rel.get_label_name() == "CONNECTED" && rel.get_properties().iter().any(|(name, value)| name == "id" && value == &Value::String("edge:201".into())))
        || !matches!(row[10], Value::List(LogicalType::Node, _))
        || !matches!(row[11], Value::List(LogicalType::Rel, _))
    {
        return Err(format!("lossless wire-value mismatch: {row:?}").into());
    }
    let paths = rows(conn, "MATCH p=(a:Content)-[r:CONNECTED]-(b:Content) WHERE a.id='content:1' AND b.id='content:2' RETURN p")?;
    if !matches!(&paths[0][0], Value::RecursiveRel { nodes, rels }
        if nodes.len() == 2
            && rels.len() == 1
            && nodes[0].get_properties().iter().any(|(name, value)| name == "id" && value == &Value::String("content:1".into()))
            && nodes[1].get_properties().iter().any(|(name, value)| name == "id" && value == &Value::String("content:2".into()))
            && rels[0].get_properties().iter().any(|(name, value)| name == "id" && value == &Value::String("edge:201".into())))
    {
        return Err("path did not retain its nodes and relationship".into());
    }
    let nested = rows(conn, "MATCH p=(l:Layer)-[m:CONTAINS]->(n:Content) WHERE l.id='layer:101' AND n.id='content:1' RETURN l AS layer, {labels:[l.id,n.title],route:p} AS nested")?;
    if !matches!(&nested[0][0], Value::Node(layer) if layer.get_label_name() == "Layer" && layer.get_properties().iter().any(|(name, value)| name == "id" && value == &Value::String("layer:101".into())))
        || !matches!(&nested[0][1], Value::Struct(fields) if matches!(&fields[0].1, Value::List(LogicalType::String, values) if values.len() == 2) && matches!(&fields[1].1, Value::RecursiveRel { nodes, rels } if nodes.len() == 2 && rels.len() == 1))
    {
        return Err(format!("nested record/list/path mismatch: {:?}", nested[0]).into());
    }

    fn parameter_roundtrip(conn: &Connection<'_>, value: Value) -> ProbeResult<Value> {
        let mut prepared = conn.prepare("RETURN $value AS value")?;
        if !prepared.is_read_only() {
            return Err("parameter roundtrip did not parse read-only".into());
        }
        let mut result = conn.execute(&mut prepared, vec![("value", value)])?;
        Ok(result.next().ok_or("parameter roundtrip returned no row")?[0].clone())
    }
    let empty_strings = Value::List(LogicalType::String, vec![]);
    if parameter_roundtrip(conn, empty_strings.clone())? != empty_strings {
        return Err("typed empty string list lost its element type".into());
    }
    let record_type = LogicalType::Struct {
        fields: vec![("title".into(), LogicalType::String)],
    };
    let empty_nested = Value::List(
        LogicalType::List {
            child_type: Box::new(record_type.clone()),
        },
        vec![],
    );
    if parameter_roundtrip(conn, empty_nested.clone())? != empty_nested {
        return Err("typed empty nested list lost its descriptor".into());
    }
    let records = Value::List(
        record_type,
        vec![
            Value::Struct(vec![("title".into(), Value::String("Queue".into()))]),
            Value::Struct(vec![("title".into(), Value::String("Worker".into()))]),
        ],
    );
    if parameter_roundtrip(conn, records.clone())? != records {
        return Err("homogeneous record list did not roundtrip losslessly".into());
    }
    Ok(())
}

fn prove_normalization_falsifiers() -> ProbeResult {
    let empty_endpoints = BTreeMap::new();
    let negative_zero = normalize_value(&Value::Double(-0.0), &empty_endpoints)?;
    let normalized = negative_zero["value"]
        .as_f64()
        .ok_or("normalized zero was not a float")?;
    if normalized != 0.0 || normalized.is_sign_negative() {
        return Err("negative zero was not canonicalized to positive zero".into());
    }
    for value in [
        Value::Double(f64::NAN),
        Value::Double(f64::INFINITY),
        Value::Double(f64::NEG_INFINITY),
        Value::Float(f32::NAN),
        Value::Float(f32::INFINITY),
        Value::Float(f32::NEG_INFINITY),
    ] {
        if normalize_value(&value, &empty_endpoints).is_ok() {
            return Err(format!("nonfinite float was accepted: {value:?}").into());
        }
    }
    for value in [
        Value::Int128(i128::from(i64::MAX) + 1),
        Value::Int128(i128::from(i64::MIN) - 1),
    ] {
        if normalize_value(&value, &empty_endpoints).is_ok() {
            return Err(format!("out-of-range integer was accepted: {value:?}").into());
        }
    }
    println!("NORMALIZATION_FALSIFIERS=passed");
    Ok(())
}

fn prove_read_only_gate(conn: &Connection<'_>) -> ProbeResult {
    for query in [
        "MATCH (n:Content) SET n.title = 'Changed' RETURN n",
        "CREATE NODE TABLE Forbidden(id INT64, PRIMARY KEY(id))",
    ] {
        let prepared = conn.prepare(query)?;
        if prepared.is_read_only() {
            return Err(format!("mutation parsed as read-only: {query}").into());
        }
    }
    println!("PARSED_READ_ONLY_GATE=passed");
    Ok(())
}

fn prove_rollback_and_reopen(path: &Path) -> ProbeResult {
    {
        let db = Database::new(path, SystemConfig::default())?;
        let conn = Connection::new(&db)?;
        exec(&conn, "BEGIN TRANSACTION")?;
        exec(&conn, "CREATE (:Content {id:'content:rollback',kind:'concept',icon:'',title:'Must roll back',detail:'',state:'accepted',p7:true,t41:true,t42:false,t99:false})")?;
        exec(&conn, "ROLLBACK")?;
        if !rows(
            &conn,
            "MATCH (n:Content) WHERE n.id='content:rollback' RETURN n",
        )?
        .is_empty()
        {
            return Err("rollback row remained visible".into());
        }
    }
    let db = Database::new(path, SystemConfig::default())?;
    let conn = Connection::new(&db)?;
    if rows(&conn, "MATCH (n:Content) WHERE n.t41 RETURN n")?.len() != 5 {
        return Err("committed fixture did not survive database reopen".into());
    }
    if !rows(
        &conn,
        "MATCH (n:Content) WHERE n.id='content:rollback' RETURN n",
    )?
    .is_empty()
    {
        return Err("rolled-back row appeared after reopen".into());
    }
    Ok(())
}

fn prove_cancellation_falsifier(conn: &Connection<'_>) -> ProbeResult {
    exec(conn, "BEGIN TRANSACTION")?;
    exec(conn, "CREATE (:Content {id:'bulk:hub',kind:'concept',icon:'',title:'Bulk hub',detail:'',state:'accepted',p7:false,t41:false,t42:false,t99:false})")?;
    let mut create_node = conn.prepare("CREATE (:Content {id:$id,kind:'concept',icon:'',title:'Bulk leaf',detail:'',state:'accepted',p7:false,t41:false,t42:false,t99:false})")?;
    let mut create_edge = conn.prepare("MATCH (a:Content),(b:Content) WHERE a.id='bulk:hub' AND b.id=$id CREATE (a)-[:CONNECTED {id:$edge,state:'accepted',p7:false,t41:false,t42:false,t99:false}]->(b)")?;
    for index in 0..1_000 {
        let id = format!("bulk:{index}");
        conn.execute(&mut create_node, vec![("id", Value::String(id.clone()))])?;
        conn.execute(
            &mut create_edge,
            vec![
                ("id", Value::String(id)),
                ("edge", Value::String(format!("bulk-edge:{index}"))),
            ],
        )?;
    }
    exec(conn, "COMMIT")?;
    const ALLOWED_TWO_HOP: &str = "MATCH (a:Content)-[:CONNECTED]-(b:Content)-[:CONNECTED]-(c:Content) WHERE b.title = $title RETURN c.title AS title";
    let params = || vec![("title", Value::String("Bulk hub".into()))];
    let mut timed = conn.prepare(ALLOWED_TWO_HOP)?;
    if !timed.is_read_only() {
        return Err("allowed cancellation query did not parse read-only".into());
    }
    conn.set_query_timeout(1);
    let result = conn.execute(&mut timed, params());
    conn.set_query_timeout(0);
    match result {
        Err(error) => {
            let message = error.to_string().to_ascii_lowercase();
            if !message.contains("interrupt")
                && !message.contains("timeout")
                && !message.contains("cancel")
            {
                return Err(format!("unexpected timeout failure: {error}").into());
            }
            println!("WALL_TIME_FALSIFIER=passed");
        }
        Ok(_) => return Err("allowed two-hop query ignored the 1ms timeout falsifier".into()),
    }
    std::thread::scope(|scope| -> ProbeResult {
        let mut interrupted = conn.prepare(ALLOWED_TWO_HOP)?;
        let interrupter = scope.spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(1));
            conn.interrupt()
        });
        let result = conn.execute(&mut interrupted, params());
        interrupter
            .join()
            .map_err(|_| "interrupt thread panicked")??;
        match result {
            Err(error) if error.to_string().to_ascii_lowercase().contains("interrupt") => {
                println!("CANCELLATION_FALSIFIER=passed");
                Ok(())
            }
            Err(error) => Err(format!("unexpected cancellation failure: {error}").into()),
            Ok(_) => Err("allowed two-hop query ignored explicit interrupt".into()),
        }
    })
}

fn main() -> ProbeResult {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("shared-ladybug");
    {
        let db = Database::new(&path, SystemConfig::default())?;
        let conn = Connection::new(&db)?;
        create_schema(&conn)?;
        load_fixture(&conn)?;
        let endpoint_ids = endpoint_index(&conn)?;
        let expected = expected_results()?;
        let mut mismatches = Vec::new();
        for (id, lowering, columns, row_cap) in POSITIVE_CASES {
            let actual = execute_positive_case(&conn, lowering, columns, *row_cap, &endpoint_ids)?;
            let expected_result = expected
                .get(*id)
                .ok_or_else(|| format!("frozen expected result missing for {id}"))?;
            if &actual != expected_result {
                mismatches.push(format!(
                    "{id}: normalized result mismatch\nexpected={}\nactual={}",
                    serde_json::to_string_pretty(expected_result)?,
                    serde_json::to_string_pretty(&actual)?,
                ));
                println!("CASE={id} STATUS=failed");
                continue;
            }
            println!("CASE={id} STATUS=passed");
        }
        if !mismatches.is_empty() {
            return Err(mismatches.join("\n\n").into());
        }
        println!("EXACT_ENVELOPES=passed");
        prove_values(&conn)?;
        println!("VALUES=passed");
        prove_normalization_falsifiers()?;
        prove_read_only_gate(&conn)?;
        prove_cancellation_falsifier(&conn)?;
    }
    prove_rollback_and_reopen(&path)?;
    println!("TRANSACTION_ROLLBACK_REOPEN=passed");
    println!("EXTENSIONS=[]");
    println!("LBUG_STORAGE_VERSION={}", lbug::get_storage_version());
    Ok(())
}
