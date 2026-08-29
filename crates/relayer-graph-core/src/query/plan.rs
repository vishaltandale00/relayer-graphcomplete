//! The typed plan a v1 query parses into.
//!
//! From `docs/graph-query-v1.md` section 4. The plan never holds a Ladybug table
//! or column name, or any raw query fragment: lowering to the engine happens
//! behind the `SearchIndex` seam, in the crate that owns the engine. Target and
//! publication predicates are injected by the executor and deliberately are not
//! representable here, so query text cannot reach them.

use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    pub distinct: bool,
    pub columns: Vec<Column>,
}
