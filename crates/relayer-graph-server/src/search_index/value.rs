//! Value normalization between Ladybug's engine values and the frozen
//! `relayer.graph-query` v1 wire shape.
//!
//! Promoted from the issue #261 contract probe, which proved these lowerings
//! lossless for scalar, null, list, record, node, layer, relationship and path
//! values against `lbug` 0.18.0. The probe's frozen receipt is retained in
//! `docs/evidence/issue-261-ladybug-contract-probe/`.

use std::collections::BTreeMap;

use anyhow::{Context, Result, bail};
use lbug::{InternalID, LogicalType, NodeVal, RelVal, Value};
use serde_json::{Value as JsonValue, json};

/// Maps a node's engine-internal identity to its stable Relayer identity, so a
/// relationship can name its endpoints without a second lookup.
pub type EndpointIds = BTreeMap<InternalID, String>;

/// Undirected relationships are the ones the engine reports in both
/// orientations, so their endpoints are ordered canonically before comparison.
const UNDIRECTED_RELATIONSHIP: &str = "CONNECTED";

pub fn property<'a>(properties: &'a [(String, Value)], name: &str) -> Result<&'a Value> {
    properties
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .with_context(|| format!("missing physical property {name}"))
}

pub fn string_property(properties: &[(String, Value)], name: &str) -> Result<String> {
    match property(properties, name)? {
        Value::String(value) => Ok(value.clone()),
        value => bail!("physical property {name} was not a string: {value:?}"),
    }
}

/// The wire descriptor for a list's element type. A typed empty list has to keep
/// its descriptor, which is why the type travels separately from the values.
pub fn list_descriptor(logical_type: &LogicalType) -> Result<JsonValue> {
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
            }))).collect::<Result<Vec<_>>>()?,
        }),
        other => bail!("unsupported v1 list descriptor: {other:?}"),
    })
}

pub fn normalize_node(node: &NodeVal) -> Result<JsonValue> {
    let properties = node.get_properties();
    let id = string_property(properties, "id")?;
    let (value_type, public_names) = match node.get_label_name().as_str() {
        "Content" => ("node", &["kind", "icon", "title", "detail", "state"][..]),
        "Layer" => ("layer", &["state", "layout_version"][..]),
        label => bail!("unexpected node label {label}"),
    };
    let mut public_properties = Vec::new();
    for name in public_names {
        // A layer with no authored layout has no layout version to report, as
        // distinct from reporting one that is null.
        if *name == "layout_version"
            && matches!(property(properties, "has_layout")?, Value::Bool(false))
        {
            continue;
        }
        public_properties.push(json!({
            "name": name,
            "value": normalize_value(property(properties, name)?, &EndpointIds::new())?,
        }));
    }
    Ok(json!({
        "type": value_type,
        "id": id,
        "kind": node.get_label_name(),
        "properties": public_properties,
    }))
}

pub fn normalize_relationship(
    relationship: &RelVal,
    endpoint_ids: &EndpointIds,
) -> Result<JsonValue> {
    let properties = relationship.get_properties();
    let id = string_property(properties, "id")?;
    let kind = relationship.get_label_name();
    let kind = kind.as_str();
    let mut start = endpoint_ids
        .get(relationship.get_src_node())
        .context("relationship source identity was not indexed")?
        .clone();
    let mut end = endpoint_ids
        .get(relationship.get_dst_node())
        .context("relationship destination identity was not indexed")?
        .clone();
    let directed = kind != UNDIRECTED_RELATIONSHIP;
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
        other => bail!("unexpected relationship kind {other}"),
    };
    let has_xy = kind != "CONTAINS" || matches!(property(properties, "has_xy")?, Value::Bool(true));
    let mut public_properties = Vec::new();
    for (public_name, physical_name) in names {
        // A membership with no placement omits its coordinates rather than
        // reporting a default position it was never given.
        if kind == "CONTAINS" && !has_xy && matches!(*public_name, "x" | "y") {
            continue;
        }
        let value = property(properties, physical_name)?;
        // The engine has no absent-property spelling, so an unset optional string
        // is stored empty and omitted on the way out.
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

pub fn normalize_value(value: &Value, endpoint_ids: &EndpointIds) -> Result<JsonValue> {
    Ok(match value {
        Value::Null(_) => json!({"type": "null"}),
        Value::Bool(value) => json!({"type": "boolean", "value": value}),
        // Integers travel as strings so a 64-bit value survives a JSON reader
        // that would otherwise round it through a double.
        Value::Int64(value) => json!({"type": "integer", "value": value.to_string()}),
        Value::Int128(value) => {
            let value = i64::try_from(*value)
                .map_err(|_| anyhow::anyhow!("engine integer exceeded i64"))?;
            json!({"type": "integer", "value": value.to_string()})
        }
        Value::Double(value) => json!({"type": "float", "value": canonical_float(*value)?}),
        Value::Float(value) => json!({"type": "float", "value": canonical_float(*value)?}),
        Value::String(value) => json!({"type": "string", "value": value}),
        Value::List(logical_type, values) => json!({
            "type": "list",
            "elementType": list_descriptor(logical_type)?,
            "values": values.iter().map(|value| normalize_value(value, endpoint_ids)).collect::<Result<Vec<_>>>()?,
        }),
        Value::Struct(fields) => json!({
            "type": "record",
            "fields": fields.iter().map(|(name, value)| Ok(json!({
                "name": name,
                "value": normalize_value(value, endpoint_ids)?,
            }))).collect::<Result<Vec<_>>>()?,
        }),
        Value::Node(node) => normalize_node(node)?,
        Value::Rel(relationship) => normalize_relationship(relationship, endpoint_ids)?,
        Value::RecursiveRel { nodes, rels } => json!({
            "type": "path",
            "vertices": nodes.iter().map(normalize_node).collect::<Result<Vec<_>>>()?,
            "relationships": rels.iter().map(|relationship| normalize_relationship(relationship, endpoint_ids)).collect::<Result<Vec<_>>>()?,
        }),
        other => bail!("unsupported v1 engine value: {other:?}"),
    })
}

/// Nonfinite floats have no v1 spelling, and negative zero is canonicalised so
/// two equal numbers never encode differently.
fn canonical_float<F: Into<f64>>(value: F) -> Result<f64> {
    let value = value.into();
    if !value.is_finite() {
        bail!("engine returned a nonfinite float");
    }
    Ok(if value == 0.0 { 0.0 } else { value })
}
