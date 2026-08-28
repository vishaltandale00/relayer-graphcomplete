# Issue #260 aggregate fixture correction

Date: 2026-08-28

The frozen `aggregate-allowlist` result originally encoded two order-1 memberships for
`project:7`. The canonical supergraph publishes eight memberships to that target, including three
whose membership identity contains order 1. The correct aggregate is therefore sum 3, average
0.375, and five zeros plus three ones.

This is a correction to an internally contradictory expected result, not a contract change. The
grammar, plan, topology, value encoding, limits, and compatibility rules remain unchanged. The
`aggregate_golden_is_derived_from_the_canonical_project_memberships` test now derives count, min,
max, sum, average, and collected order values from the canonical target membership identities so
the two fixtures cannot drift independently again.

Issue #261's exact-result probe found the contradiction only after it began deep-comparing the
Ladybug result envelope rather than checking row counts. The corrected predecessor suite and the
full exact-envelope probe must both pass before #261 can use this corpus as conformance evidence.
