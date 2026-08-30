//! The Ladybug schema an accepted closure is written into, and the lowering that
//! writes it.
//!
//! The table shape is promoted from the issue #261 contract probe, which proved
//! the frozen `relayer.graph-query` v1 cases against it. One thing changed: the
//! probe encoded target visibility as a fixed `p7`/`t41` boolean column per
//! project and thread, which a real database cannot do. Visibility is a
//! `published_targets` list here instead. That is a private lowering either way —
//! no frozen query names those columns; scoping is applied by the engine.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail};
use lbug::{Connection, LogicalType, Value};
use relayer_graph_core::{
    AcceptedGraphClosure, ActionKind, GraphAction, GraphEdge, GraphLayer, GraphNode,
    NavigateRelation, ResolvedLayer, SearchIndexRebuildSnapshot, SearchIndexRevision, SearchTarget,
};

use super::store::exec;

/// The wire spelling of an enum, taken from the model's own serialization so the
/// stored value cannot drift from the one the rest of Relayer uses. The model's
/// `as_str` helpers are crate-private.
fn wire(value: impl serde::Serialize) -> Result<String> {
    match serde_json::to_value(value)? {
        serde_json::Value::String(text) => Ok(text),
        other => bail!("expected a string encoding, got {other}"),
    }
}

/// Node and relationship tables. `INVOKE` and `interaction.context` actions are
/// absent deliberately: the frozen contract lists them under
/// `excludedTopologyTypes`, so they are not searchable topology.
const TABLES: &[&str] = &[
    "CREATE NODE TABLE Content(id STRING, kind STRING, icon STRING, title STRING, detail STRING, state STRING, published_targets STRING[], PRIMARY KEY(id))",
    "CREATE NODE TABLE Layer(id STRING, state STRING, layout_version INT64, has_layout BOOL, published_targets STRING[], PRIMARY KEY(id))",
    "CREATE REL TABLE CONNECTED(FROM Content TO Content, id STRING, state STRING, published_targets STRING[])",
    "CREATE REL TABLE CONTAINS(FROM Layer TO Content, id STRING, member_order INT64, x DOUBLE, y DOUBLE, has_xy BOOL, published_targets STRING[])",
    "CREATE REL TABLE EXPANDS(FROM Content TO Layer, id STRING, source_layer_id STRING, label STRING, variant STRING, icon STRING, description STRING, relation STRING, state STRING, published_targets STRING[])",
    "CREATE REL TABLE REFERENCES(FROM Content TO Layer, id STRING, source_layer_id STRING, label STRING, variant STRING, icon STRING, description STRING, relation STRING, state STRING, published_targets STRING[])",
    // The revision this store holds for each target. Ladybug 0.18.0 has no
    // revision of its own, so Relayer writes one inside the same transaction as
    // the closure. A revision here that SQLite never recorded is an orphan from
    // an interrupted write, which is what makes that window detectable.
    "CREATE NODE TABLE IndexRevision(target STRING, revision INT64, PRIMARY KEY(target))",
];

pub fn create(connection: &Connection<'_>) -> Result<()> {
    for table in TABLES {
        exec(connection, table).context("create the Ladybug search schema")?;
    }
    Ok(())
}

pub fn content_id(node: &GraphNode) -> String {
    format!("content:{}", node.id)
}

pub fn layer_id(layer: &GraphLayer) -> String {
    format!("layer:{}", layer.id)
}

/// Write one accepted closure into the open transaction.
///
/// Every write is a merge or a replace keyed on the stable Relayer identity, so
/// applying the same closure twice converges rather than duplicating. That is
/// what lets an exact retry after a crash reach the same state.
pub fn apply_closure(
    connection: &Connection<'_>,
    published_to: &[SearchTarget],
    closure: &AcceptedGraphClosure,
) -> Result<()> {
    let targets = published_targets(published_to);
    // Nodes first, then everything that joins them. A relationship write is a
    // MERGE behind a MATCH, so an endpoint that does not exist yet makes it match
    // nothing and write nothing, silently. The closure's layers arrive in
    // breadth-first order, which means a layer's actions name child layers that
    // have not been written yet — hence two passes rather than one.
    //
    // The interaction node belongs to no layer, so nothing else carries it.
    write_node(connection, &targets, &closure.interaction)?;
    for layer in &closure.layers {
        write_layer_node(connection, &targets, layer)?;
        for node in &layer.nodes {
            write_node(connection, &targets, node)?;
        }
    }
    for layer in &closure.layers {
        write_layer_relationships(connection, &targets, layer)?;
    }
    write_action(connection, &targets, &closure.root_action)?;
    Ok(())
}

/// Record the revision this transaction will carry. Written inside the
/// transaction so it becomes durable with the closure or not at all.
pub fn write_revision(
    connection: &Connection<'_>,
    target: SearchTarget,
    revision: SearchIndexRevision,
) -> Result<()> {
    let mut statement = connection
        .prepare("MERGE (r:IndexRevision {target: $target}) SET r.revision = $revision")?;
    connection.execute(
        &mut statement,
        vec![
            ("target", Value::String(target.to_string())),
            ("revision", Value::Int64(revision.value())),
        ],
    )?;
    Ok(())
}

/// The revision this store holds for a target, or `None` when it holds none.
pub fn read_revision(
    connection: &Connection<'_>,
    target: SearchTarget,
) -> Result<Option<SearchIndexRevision>> {
    let mut statement =
        connection.prepare("MATCH (r:IndexRevision) WHERE r.target = $target RETURN r.revision")?;
    let mut result = connection.execute(
        &mut statement,
        vec![("target", Value::String(target.to_string()))],
    )?;
    let Some(row) = result.next() else {
        return Ok(None);
    };
    match row.first() {
        Some(Value::Int64(value)) => Ok(SearchIndexRevision::new(*value)),
        other => anyhow::bail!("stored revision was not an integer: {other:?}"),
    }
}

pub fn revision_count(connection: &Connection<'_>) -> Result<usize> {
    let mut result = connection.query("MATCH (r:IndexRevision) RETURN count(r)")?;
    match result.next().and_then(|row| row.first().cloned()) {
        Some(Value::Int64(value)) => usize::try_from(value).context("negative revision count"),
        other => anyhow::bail!("stored revision count was not an integer: {other:?}"),
    }
}

pub fn revision_targets(connection: &Connection<'_>) -> Result<Vec<String>> {
    let mut result = connection.query("MATCH (r:IndexRevision) RETURN r.target")?;
    (&mut result).map(|row| value_string(&row[0])).collect()
}

/// Exact physical multiset of searchable records. Every stored property that a
/// query can observe is encoded, and duplicate relationships remain duplicate
/// entries rather than collapsing behind their authored identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchInventory(pub Vec<String>);

impl SearchInventory {
    pub fn projection(&self, target: SearchTarget) -> Result<Vec<String>> {
        let target = target.to_string();
        let mut projection = self
            .0
            .iter()
            .filter_map(|entry| {
                let parsed = decode_inventory_entry(entry);
                match parsed {
                    Ok((key, properties, targets)) if targets.contains(&target) => {
                        Some(Ok(serde_json::to_string(&(key, properties))
                            .expect("search inventory projection serializes")))
                    }
                    Ok(_) => None,
                    Err(error) => Some(Err(error)),
                }
            })
            .collect::<Result<Vec<_>>>()?;
        projection.sort();
        Ok(projection)
    }

    pub fn target_names(&self) -> Result<BTreeSet<String>> {
        let mut names = BTreeSet::new();
        for entry in &self.0 {
            let (_, _, targets) = decode_inventory_entry(entry)?;
            names.extend(targets);
        }
        Ok(names)
    }
}

type Properties = Vec<(String, String)>;
type InventoryMap = BTreeMap<Vec<String>, (Properties, BTreeSet<String>, usize)>;

pub fn canonical_inventory(snapshot: &SearchIndexRebuildSnapshot) -> SearchInventory {
    let mut inventory = InventoryMap::new();
    for item in &snapshot.closures {
        let targets = item
            .published_to
            .iter()
            .map(ToString::to_string)
            .collect::<BTreeSet<_>>();
        add_inventory(
            &mut inventory,
            vec![
                "node".into(),
                "Content".into(),
                content_id(&item.closure.interaction),
            ],
            content_properties(&item.closure.interaction),
            &targets,
            1,
        );
        for layer in &item.closure.layers {
            let layer_identity = layer_id(&layer.layer);
            add_inventory(
                &mut inventory,
                vec!["node".into(), "Layer".into(), layer_identity.clone()],
                layer_properties(layer),
                &targets,
                1,
            );
            for node in &layer.nodes {
                add_inventory(
                    &mut inventory,
                    vec!["node".into(), "Content".into(), content_id(node)],
                    content_properties(node),
                    &targets,
                    1,
                );
            }
            for (position, node_id) in layer.layer.nodes.iter().enumerate() {
                let placement = layer.layer.layout.as_ref().and_then(|layout| {
                    layout
                        .placements
                        .iter()
                        .find(|placement| placement.node_id == *node_id)
                });
                add_inventory(
                    &mut inventory,
                    vec![
                        "relationship".into(),
                        "CONTAINS".into(),
                        format!("membership:{}:{position}:{node_id}", layer.layer.id),
                        layer_identity.clone(),
                        format!("content:{node_id}"),
                    ],
                    vec![
                        property("member_order", Value::Int64(position as i64)),
                        property("x", Value::Double(placement.map_or(0.0, |value| value.x))),
                        property("y", Value::Double(placement.map_or(0.0, |value| value.y))),
                        property("has_xy", Value::Bool(placement.is_some())),
                    ],
                    &targets,
                    1,
                );
            }
            for edge in &layer.edges {
                let mut endpoints = [
                    format!("content:{}", edge.endpoints[0]),
                    format!("content:{}", edge.endpoints[1]),
                ];
                endpoints.sort();
                add_inventory(
                    &mut inventory,
                    vec![
                        "relationship".into(),
                        "CONNECTED".into(),
                        format!("edge:{}", edge.id),
                        endpoints[0].clone(),
                        endpoints[1].clone(),
                    ],
                    vec![property(
                        "state",
                        Value::String(wire(edge.state).expect("edge state serializes")),
                    )],
                    &targets,
                    // Ladybug 0.18 reports one undirected CONNECTED record in
                    // both orientations. An injected duplicate therefore adds
                    // two more entries to the physical multiset.
                    2,
                );
            }
            for action in &layer.actions {
                add_action_inventory(&mut inventory, action, &targets);
            }
        }
        add_action_inventory(&mut inventory, &item.closure.root_action, &targets);
    }
    finish_inventory(inventory)
}

pub fn physical_inventory(connection: &Connection<'_>) -> Result<SearchInventory> {
    let mut inventory = Vec::new();
    let mut content = connection.query(
        "MATCH (n:Content) RETURN n.id,n.kind,n.icon,n.title,n.detail,n.state,n.published_targets",
    )?;
    for row in &mut content {
        inventory.push(encode_inventory_entry(
            vec!["node".into(), "Content".into(), value_string(&row[0])?],
            named_properties(&["kind", "icon", "title", "detail", "state"], &row[1..6])?,
            value_string_list(&row[6])?,
        ));
    }
    let mut layers = connection.query(
        "MATCH (n:Layer) RETURN n.id,n.state,n.layout_version,n.has_layout,n.published_targets",
    )?;
    for row in &mut layers {
        inventory.push(encode_inventory_entry(
            vec!["node".into(), "Layer".into(), value_string(&row[0])?],
            named_properties(&["state", "layout_version", "has_layout"], &row[1..4])?,
            value_string_list(&row[4])?,
        ));
    }
    for (kind, property_names) in [
        ("CONNECTED", &["state"][..]),
        ("CONTAINS", &["member_order", "x", "y", "has_xy"][..]),
        (
            "EXPANDS",
            &[
                "source_layer_id",
                "label",
                "variant",
                "icon",
                "description",
                "relation",
                "state",
            ][..],
        ),
        (
            "REFERENCES",
            &[
                "source_layer_id",
                "label",
                "variant",
                "icon",
                "description",
                "relation",
                "state",
            ][..],
        ),
    ] {
        let returned = property_names
            .iter()
            .map(|name| format!("r.{name}"))
            .collect::<Vec<_>>()
            .join(",");
        let query = format!(
            "MATCH (a)-[r:{kind}]->(b) RETURN r.id,a.id,b.id,{returned},r.published_targets"
        );
        let mut result = connection.query(&query)?;
        for row in &mut result {
            let mut start = value_string(&row[1])?;
            let mut end = value_string(&row[2])?;
            if kind == "CONNECTED" && start > end {
                std::mem::swap(&mut start, &mut end);
            }
            let targets = row
                .last()
                .ok_or_else(|| anyhow::anyhow!("search inventory row omitted targets"))?;
            inventory.push(encode_inventory_entry(
                vec![
                    "relationship".into(),
                    kind.into(),
                    value_string(&row[0])?,
                    start,
                    end,
                ],
                named_properties(property_names, &row[3..row.len() - 1])?,
                value_string_list(targets)?,
            ));
        }
    }
    inventory.sort();
    Ok(SearchInventory(inventory))
}

fn add_action_inventory(
    inventory: &mut InventoryMap,
    action: &GraphAction,
    targets: &BTreeSet<String>,
) {
    if action.kind != ActionKind::Navigate {
        return;
    }
    let (Some(relation), Some(target_layer)) = (action.relation, action.target_layer_id) else {
        return;
    };
    let kind = match relation {
        NavigateRelation::Expand => "EXPANDS",
        NavigateRelation::Reference => "REFERENCES",
    };
    add_inventory(
        inventory,
        vec![
            "relationship".into(),
            kind.into(),
            format!("action:{}", action.id),
            format!("content:{}", action.source_node_id),
            format!("layer:{target_layer}"),
        ],
        action_properties(action, relation),
        targets,
        1,
    );
}

fn add_inventory(
    inventory: &mut InventoryMap,
    key: Vec<String>,
    properties: Properties,
    targets: &BTreeSet<String>,
    multiplicity: usize,
) {
    let entry = inventory
        .entry(key)
        .or_insert_with(|| (properties.clone(), BTreeSet::new(), multiplicity));
    // Applying an immutable accepted identity again replaces the same physical
    // properties and unions publication targets; it never creates another row.
    entry.0 = properties;
    entry.1.extend(targets.iter().cloned());
    entry.2 = multiplicity;
}

fn finish_inventory(inventory: InventoryMap) -> SearchInventory {
    let mut entries = Vec::new();
    for (key, (properties, targets, multiplicity)) in inventory {
        let encoded = encode_inventory_entry(key, properties, targets.into_iter().collect());
        entries.extend(std::iter::repeat_n(encoded, multiplicity));
    }
    entries.sort();
    SearchInventory(entries)
}

fn content_properties(node: &GraphNode) -> Properties {
    vec![
        property("kind", Value::String(node.kind.clone())),
        property("icon", Value::String(node.icon.clone())),
        property("title", Value::String(node.title.clone())),
        property("detail", Value::String(node.detail.clone())),
        property(
            "state",
            Value::String(wire(node.state).expect("node state serializes")),
        ),
    ]
}

fn layer_properties(layer: &ResolvedLayer) -> Properties {
    let layout = layer.layer.layout.as_ref();
    vec![
        property(
            "state",
            Value::String(wire(layer.layer.state).expect("layer state serializes")),
        ),
        property(
            "layout_version",
            match layout {
                Some(layout) => Value::Int64(i64::from(layout.version)),
                None => Value::Null(LogicalType::Int64),
            },
        ),
        property("has_layout", Value::Bool(layout.is_some())),
    ]
}

fn action_properties(action: &GraphAction, relation: NavigateRelation) -> Properties {
    vec![
        property(
            "source_layer_id",
            Value::String(
                action
                    .source_layer_id
                    .map_or_else(String::new, |id| format!("layer:{id}")),
            ),
        ),
        property("label", Value::String(action.label.clone())),
        property(
            "variant",
            Value::String(wire(&action.variant).expect("action variant serializes")),
        ),
        property(
            "icon",
            Value::String(action.icon.clone().unwrap_or_default()),
        ),
        property(
            "description",
            Value::String(action.description.clone().unwrap_or_default()),
        ),
        property(
            "relation",
            Value::String(wire(relation).expect("navigate relation serializes")),
        ),
        property(
            "state",
            Value::String(wire(action.state).expect("action state serializes")),
        ),
    ]
}

fn property(name: &str, value: Value) -> (String, String) {
    (
        name.into(),
        serde_json::to_string(
            &super::value::normalize_value(&value, &super::value::EndpointIds::new())
                .expect("canonical inventory uses supported scalar values"),
        )
        .expect("normalized scalar serializes"),
    )
}

fn named_properties(names: &[&str], values: &[Value]) -> Result<Properties> {
    if names.len() != values.len() {
        bail!("search inventory property count did not match its schema");
    }
    names
        .iter()
        .zip(values)
        .map(|(name, value)| {
            Ok((
                (*name).into(),
                serde_json::to_string(&super::value::normalize_value(
                    value,
                    &super::value::EndpointIds::new(),
                )?)?,
            ))
        })
        .collect()
}

fn encode_inventory_entry(
    key: Vec<String>,
    properties: Properties,
    targets: Vec<String>,
) -> String {
    serde_json::to_string(&(key, properties, targets)).expect("search inventory entry serializes")
}

fn decode_inventory_entry(entry: &str) -> Result<(Vec<String>, Properties, Vec<String>)> {
    serde_json::from_str(entry).context("decode search inventory entry")
}

fn value_string(value: &Value) -> Result<String> {
    match value {
        Value::String(value) => Ok(value.clone()),
        other => bail!("search inventory identity was not a string: {other:?}"),
    }
}

fn value_string_list(value: &Value) -> Result<Vec<String>> {
    match value {
        Value::List(LogicalType::String, values) => values.iter().map(value_string).collect(),
        other => bail!("search inventory publication list was not a string list: {other:?}"),
    }
}

/// Every target the closure is searchable from, as the engine list the query
/// path filters on.
fn published_targets(published_to: &[SearchTarget]) -> Value {
    Value::List(
        LogicalType::String,
        published_to
            .iter()
            .map(|target| Value::String(target.to_string()))
            .collect(),
    )
}

fn write_layer_node(
    connection: &Connection<'_>,
    targets: &Value,
    layer: &ResolvedLayer,
) -> Result<()> {
    let id = layer_id(&layer.layer);
    let layout = layer.layer.layout.as_ref();
    let mut statement = connection.prepare(
        "MERGE (l:Layer {id: $id}) \
         SET l.state = $state, l.layout_version = $layout_version, \
             l.has_layout = $has_layout, \
             l.published_targets = CASE WHEN l.published_targets IS NULL THEN $targets \
                 ELSE list_distinct(list_concat(l.published_targets, $targets)) END",
    )?;
    connection.execute(
        &mut statement,
        vec![
            ("id", Value::String(id.clone())),
            ("state", Value::String(wire(layer.layer.state)?)),
            (
                "layout_version",
                // A layer with no authored layout has no version. The contract
                // says absent, not null and not a synthesized zero, so nothing is
                // stored for it to project.
                match layout {
                    Some(layout) => Value::Int64(i64::from(layout.version)),
                    None => Value::Null(LogicalType::Int64),
                },
            ),
            ("has_layout", Value::Bool(layout.is_some())),
            ("targets", targets.clone()),
        ],
    )?;
    Ok(())
}

fn write_layer_relationships(
    connection: &Connection<'_>,
    targets: &Value,
    layer: &ResolvedLayer,
) -> Result<()> {
    let id = layer_id(&layer.layer);
    let layout = layer.layer.layout.as_ref();
    for (position, node_id) in layer.layer.nodes.iter().enumerate() {
        let placement = layout.and_then(|layout| {
            layout
                .placements
                .iter()
                .find(|placement| placement.node_id == *node_id)
        });
        let mut statement = connection.prepare(
            "MATCH (l:Layer), (n:Content) WHERE l.id = $layer AND n.id = $content \
             MERGE (l)-[m:CONTAINS {id: $id}]->(n) \
             SET m.member_order = $member_order, m.x = $x, m.y = $y, \
                 m.has_xy = $has_xy, \
                 m.published_targets = CASE WHEN m.published_targets IS NULL THEN $targets \
                     ELSE list_distinct(list_concat(m.published_targets, $targets)) END",
        )?;
        connection.execute(
            &mut statement,
            vec![
                ("layer", Value::String(id.clone())),
                ("content", Value::String(format!("content:{node_id}"))),
                (
                    "id",
                    // membership:<layer>:<zero-based order>:<content>, per the
                    // contract's stable identity for derived membership.
                    Value::String(format!(
                        "membership:{}:{position}:{node_id}",
                        layer.layer.id
                    )),
                ),
                ("member_order", Value::Int64(position as i64)),
                ("x", Value::Double(placement.map_or(0.0, |p| p.x))),
                ("y", Value::Double(placement.map_or(0.0, |p| p.y))),
                ("has_xy", Value::Bool(placement.is_some())),
                ("targets", targets.clone()),
            ],
        )?;
    }
    for edge in &layer.edges {
        write_edge(connection, targets, edge)?;
    }
    for action in &layer.actions {
        write_action(connection, targets, action)?;
    }
    Ok(())
}

fn write_node(connection: &Connection<'_>, targets: &Value, node: &GraphNode) -> Result<()> {
    let mut statement = connection.prepare(
        "MERGE (n:Content {id: $id}) \
         SET n.kind = $kind, n.icon = $icon, n.title = $title, n.detail = $detail, \
             n.state = $state, \
             n.published_targets = CASE WHEN n.published_targets IS NULL THEN $targets \
                 ELSE list_distinct(list_concat(n.published_targets, $targets)) END",
    )?;
    connection.execute(
        &mut statement,
        vec![
            ("id", Value::String(content_id(node))),
            ("kind", Value::String(node.kind.clone())),
            ("icon", Value::String(node.icon.clone())),
            ("title", Value::String(node.title.clone())),
            ("detail", Value::String(node.detail.clone())),
            ("state", Value::String(wire(node.state)?)),
            ("targets", targets.clone()),
        ],
    )?;
    Ok(())
}

fn write_edge(connection: &Connection<'_>, targets: &Value, edge: &GraphEdge) -> Result<()> {
    let mut statement = connection.prepare(
        "MATCH (a:Content), (b:Content) WHERE a.id = $from AND b.id = $to \
         MERGE (a)-[r:CONNECTED {id: $id}]->(b) \
         SET r.state = $state, \
             r.published_targets = CASE WHEN r.published_targets IS NULL THEN $targets \
                 ELSE list_distinct(list_concat(r.published_targets, $targets)) END",
    )?;
    connection.execute(
        &mut statement,
        vec![
            (
                "from",
                Value::String(format!("content:{}", edge.endpoints[0])),
            ),
            (
                "to",
                Value::String(format!("content:{}", edge.endpoints[1])),
            ),
            ("id", Value::String(format!("edge:{}", edge.id))),
            ("state", Value::String(wire(edge.state)?)),
            ("targets", targets.clone()),
        ],
    )?;
    Ok(())
}

/// Navigate actions become `EXPANDS` or `REFERENCES`. Invoke and
/// interaction-context actions are skipped: the frozen contract excludes them
/// from searchable topology.
fn write_action(connection: &Connection<'_>, targets: &Value, action: &GraphAction) -> Result<()> {
    if action.kind != ActionKind::Navigate {
        return Ok(());
    }
    let (Some(relation), Some(target_layer)) = (action.relation, action.target_layer_id) else {
        return Ok(());
    };
    let table = match relation {
        NavigateRelation::Expand => "EXPANDS",
        NavigateRelation::Reference => "REFERENCES",
    };
    let mut statement = connection.prepare(&format!(
        "MATCH (n:Content), (l:Layer) WHERE n.id = $source AND l.id = $target \
         MERGE (n)-[a:{table} {{id: $id}}]->(l) \
         SET a.source_layer_id = $source_layer_id, a.label = $label, a.variant = $variant, \
             a.icon = $icon, a.description = $description, a.relation = $relation, \
             a.state = $state, \
             a.published_targets = CASE WHEN a.published_targets IS NULL THEN $targets \
                 ELSE list_distinct(list_concat(a.published_targets, $targets)) END"
    ))?;
    connection.execute(
        &mut statement,
        vec![
            (
                "source",
                Value::String(format!("content:{}", action.source_node_id)),
            ),
            ("target", Value::String(format!("layer:{target_layer}"))),
            ("id", Value::String(format!("action:{}", action.id))),
            (
                "source_layer_id",
                Value::String(
                    action
                        .source_layer_id
                        .map_or_else(String::new, |id| format!("layer:{id}")),
                ),
            ),
            ("label", Value::String(action.label.clone())),
            ("variant", Value::String(wire(&action.variant)?)),
            (
                "icon",
                Value::String(action.icon.clone().unwrap_or_default()),
            ),
            (
                "description",
                Value::String(action.description.clone().unwrap_or_default()),
            ),
            ("relation", Value::String(wire(relation)?)),
            ("state", Value::String(wire(action.state)?)),
            ("targets", targets.clone()),
        ],
    )?;
    Ok(())
}
