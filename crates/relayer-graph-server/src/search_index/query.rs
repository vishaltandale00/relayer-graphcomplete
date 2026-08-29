//! Lower a typed v1 plan to Ladybug, execute it, and normalize the result.
//!
//! `relayer-graph-core` owns the engine-neutral half — envelope, grammar, plan,
//! limits, error precedence — and never sees a physical name. This is the other
//! half: the only place a plan becomes engine syntax.
//!
//! Two things are injected here and are deliberately not expressible in the
//! plan, so query text can never reach them: the publication predicate that
//! confines a query to the targets the caller may read, and the row and byte
//! caps. A caller cannot widen either by writing a cleverer query.

use anyhow::Result;
use lbug::{Connection, Value};
use relayer_graph_core::{
    SearchTarget,
    query::{
        Column, CompareOp, Expression, Limit, NullPlacement, PatternPart, Predicate, PropertyRef,
        QueryCode, QueryError, QueryLimits, QueryPlan, RelationshipType, SortDirection,
    },
};
use serde_json::{Value as JsonValue, json};
use std::{cmp::Ordering as Sort, collections::BTreeMap};

use super::{
    store::{endpoint_index, rows_with},
    value::normalize_value,
};

/// The physical column behind a public property name. Everything else is stored
/// under its public name, so only the exceptions are listed.
fn physical_property(relationship: Option<RelationshipType>, name: &str) -> &str {
    match (relationship, name) {
        (Some(RelationshipType::Contains), "order") => "member_order",
        _ => name,
    }
}

/// A normalized result row set, plus whether the byte or row cap truncated it.
pub struct QueryOutcome {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<JsonValue>>,
    pub truncated: bool,
}

impl QueryOutcome {
    pub fn to_json(&self) -> JsonValue {
        json!({
            "queryContractVersion": 1,
            "columns": self.columns,
            "rows": self.rows,
            "truncated": self.truncated,
        })
    }
}

/// Convert a tagged wire parameter into an engine value.
fn engine_value(name: &str, tagged: &JsonValue) -> Result<Value, QueryError> {
    let invalid = |message: &str| {
        QueryError::new(
            QueryCode::InvalidRequest,
            format!("parameters.{name}"),
            message.to_owned(),
        )
    };
    let kind = tagged
        .get("type")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| invalid("a parameter is a tagged value with a type"))?;
    let value = tagged.get("value");
    Ok(match kind {
        "string" => Value::String(
            value
                .and_then(JsonValue::as_str)
                .ok_or_else(|| invalid("a string parameter needs a string value"))?
                .to_owned(),
        ),
        // Integers travel as strings so a 64-bit value survives a JSON reader.
        "integer" => {
            let text = value
                .and_then(JsonValue::as_str)
                .ok_or_else(|| invalid("an integer parameter travels as a string"))?;
            Value::Int64(
                text.parse::<i64>()
                    .map_err(|_| invalid("an integer parameter is out of 64-bit range"))?,
            )
        }
        "float" => Value::Double(
            value
                .and_then(JsonValue::as_f64)
                .ok_or_else(|| invalid("a float parameter needs a number"))?,
        ),
        "boolean" => Value::Bool(
            value
                .and_then(JsonValue::as_bool)
                .ok_or_else(|| invalid("a boolean parameter needs true or false"))?,
        ),
        other => {
            return Err(invalid(&format!(
                "`{other}` is not an admitted parameter type"
            )));
        }
    })
}

struct Lowering {
    text: String,
    parameters: Vec<(String, Value)>,
}

/// Build the engine query for a plan, confined to `authorized`.
fn lower(
    plan: &QueryPlan,
    parameters: &serde_json::Map<String, JsonValue>,
    authorized: SearchTarget,
    limits: &QueryLimits,
) -> Result<Lowering, QueryError> {
    let mut bound = Vec::new();
    let mut text = String::from("MATCH ");
    for (index, pattern) in plan.patterns.iter().enumerate() {
        if index > 0 {
            text.push_str(", ");
        }
        text.push_str(&lower_pattern(index, pattern));
    }

    // Every binding is confined to the caller's target. This is added to the
    // query the caller wrote, never in place of anything they asked for, so a
    // query cannot widen its own visibility.
    let mut conditions = Vec::new();
    for (pattern_index, pattern) in plan.patterns.iter().enumerate() {
        for node in &pattern.nodes {
            conditions.push(format!(
                "list_contains({}.published_targets, $__target)",
                node.binding
            ));
        }
        for (index, relationship) in pattern.relationships.iter().enumerate() {
            let binding = relationship_binding(pattern_index, index, &relationship.binding);
            conditions.push(format!(
                "list_contains({binding}.published_targets, $__target)"
            ));
        }
    }

    // Relationship-unique trail: a walk may not traverse the same relationship
    // twice, so it cannot arrive back where it started by reusing an edge. The
    // contract's pathMatchMode names this exactly.
    for (pattern_index, pattern) in plan.patterns.iter().enumerate() {
        let bindings: Vec<String> = pattern
            .relationships
            .iter()
            .enumerate()
            .map(|(index, relationship)| {
                relationship_binding(pattern_index, index, &relationship.binding)
            })
            .collect();
        for (left, first) in bindings.iter().enumerate() {
            for second in bindings.iter().skip(left + 1) {
                conditions.push(format!("{first}.id <> {second}.id"));
            }
        }
    }
    bound.push(("__target".to_owned(), Value::String(authorized.to_string())));

    // The occurrence constraint: an action authored in one layer must not appear
    // to belong to another layer that merely reuses the same content.
    if plan.requires_occurrence_constraint {
        for pattern in &plan.patterns {
            let layer = pattern.relationships.iter().find_map(|relationship| {
                (relationship.relationship_type == RelationshipType::Contains)
                    .then(|| relationship.from.clone())
            });
            let action = pattern.relationships.iter().find(|relationship| {
                matches!(
                    relationship.relationship_type,
                    RelationshipType::Expands | RelationshipType::References
                )
            });
            if let (Some(layer), Some(action)) = (layer, action)
                && let Some(binding) = &action.binding
            {
                conditions.push(format!("{binding}.source_layer_id = {layer}.id"));
            }
        }
    }

    for predicate in &plan.predicates {
        match predicate {
            Predicate::PropertyComparison {
                property,
                operator,
                parameter,
            } => {
                let tagged = parameters.get(parameter).ok_or_else(|| {
                    QueryError::new(
                        QueryCode::InvalidRequest,
                        format!("parameters.{parameter}"),
                        format!("the query uses ${parameter} but the request does not supply it"),
                    )
                })?;
                bound.push((parameter.clone(), engine_value(parameter, tagged)?));
                conditions.push(format!(
                    "{} {} ${parameter}",
                    physical_reference(plan, property),
                    compare(*operator)
                ));
            }
            Predicate::NullTest { property, negated } => {
                conditions.push(format!(
                    "{} IS {}NULL",
                    physical_reference(plan, property),
                    if *negated { "NOT " } else { "" }
                ));
            }
        }
    }
    if !conditions.is_empty() {
        text.push_str(" WHERE ");
        text.push_str(&conditions.join(" AND "));
    }

    text.push_str(" RETURN ");
    // Public column names are aliased positionally. A contract alias like `order`
    // is a reserved word in the engine dialect; the public name is restored from
    // the plan when the result is assembled.
    let projected: Vec<String> = plan
        .projection
        .columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            format!(
                "{} AS {}",
                lower_expression(plan, &column.expression),
                internal_alias(index)
            )
        })
        .collect();
    text.push_str(&projected.join(", "));

    // Ordering is the contract's, not the engine's: rows are ordered after
    // normalization, so the engine is asked only to bound how many come back.
    text.push_str(&format!(
        " LIMIT {}",
        limits.intermediate_rows.saturating_add(1)
    ));

    Ok(Lowering {
        text,
        parameters: bound,
    })
}

fn row_cap(
    plan: &QueryPlan,
    parameters: &serde_json::Map<String, JsonValue>,
    limits: &QueryLimits,
) -> Result<usize, QueryError> {
    let requested = match &plan.limit {
        None => limits.default_rows,
        Some(Limit::Literal { value }) => *value,
        Some(Limit::Parameter { name }) => {
            let tagged = parameters.get(name).ok_or_else(|| {
                QueryError::new(
                    QueryCode::InvalidRequest,
                    format!("parameters.{name}"),
                    format!("the query uses ${name} but the request does not supply it"),
                )
            })?;
            let text = tagged
                .get("value")
                .and_then(JsonValue::as_str)
                .ok_or_else(|| {
                    QueryError::new(
                        QueryCode::QueryTypeMismatch,
                        format!("parameters.{name}"),
                        "a LIMIT parameter is a tagged integer",
                    )
                })?;
            text.parse::<usize>().map_err(|_| {
                QueryError::new(
                    QueryCode::QueryTypeMismatch,
                    format!("parameters.{name}"),
                    "a LIMIT parameter is a nonnegative integer",
                )
            })?
        }
    };
    if requested > limits.hard_rows {
        return Err(QueryError::new(
            QueryCode::RowLimitExceeded,
            "query",
            format!("LIMIT may not exceed {}", limits.hard_rows),
        ));
    }
    Ok(requested)
}

/// A binding for every relationship, generated when the query did not name one.
/// Without this an anonymous relationship escapes both the publication filter and
/// the trail constraint.
fn relationship_binding(pattern_index: usize, index: usize, binding: &Option<String>) -> String {
    binding
        .clone()
        .unwrap_or_else(|| format!("relayer_rel_{pattern_index}_{index}"))
}

fn lower_pattern(pattern_index: usize, pattern: &PatternPart) -> String {
    let mut text = String::new();
    if let Some(binding) = &pattern.path_binding {
        text.push_str(&format!("{binding} = "));
    }
    for (index, node) in pattern.nodes.iter().enumerate() {
        if index > 0 {
            let relationship = &pattern.relationships[index - 1];
            let name = relationship.relationship_type.as_str();
            let binding = relationship_binding(pattern_index, index - 1, &relationship.binding);
            text.push_str(&match relationship.relationship_type {
                RelationshipType::Connected => format!("-[{binding}:{name}]-"),
                _ => {
                    if relationship.to == node.binding {
                        format!("-[{binding}:{name}]->")
                    } else {
                        format!("<-[{binding}:{name}]-")
                    }
                }
            });
        }
        text.push_str(&format!(
            "({}{})",
            node.binding,
            node.label
                .map(|label| format!(":{}", label.as_str()))
                .unwrap_or_default()
        ));
    }
    text
}

fn relationship_of(plan: &QueryPlan, binding: &str) -> Option<RelationshipType> {
    plan.patterns.iter().find_map(|pattern| {
        pattern.relationships.iter().find_map(|relationship| {
            (relationship.binding.as_deref() == Some(binding))
                .then_some(relationship.relationship_type)
        })
    })
}

fn physical_reference(plan: &QueryPlan, property: &PropertyRef) -> String {
    let relationship = relationship_of(plan, &property.binding);
    format!(
        "{}.{}",
        property.binding,
        physical_property(relationship, &property.name)
    )
}

fn lower_expression(plan: &QueryPlan, expression: &Expression) -> String {
    match expression {
        Expression::Binding { binding } => binding.clone(),
        Expression::Property { property } => physical_reference(plan, property),
        Expression::Parameter { name } => format!("${name}"),
    }
}

fn internal_alias(index: usize) -> String {
    format!("relayer_column_{index}")
}

fn compare(operator: CompareOp) -> &'static str {
    operator.as_str()
}

/// Run one planned query against the store.
pub fn execute(
    connection: &Connection<'_>,
    plan: &QueryPlan,
    parameters: &serde_json::Map<String, JsonValue>,
    authorized: SearchTarget,
    limits: &QueryLimits,
) -> Result<QueryOutcome, QueryError> {
    let lowering = lower(plan, parameters, authorized, limits)?;
    let cap = row_cap(plan, parameters, limits)?;
    let endpoints = endpoint_index(connection).map_err(engine_failure)?;
    let raw = rows_with(connection, &lowering.text, lowering.parameters).map_err(engine_failure)?;

    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let undirected = plan.patterns.iter().any(|pattern| {
        pattern
            .relationships
            .iter()
            .any(|relationship| relationship.relationship_type.is_undirected())
    });
    for row in &raw {
        let normalized: Vec<JsonValue> = row
            .iter()
            .map(|value| normalize_value(value, &endpoints))
            .collect::<Result<_>>()
            .map_err(|error| {
                QueryError::new(QueryCode::InvalidEngineValue, "result", error.to_string())
            })?;
        // The engine reports an undirected relationship in both orientations.
        // The contract projects one physical/public relationship, so a matching
        // row is emitted once.
        if undirected && !seen.insert(canonical_key(&normalized)) {
            continue;
        }
        rows.push(normalized);
    }

    if rows.len() > limits.intermediate_rows {
        return Err(QueryError::new(
            QueryCode::IntermediateRowsExceeded,
            "query",
            format!(
                "the query matched more than {} rows before ordering",
                limits.intermediate_rows
            ),
        ));
    }
    order_rows(plan, &mut rows);
    let mut truncated = rows.len() > cap;
    rows.truncate(cap);

    // The encoded byte cap is a prefix truncation, reported as success.
    let mut encoded = serde_json::to_vec(&rows).unwrap_or_default().len();
    while encoded > limits.encoded_result_bytes && !rows.is_empty() {
        rows.pop();
        truncated = true;
        encoded = serde_json::to_vec(&rows).unwrap_or_default().len();
    }
    if rows.is_empty() && encoded > limits.encoded_result_bytes {
        return Err(QueryError::new(
            QueryCode::ResultRowTooLarge,
            "result",
            "a single row exceeds the encoded result cap",
        ));
    }

    Ok(QueryOutcome {
        columns: plan
            .projection
            .columns
            .iter()
            .map(|column: &Column| column.name.clone())
            .collect(),
        rows,
        truncated,
    })
}

/// A stable key for one normalized row, used to collapse the two orientations of
/// an undirected relationship.
fn canonical_key(row: &[JsonValue]) -> String {
    let mut parts = BTreeMap::new();
    for (index, value) in row.iter().enumerate() {
        parts.insert(index, value.to_string());
    }
    parts.values().cloned().collect::<Vec<_>>().join("\u{1f}")
}

fn engine_failure(error: anyhow::Error) -> QueryError {
    let text = format!("{error:#}");
    // The engine's own timeout surfaces as an interrupt; the contract reports
    // that as a wall-time failure rather than an opaque engine error.
    if text.contains("nterrupt") || text.contains("imeout") {
        QueryError::new(QueryCode::WallTimeExceeded, "query", text)
    } else {
        QueryError::new(QueryCode::InvalidEngineValue, "query", text)
    }
}

/// The contract's value type order:
/// null < boolean < integer < float < string < node < layer < relationship <
/// path < list < record.
fn type_rank(value: &JsonValue) -> u8 {
    match value.get("type").and_then(JsonValue::as_str) {
        Some("null") => 0,
        Some("boolean") => 1,
        Some("integer") => 2,
        Some("float") => 3,
        Some("string") => 4,
        Some("node") => 5,
        Some("layer") => 6,
        Some("relationship") => 7,
        Some("path") => 8,
        Some("list") => 9,
        Some("record") => 10,
        _ => 11,
    }
}

/// Compare two tagged values in the contract's canonical total order. No locale,
/// insertion order, physical row identity, or engine default order is
/// observable through this.
fn compare_values(left: &JsonValue, right: &JsonValue) -> Sort {
    let ranks = type_rank(left).cmp(&type_rank(right));
    if ranks != Sort::Equal {
        return ranks;
    }
    match left.get("type").and_then(JsonValue::as_str) {
        Some("null") => Sort::Equal,
        Some("boolean") => left["value"].as_bool().cmp(&right["value"].as_bool()),
        // Integers travel as strings; compare them mathematically, not lexically.
        Some("integer") => {
            let parse = |value: &JsonValue| {
                value["value"]
                    .as_str()
                    .and_then(|text| text.parse::<i64>().ok())
            };
            parse(left).cmp(&parse(right))
        }
        Some("float") => left["value"]
            .as_f64()
            .partial_cmp(&right["value"].as_f64())
            .unwrap_or(Sort::Equal),
        Some("string") => left["value"].as_str().cmp(&right["value"].as_str()),
        // Vertices compare identity then canonical properties; relationships
        // compare kind, identity, endpoints, then properties. Serializing after
        // those keys preserves the declared order without restating it.
        Some("node") | Some("layer") => (left["id"].as_str(), left["properties"].to_string())
            .cmp(&(right["id"].as_str(), right["properties"].to_string())),
        Some("relationship") => (
            left["kind"].as_str(),
            left["id"].as_str(),
            left["start"].as_str(),
            left["end"].as_str(),
            left["properties"].to_string(),
        )
            .cmp(&(
                right["kind"].as_str(),
                right["id"].as_str(),
                right["start"].as_str(),
                right["end"].as_str(),
                right["properties"].to_string(),
            )),
        _ => left.to_string().cmp(&right.to_string()),
    }
}

/// Compare complete projected rows in canonical order.
fn compare_rows(left: &[JsonValue], right: &[JsonValue]) -> Sort {
    for (left_value, right_value) in left.iter().zip(right.iter()) {
        let comparison = compare_values(left_value, right_value);
        if comparison != Sort::Equal {
            return comparison;
        }
    }
    left.len().cmp(&right.len())
}

/// Apply the plan's explicit ordering, then break ties canonically.
///
/// Nulls are always last unless the query said otherwise, and direction does not
/// change that default.
fn order_rows(plan: &QueryPlan, rows: &mut [Vec<JsonValue>]) {
    rows.sort_by(|left, right| {
        for ordering in &plan.ordering {
            let Some(index) = plan
                .projection
                .columns
                .iter()
                .position(|column| column.name == ordering.column)
            else {
                continue;
            };
            let (left_value, right_value) = (&left[index], &right[index]);
            let left_null = type_rank(left_value) == 0;
            let right_null = type_rank(right_value) == 0;
            if left_null != right_null {
                return match ordering.nulls {
                    NullPlacement::Last => {
                        if left_null {
                            Sort::Greater
                        } else {
                            Sort::Less
                        }
                    }
                    NullPlacement::First => {
                        if left_null {
                            Sort::Less
                        } else {
                            Sort::Greater
                        }
                    }
                };
            }
            let comparison = compare_values(left_value, right_value);
            let comparison = match ordering.direction {
                SortDirection::Asc => comparison,
                SortDirection::Desc => comparison.reverse(),
            };
            if comparison != Sort::Equal {
                return comparison;
            }
        }
        // Ties break by the canonical total order of the complete projected row,
        // so equivalent physical plans cannot reorder equal visible rows.
        compare_rows(left, right)
    });
}
