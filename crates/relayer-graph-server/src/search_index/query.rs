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
        Column, CompareOp, Expression, Limit, NullPlacement, Ordering, PatternPart, Predicate,
        PropertyRef, QueryCode, QueryError, QueryLimits, QueryPlan, RelationshipType,
        SortDirection,
    },
};
use serde_json::{Value as JsonValue, json};
use std::collections::BTreeMap;

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
        text.push_str(&lower_pattern(pattern));
    }

    // Every binding is confined to the caller's target. This is added to the
    // query the caller wrote, never in place of anything they asked for, so a
    // query cannot widen its own visibility.
    let mut conditions = Vec::new();
    for pattern in &plan.patterns {
        for node in &pattern.nodes {
            conditions.push(format!(
                "list_contains({}.published_targets, $__target)",
                node.binding
            ));
        }
        for relationship in &pattern.relationships {
            if let Some(binding) = &relationship.binding {
                conditions.push(format!(
                    "list_contains({binding}.published_targets, $__target)"
                ));
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

    if !plan.ordering.is_empty() {
        // The engine rejects NULLS FIRST and NULLS LAST, so null placement is
        // lowered as an explicit sort key ahead of the column itself.
        let keys: Vec<String> = plan
            .ordering
            .iter()
            .flat_map(|ordering| {
                let alias = plan
                    .projection
                    .columns
                    .iter()
                    .position(|column| column.name == ordering.column)
                    .map(internal_alias)
                    .unwrap_or_else(|| ordering.column.clone());
                lower_ordering(ordering, &alias)
            })
            .collect();
        text.push_str(" ORDER BY ");
        text.push_str(&keys.join(", "));
    }

    // One row beyond the cap, so truncation is observed rather than guessed.
    let cap = row_cap(plan, parameters, limits)?;
    text.push_str(&format!(" LIMIT {}", cap.saturating_add(1)));

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

fn lower_pattern(pattern: &PatternPart) -> String {
    let mut text = String::new();
    if let Some(binding) = &pattern.path_binding {
        text.push_str(&format!("{binding} = "));
    }
    for (index, node) in pattern.nodes.iter().enumerate() {
        if index > 0 {
            let relationship = &pattern.relationships[index - 1];
            let name = relationship.relationship_type.as_str();
            let binding = relationship.binding.clone().unwrap_or_default();
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

fn lower_ordering(ordering: &Ordering, alias: &str) -> Vec<String> {
    let direction = match ordering.direction {
        SortDirection::Asc => "ASC",
        SortDirection::Desc => "DESC",
    };
    // `IS NULL` sorts false before true, so ASC puts present values first.
    let nulls = match ordering.nulls {
        NullPlacement::Last => format!("{alias} IS NULL ASC"),
        NullPlacement::First => format!("{alias} IS NULL DESC"),
    };
    vec![nulls, format!("{alias} {direction}")]
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
