//! The Relayer graph query contract, version 1.
//!
//! `docs/graph-query-v1.md` is normative. This module owns the engine-neutral
//! half: the request envelope, the admitted grammar, the typed plan, the limits,
//! and the error precedence. Lowering a plan to Ladybug and executing it belongs
//! to the crate that owns the engine, so nothing here names a physical table or
//! column and no caller can reach a connection through it.
//!
//! This is a subset of the frozen contract, not all of it. Aggregates, DISTINCT,
//! list and record expressions, and `IS ABSENT` parse to a stable
//! `query_construct_unsupported` rather than being silently accepted or silently
//! dropped, so a caller can tell "not yet" from "not allowed".

pub mod error;
pub mod limits;
pub mod parser;
pub mod plan;

pub use error::{QueryCode, QueryError, QueryPhase};
pub use limits::QueryLimits;
pub use plan::{
    Column, CompareOp, Direction, Expression, Limit, NodeLabel, NodePlan, NullPlacement, Ordering,
    PatternPart, Predicate, Projection, PropertyRef, QueryPlan, RelationshipPlan, RelationshipType,
    SortDirection,
};

use serde::{Deserialize, Serialize};

/// The engine-neutral request. It carries no store, database, extension,
/// procedure, candidate-source, or authority field; authority comes from the
/// caller's capability, never from the request body.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    pub query_contract_version: u32,
    pub target: RequestTarget,
    pub query: String,
    #[serde(default)]
    pub parameters: serde_json::Map<String, serde_json::Value>,
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
        if name.is_empty()
            || !name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            return Err(QueryError::new(
                QueryCode::InvalidRequest,
                "parameters",
                format!("`{name}` is not an ASCII identifier"),
            ));
        }
    }
    let plan = parser::parse(&request.query, limits)?;
    check_parameter_types(&plan, &request.parameters)?;
    Ok(plan)
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
    plan: &QueryPlan,
    parameters: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), QueryError> {
    for predicate in &plan.predicates {
        let Predicate::PropertyComparison {
            property,
            parameter,
            ..
        } = predicate
        else {
            continue;
        };
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
    Ok(())
}
