//! Parse v1 query text into a typed plan.
//!
//! The admitted grammar is `docs/graph-query-v1.md` section 3. Anything outside
//! it is refused here, so no invalid or forbidden query ever reaches the engine.
//! Parse failures are reported before any target is touched, so a syntax error
//! cannot become an oracle for whether a target exists.

use super::{
    error::{QueryCode, QueryError},
    limits::QueryLimits,
    plan::*,
};
use std::collections::{HashMap, HashSet};

/// Properties each label and relationship type admits, in the contract's
/// canonical order. Anything else is `unknown_property`.
const CONTENT_PROPERTIES: &[&str] = &["kind", "icon", "title", "detail", "state"];
const LAYER_PROPERTIES: &[&str] = &["state", "layout_version"];
const CONNECTED_PROPERTIES: &[&str] = &["state"];
const CONTAINS_PROPERTIES: &[&str] = &["order", "x", "y"];
const ACTION_PROPERTIES: &[&str] = &[
    "source_layer_id",
    "label",
    "variant",
    "icon",
    "description",
    "relation",
    "state",
];

/// Constructs that exist in the wider engine dialect but are deliberately not in
/// v1. Naming them lets the parser answer "unsupported" rather than a bare
/// syntax error, which is the difference between a caller learning the contract
/// and guessing at it.
const UNSUPPORTED_KEYWORDS: &[&str] = &[
    "union", "unwind", "optional", "with", "foreach", "case", "exists",
];
const FORBIDDEN_KEYWORDS: &[&str] = &[
    "create", "merge", "delete", "set", "remove", "detach", "drop", "alter", "call", "install",
    "load",
];

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Word(String),
    Parameter(String),
    Number(u64),
    Symbol(String),
}

struct Lexer;

impl Lexer {
    /// Tokenize. Comments run from `//` to end of line and are allowed only
    /// between tokens; a semicolon is admitted only as the final token, which the
    /// parser enforces.
    fn tokenize(text: &str) -> Result<Vec<Token>, QueryError> {
        let mut tokens = Vec::new();
        let characters: Vec<char> = text.chars().collect();
        let mut index = 0;
        while index < characters.len() {
            let character = characters[index];
            if character.is_whitespace() {
                index += 1;
            } else if character == '/' && characters.get(index + 1) == Some(&'/') {
                while index < characters.len() && characters[index] != '\n' {
                    index += 1;
                }
            } else if character.is_ascii_alphabetic() || character == '_' {
                let start = index;
                while index < characters.len()
                    && (characters[index].is_ascii_alphanumeric() || characters[index] == '_')
                {
                    index += 1;
                }
                tokens.push(Token::Word(characters[start..index].iter().collect()));
            } else if character.is_ascii_digit() {
                let start = index;
                while index < characters.len() && characters[index].is_ascii_digit() {
                    index += 1;
                }
                let text: String = characters[start..index].iter().collect();
                let value = text.parse::<u64>().map_err(|_| {
                    QueryError::new(
                        QueryCode::QuerySyntaxInvalid,
                        "query",
                        "integer literal is out of range",
                    )
                })?;
                tokens.push(Token::Number(value));
            } else if character == '$' {
                index += 1;
                let start = index;
                if !matches!(characters.get(index), Some(character) if character.is_ascii_alphabetic() || *character == '_')
                {
                    return Err(QueryError::new(
                        QueryCode::QuerySyntaxInvalid,
                        "query",
                        "a parameter name begins with an ASCII letter or underscore",
                    ));
                }
                while index < characters.len()
                    && (characters[index].is_ascii_alphanumeric() || characters[index] == '_')
                {
                    index += 1;
                }
                if start == index {
                    return Err(QueryError::new(
                        QueryCode::QuerySyntaxInvalid,
                        "query",
                        "a parameter needs a name after $",
                    ));
                }
                tokens.push(Token::Parameter(characters[start..index].iter().collect()));
            } else if character == '\'' || character == '"' {
                // String literals are deliberately absent: values arrive as
                // parameters, so a literal is a contract violation rather than a
                // syntax slip.
                return Err(QueryError::new(
                    QueryCode::QueryConstructForbidden,
                    "query",
                    "string literals are not admitted; pass values as parameters",
                ));
            } else {
                let two: String = characters[index..(index + 2).min(characters.len())]
                    .iter()
                    .collect();
                if ["<-", "->", "<>", "<=", ">=", "-["].contains(&two.as_str()) {
                    tokens.push(Token::Symbol(two));
                    index += 2;
                } else {
                    tokens.push(Token::Symbol(character.to_string()));
                    index += 1;
                }
            }
        }
        Ok(tokens)
    }
}

pub struct Parser {
    tokens: Vec<Token>,
    position: usize,
    limits: QueryLimits,
    bindings: HashMap<String, Option<NodeLabel>>,
    relationship_bindings: HashMap<String, RelationshipType>,
    path_bindings: HashSet<String>,
    // #354 semantic checks are recorded while the remaining grammar is consumed,
    // so a later parse error retains the contract's parse-before-plan precedence.
    deferred_plan_error: Option<QueryError>,
    projection_index: Option<usize>,
    occurrence: usize,
}

/// Parse one query into a typed plan, enforcing the parse and plan stage limits.
pub fn parse(query: &str, limits: &QueryLimits) -> Result<QueryPlan, QueryError> {
    if query.len() > limits.query_bytes {
        return Err(QueryError::new(
            QueryCode::QueryBytesExceeded,
            "query",
            format!("query exceeds {} bytes", limits.query_bytes),
        ));
    }
    let tokens = Lexer::tokenize(query)?;
    let mut parser = Parser {
        tokens,
        position: 0,
        limits: limits.clone(),
        bindings: HashMap::new(),
        relationship_bindings: HashMap::new(),
        path_bindings: HashSet::new(),
        deferred_plan_error: None,
        projection_index: None,
        occurrence: 0,
    };
    parser.query()
}

impl Parser {
    /// Keep encounter order deterministic: valid syntax reports the first plan
    /// error, while any later parse error still returns immediately.
    fn defer_plan_error(&mut self, mut error: QueryError) {
        debug_assert_eq!(error.phase, super::error::QueryPhase::Plan);
        if error.path == "query"
            && let Some(index) = self.projection_index
        {
            error.path = format!("query.return[{index}]");
        }
        if self.deferred_plan_error.is_none() {
            self.deferred_plan_error = Some(error);
        }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.position)
    }

    fn peek_word(&self) -> Option<String> {
        match self.peek() {
            Some(Token::Word(word)) => Some(word.to_ascii_lowercase()),
            _ => None,
        }
    }

    fn eat_word(&mut self, expected: &str) -> bool {
        if self.peek_word().as_deref() == Some(expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn eat_symbol(&mut self, expected: &str) -> bool {
        if matches!(self.peek(), Some(Token::Symbol(symbol)) if symbol == expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn expect_symbol(&mut self, expected: &str) -> Result<(), QueryError> {
        if self.eat_symbol(expected) {
            Ok(())
        } else {
            Err(self.syntax(format!("expected `{expected}`")))
        }
    }

    fn identifier(&mut self) -> Result<String, QueryError> {
        match self.peek().cloned() {
            Some(Token::Word(word)) => {
                self.position += 1;
                Ok(word)
            }
            _ => Err(self.syntax("expected an identifier")),
        }
    }

    fn syntax(&self, message: impl Into<String>) -> QueryError {
        QueryError::new(QueryCode::QuerySyntaxInvalid, "query", message)
    }

    fn binding_is_bound(&self, binding: &str) -> bool {
        self.bindings.contains_key(binding)
            || self.relationship_bindings.contains_key(binding)
            || self.path_bindings.contains(binding)
    }

    fn forbidden_construct_at_clause_position(&self) -> Option<QueryError> {
        let word = match self.peek() {
            Some(Token::Word(word))
                if FORBIDDEN_KEYWORDS.contains(&word.to_ascii_lowercase().as_str()) =>
            {
                word
            }
            _ => return None,
        };
        Some(QueryError::new(
            QueryCode::QueryConstructForbidden,
            "query",
            format!("`{word}` is forbidden by query contract version 1"),
        ))
    }

    fn unsupported_construct_at_clause_position(&self) -> Option<QueryError> {
        let word = match self.peek() {
            Some(Token::Word(word))
                if UNSUPPORTED_KEYWORDS.contains(&word.to_ascii_lowercase().as_str()) =>
            {
                word
            }
            _ => return None,
        };
        Some(QueryError::new(
            QueryCode::QueryConstructUnsupported,
            "query",
            format!("`{word}` is not admitted by query contract version 1"),
        ))
    }

    fn query(&mut self) -> Result<QueryPlan, QueryError> {
        if let Some(error) = self.forbidden_construct_at_clause_position() {
            return Err(error);
        }
        if let Some(error) = self.unsupported_construct_at_clause_position() {
            return Err(error);
        }
        if self.tokens.iter().any(|token| matches!(token, Token::Symbol(symbol) if symbol == "*"))
            && !self.tokens.iter().any(|token| matches!(token, Token::Word(word) if word.eq_ignore_ascii_case("count") || word.eq_ignore_ascii_case("min")))
        {
            return Err(QueryError::new(
                QueryCode::QueryConstructForbidden,
                "query",
                "variable-length relationships are forbidden",
            ));
        }
        if !self.eat_word("match") {
            return Err(self.syntax("a query begins with MATCH"));
        }
        let mut patterns = vec![self.pattern_part()?];
        while self.eat_symbol(",") {
            patterns.push(self.pattern_part()?);
        }
        if patterns.len() > self.limits.pattern_parts {
            self.defer_plan_error(QueryError::new(
                QueryCode::PatternPartLimitExceeded,
                "query",
                format!("at most {} pattern parts", self.limits.pattern_parts),
            ));
        }
        // A node whose label cannot be inferred from a relationship it takes part
        // in has to state one: an unlabelled zero-hop pattern is an untyped scan
        // of the whole store.
        for (pattern_index, pattern) in patterns.iter().enumerate() {
            for (node_index, node) in pattern.nodes.iter().enumerate() {
                let anchored = pattern.relationships.iter().any(|relationship| {
                    relationship.from == node.binding || relationship.to == node.binding
                });
                if node.label.is_none() && !anchored {
                    self.defer_plan_error(QueryError::new(
                        QueryCode::QueryTypeMismatch,
                        format!("query.match[{pattern_index}].nodes[{node_index}]"),
                        format!("`{}` needs a node label", node.binding),
                    ));
                }
            }
        }
        let hops = joined_traversal_hops(&patterns);
        if hops > self.limits.traversal_hops {
            self.defer_plan_error(QueryError::new(
                QueryCode::TraversalLimitExceeded,
                if patterns.len() == 1 {
                    "query.match[0]"
                } else {
                    "query.match"
                },
                format!("at most {} traversal hops", self.limits.traversal_hops),
            ));
        }
        let path_bindings = patterns
            .iter()
            .filter_map(|pattern| pattern.path_binding.as_ref())
            .collect::<HashSet<_>>()
            .len();
        if self.bindings.len() + self.relationship_bindings.len() + path_bindings
            > self.limits.variables
        {
            self.defer_plan_error(QueryError::new(
                QueryCode::VariableLimitExceeded,
                "query",
                format!("at most {} variables", self.limits.variables),
            ));
        }

        let predicates = if self.eat_word("where") {
            self.where_clause()?
        } else {
            Vec::new()
        };
        if !self.eat_word("return") {
            if let Some(error) = self.forbidden_construct_at_clause_position() {
                return Err(error);
            }
            if let Some(error) = self.unsupported_construct_at_clause_position() {
                return Err(error);
            }
            return Err(self.syntax("a query needs a RETURN clause"));
        }
        let projection = self.return_clause()?;
        let ordering = if self.eat_word("order") {
            if !self.eat_word("by") {
                return Err(self.syntax("expected BY after ORDER"));
            }
            self.order_clause(&projection)?
        } else {
            Vec::new()
        };
        let limit = if self.eat_word("limit") {
            Some(self.limit_clause()?)
        } else {
            None
        };
        // A semicolon is allowed only as the final token.
        self.eat_symbol(";");
        if self.position != self.tokens.len() {
            if let Some(error) = self.forbidden_construct_at_clause_position() {
                return Err(error);
            }
            if let Some(error) = self.unsupported_construct_at_clause_position() {
                return Err(error);
            }
            return Err(self.syntax("unexpected trailing input"));
        }

        if let Some(error) = self.deferred_plan_error.take() {
            return Err(error);
        }

        let contains = patterns
            .iter()
            .flat_map(|pattern| &pattern.relationships)
            .filter(|relationship| relationship.relationship_type == RelationshipType::Contains);
        let actions = patterns
            .iter()
            .flat_map(|pattern| &pattern.relationships)
            .filter(|relationship| {
                matches!(
                    relationship.relationship_type,
                    RelationshipType::Expands | RelationshipType::References
                )
            })
            .collect::<Vec<_>>();
        let requires_occurrence_constraint = contains
            .into_iter()
            .any(|membership| actions.iter().any(|action| membership.to == action.from));

        Ok(QueryPlan {
            query_contract_version: 1,
            candidate_source: "structural".into(),
            patterns,
            predicates,
            projection,
            ordering,
            limit,
            max_traversal_hops: hops,
            requires_occurrence_constraint,
            parameter_types: Default::default(),
        })
    }

    fn pattern_part(&mut self) -> Result<PatternPart, QueryError> {
        self.occurrence = 0;
        // `p = (a)-[:CONNECTED]-(b)` binds the whole path.
        let path_binding = if matches!(self.peek(), Some(Token::Word(_)))
            && matches!(self.tokens.get(self.position + 1), Some(Token::Symbol(symbol)) if symbol == "=")
        {
            let binding = self.identifier()?;
            self.position += 1;
            Some(binding)
        } else {
            None
        };
        let mut nodes = vec![self.node_pattern()?];
        let mut relationships = Vec::new();
        while let Some(relationship) = self.relationship_pattern()? {
            let target = self.node_pattern()?;
            let from = nodes
                .last()
                .expect("a pattern starts with a node")
                .binding
                .clone();
            let to = target.binding.clone();
            let (from, to) = match relationship.1 {
                Direction::Incoming => (to.clone(), from.clone()),
                _ => (from, to),
            };
            relationships.push(RelationshipPlan {
                binding: relationship.0,
                relationship_type: relationship.2,
                direction: relationship.1,
                from,
                to,
            });
            nodes.push(target);
            let (from_label, to_label) = match relationship.2 {
                RelationshipType::Connected => (NodeLabel::Content, NodeLabel::Content),
                RelationshipType::Contains => (NodeLabel::Layer, NodeLabel::Content),
                RelationshipType::Expands | RelationshipType::References => {
                    (NodeLabel::Content, NodeLabel::Layer)
                }
            };
            let relationship = relationships.last().expect("relationship was pushed");
            let from = relationship.from.clone();
            let to = relationship.to.clone();
            self.constrain_node_label(&mut nodes, &from, from_label);
            self.constrain_node_label(&mut nodes, &to, to_label);
        }
        if let Some(binding) = &path_binding {
            if relationships.is_empty() {
                self.defer_plan_error(QueryError::new(
                    QueryCode::QueryTypeMismatch,
                    "query.match",
                    "a path binding requires at least one relationship",
                ));
            }
            let collides = self.bindings.contains_key(binding)
                || self.relationship_bindings.contains_key(binding)
                || self.path_bindings.contains(binding);
            if collides {
                self.defer_plan_error(QueryError::new(
                    QueryCode::QueryTypeMismatch,
                    "query.match",
                    format!("path binding `{binding}` collides with another MATCH binding"),
                ));
            } else {
                self.path_bindings.insert(binding.clone());
            }
        }
        Ok(PatternPart {
            path_binding,
            nodes,
            relationships,
        })
    }

    fn constrain_node_label(&mut self, nodes: &mut [NodePlan], binding: &str, required: NodeLabel) {
        let binding_contradicts = self
            .bindings
            .get(binding)
            .copied()
            .flatten()
            .is_some_and(|existing| existing != required);
        if binding_contradicts {
            self.defer_plan_error(QueryError::new(
                QueryCode::QueryTypeMismatch,
                "query.match",
                format!(
                    "binding `{binding}` contradicts the endpoint type required by its relationship"
                ),
            ));
        } else {
            self.bindings.insert(binding.to_owned(), Some(required));
        }
        for node in nodes.iter_mut().filter(|node| node.binding == binding) {
            if node.label.is_some_and(|existing| existing != required) {
                self.defer_plan_error(QueryError::new(
                    QueryCode::QueryTypeMismatch,
                    "query.match",
                    format!(
                        "binding `{binding}` contradicts the endpoint type required by its relationship"
                    ),
                ));
            } else {
                node.label = Some(required);
            }
        }
    }

    fn node_pattern(&mut self) -> Result<NodePlan, QueryError> {
        self.expect_symbol("(")?;
        let binding = self.identifier()?;
        let label = if self.eat_symbol(":") {
            if matches!(self.peek(), Some(Token::Parameter(_))) {
                return Err(QueryError::new(
                    QueryCode::DynamicSchemaForbidden,
                    "query.match[0].label",
                    "dynamic node labels are forbidden",
                )
                .with_phase(super::error::QueryPhase::Parse));
            }
            let name = self.identifier()?;
            let parsed = NodeLabel::parse(&name);
            if parsed.is_none() {
                self.defer_plan_error(QueryError::new(
                    QueryCode::UnknownLabel,
                    format!("query.match[0].nodes[{}].label", self.occurrence),
                    format!("`{name}` is not a v1 node label"),
                ));
            }
            Some(parsed.unwrap_or_else(|| {
                self.bindings
                    .get(&binding)
                    .copied()
                    .flatten()
                    .unwrap_or(NodeLabel::Content)
            }))
        } else {
            None
        };
        self.expect_symbol(")")?;
        let collides = if self.path_bindings.contains(&binding) {
            self.defer_plan_error(QueryError::new(
                QueryCode::QueryTypeMismatch,
                "query.match",
                format!("node binding `{binding}` collides with a path binding"),
            ));
            true
        } else if self.relationship_bindings.contains_key(&binding) {
            self.defer_plan_error(QueryError::new(
                QueryCode::QueryTypeMismatch,
                "query.match",
                format!("node binding `{binding}` collides with a relationship binding"),
            ));
            true
        } else {
            false
        };
        // A repeated binding must not contradict its first label.
        let resolved_label = match self.bindings.get(&binding).copied() {
            Some(existing) if label.is_some() && existing != label && existing.is_some() => {
                self.defer_plan_error(QueryError::new(
                    QueryCode::QueryTypeMismatch,
                    "query",
                    format!("binding `{binding}` is used with two different labels"),
                ));
                existing
            }
            Some(Some(existing)) if label.is_none() => Some(existing),
            _ => label,
        };
        if !collides {
            self.bindings.insert(binding.clone(), resolved_label);
        }
        let occurrence = self.occurrence;
        self.occurrence += 1;
        Ok(NodePlan {
            binding,
            label: resolved_label,
            occurrence,
        })
    }

    #[allow(clippy::type_complexity)]
    fn relationship_pattern(
        &mut self,
    ) -> Result<Option<(Option<String>, Direction, RelationshipType)>, QueryError> {
        let incoming = if self.eat_symbol("<-") {
            true
        } else if self.eat_symbol("-[") {
            false
        } else {
            return Ok(None);
        };
        if incoming {
            self.expect_symbol("[")?;
        }
        let binding = if matches!(self.peek(), Some(Token::Word(_))) {
            Some(self.identifier()?)
        } else {
            None
        };
        self.expect_symbol(":")?;
        let name = self.identifier()?;
        let parsed_relationship_type = RelationshipType::parse(&name);
        self.expect_symbol("]")?;
        let direction = if incoming {
            self.expect_symbol("-")?;
            Direction::Incoming
        } else if self.eat_symbol("->") {
            Direction::Outgoing
        } else if self.eat_symbol("-") {
            Direction::Undirected
        } else {
            return Err(self.syntax("expected `-` or `->` after a relationship"));
        };
        let relationship_type = if let Some(relationship_type) = parsed_relationship_type {
            if relationship_type.is_undirected() && direction != Direction::Undirected {
                return Err(QueryError::new(
                    QueryCode::QueryConstructForbidden,
                    "query",
                    "CONNECTED is undirected and cannot be written with an arrow",
                ));
            }
            if !relationship_type.is_undirected() && direction == Direction::Undirected {
                return Err(QueryError::new(
                    QueryCode::QueryConstructForbidden,
                    "query",
                    format!(
                        "{} is directed and needs an arrow",
                        relationship_type.as_str()
                    ),
                ));
            }
            relationship_type
        } else {
            self.defer_plan_error(QueryError::new(
                QueryCode::UnknownRelationshipType,
                "query",
                format!("`{name}` is not a v1 relationship type"),
            ));
            if direction == Direction::Undirected {
                RelationshipType::Connected
            } else {
                RelationshipType::Contains
            }
        };
        if let Some(binding) = &binding {
            if self.bindings.contains_key(binding)
                || self.relationship_bindings.contains_key(binding)
                || self.path_bindings.contains(binding)
            {
                self.defer_plan_error(QueryError::new(
                    QueryCode::QueryTypeMismatch,
                    "query.match",
                    format!("relationship binding `{binding}` collides with another MATCH binding"),
                ));
            } else {
                self.relationship_bindings
                    .insert(binding.clone(), relationship_type);
            }
        }
        Ok(Some((binding, direction, relationship_type)))
    }

    fn where_clause(&mut self) -> Result<Vec<Predicate>, QueryError> {
        let mut predicates = vec![self.predicate()?];
        while self.eat_word("and") {
            predicates.push(self.predicate()?);
        }
        Ok(predicates)
    }

    fn predicate(&mut self) -> Result<Predicate, QueryError> {
        if self.peek_word().as_deref() == Some("vector_similarity")
            && matches!(self.tokens.get(self.position + 1), Some(Token::Symbol(symbol)) if symbol == "(")
        {
            return Err(QueryError::new(
                QueryCode::QueryConstructUnsupported,
                "query.where",
                "vector search is deferred from query contract version 1",
            ));
        }
        if self.peek_word().as_deref() == Some("exists")
            && matches!(self.tokens.get(self.position + 1), Some(Token::Symbol(symbol)) if symbol == "(")
        {
            return Err(QueryError::new(
                QueryCode::QueryConstructUnsupported,
                "query",
                "`exists` is not admitted by query contract version 1",
            ));
        }
        let property = self.property()?;
        if self.eat_word("is") {
            let negated = self.eat_word("not");
            if self.eat_word("null") {
                return Ok(Predicate::NullTest { property, negated });
            }
            if self.eat_word("absent") {
                return Ok(Predicate::AbsenceTest { property, negated });
            }
            return Err(self.syntax("expected NULL or ABSENT after IS"));
        }
        let operator = match self.peek().cloned() {
            Some(Token::Symbol(symbol)) => {
                let operator = match symbol.as_str() {
                    "=" => CompareOp::Equal,
                    "<>" => CompareOp::NotEqual,
                    "<" => CompareOp::Less,
                    "<=" => CompareOp::LessOrEqual,
                    ">" => CompareOp::Greater,
                    ">=" => CompareOp::GreaterOrEqual,
                    _ => return Err(self.syntax("expected a comparison operator")),
                };
                self.position += 1;
                operator
            }
            _ => return Err(self.syntax("expected a comparison operator")),
        };
        match self.peek().cloned() {
            Some(Token::Parameter(name)) => {
                self.position += 1;
                Ok(Predicate::PropertyComparison {
                    property,
                    operator,
                    parameter: name,
                })
            }
            _ => Err(QueryError::new(
                QueryCode::QueryConstructForbidden,
                "query",
                "a comparison compares a property with a parameter",
            )),
        }
    }

    fn property(&mut self) -> Result<PropertyRef, QueryError> {
        let binding = self.identifier()?;
        self.expect_symbol(".")?;
        let name = self.identifier()?;
        self.validate_property(&binding, &name);
        Ok(PropertyRef { binding, name })
    }

    /// A property has to exist on whatever the binding was matched as. An unknown
    /// one is a plan error, not a runtime empty result.
    fn validate_property(&mut self, binding: &str, name: &str) {
        let error_path = self.projection_index.map_or_else(
            || "query".to_owned(),
            |index| format!("query.return[{index}]"),
        );
        let allowed: &[&str] = if let Some(label) = self.bindings.get(binding) {
            match label {
                Some(NodeLabel::Content) => CONTENT_PROPERTIES,
                Some(NodeLabel::Layer) => LAYER_PROPERTIES,
                // An unlabelled binding could be either, so accept the union and
                // let the engine decide.
                None => return,
            }
        } else if let Some(relationship) = self.relationship_bindings.get(binding) {
            match relationship {
                RelationshipType::Connected => CONNECTED_PROPERTIES,
                RelationshipType::Contains => CONTAINS_PROPERTIES,
                RelationshipType::Expands | RelationshipType::References => ACTION_PROPERTIES,
            }
        } else {
            self.defer_plan_error(QueryError::new(
                QueryCode::DynamicSchemaForbidden,
                &error_path,
                format!("`{binding}` is not bound by the MATCH clause"),
            ));
            return;
        };
        if !allowed.contains(&name) {
            self.defer_plan_error(QueryError::new(
                QueryCode::UnknownProperty,
                error_path,
                format!("`{name}` is not a visible property of `{binding}`"),
            ));
        }
    }

    fn return_clause(&mut self) -> Result<Projection, QueryError> {
        let distinct = self.eat_word("distinct");
        self.projection_index = Some(0);
        let mut columns = vec![self.return_item().map_err(|mut error| {
            if error.path == "query" {
                error.path = "query.return[0]".into();
            }
            error
        })?];
        self.projection_index = None;
        while self.eat_symbol(",") {
            let index = columns.len();
            self.projection_index = Some(index);
            columns.push(self.return_item().map_err(|mut error| {
                if error.path == "query" {
                    error.path = format!("query.return[{index}]");
                }
                error
            })?);
            self.projection_index = None;
        }
        let mut seen = HashSet::new();
        for (index, column) in columns.iter().enumerate() {
            if !seen.insert(column.name.clone()) {
                self.defer_plan_error(QueryError::new(
                    QueryCode::DuplicateOutputColumn,
                    format!("query.return[{index}]"),
                    format!("output column `{}` appears twice", column.name),
                ));
            }
        }
        Ok(Projection { distinct, columns })
    }

    fn return_item(&mut self) -> Result<Column, QueryError> {
        let expression = self.expression()?;
        // A bare empty list has nothing to give it an element type. Nested in
        // another list it is fine, because a sibling types it.
        if matches!(&expression, Expression::List { items } if items.is_empty()) {
            self.defer_plan_error(QueryError::new(
                QueryCode::QueryTypeMismatch,
                "query",
                "an empty list literal has no element type",
            ));
        }
        self.check_homogeneous(&expression);
        let name = if self.eat_word("as") {
            self.identifier()?
        } else {
            match &expression {
                Expression::Property { property } => property.name.clone(),
                Expression::Binding { binding } => binding.clone(),
                _ => {
                    return Err(QueryError::new(
                        QueryCode::QuerySyntaxInvalid,
                        "query",
                        "parameter, aggregate, list, and record expressions require AS aliases",
                    ));
                }
            }
        };
        Ok(Column { name, expression })
    }

    fn expression(&mut self) -> Result<Expression, QueryError> {
        self.expression_at(0)
    }

    /// Expressions nest, so depth is bounded here rather than by counting tokens.
    fn expression_at(&mut self, depth: usize) -> Result<Expression, QueryError> {
        if depth > self.limits.ast_depth {
            self.defer_plan_error(QueryError::new(
                QueryCode::AstDepthExceeded,
                "query",
                format!("expressions nest at most {} deep", self.limits.ast_depth),
            ));
            self.recover_expression_syntax()?;
            return Ok(Expression::Parameter {
                name: "__ast_depth_exceeded".into(),
            });
        }
        if self.eat_symbol("[") {
            let mut items = Vec::new();
            if !self.eat_symbol("]") {
                items.push(self.expression_at(depth + 1)?);
                while self.eat_symbol(",") {
                    items.push(self.expression_at(depth + 1)?);
                }
                self.expect_symbol("]")?;
            }
            return Ok(Expression::List { items });
        }
        if self.eat_symbol("{") {
            let mut fields = Vec::new();
            loop {
                let name = self.identifier()?;
                self.expect_symbol(":")?;
                let value = self.expression_at(depth + 1)?;
                if fields.iter().any(|field: &RecordField| field.name == name) {
                    self.defer_plan_error(QueryError::new(
                        QueryCode::DuplicateOutputColumn,
                        "query",
                        format!("record field `{name}` appears twice"),
                    ));
                }
                fields.push(RecordField { name, value });
                if !self.eat_symbol(",") {
                    break;
                }
            }
            self.expect_symbol("}")?;
            return Ok(Expression::Record { fields });
        }
        if let Some(Token::Parameter(name)) = self.peek().cloned() {
            self.position += 1;
            return Ok(Expression::Parameter { name });
        }
        let binding = self.identifier()?;
        let unsupported = UNSUPPORTED_KEYWORDS.contains(&binding.to_ascii_lowercase().as_str());
        if unsupported
            && !self.binding_is_bound(&binding)
            && (binding.eq_ignore_ascii_case("case")
                || matches!(self.peek(), Some(Token::Symbol(symbol)) if symbol == "("))
        {
            return Err(QueryError::new(
                QueryCode::QueryConstructUnsupported,
                "query",
                format!("`{binding}` is not admitted by query contract version 1"),
            ));
        }
        if self.eat_symbol("[") {
            return Err(QueryError::new(
                QueryCode::DynamicSchemaForbidden,
                "query",
                "dynamic property lookup is forbidden",
            )
            .with_phase(super::error::QueryPhase::Parse));
        }
        if matches!(self.peek(), Some(Token::Symbol(symbol)) if symbol == "(") {
            return self.aggregate(&binding, depth);
        }
        if self.eat_symbol(".") {
            let name = self.identifier()?;
            self.validate_property(&binding, &name);
            return Ok(Expression::Property {
                property: PropertyRef { binding, name },
            });
        }
        if !self.binding_is_bound(&binding) {
            let path = self.projection_index.map_or_else(
                || "query".to_owned(),
                |index| format!("query.return[{index}]"),
            );
            self.defer_plan_error(QueryError::new(
                QueryCode::DynamicSchemaForbidden,
                path,
                format!("`{binding}` is not bound by the MATCH clause"),
            ));
        }
        Ok(Expression::Binding { binding })
    }

    /// Consume one expression without recursion after the configured AST depth
    /// is exceeded. The task stack is heap-bounded by the already byte-bounded
    /// token stream, and it retains syntax/forbidden-construct validation inside
    /// the skipped typed subtree before ordinary outer parsing resumes.
    fn recover_expression_syntax(&mut self) -> Result<(), QueryError> {
        enum Task {
            Expression,
            ListTail,
            RecordField,
            RecordTail,
            Close(&'static str),
        }

        let mut tasks = vec![Task::Expression];
        while let Some(task) = tasks.pop() {
            match task {
                Task::Expression => {
                    if self.eat_symbol("[") {
                        if !self.eat_symbol("]") {
                            tasks.push(Task::ListTail);
                            tasks.push(Task::Expression);
                        }
                    } else if self.eat_symbol("{") {
                        tasks.push(Task::RecordField);
                    } else if matches!(self.peek(), Some(Token::Parameter(_))) {
                        self.position += 1;
                    } else {
                        let binding = self.identifier()?;
                        let unsupported =
                            UNSUPPORTED_KEYWORDS.contains(&binding.to_ascii_lowercase().as_str());
                        if unsupported
                            && !self.binding_is_bound(&binding)
                            && (binding.eq_ignore_ascii_case("case")
                                || matches!(self.peek(), Some(Token::Symbol(symbol)) if symbol == "("))
                        {
                            return Err(QueryError::new(
                                QueryCode::QueryConstructUnsupported,
                                "query",
                                format!("`{binding}` is not admitted by query contract version 1"),
                            ));
                        }
                        if self.eat_symbol("[") {
                            return Err(QueryError::new(
                                QueryCode::DynamicSchemaForbidden,
                                "query",
                                "dynamic property lookup is forbidden",
                            )
                            .with_phase(super::error::QueryPhase::Parse));
                        }
                        if matches!(self.peek(), Some(Token::Symbol(symbol)) if symbol == "(") {
                            if AggregateFunction::parse(&binding).is_none() {
                                return Err(QueryError::new(
                                    QueryCode::QueryConstructForbidden,
                                    "query",
                                    format!("`{binding}` is not an admitted function"),
                                ));
                            }
                            self.expect_symbol("(")?;
                            self.eat_word("distinct");
                            if self.eat_symbol("*") {
                                self.expect_symbol(")")?;
                            } else {
                                tasks.push(Task::Close(")"));
                                tasks.push(Task::Expression);
                            }
                        } else if self.eat_symbol(".") {
                            self.identifier()?;
                        }
                    }
                }
                Task::ListTail => {
                    if self.eat_symbol(",") {
                        tasks.push(Task::ListTail);
                        tasks.push(Task::Expression);
                    } else {
                        self.expect_symbol("]")?;
                    }
                }
                Task::RecordField => {
                    self.identifier()?;
                    self.expect_symbol(":")?;
                    tasks.push(Task::RecordTail);
                    tasks.push(Task::Expression);
                }
                Task::RecordTail => {
                    if self.eat_symbol(",") {
                        tasks.push(Task::RecordField);
                    } else {
                        self.expect_symbol("}")?;
                    }
                }
                Task::Close(symbol) => self.expect_symbol(symbol)?,
            }
        }
        Ok(())
    }

    /// Lists are homogeneous: every element carries the same type. A list mixing
    /// a string with a node has no element type the wire algebra can name.
    fn check_homogeneous(&mut self, expression: &Expression) {
        if let Expression::List { items } = expression {
            let mut kinds = items.iter().filter_map(|item| self.static_type(item));
            if let Some(first) = kinds.next()
                && let Some(other) = kinds.find(|kind| *kind != first)
            {
                self.defer_plan_error(QueryError::new(
                    QueryCode::QueryTypeMismatch,
                    "query",
                    format!("a list cannot mix {first} and {other} elements"),
                ));
            }
        }
        match expression {
            Expression::List { items } => {
                for item in items {
                    self.check_homogeneous(item);
                }
            }
            Expression::Record { fields } => {
                for field in fields {
                    self.check_homogeneous(&field.value);
                }
            }
            _ => {}
        }
    }

    /// The type an expression carries, where it can be known without running the
    /// query. A parameter's type is not known here, so it is left open rather
    /// than guessed.
    fn static_type(&self, expression: &Expression) -> Option<&'static str> {
        match expression {
            Expression::Property { property } => match self.bindings.get(&property.binding) {
                Some(Some(NodeLabel::Layer)) if property.name == "layout_version" => {
                    Some("integer")
                }
                Some(Some(_)) => Some("string"),
                _ => match self.relationship_bindings.get(&property.binding)? {
                    RelationshipType::Contains if property.name == "order" => Some("integer"),
                    RelationshipType::Contains if matches!(property.name.as_str(), "x" | "y") => {
                        Some("float")
                    }
                    _ => Some("string"),
                },
            },
            Expression::Binding { binding } => match self.bindings.get(binding) {
                Some(Some(NodeLabel::Content)) => Some("node"),
                Some(Some(NodeLabel::Layer)) => Some("layer"),
                Some(None) => None,
                None => self
                    .relationship_bindings
                    .get(binding)
                    .map(|_| "relationship")
                    .or(Some("path")),
            },
            Expression::List { .. } => Some("list"),
            Expression::Record { .. } => Some("record"),
            Expression::Parameter { .. } | Expression::Aggregate { .. } => None,
        }
    }

    /// `count(*)` is the only aggregate admitted without an argument, and
    /// aggregates may not nest.
    fn aggregate(&mut self, name: &str, depth: usize) -> Result<Expression, QueryError> {
        let function = AggregateFunction::parse(name).ok_or_else(|| {
            QueryError::new(
                QueryCode::QueryConstructForbidden,
                "query",
                format!("`{name}` is not an admitted function"),
            )
        })?;
        self.expect_symbol("(")?;
        let distinct = self.eat_word("distinct");
        if self.eat_symbol("*") {
            self.expect_symbol(")")?;
            if function != AggregateFunction::Count || distinct {
                self.defer_plan_error(QueryError::new(
                    QueryCode::InvalidAggregate,
                    "query",
                    "only count(*) takes a star, and it does not take DISTINCT",
                ));
            }
            return Ok(Expression::Aggregate {
                function,
                distinct: false,
                argument: None,
            });
        }
        let argument = self.expression_at(depth + 1)?;
        self.expect_symbol(")")?;
        if argument.has_aggregate() {
            self.defer_plan_error(QueryError::new(
                QueryCode::InvalidAggregate,
                "query",
                "aggregates do not nest",
            ));
        }
        Ok(Expression::Aggregate {
            function,
            distinct,
            argument: Some(Box::new(argument)),
        })
    }

    fn order_clause(&mut self, projection: &Projection) -> Result<Vec<Ordering>, QueryError> {
        let mut ordering = vec![self.order_item(projection)?];
        while self.eat_symbol(",") {
            ordering.push(self.order_item(projection)?);
        }
        Ok(ordering)
    }

    fn order_item(&mut self, projection: &Projection) -> Result<Ordering, QueryError> {
        let column = self.identifier()?;
        if !projection
            .columns
            .iter()
            .any(|candidate| candidate.name == column)
        {
            self.defer_plan_error(QueryError::new(
                QueryCode::DynamicSchemaForbidden,
                "query",
                format!("ORDER BY `{column}` is not an output column"),
            ));
        }
        let direction = if self.eat_word("desc") {
            SortDirection::Desc
        } else {
            self.eat_word("asc");
            SortDirection::Asc
        };
        // The engine rejects NULLS FIRST/LAST, so the contract's null placement is
        // applied by Relayer's own ordering rather than passed through.
        let nulls = if self.eat_word("nulls") {
            if self.eat_word("first") {
                NullPlacement::First
            } else if self.eat_word("last") {
                NullPlacement::Last
            } else {
                return Err(self.syntax("expected FIRST or LAST after NULLS"));
            }
        } else {
            // Nulls are always last unless stated; direction does not flip it.
            NullPlacement::Last
        };
        Ok(Ordering {
            column,
            direction,
            nulls,
        })
    }

    fn limit_clause(&mut self) -> Result<Limit, QueryError> {
        match self.peek().cloned() {
            Some(Token::Number(value)) => {
                self.position += 1;
                let value = usize::try_from(value).unwrap_or(usize::MAX);
                if value > self.limits.hard_rows {
                    self.defer_plan_error(QueryError::new(
                        QueryCode::RowLimitExceeded,
                        "query.limit",
                        format!("LIMIT may not exceed {}", self.limits.hard_rows),
                    ));
                }
                Ok(Limit::Literal { value })
            }
            Some(Token::Parameter(name)) => {
                self.position += 1;
                Ok(Limit::Parameter { name })
            }
            _ => Err(self.syntax("LIMIT takes a nonnegative integer or a parameter")),
        }
    }
}

/// Hops across *joined* pattern parts.
///
/// Parts that share a node binding are one traversal, so their hops add up. The
/// contract validates the cap after this join, which is what stops a three-hop
/// walk from being split across commas into three legal-looking one-hop parts.
fn joined_traversal_hops(patterns: &[PatternPart]) -> usize {
    let mut components: Vec<(HashSet<String>, usize)> = Vec::new();
    for pattern in patterns {
        let mut bindings: HashSet<String> = pattern
            .nodes
            .iter()
            .map(|node| node.binding.clone())
            .collect();
        let mut hops = pattern.relationships.len();
        let mut remaining = Vec::with_capacity(components.len());
        for (existing_bindings, existing_hops) in components.drain(..) {
            if existing_bindings.is_disjoint(&bindings) {
                remaining.push((existing_bindings, existing_hops));
            } else {
                bindings.extend(existing_bindings);
                hops += existing_hops;
            }
        }
        components = remaining;
        components.push((bindings, hops));
    }
    components.iter().map(|(_, hops)| *hops).max().unwrap_or(0)
}
