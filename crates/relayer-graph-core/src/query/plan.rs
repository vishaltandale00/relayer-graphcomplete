//! The typed plan a v1 query parses into.
//!
//! From `docs/graph-query-v1.md` section 4. The plan never holds a Ladybug table
//! or column name, or any raw query fragment: lowering to the engine happens
//! behind the `SearchIndex` seam, in the crate that owns the engine. Target and
//! publication predicates are injected by the executor and deliberately are not
//! representable here, so query text cannot reach them.

use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Value as JsonValue, json};
use std::collections::BTreeMap;

/// The only node labels v1 admits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NodeLabel {
    Content,
    Layer,
}

impl NodeLabel {
    pub fn parse(value: &str) -> Option<Self> {
        // Schema names are ASCII case-insensitive.
        match value.to_ascii_lowercase().as_str() {
            "content" => Some(Self::Content),
            "layer" => Some(Self::Layer),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Content => "Content",
            Self::Layer => "Layer",
        }
    }
}

/// The four relationship types in the public logical schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RelationshipType {
    Connected,
    Contains,
    Expands,
    References,
}

impl RelationshipType {
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "connected" => Some(Self::Connected),
            "contains" => Some(Self::Contains),
            "expands" => Some(Self::Expands),
            "references" => Some(Self::References),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connected => "CONNECTED",
            Self::Contains => "CONTAINS",
            Self::Expands => "EXPANDS",
            Self::References => "REFERENCES",
        }
    }

    /// `CONNECTED` is the one undirected type: the engine reports both
    /// orientations, so the plan carries a canonical direction and normalization
    /// orders its endpoints.
    pub fn is_undirected(self) -> bool {
        matches!(self, Self::Connected)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Outgoing,
    Incoming,
    Undirected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePlan {
    pub binding: String,
    pub label: Option<NodeLabel>,
    pub occurrence: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipPlan {
    pub binding: Option<String>,
    pub relationship_type: RelationshipType,
    pub direction: Direction,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternPart {
    pub path_binding: Option<String>,
    pub nodes: Vec<NodePlan>,
    pub relationships: Vec<RelationshipPlan>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompareOp {
    Equal,
    NotEqual,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
}

impl CompareOp {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Equal => "=",
            Self::NotEqual => "<>",
            Self::Less => "<",
            Self::LessOrEqual => "<=",
            Self::Greater => ">",
            Self::GreaterOrEqual => ">=",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyRef {
    pub binding: String,
    pub name: String,
}

/// A user-authored filter. Target and publication predicates are not expressible
/// here; the executor injects those separately.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Predicate {
    PropertyComparison {
        property: PropertyRef,
        operator: CompareOp,
        parameter: String,
    },
    NullTest {
        property: PropertyRef,
        negated: bool,
    },
    AbsenceTest {
        property: PropertyRef,
        negated: bool,
    },
}

/// The aggregates v1 admits. Anything else is `invalid_aggregate`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AggregateFunction {
    Count,
    Min,
    Max,
    Sum,
    Avg,
    Collect,
}

impl AggregateFunction {
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "count" => Some(Self::Count),
            "min" => Some(Self::Min),
            "max" => Some(Self::Max),
            "sum" => Some(Self::Sum),
            "avg" => Some(Self::Avg),
            "collect" => Some(Self::Collect),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Count => "count",
            Self::Min => "min",
            Self::Max => "max",
            Self::Sum => "sum",
            Self::Avg => "avg",
            Self::Collect => "collect",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordField {
    pub name: String,
    pub value: Expression,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Expression {
    Binding {
        binding: String,
    },
    Property {
        property: PropertyRef,
    },
    Parameter {
        name: String,
    },
    List {
        items: Vec<Expression>,
    },
    Record {
        fields: Vec<RecordField>,
    },
    Aggregate {
        function: AggregateFunction,
        distinct: bool,
        /// `None` is `count(*)`, the only aggregate admitted without an argument.
        argument: Option<Box<Expression>>,
    },
}

impl Expression {
    /// Whether this expression contains an aggregate at any depth. Aggregates may
    /// not nest, and a projection that mixes aggregates with plain expressions
    /// groups by the plain ones.
    pub fn has_aggregate(&self) -> bool {
        match self {
            Self::Aggregate { .. } => true,
            Self::List { items } => items.iter().any(Self::has_aggregate),
            Self::Record { fields } => fields.iter().any(|field| field.value.has_aggregate()),
            _ => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub expression: Expression,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NullPlacement {
    First,
    Last,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ordering {
    pub column: String,
    pub direction: SortDirection,
    pub nulls: NullPlacement,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Limit {
    Literal { value: usize },
    Parameter { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPlan {
    pub query_contract_version: u32,
    /// Exactly `structural` for every public v1 query. Vector and late-interaction
    /// sources are versioned separately and reserve no syntax here.
    pub candidate_source: String,
    pub patterns: Vec<PatternPart>,
    pub predicates: Vec<Predicate>,
    pub projection: Projection,
    pub ordering: Vec<Ordering>,
    pub limit: Option<Limit>,
    pub max_traversal_hops: usize,
    /// True when the plan joins `CONTAINS` to `EXPANDS` or `REFERENCES` through a
    /// Content binding, which needs the occurrence constraint to avoid matching a
    /// node in one layer against an action authored from another.
    pub requires_occurrence_constraint: bool,
    /// Recursive descriptors validated from the request envelope. This is
    /// deliberately not a top-level public plan field; it types parameter
    /// expressions and prevents lowering from discovering malformed values
    /// after authorization.
    pub parameter_types: BTreeMap<String, JsonValue>,
}

impl Serialize for QueryPlan {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        plan_json(self).serialize(serializer)
    }
}

fn plan_json(plan: &QueryPlan) -> JsonValue {
    let patterns = plan
        .patterns
        .iter()
        .map(|pattern| {
            json!({
                "pathBinding": pattern.path_binding,
                "nodes": pattern.nodes,
                "relationships": pattern.relationships.iter().map(|relationship| json!({
                    "binding": relationship.binding,
                    "type": relationship.relationship_type.as_str(),
                    "direction": match relationship.direction {
                        Direction::Outgoing => "forward",
                        Direction::Incoming => "reverse-text-normalized-forward",
                        Direction::Undirected => "undirected",
                    },
                    "from": relationship.from,
                    "to": relationship.to,
                })).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    let predicates = plan
        .predicates
        .iter()
        .map(|predicate| match predicate {
            Predicate::PropertyComparison {
                property,
                operator,
                parameter,
            } => json!({
                "kind": "propertyComparison",
                "left": property_json(plan, property),
                "operator": match operator {
                    CompareOp::Equal => "eq",
                    CompareOp::NotEqual => "ne",
                    CompareOp::Less => "lt",
                    CompareOp::LessOrEqual => "lte",
                    CompareOp::Greater => "gt",
                    CompareOp::GreaterOrEqual => "gte",
                },
                "right": {
                    "kind": "parameter",
                    "name": parameter,
                    "valueType": property_value_type(plan, property),
                },
            }),
            Predicate::NullTest { property, negated } => json!({
                "kind": "nullTest",
                "property": property_json(plan, property),
                "negated": negated,
            }),
            Predicate::AbsenceTest { property, negated } => json!({
                "kind": "absenceTest",
                "property": property_json(plan, property),
                "negated": negated,
            }),
        })
        .collect::<Vec<_>>();
    let columns = plan
        .projection
        .columns
        .iter()
        .map(|column| {
            json!({
                "name": column.name,
                "expression": expression_json(plan, &column.expression, None),
            })
        })
        .collect::<Vec<_>>();
    let mut aggregate_names = Vec::new();
    let mut groups = Vec::new();
    for column in &plan.projection.columns {
        if column.expression.has_aggregate() {
            collect_aggregate_names(&column.expression, &mut aggregate_names);
        } else {
            groups.push(column.name.clone());
        }
    }
    let aggregation = if aggregate_names.is_empty() {
        JsonValue::Null
    } else {
        json!({"groups": groups, "aggregates": aggregate_names})
    };
    let limit = match &plan.limit {
        None => JsonValue::Null,
        Some(Limit::Literal { value }) => json!({"kind": "literal", "value": value}),
        Some(Limit::Parameter { name }) => {
            json!({"kind": "parameter", "name": name, "valueType": "integer"})
        }
    };
    json!({
        "queryContractVersion": plan.query_contract_version,
        "candidateSource": plan.candidate_source,
        "patterns": patterns,
        "predicates": predicates,
        "projection": {"distinct": plan.projection.distinct, "columns": columns},
        "aggregation": aggregation,
        "ordering": plan.ordering,
        "limit": limit,
        "maxTraversalHops": plan.max_traversal_hops,
        "requiresOccurrenceConstraint": plan.requires_occurrence_constraint,
    })
}

fn relationship_type(plan: &QueryPlan, binding: &str) -> Option<RelationshipType> {
    plan.patterns
        .iter()
        .flat_map(|pattern| &pattern.relationships)
        .find_map(|relationship| {
            (relationship.binding.as_deref() == Some(binding))
                .then_some(relationship.relationship_type)
        })
}

fn node_label(plan: &QueryPlan, binding: &str) -> Option<NodeLabel> {
    plan.patterns
        .iter()
        .flat_map(|pattern| &pattern.nodes)
        .find_map(|node| (node.binding == binding).then_some(node.label).flatten())
}

fn property_value_type(plan: &QueryPlan, property: &PropertyRef) -> &'static str {
    match (
        node_label(plan, &property.binding),
        relationship_type(plan, &property.binding),
        property.name.as_str(),
    ) {
        (Some(NodeLabel::Layer), _, "layout_version") => "integer",
        (_, Some(RelationshipType::Contains), "order") => "integer",
        (_, Some(RelationshipType::Contains), "x" | "y") => "float",
        _ => "string",
    }
}

fn property_json(plan: &QueryPlan, property: &PropertyRef) -> JsonValue {
    json!({
        "binding": property.binding,
        "name": property.name,
        "valueType": property_value_type(plan, property),
    })
}

fn binding_value_type(plan: &QueryPlan, binding: &str) -> &'static str {
    if let Some(label) = node_label(plan, binding) {
        return match label {
            NodeLabel::Content => "node",
            NodeLabel::Layer => "layer",
        };
    }
    if relationship_type(plan, binding).is_some() {
        return "relationship";
    }
    "path"
}

fn expression_value_type(plan: &QueryPlan, expression: &Expression) -> &'static str {
    match expression {
        Expression::Binding { binding } => binding_value_type(plan, binding),
        Expression::Property { property } => property_value_type(plan, property),
        Expression::Parameter { name } => plan
            .parameter_types
            .get(name)
            .and_then(|descriptor| descriptor.get("kind"))
            .and_then(JsonValue::as_str)
            .map(|kind| match kind {
                "null" => "null",
                "boolean" => "boolean",
                "integer" => "integer",
                "float" => "float",
                "string" => "string",
                "node" => "node",
                "layer" => "layer",
                "relationship" => "relationship",
                "path" => "path",
                "list" => "list",
                "record" => "record",
                _ => "string",
            })
            .unwrap_or("string"),
        Expression::List { .. } => "list",
        Expression::Record { .. } => "record",
        Expression::Aggregate {
            function, argument, ..
        } => match function {
            AggregateFunction::Count => "integer",
            AggregateFunction::Avg => "float",
            AggregateFunction::Collect => "list",
            _ => argument
                .as_deref()
                .map_or("integer", |argument| expression_value_type(plan, argument)),
        },
    }
}

fn descriptor(plan: &QueryPlan, expression: &Expression) -> Option<JsonValue> {
    match expression {
        Expression::List { items } if items.is_empty() => None,
        Expression::List { items } => {
            let element = items.iter().find_map(|item| descriptor(plan, item))?;
            Some(json!({"kind": "list", "elementType": element}))
        }
        Expression::Record { fields } => Some(json!({
            "kind": "record",
            "fields": fields.iter().map(|field| json!({
                "name": field.name,
                "type": descriptor(plan, &field.value).unwrap_or_else(|| json!({"kind": expression_value_type(plan, &field.value)})),
            })).collect::<Vec<_>>(),
        })),
        Expression::Parameter { name } => plan.parameter_types.get(name).cloned(),
        _ => Some(json!({"kind": expression_value_type(plan, expression)})),
    }
}

fn expression_json(
    plan: &QueryPlan,
    expression: &Expression,
    expected: Option<&JsonValue>,
) -> JsonValue {
    match expression {
        Expression::Binding { binding } => json!({
            "kind": "binding", "name": binding, "valueType": binding_value_type(plan, binding),
        }),
        Expression::Property { property } => {
            let mut value = property_json(plan, property);
            value
                .as_object_mut()
                .unwrap()
                .insert("kind".into(), json!("property"));
            value
        }
        Expression::Parameter { name } => json!({
            "kind": "parameter", "name": name, "valueType": expression_value_type(plan, expression),
        }),
        Expression::List { items } => {
            let element_type = items
                .iter()
                .find_map(|item| descriptor(plan, item))
                .or_else(|| expected.and_then(|expected| expected.get("elementType").cloned()))
                .unwrap_or_else(|| json!({"kind": "string"}));
            json!({
                "kind": "list",
                "elementType": element_type,
                "items": items.iter().map(|item| expression_json(plan, item, Some(&element_type))).collect::<Vec<_>>(),
            })
        }
        Expression::Record { fields } => json!({
            "kind": "record",
            "fields": fields.iter().map(|field| json!({
                "name": field.name,
                "expression": expression_json(plan, &field.value, None),
            })).collect::<Vec<_>>(),
        }),
        Expression::Aggregate {
            function,
            distinct,
            argument,
        } => json!({
            "kind": "aggregate",
            "function": function.as_str(),
            "distinct": distinct,
            "argument": argument.as_deref().map(|argument| expression_json(plan, argument, None)).unwrap_or_else(|| json!({"kind": "all"})),
            "valueType": expression_value_type(plan, expression),
        }),
    }
}

fn collect_aggregate_names(expression: &Expression, names: &mut Vec<&'static str>) {
    match expression {
        Expression::Aggregate { function, .. } => names.push(function.as_str()),
        Expression::List { items } => items
            .iter()
            .for_each(|item| collect_aggregate_names(item, names)),
        Expression::Record { fields } => fields
            .iter()
            .for_each(|field| collect_aggregate_names(&field.value, names)),
        _ => {}
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    pub distinct: bool,
    pub columns: Vec<Column>,
}
