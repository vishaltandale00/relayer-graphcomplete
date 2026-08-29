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
    "create", "merge", "delete", "set", "remove", "detach", "drop", "alter", "call", "install",
    "load", "union", "unwind", "optional", "with", "foreach", "case", "exists",
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
        occurrence: 0,
    };
    parser.query()
}

impl Parser {
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

    fn query(&mut self) -> Result<QueryPlan, QueryError> {
        // A construct outside v1 is named as unsupported rather than reported as
        // a bare syntax error.
        for token in &self.tokens {
            if let Token::Word(word) = token
                && UNSUPPORTED_KEYWORDS.contains(&word.to_ascii_lowercase().as_str())
            {
                return Err(QueryError::new(
                    QueryCode::QueryConstructUnsupported,
                    "query",
                    format!("`{word}` is not admitted by query contract version 1"),
                ));
            }
        }
        if !self.eat_word("match") {
            return Err(self.syntax("a query begins with MATCH"));
        }
        let mut patterns = vec![self.pattern_part()?];
        while self.eat_symbol(",") {
            patterns.push(self.pattern_part()?);
        }
        if patterns.len() > self.limits.pattern_parts {
            return Err(QueryError::new(
                QueryCode::PatternPartLimitExceeded,
                "query",
                format!("at most {} pattern parts", self.limits.pattern_parts),
            ));
        }
        // A node whose label cannot be inferred from a relationship it takes part
        // in has to state one: an unlabelled zero-hop pattern is an untyped scan
        // of the whole store.
        for pattern in &patterns {
            for node in &pattern.nodes {
                let anchored = pattern.relationships.iter().any(|relationship| {
                    relationship.from == node.binding || relationship.to == node.binding
                });
                if node.label.is_none() && !anchored {
                    return Err(QueryError::new(
                        QueryCode::QueryTypeMismatch,
                        "query",
                        format!("`{}` needs a node label", node.binding),
                    ));
                }
            }
        }
        let hops = joined_traversal_hops(&patterns);
        if hops > self.limits.traversal_hops {
            return Err(QueryError::new(
                QueryCode::TraversalLimitExceeded,
                "query",
                format!("at most {} traversal hops", self.limits.traversal_hops),
            ));
        }
        if self.bindings.len() + self.relationship_bindings.len() > self.limits.variables {
            return Err(QueryError::new(
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
            return Err(self.syntax("unexpected trailing input"));
        }

        let requires_occurrence_constraint = patterns.iter().any(|pattern| {
            let has_contains = pattern
                .relationships
                .iter()
                .any(|relationship| relationship.relationship_type == RelationshipType::Contains);
            let has_action = pattern.relationships.iter().any(|relationship| {
                matches!(
                    relationship.relationship_type,
                    RelationshipType::Expands | RelationshipType::References
                )
            });
            has_contains && has_action
        });

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
        })
    }

    fn pattern_part(&mut self) -> Result<PatternPart, QueryError> {
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
        }
        Ok(PatternPart {
            path_binding,
            nodes,
            relationships,
        })
    }

    fn node_pattern(&mut self) -> Result<NodePlan, QueryError> {
        self.expect_symbol("(")?;
        let binding = self.identifier()?;
        let label = if self.eat_symbol(":") {
            let name = self.identifier()?;
            Some(NodeLabel::parse(&name).ok_or_else(|| {
                QueryError::new(
                    QueryCode::UnknownLabel,
                    "query",
                    format!("`{name}` is not a v1 node label"),
                )
            })?)
        } else {
            None
        };
        self.expect_symbol(")")?;
        // A repeated binding must not contradict its first label.
        match self.bindings.get(&binding) {
            Some(existing) if label.is_some() && *existing != label && existing.is_some() => {
                return Err(QueryError::new(
                    QueryCode::QueryTypeMismatch,
                    "query",
                    format!("binding `{binding}` is used with two different labels"),
                ));
            }
            Some(Some(existing)) if label.is_none() => {
                let existing = *existing;
                let occurrence = self.occurrence;
                self.occurrence += 1;
                return Ok(NodePlan {
                    binding,
                    label: Some(existing),
                    occurrence,
                });
            }
            _ => {}
        }
        self.bindings.insert(binding.clone(), label);
        let occurrence = self.occurrence;
        self.occurrence += 1;
        Ok(NodePlan {
            binding,
            label,
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
        let relationship_type = RelationshipType::parse(&name).ok_or_else(|| {
            QueryError::new(
                QueryCode::UnknownRelationshipType,
                "query",
                format!("`{name}` is not a v1 relationship type"),
            )
        })?;
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
        if let Some(binding) = &binding {
            self.relationship_bindings
                .insert(binding.clone(), relationship_type);
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
        let property = self.property()?;
        if self.eat_word("is") {
            let negated = self.eat_word("not");
            if self.eat_word("null") {
                return Ok(Predicate::NullTest { property, negated });
            }
            if self.eat_word("absent") {
                return Err(QueryError::new(
                    QueryCode::QueryConstructUnsupported,
                    "query",
                    "IS ABSENT is contract v1 but is not implemented yet",
                ));
            }
            return Err(self.syntax("expected NULL after IS"));
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
        self.validate_property(&binding, &name)?;
        Ok(PropertyRef { binding, name })
    }

    /// A property has to exist on whatever the binding was matched as. An unknown
    /// one is a plan error, not a runtime empty result.
    fn validate_property(&self, binding: &str, name: &str) -> Result<(), QueryError> {
        let allowed: &[&str] = if let Some(label) = self.bindings.get(binding) {
            match label {
                Some(NodeLabel::Content) => CONTENT_PROPERTIES,
                Some(NodeLabel::Layer) => LAYER_PROPERTIES,
                // An unlabelled binding could be either, so accept the union and
                // let the engine decide.
                None => return Ok(()),
            }
        } else if let Some(relationship) = self.relationship_bindings.get(binding) {
            match relationship {
                RelationshipType::Connected => CONNECTED_PROPERTIES,
                RelationshipType::Contains => CONTAINS_PROPERTIES,
                RelationshipType::Expands | RelationshipType::References => ACTION_PROPERTIES,
            }
        } else {
            return Err(QueryError::new(
                QueryCode::DynamicSchemaForbidden,
                "query",
                format!("`{binding}` is not bound by the MATCH clause"),
            ));
        };
        if allowed.contains(&name) {
            Ok(())
        } else {
            Err(QueryError::new(
                QueryCode::UnknownProperty,
                "query",
                format!("`{name}` is not a visible property of `{binding}`"),
            ))
        }
    }

    fn return_clause(&mut self) -> Result<Projection, QueryError> {
        let distinct = self.eat_word("distinct");
        let mut columns = vec![self.return_item()?];
        while self.eat_symbol(",") {
            columns.push(self.return_item()?);
        }
        let mut seen = HashSet::new();
        for column in &columns {
            if !seen.insert(column.name.clone()) {
                return Err(QueryError::new(
                    QueryCode::DuplicateOutputColumn,
                    "query",
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
            return Err(QueryError::new(
                QueryCode::QueryTypeMismatch,
                "query",
                "an empty list literal has no element type",
            ));
        }
        self.check_homogeneous(&expression)?;
        let name = if self.eat_word("as") {
            self.identifier()?
        } else {
            match &expression {
                Expression::Property { property } => property.name.clone(),
                Expression::Binding { binding } => binding.clone(),
                Expression::Parameter { name } => name.clone(),
                Expression::Aggregate { function, .. } => function.as_str().to_owned(),
                Expression::List { .. } => "list".to_owned(),
                Expression::Record { .. } => "record".to_owned(),
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
            return Err(QueryError::new(
                QueryCode::AstDepthExceeded,
                "query",
                format!("expressions nest at most {} deep", self.limits.ast_depth),
            ));
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
                    return Err(QueryError::new(
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
        if matches!(self.peek(), Some(Token::Symbol(symbol)) if symbol == "(") {
            return self.aggregate(&binding, depth);
        }
        if self.eat_symbol(".") {
            let name = self.identifier()?;
            self.validate_property(&binding, &name)?;
            return Ok(Expression::Property {
                property: PropertyRef { binding, name },
            });
        }
        if !self.bindings.contains_key(&binding)
            && !self.relationship_bindings.contains_key(&binding)
        {
            let bound_path = self
                .tokens
                .iter()
                .any(|token| matches!(token, Token::Word(word) if word == &binding));
            if !bound_path {
                return Err(QueryError::new(
                    QueryCode::DynamicSchemaForbidden,
                    "query",
                    format!("`{binding}` is not bound by the MATCH clause"),
                ));
            }
        }
        Ok(Expression::Binding { binding })
    }

    /// Lists are homogeneous: every element carries the same type. A list mixing
    /// a string with a node has no element type the wire algebra can name.
    fn check_homogeneous(&self, expression: &Expression) -> Result<(), QueryError> {
        if let Expression::List { items } = expression {
            let mut kinds = items.iter().filter_map(|item| self.static_type(item));
            if let Some(first) = kinds.next()
                && let Some(other) = kinds.find(|kind| *kind != first)
            {
                return Err(QueryError::new(
                    QueryCode::QueryTypeMismatch,
                    "query",
                    format!("a list cannot mix {first} and {other} elements"),
                ));
            }
        }
        match expression {
            Expression::List { items } => {
                for item in items {
                    self.check_homogeneous(item)?;
                }
            }
            Expression::Record { fields } => {
                for field in fields {
                    self.check_homogeneous(&field.value)?;
                }
            }
            _ => {}
        }
        Ok(())
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
                return Err(QueryError::new(
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
            return Err(QueryError::new(
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
            return Err(QueryError::new(
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
                    return Err(QueryError::new(
                        QueryCode::RowLimitExceeded,
                        "query",
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
