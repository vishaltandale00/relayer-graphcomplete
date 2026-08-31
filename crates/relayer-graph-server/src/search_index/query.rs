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
use lbug::{Connection, LogicalType, Value};
use relayer_graph_core::{
    SearchTarget,
    query::{
        AggregateFunction, Column, CompareOp, Expression, Limit, NullPlacement, PatternPart,
        Predicate, PropertyRef, QueryCode, QueryError, QueryLimits, QueryPlan, RelationshipType,
        SortDirection,
    },
};
use serde::Serialize;
use serde_json::{Value as JsonValue, json};
use std::cmp::Ordering as Sort;

use super::{
    QueryCancellation,
    store::rows_with,
    value::{
        EndpointIds, NormalizeFailure, NormalizeFailureKind, index_endpoint_nodes, normalize_value,
        normalized_descriptor,
    },
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryOutcome {
    pub query_contract_version: u32,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<JsonValue>>,
    pub truncated: bool,
}

impl QueryOutcome {
    pub fn to_json(&self) -> JsonValue {
        serde_json::to_value(self).expect("query outcome serializes")
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
    if contains_graph_value(tagged) {
        return serde_json::to_string(tagged)
            .map(Value::String)
            .map_err(|_| invalid("a graph parameter could not be encoded"));
    }
    let value = tagged.get("value");
    Ok(match kind {
        "null" => Value::Null(LogicalType::Any),
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
        "list" => {
            let descriptor = tagged
                .get("elementType")
                .ok_or_else(|| invalid("a list parameter needs elementType"))?;
            let child_type = logical_type(name, descriptor)?;
            let values = tagged
                .get("values")
                .and_then(JsonValue::as_array)
                .ok_or_else(|| invalid("a list parameter needs values"))?
                .iter()
                .map(|value| engine_value(name, value))
                .collect::<Result<Vec<_>, _>>()?;
            Value::List(child_type, values)
        }
        "record" => {
            let fields = tagged
                .get("fields")
                .and_then(JsonValue::as_array)
                .ok_or_else(|| invalid("a record parameter needs fields"))?
                .iter()
                .map(|field| {
                    let field_name = field
                        .get("name")
                        .and_then(JsonValue::as_str)
                        .ok_or_else(|| invalid("a record field needs a name"))?;
                    let value = field
                        .get("value")
                        .ok_or_else(|| invalid("a record field needs a value"))?;
                    Ok((field_name.to_owned(), engine_value(name, value)?))
                })
                .collect::<Result<Vec<_>, QueryError>>()?;
            Value::Struct(fields)
        }
        other => {
            return Err(invalid(&format!(
                "`{other}` is not an admitted parameter type"
            )));
        }
    })
}

fn contains_graph_value(tagged: &JsonValue) -> bool {
    match tagged.get("type").and_then(JsonValue::as_str) {
        Some("node" | "layer" | "relationship" | "path") => true,
        Some("list") => tagged["values"]
            .as_array()
            .is_some_and(|values| values.iter().any(contains_graph_value)),
        Some("record") => tagged["fields"].as_array().is_some_and(|fields| {
            fields
                .iter()
                .any(|field| contains_graph_value(&field["value"]))
        }),
        _ => false,
    }
}

fn logical_type(name: &str, descriptor: &JsonValue) -> Result<LogicalType, QueryError> {
    let invalid = |message: &str| {
        QueryError::new(
            QueryCode::InvalidRequest,
            format!("parameters.{name}"),
            message,
        )
    };
    let kind = descriptor
        .get("kind")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| invalid("a type descriptor needs a kind"))?;
    Ok(match kind {
        "boolean" => LogicalType::Bool,
        "integer" => LogicalType::Int64,
        "float" => LogicalType::Double,
        "string" => LogicalType::String,
        "list" => LogicalType::List {
            child_type: Box::new(logical_type(
                name,
                descriptor
                    .get("elementType")
                    .ok_or_else(|| invalid("a list descriptor needs elementType"))?,
            )?),
        },
        "record" => LogicalType::Struct {
            fields: descriptor
                .get("fields")
                .and_then(JsonValue::as_array)
                .ok_or_else(|| invalid("a record descriptor needs fields"))?
                .iter()
                .map(|field| {
                    Ok((
                        field
                            .get("name")
                            .and_then(JsonValue::as_str)
                            .ok_or_else(|| invalid("a record descriptor field needs a name"))?
                            .to_owned(),
                        logical_type(
                            name,
                            field
                                .get("type")
                                .ok_or_else(|| invalid("a record descriptor field needs a type"))?,
                        )?,
                    ))
                })
                .collect::<Result<Vec<_>, QueryError>>()?,
        },
        _ => return Err(invalid("the parameter type is not bindable in v1")),
    })
}

struct Lowering {
    text: String,
    intermediate_probe: String,
    expansion_probes: Vec<String>,
    parameters: Vec<(String, Value)>,
}

fn engine_safe_binding(binding: &str) -> String {
    format!("relayer_user_{binding}")
}

fn rename_expression_bindings(expression: &mut Expression) {
    match expression {
        Expression::Binding { binding } => *binding = engine_safe_binding(binding),
        Expression::Property { property } => {
            property.binding = engine_safe_binding(&property.binding);
        }
        Expression::List { items } => items.iter_mut().for_each(rename_expression_bindings),
        Expression::Record { fields } => fields
            .iter_mut()
            .for_each(|field| rename_expression_bindings(&mut field.value)),
        Expression::Aggregate { argument, .. } => {
            if let Some(argument) = argument {
                rename_expression_bindings(argument);
            }
        }
        Expression::Parameter { .. } => {}
    }
}

/// Ladybug's dialect reserves words that remain valid public v1 identifiers.
/// Lower through private, collision-free names so engine syntax never narrows
/// the frozen public identifier grammar.
fn engine_safe_plan(plan: &QueryPlan) -> QueryPlan {
    let mut plan = plan.clone();
    for pattern in &mut plan.patterns {
        if let Some(binding) = &mut pattern.path_binding {
            *binding = engine_safe_binding(binding);
        }
        for node in &mut pattern.nodes {
            node.binding = engine_safe_binding(&node.binding);
        }
        for relationship in &mut pattern.relationships {
            if let Some(binding) = &mut relationship.binding {
                *binding = engine_safe_binding(binding);
            }
            relationship.from = engine_safe_binding(&relationship.from);
            relationship.to = engine_safe_binding(&relationship.to);
        }
    }
    for predicate in &mut plan.predicates {
        let property = match predicate {
            Predicate::PropertyComparison { property, .. }
            | Predicate::NullTest { property, .. }
            | Predicate::AbsenceTest { property, .. } => property,
        };
        property.binding = engine_safe_binding(&property.binding);
    }
    for column in &mut plan.projection.columns {
        rename_expression_bindings(&mut column.expression);
    }
    plan
}

/// Build the engine query for a plan, confined to `authorized`.
fn lower(
    plan: &QueryPlan,
    parameters: &serde_json::Map<String, JsonValue>,
    authorized: SearchTarget,
    limits: &QueryLimits,
) -> Result<Lowering, QueryError> {
    let engine_plan = engine_safe_plan(plan);
    let plan = &engine_plan;
    let mut bound = Vec::new();
    let mut target_parameter = "__relayer_target".to_owned();
    while parameters.contains_key(&target_parameter) {
        target_parameter.push('_');
    }
    let mut text = String::from("MATCH ");
    for (index, pattern) in plan.patterns.iter().enumerate() {
        if index > 0 {
            text.push_str(", ");
        }
        text.push_str(&lower_pattern(plan, index, pattern));
    }
    let match_text = text.clone();

    // Every binding is confined to the caller's target. This is added to the
    // query the caller wrote, never in place of anything they asked for, so a
    // query cannot widen its own visibility.
    let mut conditions = Vec::new();
    for (pattern_index, pattern) in plan.patterns.iter().enumerate() {
        for node in &pattern.nodes {
            conditions.push(format!(
                "list_contains({}.published_targets, ${target_parameter})",
                node.binding,
            ));
        }
        for (index, relationship) in pattern.relationships.iter().enumerate() {
            let binding = relationship_binding(plan, pattern_index, index, &relationship.binding);
            conditions.push(format!(
                "list_contains({binding}.published_targets, ${target_parameter})"
            ));
        }
    }

    // Relationship-unique trail: a walk may not traverse the same relationship
    // twice, so it cannot arrive back where it started by reusing an edge. The
    // contract's pathMatchMode names this exactly.
    for bindings in joined_relationship_components(plan) {
        for (left, first) in bindings.iter().enumerate() {
            for second in bindings.iter().skip(left + 1) {
                conditions.push(format!("{first}.id <> {second}.id"));
            }
        }
    }
    bound.push((
        target_parameter.clone(),
        Value::String(authorized.to_string()),
    ));

    // The occurrence constraint: an action authored in one layer must not appear
    // to belong to another layer that merely reuses the same content.
    if plan.requires_occurrence_constraint {
        let relationships = plan
            .patterns
            .iter()
            .enumerate()
            .flat_map(|(pattern_index, pattern)| {
                pattern.relationships.iter().enumerate().map(
                    move |(relationship_index, relationship)| {
                        (
                            relationship,
                            relationship_binding(
                                plan,
                                pattern_index,
                                relationship_index,
                                &relationship.binding,
                            ),
                        )
                    },
                )
            })
            .collect::<Vec<_>>();
        for (membership, _) in relationships.iter().filter(|(relationship, _)| {
            relationship.relationship_type == RelationshipType::Contains
        }) {
            for (action, binding) in relationships.iter().filter(|(relationship, _)| {
                matches!(
                    relationship.relationship_type,
                    RelationshipType::Expands | RelationshipType::References
                )
            }) {
                if membership.to == action.from {
                    conditions.push(format!(
                        "{binding}.source_layer_id = {}.id",
                        membership.from
                    ));
                }
            }
        }
    }
    let structural_conditions = conditions.clone();

    for predicate in &plan.predicates {
        if let Predicate::PropertyComparison { parameter, .. } = predicate {
            let tagged = parameters.get(parameter).ok_or_else(|| {
                QueryError::new(
                    QueryCode::InvalidRequest,
                    format!("parameters.{parameter}"),
                    format!("the query uses ${parameter} but the request does not supply it"),
                )
            })?;
            bound.push((parameter.clone(), engine_value(parameter, tagged)?));
        }
        conditions.push(predicate_condition(plan, predicate, None));
    }

    // Ladybug yields both orientations for CONNECTED. Keep the orientation
    // selected by endpoint predicates when only one survives; if both survive,
    // retain the canonical lower-public-identity endpoint on the left.
    for pattern in &plan.patterns {
        for relationship in &pattern.relationships {
            if !relationship.relationship_type.is_undirected() {
                continue;
            }
            let swapped = plan
                .predicates
                .iter()
                .filter(|predicate| {
                    let binding = predicate_property(predicate).binding.as_str();
                    binding == relationship.from || binding == relationship.to
                })
                .map(|predicate| {
                    predicate_condition(
                        plan,
                        predicate,
                        Some((&relationship.from, &relationship.to)),
                    )
                })
                .collect::<Vec<_>>();
            let canonical = format!("{}.id < {}.id", relationship.from, relationship.to);
            if swapped.is_empty() {
                conditions.push(canonical);
            } else {
                conditions.push(format!("({canonical} OR NOT ({}))", swapped.join(" AND ")));
            }
        }
    }
    let mut projection_parameters = std::collections::BTreeSet::new();
    for column in &plan.projection.columns {
        collect_expression_parameters(&column.expression, &mut projection_parameters);
    }
    for name in projection_parameters {
        if bound.iter().any(|(existing, _)| existing == &name) {
            continue;
        }
        let tagged = parameters.get(&name).ok_or_else(|| {
            QueryError::new(
                QueryCode::InvalidRequest,
                format!("parameters.{name}"),
                format!("the query uses ${name} but the request does not supply it"),
            )
        })?;
        bound.push((name.clone(), engine_value(&name, tagged)?));
    }
    if !conditions.is_empty() {
        text.push_str(" WHERE ");
        text.push_str(&conditions.join(" AND "));
    }

    let structural_where = if structural_conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", structural_conditions.join(" AND "))
    };
    let intermediate_probe = format!(
        "{match_text}{structural_where} RETURN {} LIMIT {}",
        work_probe_projection(plan),
        work_probe_cap(limits),
    );
    let expansion_probes = expansion_probes(plan, &target_parameter, limits);

    text.push_str(" RETURN ");
    // Public column names are aliased positionally. A contract alias like `order`
    // is a reserved word in the engine dialect; the public name is restored from
    // the plan when the result is assembled.
    let mut projected: Vec<String> = plan
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
    let has_aggregate = plan
        .projection
        .columns
        .iter()
        .any(|column| column.expression.has_aggregate());
    if !has_aggregate {
        projected.extend(hidden_identity_expressions(plan));
    }
    let endpoint_start = projected.len();
    projected.extend(hidden_endpoint_expressions(
        plan,
        endpoint_start,
        has_aggregate,
    ));
    text.push_str(&projected.join(", "));

    // Ordering is the contract's, not the engine's: rows are ordered after
    // normalization, so the engine is asked only to bound how many come back.
    text.push_str(&format!(" LIMIT {}", engine_work_cap(limits)));

    Ok(Lowering {
        text,
        intermediate_probe,
        expansion_probes,
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
            "query.limit",
            format!("LIMIT may not exceed {}", limits.hard_rows),
        ));
    }
    Ok(requested)
}

/// A binding for every relationship, generated when the query did not name one.
/// Without this an anonymous relationship escapes both the publication filter and
/// the trail constraint.
fn relationship_binding(
    plan: &QueryPlan,
    pattern_index: usize,
    index: usize,
    binding: &Option<String>,
) -> String {
    if let Some(binding) = binding {
        return binding.clone();
    }
    let used = plan
        .patterns
        .iter()
        .flat_map(|pattern| {
            pattern
                .nodes
                .iter()
                .map(|node| node.binding.as_str())
                .chain(
                    pattern
                        .relationships
                        .iter()
                        .filter_map(|relationship| relationship.binding.as_deref()),
                )
                .chain(pattern.path_binding.as_deref())
        })
        .collect::<std::collections::BTreeSet<_>>();
    let mut generated = format!("relayer_rel_{pattern_index}_{index}");
    while used.contains(generated.as_str()) {
        generated.push('_');
    }
    generated
}

fn joined_relationship_components(plan: &QueryPlan) -> Vec<Vec<String>> {
    let mut components: Vec<(std::collections::BTreeSet<String>, Vec<String>)> = Vec::new();
    for (pattern_index, pattern) in plan.patterns.iter().enumerate() {
        let mut nodes = pattern
            .nodes
            .iter()
            .map(|node| node.binding.clone())
            .collect::<std::collections::BTreeSet<_>>();
        let mut relationships = pattern
            .relationships
            .iter()
            .enumerate()
            .map(|(index, relationship)| {
                relationship_binding(plan, pattern_index, index, &relationship.binding)
            })
            .collect::<Vec<_>>();
        let mut remaining = Vec::new();
        for (existing_nodes, existing_relationships) in components.drain(..) {
            if existing_nodes.is_disjoint(&nodes) {
                remaining.push((existing_nodes, existing_relationships));
            } else {
                nodes.extend(existing_nodes);
                relationships.extend(existing_relationships);
            }
        }
        remaining.push((nodes, relationships));
        components = remaining;
    }
    components
        .into_iter()
        .map(|(_, relationships)| relationships)
        .collect()
}

fn lower_pattern(plan: &QueryPlan, pattern_index: usize, pattern: &PatternPart) -> String {
    let mut text = String::new();
    if let Some(binding) = &pattern.path_binding {
        text.push_str(&format!("{binding} = "));
    }
    for (index, node) in pattern.nodes.iter().enumerate() {
        if index > 0 {
            let relationship = &pattern.relationships[index - 1];
            let name = relationship.relationship_type.as_str();
            let binding =
                relationship_binding(plan, pattern_index, index - 1, &relationship.binding);
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

/// Physical presence sentinels used to preserve the public distinction between
/// absent, null, and present values despite Ladybug's fixed table columns.
fn presence_expression(plan: &QueryPlan, property: &PropertyRef) -> Option<String> {
    match (
        relationship_of(plan, &property.binding),
        property.name.as_str(),
    ) {
        (None, "layout_version") => Some(format!("{}.has_layout", property.binding)),
        (Some(RelationshipType::Contains), "x" | "y") => {
            Some(format!("{}.has_xy", property.binding))
        }
        (
            Some(RelationshipType::Expands | RelationshipType::References),
            "source_layer_id" | "icon" | "description",
        ) => Some(format!(
            "{}.{} <> ''",
            property.binding,
            physical_property(relationship_of(plan, &property.binding), &property.name)
        )),
        _ => None,
    }
}

fn predicate_property(predicate: &Predicate) -> &PropertyRef {
    match predicate {
        Predicate::PropertyComparison { property, .. }
        | Predicate::NullTest { property, .. }
        | Predicate::AbsenceTest { property, .. } => property,
    }
}

fn predicate_condition(
    plan: &QueryPlan,
    predicate: &Predicate,
    swap: Option<(&str, &str)>,
) -> String {
    let remap = |property: &PropertyRef| {
        let mut property = property.clone();
        if let Some((left, right)) = swap {
            if property.binding == left {
                property.binding = right.to_owned();
            } else if property.binding == right {
                property.binding = left.to_owned();
            }
        }
        property
    };
    match predicate {
        Predicate::PropertyComparison {
            property,
            operator,
            parameter,
        } => {
            let property = remap(property);
            let reference = physical_reference(plan, &property);
            let comparison = format!("{reference} {} ${parameter}", compare(*operator));
            match presence_expression(plan, &property) {
                Some(presence) => format!("({presence} AND {comparison})"),
                None => comparison,
            }
        }
        Predicate::NullTest { property, negated } => {
            let property = remap(property);
            let reference = physical_reference(plan, &property);
            let null_test = format!("{reference} IS {}NULL", if *negated { "NOT " } else { "" });
            match presence_expression(plan, &property) {
                Some(presence) => format!("({presence} AND {null_test})"),
                None => null_test,
            }
        }
        Predicate::AbsenceTest { property, negated } => {
            let property = remap(property);
            match presence_expression(plan, &property) {
                Some(presence) if *negated => presence,
                Some(presence) => format!("NOT ({presence})"),
                None if *negated => "true".to_owned(),
                None => "false".to_owned(),
            }
        }
    }
}

fn engine_work_cap(limits: &QueryLimits) -> usize {
    // Expansion probes enforce their budget independently. Expansion counts add
    // across pattern parts while joined rows can multiply, so no quotient of
    // the expansion cap is a sound bound on complete result rows.
    limits.intermediate_rows.saturating_add(1)
}

fn work_probe_cap(limits: &QueryLimits) -> usize {
    limits.intermediate_rows.saturating_add(1)
}

fn work_probe_projection(plan: &QueryPlan) -> String {
    let mut expressions = Vec::new();
    for (pattern_index, pattern) in plan.patterns.iter().enumerate() {
        for node in &pattern.nodes {
            expressions.push(format!("{}.id", node.binding));
        }
        for (relationship_index, relationship) in pattern.relationships.iter().enumerate() {
            expressions.push(format!(
                "{}.id",
                relationship_binding(
                    plan,
                    pattern_index,
                    relationship_index,
                    &relationship.binding,
                ),
            ));
        }
    }
    expressions
        .into_iter()
        .enumerate()
        .map(|(index, expression)| format!("{expression} AS relayer_probe_{index}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn expansion_probes(plan: &QueryPlan, target_parameter: &str, limits: &QueryLimits) -> Vec<String> {
    let mut probes = Vec::new();
    for (pattern_index, pattern) in plan.patterns.iter().enumerate() {
        for steps in 1..=pattern.relationships.len() {
            let partial = PatternPart {
                path_binding: None,
                nodes: pattern.nodes[..=steps].to_vec(),
                relationships: pattern.relationships[..steps].to_vec(),
            };
            let mut conditions = partial
                .nodes
                .iter()
                .map(|node| {
                    format!(
                        "list_contains({}.published_targets, ${target_parameter})",
                        node.binding
                    )
                })
                .collect::<Vec<_>>();
            let bindings = partial
                .relationships
                .iter()
                .enumerate()
                .map(|(relationship_index, relationship)| {
                    relationship_binding(
                        plan,
                        pattern_index,
                        relationship_index,
                        &relationship.binding,
                    )
                })
                .collect::<Vec<_>>();
            for binding in &bindings {
                conditions.push(format!(
                    "list_contains({binding}.published_targets, ${target_parameter})"
                ));
            }
            for (left, first) in bindings.iter().enumerate() {
                for second in bindings.iter().skip(left + 1) {
                    conditions.push(format!("{first}.id <> {second}.id"));
                }
            }
            for membership in &partial.relationships {
                if membership.relationship_type != RelationshipType::Contains {
                    continue;
                }
                for (action_index, action) in partial.relationships.iter().enumerate() {
                    if matches!(
                        action.relationship_type,
                        RelationshipType::Expands | RelationshipType::References
                    ) && membership.to == action.from
                    {
                        let action_binding = relationship_binding(
                            plan,
                            pattern_index,
                            action_index,
                            &action.binding,
                        );
                        conditions.push(format!(
                            "{action_binding}.source_layer_id = {}.id",
                            membership.from
                        ));
                    }
                }
            }
            let projections = partial
                .nodes
                .iter()
                .map(|node| format!("{}.id", node.binding))
                .chain(bindings.iter().map(|binding| format!("{binding}.id")))
                .enumerate()
                .map(|(index, expression)| format!("{expression} AS relayer_expansion_{index}"))
                .collect::<Vec<_>>()
                .join(", ");
            probes.push(format!(
                "MATCH {} WHERE {} RETURN {projections} LIMIT {}",
                lower_pattern(plan, pattern_index, &partial),
                conditions.join(" AND "),
                limits.examined_expansions.saturating_add(1),
            ));
        }
    }
    probes
}

fn lower_expression(plan: &QueryPlan, expression: &Expression) -> String {
    match expression {
        Expression::Binding { binding } => binding.clone(),
        Expression::Property { property } => {
            let reference = physical_reference(plan, property);
            // layout_version is physically NULL when absent, already the exact
            // projected wire value. Its has_layout sentinel is needed only to
            // distinguish IS NULL from IS ABSENT in predicates.
            match presence_expression(plan, property).filter(|_| property.name != "layout_version")
            {
                Some(presence) => format!("CASE WHEN {presence} THEN {reference} ELSE NULL END"),
                None => reference,
            }
        }
        Expression::Parameter { name } => format!("${name}"),
        Expression::List { items } => format!(
            "[{}]",
            items
                .iter()
                .map(|item| lower_expression(plan, item))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Expression::Record { fields } => format!(
            "{{{}}}",
            fields
                .iter()
                .map(|field| format!("{}:{}", field.name, lower_expression(plan, &field.value)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Expression::Aggregate {
            function,
            distinct,
            argument,
        } => {
            let Some(argument) = argument else {
                return "count(*)".to_owned();
            };
            let inner = format!(
                "{}{}",
                if *distinct { "DISTINCT " } else { "" },
                lower_expression(plan, argument)
            );
            match function {
                // Relayer sorts/reduces collected values after normalization
                // using the full recursive wire order. Ladybug's aggregate
                // order is neither defined nor available for every graph and
                // composite value admitted by the v1 algebra.
                AggregateFunction::Collect | AggregateFunction::Min | AggregateFunction::Max => {
                    format!("collect({inner})")
                }
                other => format!("{}({inner})", other.as_str()),
            }
        }
    }
}

fn collect_expression_parameters(
    expression: &Expression,
    parameters: &mut std::collections::BTreeSet<String>,
) {
    match expression {
        Expression::Parameter { name } => {
            parameters.insert(name.clone());
        }
        Expression::List { items } => {
            for item in items {
                collect_expression_parameters(item, parameters);
            }
        }
        Expression::Record { fields } => {
            for field in fields {
                collect_expression_parameters(&field.value, parameters);
            }
        }
        Expression::Aggregate { argument, .. } => {
            if let Some(argument) = argument {
                collect_expression_parameters(argument, parameters);
            }
        }
        Expression::Binding { .. } | Expression::Property { .. } => {}
    }
}

fn hidden_identity_expressions(plan: &QueryPlan) -> Vec<String> {
    let mut expressions = Vec::new();
    let mut index = plan.projection.columns.len();
    for (pattern_index, pattern) in plan.patterns.iter().enumerate() {
        for node in &pattern.nodes {
            expressions.push(format!("{}.id AS {}", node.binding, internal_alias(index)));
            index += 1;
        }
        for (relationship_index, relationship) in pattern.relationships.iter().enumerate() {
            let binding = relationship_binding(
                plan,
                pattern_index,
                relationship_index,
                &relationship.binding,
            );
            expressions.push(format!("{binding}.id AS {}", internal_alias(index)));
            index += 1;
        }
    }
    expressions
}

fn hidden_identity_count(plan: &QueryPlan) -> usize {
    if plan
        .projection
        .columns
        .iter()
        .any(|column| column.expression.has_aggregate())
    {
        0
    } else {
        plan.patterns
            .iter()
            .map(|pattern| pattern.nodes.len() + pattern.relationships.len())
            .sum()
    }
}

fn hidden_endpoint_expressions(plan: &QueryPlan, mut index: usize, aggregate: bool) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut expressions = Vec::new();
    for binding in plan
        .patterns
        .iter()
        .flat_map(|pattern| pattern.nodes.iter().map(|node| &node.binding))
    {
        if !seen.insert(binding) {
            continue;
        }
        let value = if aggregate {
            format!("collect({binding})")
        } else {
            binding.clone()
        };
        expressions.push(format!("{value} AS {}", internal_alias(index)));
        index += 1;
    }
    expressions
}

fn internal_alias(index: usize) -> String {
    format!("relayer_column_{index}")
}

fn compare(operator: CompareOp) -> &'static str {
    operator.as_str()
}

fn restore_parameter_values(
    plan: &QueryPlan,
    expression: &Expression,
    mut normalized: JsonValue,
    parameters: &serde_json::Map<String, JsonValue>,
) -> JsonValue {
    match expression {
        Expression::Parameter { name } => parameters
            .get(name)
            .map(canonical_parameter)
            .unwrap_or(normalized),
        Expression::List { items } => {
            if let Some(values) = normalized
                .get_mut("values")
                .and_then(JsonValue::as_array_mut)
            {
                for (value, item) in values.iter_mut().zip(items) {
                    *value = restore_parameter_values(plan, item, value.take(), parameters);
                }
                if let Some(first) = values.first() {
                    normalized["elementType"] = normalized_descriptor(first);
                }
            }
            normalized
        }
        Expression::Record { fields } => {
            if let Some(values) = normalized
                .get_mut("fields")
                .and_then(JsonValue::as_array_mut)
            {
                for (value, field) in values.iter_mut().zip(fields) {
                    value["value"] = restore_parameter_values(
                        plan,
                        &field.value,
                        value["value"].take(),
                        parameters,
                    );
                }
            }
            normalized
        }
        Expression::Aggregate {
            function: AggregateFunction::Collect,
            argument: Some(argument),
            ..
        } => {
            if let Some(values) = normalized
                .get_mut("values")
                .and_then(JsonValue::as_array_mut)
            {
                for value in values.iter_mut() {
                    *value = restore_parameter_values(plan, argument, value.take(), parameters);
                }
                values.sort_by(compare_values);
                normalized["elementType"] = values
                    .first()
                    .map(normalized_descriptor)
                    .unwrap_or_else(|| expression_descriptor(plan, argument));
            }
            normalized
        }
        Expression::Aggregate {
            function: AggregateFunction::Min | AggregateFunction::Max,
            argument: Some(argument),
            ..
        } => {
            let Some(values) = normalized
                .get_mut("values")
                .and_then(JsonValue::as_array_mut)
            else {
                return normalized;
            };
            for value in values.iter_mut() {
                *value = restore_parameter_values(plan, argument, value.take(), parameters);
            }
            let function = match expression {
                Expression::Aggregate { function, .. } => *function,
                _ => unreachable!(),
            };
            values
                .iter()
                .min_by(|left, right| {
                    let order = compare_values(left, right);
                    if function == AggregateFunction::Min {
                        order
                    } else {
                        order.reverse()
                    }
                })
                .cloned()
                .unwrap_or_else(|| json!({"type":"null"}))
        }
        Expression::Aggregate { .. } | Expression::Binding { .. } | Expression::Property { .. } => {
            normalized
        }
    }
}

fn canonical_parameter(value: &JsonValue) -> JsonValue {
    let mut value = value.clone();
    match value.get("type").and_then(JsonValue::as_str) {
        Some("float") if value["value"].as_f64() == Some(0.0) => value["value"] = json!(0.0),
        Some("list") => {
            if let Some(values) = value["values"].as_array_mut() {
                for child in values {
                    *child = canonical_parameter(child);
                }
            }
        }
        Some("record") => {
            if let Some(fields) = value["fields"].as_array_mut() {
                for field in fields {
                    field["value"] = canonical_parameter(&field["value"]);
                }
            }
        }
        Some("node" | "layer" | "relationship") => {
            if let Some(fields) = value["properties"].as_array_mut() {
                for field in fields {
                    field["value"] = canonical_parameter(&field["value"]);
                }
            }
        }
        Some("path") => {
            for collection in ["vertices", "relationships"] {
                if let Some(values) = value[collection].as_array_mut() {
                    for child in values {
                        *child = canonical_parameter(child);
                    }
                }
            }
        }
        _ => {}
    }
    value
}

fn expression_descriptor(plan: &QueryPlan, expression: &Expression) -> JsonValue {
    match expression {
        Expression::Parameter { name } => plan
            .parameter_types
            .get(name)
            .cloned()
            .unwrap_or_else(|| json!({"kind":"string"})),
        Expression::Binding { binding } => {
            let kind = plan
                .patterns
                .iter()
                .find_map(|pattern| {
                    pattern
                        .nodes
                        .iter()
                        .find(|node| node.binding == *binding)
                        .map(|node| match node.label {
                            Some(relayer_graph_core::query::NodeLabel::Layer) => "layer",
                            _ => "node",
                        })
                        .or_else(|| {
                            pattern
                                .relationships
                                .iter()
                                .any(|relationship| {
                                    relationship.binding.as_deref() == Some(binding)
                                })
                                .then_some("relationship")
                        })
                        .or_else(|| {
                            (pattern.path_binding.as_deref() == Some(binding)).then_some("path")
                        })
                })
                .unwrap_or("node");
            json!({"kind": kind})
        }
        Expression::Property { property } => {
            let kind = match (
                relationship_of(plan, &property.binding),
                property.name.as_str(),
            ) {
                (Some(RelationshipType::Contains), "order") | (None, "layout_version") => "integer",
                (Some(RelationshipType::Contains), "x" | "y") => "float",
                _ => "string",
            };
            json!({"kind": kind})
        }
        Expression::List { items } => json!({
            "kind": "list",
            "elementType": items.first().map(|item| expression_descriptor(plan, item)).unwrap_or_else(|| json!({"kind":"string"})),
        }),
        Expression::Record { fields } => json!({
            "kind": "record",
            "fields": fields.iter().map(|field| json!({
                "name": field.name,
                "type": expression_descriptor(plan, &field.value),
            })).collect::<Vec<_>>(),
        }),
        Expression::Aggregate {
            function, argument, ..
        } => match function {
            AggregateFunction::Count => json!({"kind":"integer"}),
            AggregateFunction::Avg => json!({"kind":"float"}),
            AggregateFunction::Collect => json!({
                "kind":"list",
                "elementType": argument.as_deref().map(|argument| expression_descriptor(plan, argument)).unwrap_or_else(|| json!({"kind":"null"})),
            }),
            _ => argument
                .as_deref()
                .map(|argument| expression_descriptor(plan, argument))
                .unwrap_or_else(|| json!({"kind":"integer"})),
        },
    }
}

/// Run one planned query against the store.
pub fn execute(
    connection: &Connection<'_>,
    plan: &QueryPlan,
    parameters: &serde_json::Map<String, JsonValue>,
    authorized: SearchTarget,
    limits: &QueryLimits,
    cancellation: &QueryCancellation,
) -> Result<QueryOutcome, QueryError> {
    require_not_cancelled(cancellation)?;
    let lowering = lower(plan, parameters, authorized, limits)?;
    let cap = row_cap(plan, parameters, limits)?;
    let mut examined_expansions = 0_usize;
    for probe in &lowering.expansion_probes {
        require_not_cancelled(cancellation)?;
        let expansions =
            rows_with(connection, probe, lowering.parameters.clone()).map_err(engine_failure)?;
        examined_expansions = examined_expansions.saturating_add(expansions.len());
        if examined_expansions > limits.examined_expansions {
            return Err(QueryError::new(
                QueryCode::ExaminedExpansionsExceeded,
                "budget.examined_expansions",
                format!(
                    "the query examined more than {} relationship expansions",
                    limits.examined_expansions
                ),
            ));
        }
        if expansions.len() > limits.intermediate_rows {
            return Err(QueryError::new(
                QueryCode::IntermediateRowsExceeded,
                "budget.intermediate_rows",
                format!(
                    "the query produced more than {} intermediate rows",
                    limits.intermediate_rows
                ),
            ));
        }
    }
    let work = rows_with(
        connection,
        &lowering.intermediate_probe,
        lowering.parameters.clone(),
    )
    .map_err(engine_failure)?;
    require_not_cancelled(cancellation)?;
    if work.len() > limits.intermediate_rows {
        return Err(QueryError::new(
            QueryCode::IntermediateRowsExceeded,
            "budget.intermediate_rows",
            format!(
                "the query matched more than {} rows before ordering",
                limits.intermediate_rows
            ),
        ));
    }
    let raw = rows_with(connection, &lowering.text, lowering.parameters).map_err(engine_failure)?;
    require_not_cancelled(cancellation)?;

    let visible_columns = plan.projection.columns.len();
    let endpoint_start = visible_columns + hidden_identity_count(plan);
    let mut endpoints = EndpointIds::new();
    for row in &raw {
        for value in row {
            index_endpoint_nodes(value, &mut endpoints).map_err(normalization_failure)?;
        }
    }
    let mut rows = Vec::new();
    for row in &raw {
        let normalized: Vec<JsonValue> = row[..visible_columns]
            .iter()
            .map(|value| normalize_value(value, &endpoints))
            .collect::<std::result::Result<_, NormalizeFailure>>()
            .map_err(normalization_failure)?;
        let normalized = normalized
            .into_iter()
            .zip(&plan.projection.columns)
            .map(|(value, column)| {
                restore_parameter_values(plan, &column.expression, value, parameters)
            })
            .collect::<Vec<_>>();
        let identity = row[visible_columns..endpoint_start]
            .iter()
            .map(matched_identity)
            .collect::<Result<Vec<_>, _>>()?;
        rows.push(NormalizedRow {
            values: normalized,
            identity,
        });
    }

    if plan.projection.distinct {
        // DISTINCT compares the complete typed projected row, which only exists
        // after normalization — engine-level DISTINCT compares engine values.
        rows.sort_by(|left, right| compare_rows(&left.values, &right.values));
        rows.dedup_by(|left, right| compare_rows(&left.values, &right.values) == Sort::Equal);
    }
    order_rows(plan, &mut rows);
    let columns: Vec<String> = plan
        .projection
        .columns
        .iter()
        .map(|column: &Column| column.name.clone())
        .collect();
    let rows = rows.into_iter().map(|row| row.values).collect();
    bounded_outcome(columns, rows, cap, limits.encoded_result_bytes)
}

fn matched_identity(value: &Value) -> Result<String, QueryError> {
    match value {
        Value::String(value) => Ok(value.clone()),
        _ => Err(QueryError::new(
            QueryCode::InvalidEngineValue,
            "result",
            "matched identity was not a stable string",
        )),
    }
}

fn require_not_cancelled(cancellation: &QueryCancellation) -> Result<(), QueryError> {
    if cancellation.is_cancelled() {
        Err(QueryError::new(
            QueryCode::QueryCancelled,
            "budget.cancellation",
            "the query was cancelled",
        ))
    } else {
        Ok(())
    }
}

pub(super) fn normalization_failure(error: NormalizeFailure) -> QueryError {
    let (code, message) = match error.kind() {
        NormalizeFailureKind::InvalidEngineValue => (
            QueryCode::InvalidEngineValue,
            "the search engine returned a value outside the v1 wire algebra",
        ),
        NormalizeFailureKind::HeterogeneousList => (
            QueryCode::HeterogeneousList,
            "the search engine returned a list without one recursive element type",
        ),
        NormalizeFailureKind::IntegerOverflow => (
            QueryCode::IntegerOverflow,
            "the search engine returned an integer outside signed 64-bit range",
        ),
        NormalizeFailureKind::DuplicateRecordField => (
            QueryCode::DuplicateRecordField,
            "the search engine returned a record with a duplicate field",
        ),
    };
    QueryError::new(code, "result", message)
}

fn bounded_outcome(
    columns: Vec<String>,
    rows: Vec<Vec<JsonValue>>,
    cap: usize,
    encoded_result_bytes: usize,
) -> Result<QueryOutcome, QueryError> {
    let total = rows.len();
    let mut prefix = Vec::new();
    let empty = QueryOutcome {
        query_contract_version: 1,
        columns: columns.clone(),
        rows: Vec::new(),
        truncated: total > 0,
    };
    if serde_json::to_vec(&empty)
        .map_err(|_| {
            QueryError::new(
                QueryCode::InvalidEngineValue,
                "result",
                "the result envelope could not be encoded",
            )
        })?
        .len()
        > encoded_result_bytes
    {
        return Err(QueryError::new(
            QueryCode::ResultRowTooLarge,
            "result",
            "the result envelope exceeds the encoded result cap",
        ));
    }
    for row in rows.into_iter().take(cap) {
        let single = QueryOutcome {
            query_contract_version: 1,
            columns: columns.clone(),
            rows: vec![row.clone()],
            truncated: false,
        };
        if serde_json::to_vec(&single)
            .map_err(|_| {
                QueryError::new(
                    QueryCode::InvalidEngineValue,
                    "result",
                    "the result envelope could not be encoded",
                )
            })?
            .len()
            > encoded_result_bytes
        {
            return Err(QueryError::new(
                QueryCode::ResultRowTooLarge,
                "result",
                "a single row exceeds the encoded result cap",
            ));
        }
        prefix.push(row);
        let truncated = prefix.len() < total;
        let candidate = QueryOutcome {
            query_contract_version: 1,
            columns: columns.clone(),
            rows: prefix.clone(),
            truncated,
        };
        if serde_json::to_vec(&candidate)
            .map_err(|_| {
                QueryError::new(
                    QueryCode::InvalidEngineValue,
                    "result",
                    "the result envelope could not be encoded",
                )
            })?
            .len()
            > encoded_result_bytes
        {
            prefix.pop();
            break;
        }
    }

    Ok(QueryOutcome {
        query_contract_version: 1,
        columns,
        truncated: prefix.len() < total,
        rows: prefix,
    })
}

pub(super) fn engine_failure(error: anyhow::Error) -> QueryError {
    let text = format!("{error:#}");
    // The engine's own timeout surfaces as an interrupt; the contract reports
    // that as a wall-time failure rather than an opaque engine error.
    if text.contains("nterrupt") || text.contains("imeout") || text.contains("deadline") {
        QueryError::new(
            QueryCode::WallTimeExceeded,
            "budget.wall_time_ms",
            "the query exceeded its wall-time budget",
        )
    } else {
        QueryError::new(
            QueryCode::InvalidEngineValue,
            "result",
            "the search engine could not produce a valid v1 result",
        )
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
        Some("node") | Some("layer") => left["id"]
            .as_str()
            .cmp(&right["id"].as_str())
            .then_with(|| compare_fields(&left["properties"], &right["properties"])),
        Some("relationship") => left["kind"]
            .as_str()
            .cmp(&right["kind"].as_str())
            .then_with(|| left["id"].as_str().cmp(&right["id"].as_str()))
            .then_with(|| left["start"].as_str().cmp(&right["start"].as_str()))
            .then_with(|| left["end"].as_str().cmp(&right["end"].as_str()))
            .then_with(|| compare_fields(&left["properties"], &right["properties"])),
        Some("path") => compare_paths(left, right),
        Some("list") => compare_value_arrays(&left["values"], &right["values"]).then_with(|| {
            left["elementType"]
                .to_string()
                .cmp(&right["elementType"].to_string())
        }),
        Some("record") => compare_fields(&left["fields"], &right["fields"]),
        _ => Sort::Equal,
    }
}

fn compare_value_arrays(left: &JsonValue, right: &JsonValue) -> Sort {
    let left = left.as_array().map(Vec::as_slice).unwrap_or_default();
    let right = right.as_array().map(Vec::as_slice).unwrap_or_default();
    for (left, right) in left.iter().zip(right.iter()) {
        let compared = compare_values(left, right);
        if compared != Sort::Equal {
            return compared;
        }
    }
    left.len().cmp(&right.len())
}

fn compare_fields(left: &JsonValue, right: &JsonValue) -> Sort {
    let left = left.as_array().map(Vec::as_slice).unwrap_or_default();
    let right = right.as_array().map(Vec::as_slice).unwrap_or_default();
    for (left, right) in left.iter().zip(right.iter()) {
        let compared = left["name"]
            .as_str()
            .cmp(&right["name"].as_str())
            .then_with(|| compare_values(&left["value"], &right["value"]));
        if compared != Sort::Equal {
            return compared;
        }
    }
    left.len().cmp(&right.len())
}

fn compare_paths(left: &JsonValue, right: &JsonValue) -> Sort {
    let left_vertices = left["vertices"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let right_vertices = right["vertices"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let left_relationships = left["relationships"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let right_relationships = right["relationships"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let steps = left_vertices.len().max(right_vertices.len());
    for index in 0..steps {
        match (left_vertices.get(index), right_vertices.get(index)) {
            (Some(left), Some(right)) => {
                let compared = compare_values(left, right);
                if compared != Sort::Equal {
                    return compared;
                }
            }
            (None, Some(_)) => return Sort::Less,
            (Some(_), None) => return Sort::Greater,
            (None, None) => break,
        }
        match (
            left_relationships.get(index),
            right_relationships.get(index),
        ) {
            (Some(left), Some(right)) => {
                let compared = compare_values(left, right);
                if compared != Sort::Equal {
                    return compared;
                }
            }
            (None, Some(_)) => return Sort::Less,
            (Some(_), None) => return Sort::Greater,
            (None, None) => {}
        }
    }
    Sort::Equal
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

struct NormalizedRow {
    values: Vec<JsonValue>,
    identity: Vec<String>,
}

/// Apply the plan's explicit ordering, then break ties canonically.
///
/// Nulls are always last unless the query said otherwise, and direction does not
/// change that default.
fn order_rows(plan: &QueryPlan, rows: &mut [NormalizedRow]) {
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
            let (left_value, right_value) = (&left.values[index], &right.values[index]);
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
        compare_rows(&left.values, &right.values).then_with(|| left.identity.cmp(&right.identity))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn string_row(bytes: usize) -> Vec<JsonValue> {
        vec![json!({"type": "string", "value": "x".repeat(bytes)})]
    }

    #[test]
    fn frozen_complete_envelope_byte_recipes_are_exact() {
        let exact =
            bounded_outcome(vec!["value".into()], vec![string_row(16_280)], 5, 16_384).unwrap();
        assert_eq!(serde_json::to_vec(&exact).unwrap().len(), 16_384);
        assert!(!exact.truncated);

        let prefix = bounded_outcome(
            vec!["value".into()],
            vec![string_row(7_933), string_row(7_933), string_row(1_200)],
            5,
            16_384,
        )
        .unwrap();
        assert_eq!(prefix.rows.len(), 2);
        assert_eq!(serde_json::to_vec(&prefix).unwrap().len(), 16_000);
        assert!(prefix.truncated);

        let oversized =
            bounded_outcome(vec!["value".into()], vec![string_row(16_281)], 5, 16_384).unwrap_err();
        assert_eq!(oversized.code, QueryCode::ResultRowTooLarge);
        assert_eq!(oversized.phase.as_str(), "encode");
    }

    #[test]
    fn row_cap_does_not_inspect_the_next_candidate_for_oversize() {
        let outcome = bounded_outcome(
            vec!["value".into()],
            vec![string_row(1), string_row(20_000)],
            1,
            16_384,
        )
        .unwrap();
        assert_eq!(outcome.rows.len(), 1);
        assert!(outcome.truncated);
    }

    #[test]
    fn any_oversized_candidate_within_the_row_cap_fails_the_whole_result() {
        let failure = bounded_outcome(
            vec!["value".into()],
            vec![string_row(1), string_row(16_281)],
            5,
            16_384,
        )
        .unwrap_err();
        assert_eq!(failure.code, QueryCode::ResultRowTooLarge);
        assert_eq!(failure.phase.as_str(), "encode");
    }

    #[test]
    fn composite_values_use_recursive_typed_order_instead_of_json_text() {
        let two = json!({
            "type":"list",
            "elementType":{"kind":"integer"},
            "values":[{"type":"integer","value":"2"}],
        });
        let ten = json!({
            "type":"list",
            "elementType":{"kind":"integer"},
            "values":[{"type":"integer","value":"10"}],
        });
        assert_eq!(compare_values(&two, &ten), Sort::Less);

        let record_two = json!({
            "type":"record",
            "fields":[{"name":"count","value":{"type":"integer","value":"2"}}],
        });
        let record_ten = json!({
            "type":"record",
            "fields":[{"name":"count","value":{"type":"integer","value":"10"}}],
        });
        assert_eq!(compare_values(&record_two, &record_ten), Sort::Less);
    }

    #[test]
    fn frozen_default_hard_and_zero_row_caps_are_exact() {
        let rows = (0..8).map(string_row).collect::<Vec<_>>();
        let default = bounded_outcome(vec!["value".into()], rows[..6].to_vec(), 5, 16_384).unwrap();
        assert_eq!(default.rows.len(), 5);
        assert!(default.truncated);

        let hard = bounded_outcome(vec!["value".into()], rows.clone(), 8, 16_384).unwrap();
        assert_eq!(hard.rows.len(), 8);
        assert!(!hard.truncated);

        let zero = bounded_outcome(vec!["value".into()], rows[..1].to_vec(), 0, 16_384).unwrap();
        assert!(zero.rows.is_empty());
        assert!(zero.truncated);
    }

    #[test]
    fn equal_visible_rows_use_hidden_matched_identity_as_the_final_tie_break() {
        let request = relayer_graph_core::query::QueryRequest {
            query_contract_version: 1,
            target: relayer_graph_core::query::RequestTarget {
                scope: relayer_graph_core::query::TargetScope::Thread,
                id: 1,
            },
            query: "MATCH (n:Content) RETURN n.kind AS kind".into(),
            parameters: Default::default(),
            budget: Default::default(),
        };
        let plan =
            relayer_graph_core::query::plan_request(&request, &QueryLimits::default()).unwrap();
        let value = json!({"type": "string", "value": "same"});
        let mut rows = vec![
            NormalizedRow {
                values: vec![value.clone()],
                identity: vec!["content:b".into()],
            },
            NormalizedRow {
                values: vec![value],
                identity: vec!["content:a".into()],
            },
        ];
        order_rows(&plan, &mut rows);
        assert_eq!(rows[0].identity, vec!["content:a"]);
        assert_eq!(rows[1].identity, vec!["content:b"]);
    }

    #[test]
    fn malformed_hidden_identity_has_a_stable_safe_error() {
        let error = matched_identity(&Value::Bool(true)).unwrap_err();
        assert_eq!(error.code, QueryCode::InvalidEngineValue);
        assert_eq!(error.path, "result");
        assert_eq!(error.message, "matched identity was not a stable string");
        assert!(!error.message.contains("Bool"));
        assert!(!error.message.contains("true"));
    }
}
