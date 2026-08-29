//! Result and execution bounds, from `docs/graph-query-v1.md` section 9 and the
//! frozen manifest. A caller may request smaller budgets but cannot raise these.

use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryLimits {
    pub query_bytes: usize,
    pub ast_depth: usize,
    pub variables: usize,
    pub pattern_parts: usize,
    pub traversal_hops: usize,
    pub default_rows: usize,
    pub hard_rows: usize,
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
            default_rows: 5,
            hard_rows: 8,
            encoded_result_bytes: 16 * 1024,
            wall_time: Duration::from_millis(250),
        }
    }
}

impl QueryLimits {
    /// Narrow these limits to a caller's request. A caller may only ask for less.
    pub fn narrowed(mut self, rows: Option<usize>, wall_time: Option<Duration>) -> Self {
        if let Some(rows) = rows {
            self.hard_rows = self.hard_rows.min(rows);
            self.default_rows = self.default_rows.min(self.hard_rows);
        }
        if let Some(wall_time) = wall_time {
            self.wall_time = self.wall_time.min(wall_time);
        }
        self
    }
}
