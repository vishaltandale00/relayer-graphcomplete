# ADR 0007: Interaction context is a control-authored action relation

## Status

Accepted.

## Decision

`interaction.context` is a stable member of GraphComplete's identified action/relationship
family. One immutable accepted context action connects a canonical input interaction node to one
accepted target-node occurrence. Its subtype payload preserves the exact accepted source
interaction and layer plus ordered, non-whitespace annotations. The target node is unique within
an input interaction; neither node count nor annotation count has a graph-layer size cap.

Only graph control may create these actions, atomically with the canonical input interaction.
Agent-facing action authoring rejects the type. Creation verifies that the target occurrence is a
member of a layer reachable from the exact accepted source completion and is visible in the new
interaction's project or standalone-thread scope.

The common `actions` identity envelope stores a stable `type_id`; type-specific target occurrence
and annotation constraints remain in dedicated tables. This keeps ordinary `GraphEdge` and the
existing navigate/invoke payload grammar unchanged. Legacy action rows migrate deterministically
to `graph.action`.

Context identities use a graph-control-only client key beginning with NUL. Public action drafts
reject NUL in `clientKey`, and authored-action lookup also excludes `interaction.context` rows.
This reserves a collision-impossible internal namespace without rebuilding the legacy actions
table and its foreign-key dependents merely to widen the existing uniqueness constraint. A future
schema replacement may make uniqueness type-aware, but it is not required for this contract.

The graph capability exposes normalized interaction input from the interaction pointer: message
node, immutable target-node contents, and annotations. It omits occurrence authority metadata.
Control diagnostics may inspect the full persisted context action.

Portable conversation V1 turn records may include an additive `contexts` array and
`interactionNodeId`. Each context carries an export-local action ID, the immutable target-node
snapshot under an export-local node ID, ordered annotations, and authority-free source occurrence
references. Readers treat fields absent from older V1 exports as no attached context. Across one
export, repeated target IDs must have byte-identical snapshots. Importers allocate fresh local
identities, materialize one deduplicated inert target occurrence, and never interpret producer IDs
or text containing filesystem paths as local authority. Context is materialized for non-accepted
turns as well as accepted turns; it does not create a completion or execute imported actions.

Context actions are input, not model-authored output. Ordinary action reads, layer snapshots,
root-action guards and counting, completion closure traversal, recursive depth, orphan detection,
and graph neighbors exclude them. `graph.submit(interactionNode)` still requires exactly one new
model-authored root `navigate` action with `relation=expand`.

## Consequences

- `complete(inputGraph)` remains the canonical boundary; every harness can recover normalized
  context from the interaction pointer without product-database access.
- Product persistence and cross-database recovery remain a separate Relayer responsibility.
- Context actions never become clickable output actions or semantic graph edges.
- Existing navigate, reference, invoke, explicit submission, and harness-native recursion
  semantics are unchanged.
