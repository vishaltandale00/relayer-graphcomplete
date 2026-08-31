//! Result and execution bounds, from `docs/graph-query-v1.md` section 9 and the
//! frozen manifest. A caller may request smaller budgets but cannot raise these.

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Optional caller-requested ceilings. Every field can only narrow the product
/// maximum; omitting a field retains that maximum.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryBudget {
    pub query_bytes: Option<usize>,
    pub ast_depth: Option<usize>,
    pub variables: Option<usize>,
    pub pattern_parts: Option<usize>,
    pub traversal_hops: Option<usize>,
    pub examined_expansions: Option<usize>,
    pub intermediate_rows: Option<usize>,
    pub wall_time_ms: Option<u64>,
    pub result_rows: Option<usize>,
    pub encoded_result_bytes: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryLimits {
    pub query_bytes: usize,
    pub ast_depth: usize,
    pub variables: usize,
    pub pattern_parts: usize,
    pub traversal_hops: usize,
    pub examined_expansions: usize,
    pub default_rows: usize,
    pub hard_rows: usize,
    /// How many matched rows may be brought back to be ordered before the row
    /// cap applies. Ordering is Relayer's, not the engine's, so rows have to be
    /// in hand to sort — and this is the budget that stops that being unbounded.
    pub intermediate_rows: usize,
    pub encoded_result_bytes: usize,
    pub wall_time: Duration,
}

impl Default for QueryLimits {
    fn default() -> Self {
        Self {
            query_bytes: 8 * 1024,
            ast_depth: 32,
            variables: 16,
            pattern_parts: 4,
            // The contract's maxTraversalHops. Zero, one, and two hops only.
            traversal_hops: 2,
            examined_expansions: 4096,
            default_rows: 5,
            hard_rows: 8,
            intermediate_rows: 1024,
            encoded_result_bytes: 16 * 1024,
            wall_time: Duration::from_millis(250),
        }
    }
}

impl QueryLimits {
    /// Narrow these limits to a caller's request. A caller may only ask for less.
    pub fn narrowed(mut self, budget: &QueryBudget) -> Self {
        macro_rules! narrow {
            ($field:ident) => {
                if let Some(value) = budget.$field {
                    self.$field = self.$field.min(value);
                }
            };
        }
        narrow!(query_bytes);
        narrow!(ast_depth);
        narrow!(variables);
        narrow!(pattern_parts);
        narrow!(traversal_hops);
        narrow!(examined_expansions);
        narrow!(intermediate_rows);
        narrow!(encoded_result_bytes);
        if let Some(rows) = budget.result_rows {
            self.hard_rows = self.hard_rows.min(rows);
            self.default_rows = self.default_rows.min(self.hard_rows);
        }
        if let Some(wall_time_ms) = budget.wall_time_ms {
            self.wall_time = self.wall_time.min(Duration::from_millis(wall_time_ms));
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caller_can_narrow_every_numeric_dimension_but_never_raise_one() {
        let maximum = QueryLimits::default();
        let raised = maximum.clone().narrowed(&QueryBudget {
            query_bytes: Some(usize::MAX),
            ast_depth: Some(usize::MAX),
            variables: Some(usize::MAX),
            pattern_parts: Some(usize::MAX),
            traversal_hops: Some(usize::MAX),
            examined_expansions: Some(usize::MAX),
            intermediate_rows: Some(usize::MAX),
            wall_time_ms: Some(u64::MAX),
            result_rows: Some(usize::MAX),
            encoded_result_bytes: Some(usize::MAX),
        });
        assert_eq!(raised, maximum);

        let narrowed = maximum.narrowed(&QueryBudget {
            query_bytes: Some(1),
            ast_depth: Some(1),
            variables: Some(1),
            pattern_parts: Some(1),
            traversal_hops: Some(1),
            examined_expansions: Some(1),
            intermediate_rows: Some(1),
            wall_time_ms: Some(1),
            result_rows: Some(1),
            encoded_result_bytes: Some(1),
        });
        assert_eq!(narrowed.query_bytes, 1);
        assert_eq!(narrowed.ast_depth, 1);
        assert_eq!(narrowed.variables, 1);
        assert_eq!(narrowed.pattern_parts, 1);
        assert_eq!(narrowed.traversal_hops, 1);
        assert_eq!(narrowed.examined_expansions, 1);
        assert_eq!(narrowed.intermediate_rows, 1);
        assert_eq!(narrowed.wall_time, Duration::from_millis(1));
        assert_eq!(narrowed.default_rows, 1);
        assert_eq!(narrowed.hard_rows, 1);
        assert_eq!(narrowed.encoded_result_bytes, 1);
    }
}
