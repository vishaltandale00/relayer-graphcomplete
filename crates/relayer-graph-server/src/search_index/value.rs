//! Value normalization between Ladybug's engine values and the frozen
//! `relayer.graph-query` v1 wire shape.
//!
//! Promoted from the issue #261 contract probe, which proved these lowerings
//! lossless for scalar, null, list, record, node, layer, relationship and path
//! values against `lbug` 0.18.0. The probe's frozen receipt is retained in
//! `docs/evidence/issue-261-ladybug-contract-probe/`.

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
};

use lbug::{InternalID, LogicalType, NodeVal, RelVal, Value};
use serde_json::{Value as JsonValue, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NormalizeFailureKind {
    InvalidEngineValue,
    HeterogeneousList,
    IntegerOverflow,
    DuplicateRecordField,
}

#[derive(Debug)]
pub(crate) struct NormalizeFailure {
    kind: NormalizeFailureKind,
    detail: String,
}

impl NormalizeFailure {
    fn new(kind: NormalizeFailureKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }

    pub(crate) fn kind(&self) -> NormalizeFailureKind {
        self.kind
    }
}

impl fmt::Display for NormalizeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.detail)
    }
}

impl Error for NormalizeFailure {}

type NormalizeResult<T> = Result<T, NormalizeFailure>;

fn invalid(detail: impl Into<String>) -> NormalizeFailure {
    NormalizeFailure::new(NormalizeFailureKind::InvalidEngineValue, detail)
}

/// Maps a node's engine-internal identity to its stable Relayer identity, so a
/// relationship can name its endpoints without a second lookup.
pub type EndpointIds = BTreeMap<InternalID, String>;

/// Add the stable identities carried by node values in one bounded query row.
/// Relationship values carry only engine-internal endpoint IDs, so lowering
/// projects the matched endpoint nodes beside them rather than scanning the
/// shared store to build a global index.
pub fn index_endpoint_nodes(value: &Value, endpoint_ids: &mut EndpointIds) -> NormalizeResult<()> {
    match value {
        Value::Node(node) => {
            endpoint_ids.insert(
                node.get_node_id().clone(),
                string_property(node.get_properties(), "id")?,
            );
        }
        Value::List(_, values) => {
            for value in values {
                index_endpoint_nodes(value, endpoint_ids)?;
            }
        }
        Value::Struct(fields) => {
            for (_, value) in fields {
                index_endpoint_nodes(value, endpoint_ids)?;
            }
        }
        Value::RecursiveRel { nodes, .. } => {
            for node in nodes {
                endpoint_ids.insert(
                    node.get_node_id().clone(),
                    string_property(node.get_properties(), "id")?,
                );
            }
        }
        _ => {}
    }
    Ok(())
}

/// Undirected relationships are the ones the engine reports in both
/// orientations, so their endpoints are ordered canonically before comparison.
const UNDIRECTED_RELATIONSHIP: &str = "CONNECTED";

pub fn property<'a>(properties: &'a [(String, Value)], name: &str) -> NormalizeResult<&'a Value> {
    properties
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .ok_or_else(|| invalid(format!("missing physical property {name}")))
}

pub fn string_property(properties: &[(String, Value)], name: &str) -> NormalizeResult<String> {
    match property(properties, name)? {
        Value::String(value) => Ok(value.clone()),
        value => Err(invalid(format!(
            "physical property {name} was not a string: {value:?}"
        ))),
    }
}

/// The wire descriptor for a list's element type. A typed empty list has to keep
/// its descriptor, which is why the type travels separately from the values.
pub fn list_descriptor(logical_type: &LogicalType) -> NormalizeResult<JsonValue> {
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
            }))).collect::<NormalizeResult<Vec<_>>>()?,
        }),
        other => {
            return Err(invalid(format!(
                "unsupported v1 list descriptor: {other:?}"
            )));
        }
    })
}

pub fn normalize_node(node: &NodeVal) -> NormalizeResult<JsonValue> {
    let properties = node.get_properties();
    let id = string_property(properties, "id")?;
    let (value_type, public_names) = match node.get_label_name().as_str() {
        "Content" => ("node", &["kind", "icon", "title", "detail", "state"][..]),
        "Layer" => ("layer", &["state", "layout_version"][..]),
        label => return Err(invalid(format!("unexpected node label {label}"))),
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
) -> NormalizeResult<JsonValue> {
    let properties = relationship.get_properties();
    let id = string_property(properties, "id")?;
    let kind = relationship.get_label_name();
    let kind = kind.as_str();
    let mut start = endpoint_ids
        .get(relationship.get_src_node())
        .ok_or_else(|| invalid("relationship source identity was not indexed"))?
        .clone();
    let mut end = endpoint_ids
        .get(relationship.get_dst_node())
        .ok_or_else(|| invalid("relationship destination identity was not indexed"))?
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
        other => return Err(invalid(format!("unexpected relationship kind {other}"))),
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

pub fn normalize_value(value: &Value, endpoint_ids: &EndpointIds) -> NormalizeResult<JsonValue> {
    Ok(match value {
        Value::Null(_) => json!({"type": "null"}),
        Value::Bool(value) => json!({"type": "boolean", "value": value}),
        // Integers travel as strings so a 64-bit value survives a JSON reader
        // that would otherwise round it through a double.
        Value::Int64(value) => json!({"type": "integer", "value": value.to_string()}),
        Value::Int128(value) => {
            let value = i64::try_from(*value).map_err(|_| {
                NormalizeFailure::new(
                    NormalizeFailureKind::IntegerOverflow,
                    "engine integer exceeded signed 64-bit range",
                )
            })?;
            json!({"type": "integer", "value": value.to_string()})
        }
        Value::Double(value) => json!({"type": "float", "value": canonical_float(*value)?}),
        Value::Float(value) => json!({"type": "float", "value": canonical_float(*value)?}),
        Value::String(value) => json!({"type": "string", "value": value}),
        Value::List(logical_type, values) => {
            let mut declared = list_descriptor(logical_type)?;
            let normalized = values
                .iter()
                .map(|value| normalize_value(value, endpoint_ids))
                .collect::<NormalizeResult<Vec<_>>>()?;
            // Ladybug's logical Node type covers both Content and Layer. The
            // Relayer wire algebra distinguishes them, so a nonempty engine
            // list takes the precise normalized vertex descriptor. Empty
            // aggregate lists are corrected from the typed plan by the query
            // executor.
            if matches!(logical_type, LogicalType::Node)
                && let Some(first) = normalized.first()
            {
                declared = normalized_descriptor(first);
            }
            if normalized
                .iter()
                .any(|value| normalized_descriptor(value) != declared)
            {
                return Err(NormalizeFailure::new(
                    NormalizeFailureKind::HeterogeneousList,
                    "engine list values did not match one recursive element descriptor",
                ));
            }
            json!({
                "type": "list",
                "elementType": declared,
                "values": normalized,
            })
        }
        Value::Struct(fields) => {
            let mut seen = BTreeSet::new();
            let mut normalized = Vec::new();
            for (name, value) in fields {
                if !seen.insert(name) {
                    return Err(NormalizeFailure::new(
                        NormalizeFailureKind::DuplicateRecordField,
                        "engine record contained a duplicate field",
                    ));
                }
                normalized.push(json!({
                    "name": name,
                    "value": normalize_value(value, endpoint_ids)?,
                }));
            }
            json!({"type": "record", "fields": normalized})
        }
        Value::Node(node) => normalize_node(node)?,
        Value::Rel(relationship) => normalize_relationship(relationship, endpoint_ids)?,
        Value::RecursiveRel { nodes, rels } => json!({
            "type": "path",
            "vertices": nodes.iter().map(normalize_node).collect::<NormalizeResult<Vec<_>>>()?,
            "relationships": rels.iter().map(|relationship| normalize_relationship(relationship, endpoint_ids)).collect::<NormalizeResult<Vec<_>>>()?,
        }),
        other => return Err(invalid(format!("unsupported v1 engine value: {other:?}"))),
    })
}

/// Nonfinite floats have no v1 spelling, and negative zero is canonicalised so
/// two equal numbers never encode differently.
fn canonical_float<F: Into<f64>>(value: F) -> NormalizeResult<f64> {
    let value = value.into();
    if !value.is_finite() {
        return Err(invalid("engine returned a nonfinite float"));
    }
    Ok(if value == 0.0 { 0.0 } else { value })
}

pub(super) fn normalized_descriptor(value: &JsonValue) -> JsonValue {
    match value.get("type").and_then(JsonValue::as_str) {
        Some("list") => json!({
            "kind": "list",
            "elementType": value["elementType"].clone(),
        }),
        Some("record") => json!({
            "kind": "record",
            "fields": value["fields"].as_array().into_iter().flatten().map(|field| json!({
                "name": field["name"].clone(),
                "type": normalized_descriptor(&field["value"]),
            })).collect::<Vec<_>>(),
        }),
        Some(kind) => json!({"kind": kind}),
        None => json!({"kind": "invalid"}),
    }
}
