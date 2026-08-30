//! The Relayer graph query contract, version 1.
//!
//! `docs/graph-query-v1.md` is normative. This module owns the engine-neutral
//! half: the request envelope, the admitted grammar, the typed plan, the limits,
//! and the error precedence. Lowering a plan to Ladybug and executing it belongs
//! to the crate that owns the engine, so nothing here names a physical table or
//! column and no caller can reach a connection through it.
//!
//! The admitted v1 profile is frozen by the contract corpus. Constructs outside
//! it fail with stable phase-specific errors rather than being silently accepted
//! or dropped.

pub mod error;
pub mod limits;
pub mod parser;
pub mod plan;

pub use error::{QueryCode, QueryError, QueryPhase};
pub use limits::{QueryBudget, QueryLimits};
pub use plan::{
    AggregateFunction, Column, CompareOp, Direction, Expression, Limit, NodeLabel, NodePlan,
    NullPlacement, Ordering, PatternPart, Predicate, Projection, PropertyRef, QueryPlan,
    RecordField, RelationshipPlan, RelationshipType, SortDirection,
};

use serde::{
    Deserialize, Deserializer, Serialize,
    de::{MapAccess, Visitor},
};
use std::fmt;

/// The engine-neutral request. It carries no store, database, extension,
/// procedure, candidate-source, or authority field; authority comes from the
/// caller's capability, never from the request body.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    pub query_contract_version: u32,
    pub target: RequestTarget,
    pub query: String,
    #[serde(default, deserialize_with = "deserialize_unique_parameters")]
    pub parameters: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub budget: QueryBudget,
}

fn deserialize_unique_parameters<'de, D>(
    deserializer: D,
) -> Result<serde_json::Map<String, serde_json::Value>, D::Error>
where
    D: Deserializer<'de>,
{
    struct UniqueParameters;
    impl<'de> Visitor<'de> for UniqueParameters {
        type Value = serde_json::Map<String, serde_json::Value>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("an object with unique parameter names")
        }

        fn visit_map<A>(self, mut access: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut parameters = serde_json::Map::new();
            while let Some((name, value)) = access.next_entry::<String, serde_json::Value>()? {
                if parameters.insert(name.clone(), value).is_some() {
                    return Err(serde::de::Error::custom(format!(
                        "duplicate parameter name `{name}`"
                    )));
                }
            }
            Ok(parameters)
        }
    }
    deserializer.deserialize_map(UniqueParameters)
}

pub fn parse_request_json(bytes: &[u8]) -> Result<QueryRequest, QueryError> {
    serde_json::from_slice(bytes)
        .map_err(|error| QueryError::new(QueryCode::InvalidRequest, "request", error.to_string()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestTarget {
    pub scope: TargetScope,
    pub id: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetScope {
    Project,
    Thread,
}

/// The immutable current-thread read entitlement consumed by graph search.
///
/// Its fields and constructor are private: a request target is a selector, not
/// authority. Graph core mints this permit from canonical graph provenance and
/// the query executor can only intersect a request with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueryReadPermit {
    target: crate::SearchTarget,
    foreign_draft_attempt: bool,
}

impl QueryReadPermit {
    pub(crate) fn current_thread(thread: crate::ThreadId) -> Self {
        Self {
            target: crate::SearchTarget::Thread(thread),
            foreign_draft_attempt: false,
        }
    }

    #[cfg(feature = "crash-test-support")]
    #[doc(hidden)]
    pub fn for_contract_test(target: crate::SearchTarget) -> Self {
        Self {
            target,
            foreign_draft_attempt: false,
        }
    }

    #[cfg(feature = "crash-test-support")]
    #[doc(hidden)]
    pub fn foreign_draft_contract_test(target: crate::SearchTarget) -> Self {
        Self {
            target,
            foreign_draft_attempt: true,
        }
    }

    pub fn authorize(&self, requested: RequestTarget) -> Result<crate::SearchTarget, QueryError> {
        if self.foreign_draft_attempt {
            return Err(QueryError::new(
                QueryCode::ForeignDraft,
                "readPermit",
                "foreign drafts are never eligible for graph search",
            ));
        }
        if matches!(self.target, crate::SearchTarget::Thread(_))
            && requested.scope == TargetScope::Project
        {
            return Err(QueryError::new(
                QueryCode::ScopeNotGranted,
                "target.scope",
                "the current interaction grants thread search only",
            ));
        }
        let requested = match requested.scope {
            TargetScope::Thread => {
                crate::ThreadId::new(requested.id).map(crate::SearchTarget::Thread)
            }
            TargetScope::Project => {
                crate::ProjectId::new(requested.id).map(crate::SearchTarget::Project)
            }
        };
        match requested {
            Some(requested) if requested == self.target => Ok(requested),
            Some(_) => Err(QueryError::new(
                QueryCode::InaccessibleOrMissing,
                "target",
                "the requested target is missing or inaccessible",
            )),
            None => Err(QueryError::new(
                QueryCode::InaccessibleOrMissing,
                "target",
                "the requested target is missing or inaccessible",
            )),
        }
    }
}

/// Validate the envelope, then parse the query into a typed plan.
///
/// Envelope failures win over parse failures, and a query is fully parsed and
/// planned before any target is touched, so a syntax error cannot reveal whether
/// a target exists.
pub fn plan_request(request: &QueryRequest, limits: &QueryLimits) -> Result<QueryPlan, QueryError> {
    if request.query_contract_version != 1 {
        return Err(QueryError::new(
            QueryCode::UnsupportedQueryContractVersion,
            "queryContractVersion",
            "this store serves query contract version 1",
        ));
    }
    if request.target.id <= 0 {
        return Err(QueryError::new(
            QueryCode::InvalidRequest,
            "target.id",
            "a target identity is a positive integer",
        ));
    }
    if request.query.trim().is_empty() {
        return Err(QueryError::new(
            QueryCode::InvalidRequest,
            "query",
            "a request needs a query",
        ));
    }
    for name in request.parameters.keys() {
        if !ascii_identifier(name) {
            return Err(QueryError::new(
                QueryCode::InvalidRequest,
                "parameters",
                format!("`{name}` is not an ASCII identifier"),
            ));
        }
    }
    let mut plan = parser::parse(&request.query, limits)?;
    check_parameter_types(&mut plan, &request.parameters, limits)?;
    Ok(plan)
}

fn ascii_identifier(name: &str) -> bool {
    let mut characters = name.chars();
    matches!(characters.next(), Some(character) if character.is_ascii_alphabetic() || character == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// The wire type each visible property carries. Comparisons require the same
/// type: there is no implicit integer/float, string/identity, or boolean/numeric
/// coercion, so a mismatch is a plan error rather than an empty result.
fn property_type(plan: &QueryPlan, property: &PropertyRef) -> Option<&'static str> {
    for pattern in &plan.patterns {
        for node in &pattern.nodes {
            if node.binding == property.binding {
                return match (node.label?, property.name.as_str()) {
                    (NodeLabel::Layer, "layout_version") => Some("integer"),
                    (NodeLabel::Layer, "state") => Some("string"),
                    (NodeLabel::Content, _) => Some("string"),
                    _ => None,
                };
            }
        }
        for relationship in &pattern.relationships {
            if relationship.binding.as_deref() == Some(property.binding.as_str()) {
                return match (relationship.relationship_type, property.name.as_str()) {
                    (RelationshipType::Contains, "order") => Some("integer"),
                    (RelationshipType::Contains, "x" | "y") => Some("float"),
                    _ => Some("string"),
                };
            }
        }
    }
    None
}

fn check_parameter_types(
    plan: &mut QueryPlan,
    parameters: &serde_json::Map<String, serde_json::Value>,
    limits: &QueryLimits,
) -> Result<(), QueryError> {
    for (name, value) in parameters {
        plan.parameter_types
            .insert(name.clone(), tagged_descriptor(name, value)?);
    }

    let mut used = std::collections::BTreeSet::new();
    for predicate in &plan.predicates {
        let Predicate::PropertyComparison {
            property,
            parameter,
            ..
        } = predicate
        else {
            continue;
        };
        used.insert(parameter.clone());
        let Some(expected) = property_type(plan, property) else {
            continue;
        };
        let Some(value) = parameters.get(parameter) else {
            return Err(QueryError::new(
                QueryCode::InvalidRequest,
                format!("parameters.{parameter}"),
                format!("the query uses ${parameter} but the request does not supply it"),
            ));
        };
        let actual = value.get("type").and_then(serde_json::Value::as_str);
        if actual != Some(expected) {
            return Err(QueryError::new(
                QueryCode::QueryTypeMismatch,
                format!("parameters.{parameter}"),
                format!(
                    "`{}.{}` is {expected}, but ${parameter} is {}",
                    property.binding,
                    property.name,
                    actual.unwrap_or("untagged")
                ),
            ));
        }
    }
    for (index, column) in plan.projection.columns.iter().enumerate() {
        collect_parameters(&column.expression, &mut used);
        validate_expression_types(&column.expression, plan, &format!("query.return[{index}]"))?;
    }
    if let Some(Limit::Parameter { name }) = &plan.limit {
        used.insert(name.clone());
        let value = parameters
            .get(name)
            .ok_or_else(|| missing_parameter(name))?;
        if value.get("type").and_then(serde_json::Value::as_str) != Some("integer") {
            return Err(QueryError::new(
                QueryCode::QueryTypeMismatch,
                format!("parameters.{name}"),
                "a LIMIT parameter is a tagged integer",
            ));
        }
        let parsed = value["value"]
            .as_str()
            .and_then(|value| value.parse::<usize>().ok())
            .ok_or_else(|| {
                QueryError::new(
                    QueryCode::QueryTypeMismatch,
                    format!("parameters.{name}"),
                    "a LIMIT parameter is a nonnegative integer",
                )
            })?;
        if parsed > limits.hard_rows {
            return Err(QueryError::new(
                QueryCode::RowLimitExceeded,
                "query.limit",
                format!("LIMIT may not exceed {}", limits.hard_rows),
            ));
        }
    }
    for name in used {
        if !parameters.contains_key(&name) {
            return Err(missing_parameter(&name));
        }
    }
    Ok(())
}

fn missing_parameter(name: &str) -> QueryError {
    QueryError::new(
        QueryCode::InvalidRequest,
        format!("parameters.{name}"),
        format!("the query uses ${name} but the request does not supply it"),
    )
}

fn collect_parameters(expression: &Expression, names: &mut std::collections::BTreeSet<String>) {
    match expression {
        Expression::Parameter { name } => {
            names.insert(name.clone());
        }
        Expression::List { items } => {
            for item in items {
                collect_parameters(item, names);
            }
        }
        Expression::Record { fields } => {
            for field in fields {
                collect_parameters(&field.value, names);
            }
        }
        Expression::Aggregate { argument, .. } => {
            if let Some(argument) = argument {
                collect_parameters(argument, names);
            }
        }
        Expression::Binding { .. } | Expression::Property { .. } => {}
    }
}

fn validate_expression_types(
    expression: &Expression,
    plan: &QueryPlan,
    path: &str,
) -> Result<Option<serde_json::Value>, QueryError> {
    let descriptor = match expression {
        Expression::Parameter { name } => plan.parameter_types.get(name).cloned(),
        Expression::Property { property } => {
            property_type(plan, property).map(|kind| serde_json::json!({"kind": kind}))
        }
        Expression::Binding { binding } => Some(serde_json::json!({
            "kind": binding_type(plan, binding),
        })),
        Expression::List { items } => {
            let mut expected = None;
            for item in items {
                let item_descriptor = validate_expression_types(item, plan, path)?;
                if let Some(item_descriptor) = item_descriptor {
                    if let Some(expected) = &expected
                        && expected != &item_descriptor
                    {
                        return Err(QueryError::new(
                            QueryCode::QueryTypeMismatch,
                            "query",
                            "a list expression must be recursively homogeneous",
                        ));
                    }
                    expected = Some(item_descriptor);
                }
            }
            expected.map(|element_type| {
                serde_json::json!({
                    "kind": "list",
                    "elementType": element_type,
                })
            })
        }
        Expression::Record { fields } => {
            let mut descriptors = Vec::new();
            for field in fields {
                if let Some(descriptor) = validate_expression_types(&field.value, plan, path)? {
                    descriptors.push(serde_json::json!({
                        "name": field.name,
                        "type": descriptor,
                    }));
                }
            }
            Some(serde_json::json!({"kind": "record", "fields": descriptors}))
        }
        Expression::Aggregate {
            function, argument, ..
        } => {
            let descriptor = argument
                .as_deref()
                .map(|argument| validate_expression_types(argument, plan, path))
                .transpose()?
                .flatten();
            if matches!(function, AggregateFunction::Sum | AggregateFunction::Avg)
                && descriptor
                    .as_ref()
                    .and_then(|descriptor| descriptor.get("kind"))
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|kind| !matches!(kind, "integer" | "float" | "null"))
            {
                return Err(QueryError::new(
                    QueryCode::InvalidAggregate,
                    path,
                    "sum and avg require numeric values",
                ));
            }
            descriptor
        }
    };
    Ok(descriptor)
}

fn binding_type(plan: &QueryPlan, binding: &str) -> &'static str {
    for pattern in &plan.patterns {
        if let Some(node) = pattern.nodes.iter().find(|node| node.binding == binding) {
            return match node.label {
                Some(NodeLabel::Layer) => "layer",
                _ => "node",
            };
        }
        if pattern
            .relationships
            .iter()
            .any(|relationship| relationship.binding.as_deref() == Some(binding))
        {
            return "relationship";
        }
        if pattern.path_binding.as_deref() == Some(binding) {
            return "path";
        }
    }
    "node"
}

fn tagged_descriptor(
    name: &str,
    tagged: &serde_json::Value,
) -> Result<serde_json::Value, QueryError> {
    let invalid = |message: &str| {
        QueryError::new(
            QueryCode::InvalidRequest,
            format!("parameters.{name}"),
            message,
        )
    };
    let kind = tagged
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| invalid("a parameter is a tagged value with a type"))?;
    match kind {
        "null" => Ok(serde_json::json!({"kind": "null"})),
        "boolean"
            if tagged
                .get("value")
                .and_then(serde_json::Value::as_bool)
                .is_some() =>
        {
            Ok(serde_json::json!({"kind": "boolean"}))
        }
        "float"
            if tagged
                .get("value")
                .and_then(serde_json::Value::as_f64)
                .is_some() =>
        {
            Ok(serde_json::json!({"kind": "float"}))
        }
        "string"
            if tagged
                .get("value")
                .and_then(serde_json::Value::as_str)
                .is_some() =>
        {
            Ok(serde_json::json!({"kind": "string"}))
        }
        "integer" => {
            let value = tagged
                .get("value")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| invalid("an integer parameter travels as a decimal string"))?;
            let nonzero_digits = |digits: &str| {
                matches!(digits.as_bytes().first(), Some(b'1'..=b'9'))
                    && digits.bytes().all(|character| character.is_ascii_digit())
            };
            let canonical = value == "0"
                || value.strip_prefix('-').is_some_and(nonzero_digits)
                || nonzero_digits(value);
            if !canonical || value.parse::<i64>().is_err() {
                return Err(invalid(
                    "an integer parameter needs canonical signed i64 spelling",
                ));
            }
            Ok(serde_json::json!({"kind": "integer"}))
        }
        "list" => {
            let declared = tagged
                .get("elementType")
                .ok_or_else(|| invalid("a list parameter needs elementType"))?;
            validate_descriptor(name, declared)?;
            let values = tagged
                .get("values")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| invalid("a list parameter needs values"))?;
            for value in values {
                if tagged_descriptor(name, value)? != *declared {
                    return Err(QueryError::new(
                        QueryCode::QueryTypeMismatch,
                        format!("parameters.{name}"),
                        "a list parameter must match its recursive elementType",
                    ));
                }
            }
            Ok(serde_json::json!({"kind": "list", "elementType": declared}))
        }
        "record" => {
            let fields = tagged
                .get("fields")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| invalid("a record parameter needs fields"))?;
            let mut seen = std::collections::BTreeSet::new();
            let mut descriptors = Vec::new();
            for field in fields {
                let field_name = field
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .filter(|name| ascii_identifier(name))
                    .ok_or_else(|| invalid("a record field needs an ASCII identifier name"))?;
                if !seen.insert(field_name) {
                    return Err(invalid("record field names are unique"));
                }
                let value = field
                    .get("value")
                    .ok_or_else(|| invalid("a record field needs a tagged value"))?;
                descriptors.push(serde_json::json!({
                    "name": field_name,
                    "type": tagged_descriptor(name, value)?,
                }));
            }
            Ok(serde_json::json!({"kind": "record", "fields": descriptors}))
        }
        "node" | "layer" | "relationship" | "path" => {
            validate_graph_value(name, kind, tagged)?;
            Ok(serde_json::json!({"kind": kind}))
        }
        _ => Err(invalid(
            "the tagged parameter value does not match its declared type",
        )),
    }
}

fn validate_graph_value(
    parameter: &str,
    kind: &str,
    tagged: &serde_json::Value,
) -> Result<(), QueryError> {
    let invalid = |message: &str| {
        QueryError::new(
            QueryCode::InvalidRequest,
            format!("parameters.{parameter}"),
            message,
        )
    };
    let require_string = |field: &str| {
        tagged
            .get(field)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| invalid("a graph value is missing a required string field"))
    };
    match kind {
        "node" | "layer" => {
            require_string("id")?;
            let expected_kind = if kind == "node" { "Content" } else { "Layer" };
            if tagged.get("kind").and_then(serde_json::Value::as_str) != Some(expected_kind) {
                return Err(invalid("a vertex kind must match its tagged graph type"));
            }
            validate_wire_fields(parameter, tagged.get("properties"), &invalid)?;
        }
        "relationship" => {
            for field in ["id", "kind", "start", "end"] {
                require_string(field)?;
            }
            if tagged
                .get("directed")
                .and_then(serde_json::Value::as_bool)
                .is_none()
            {
                return Err(invalid("a relationship needs a directed boolean"));
            }
            validate_wire_fields(parameter, tagged.get("properties"), &invalid)?;
        }
        "path" => {
            let vertices = tagged
                .get("vertices")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| invalid("a path needs vertices"))?;
            let relationships = tagged
                .get("relationships")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| invalid("a path needs relationships"))?;
            if vertices.len() != relationships.len().saturating_add(1) {
                return Err(invalid("a path needs one more vertex than relationship"));
            }
            for vertex in vertices {
                let vertex_kind = vertex
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .filter(|kind| matches!(*kind, "node" | "layer"))
                    .ok_or_else(|| invalid("a path vertex must be a tagged node or layer"))?;
                validate_graph_value(parameter, vertex_kind, vertex)?;
            }
            let mut identities = std::collections::BTreeSet::new();
            for (index, relationship) in relationships.iter().enumerate() {
                validate_graph_value(parameter, "relationship", relationship)?;
                let identity = relationship["id"].as_str().expect("validated identity");
                if !identities.insert(identity) {
                    return Err(invalid("a path cannot reuse a relationship identity"));
                }
                let adjacent = [
                    vertices[index]["id"].as_str(),
                    vertices[index + 1]["id"].as_str(),
                ];
                let endpoints = [relationship["start"].as_str(), relationship["end"].as_str()];
                if !((adjacent[0] == endpoints[0] && adjacent[1] == endpoints[1])
                    || (adjacent[0] == endpoints[1] && adjacent[1] == endpoints[0]))
                {
                    return Err(invalid(
                        "a path relationship must connect adjacent vertices",
                    ));
                }
            }
        }
        _ => unreachable!("validated graph kind"),
    }
    Ok(())
}

fn validate_wire_fields(
    parameter: &str,
    fields: Option<&serde_json::Value>,
    invalid: &impl Fn(&str) -> QueryError,
) -> Result<(), QueryError> {
    let fields = fields
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| invalid("a graph value needs a property field array"))?;
    let mut seen = std::collections::BTreeSet::new();
    for field in fields {
        let name = field
            .get("name")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| invalid("a graph property needs a name"))?;
        if !seen.insert(name) {
            return Err(invalid("graph property names are unique"));
        }
        tagged_descriptor(
            parameter,
            field
                .get("value")
                .ok_or_else(|| invalid("a graph property needs a tagged value"))?,
        )?;
    }
    Ok(())
}

fn validate_descriptor(name: &str, descriptor: &serde_json::Value) -> Result<(), QueryError> {
    let invalid = || {
        QueryError::new(
            QueryCode::InvalidRequest,
            format!("parameters.{name}"),
            "the list elementType is not a complete v1 descriptor",
        )
    };
    match descriptor.get("kind").and_then(serde_json::Value::as_str) {
        Some(
            "null" | "boolean" | "integer" | "float" | "string" | "node" | "layer" | "relationship"
            | "path",
        ) => Ok(()),
        Some("list") => {
            validate_descriptor(name, descriptor.get("elementType").ok_or_else(invalid)?)
        }
        Some("record") => {
            let fields = descriptor
                .get("fields")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(invalid)?;
            let mut seen = std::collections::BTreeSet::new();
            for field in fields {
                let field_name = field
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .filter(|name| ascii_identifier(name))
                    .ok_or_else(invalid)?;
                if !seen.insert(field_name) {
                    return Err(invalid());
                }
                validate_descriptor(name, field.get("type").ok_or_else(invalid)?)?;
            }
            Ok(())
        }
        _ => Err(invalid()),
    }
}
