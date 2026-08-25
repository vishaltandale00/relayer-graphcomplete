# ADR 0005: Layered navigation is relation-typed and submit-enforced

## Status

Accepted.

## Decision

GraphComplete distinguishes two navigate relations. `expand` continues an answer's decomposition and must form an acyclic graph. `reference` opens supporting accepted or current-turn context, may be shared, and may contain cycles. Every non-root action records the exact source layer in which it was authored. The interaction root has exactly one `expand` action and no source layer.

An interaction created by invoking an accepted `invoke` action may carry one immutable, nullable `leased_action_id` referencing that exact source action. A private immutable nullable `lease_source_interaction_id` persists the accepted source completion that issued it; both lease fields are null or both are non-null. The user-interaction-node action field has a uniqueness constraint when present: an action can lease at most one interaction, and ordinary interactions have no lease. Only graph control may issue the lease after validating that the unresolved accepted `invoke` action is snapshotted in the exact accepted source completion and that the requested result scope is compatible; that membership may come from reuse of an accepted node-owned action, and authoring clients cannot set or transfer either field. The stored `(sourceInteractionNodeId, sourceActionId)` pair is the response-loss idempotency identity: retrying that pair returns the existing immutable result interaction, while the same action presented from another accepted source completion cannot claim the existing lease. Interactions and invocations created before lease support retain `null` and are not backfilled.

The lease also defines derived read adjacency. Neighbor reads for the leased interaction include the accepted source node obtained through `leased_action_id -> action.source_node_id`, subject to the interaction's established visibility scope. GraphComplete does not persist a `GraphEdge` for this relationship. Invocation provenance therefore does not change authored topology, layer membership, edge uniqueness, or the semantics of `expand` and `reference`.

The Rust `graph.submit` boundary validates and atomically accepts the current interaction's authored closure. It traverses expansion recursively, traverses references with visited-layer tracking, treats prior accepted reference targets as boundaries, rejects orphan draft layers, and prevents a new target from being both expansion and reference. Reference-arrived layers may author only reference actions.

For a leased interaction, that same ordinary `graph.submit(interactionNode)` call also consumes the lease. In the acceptance transaction it revalidates that the leased source action is the exact accepted unresolved `invoke`, accepts the result closure, and changes only that action's `target_layer_id` from `null` to the accepted result root layer. The result root remains expansion depth zero. The transition is allowed exactly once: the target cannot be cleared, replaced, or assigned by another interaction, and a failed or stopped result leaves it `null`. Repeating submission of the already accepted leased result is idempotent. Validation or storage failure accepts neither the result closure nor the target assignment.

This is the sole mutation exception for an accepted action. Its authored kind remains `invoke`; a populated target is effective cross-interaction navigation, not an `expand` or `reference` relation and not additional recursive depth in the source completion. Because actions are node-owned, every project-visible reuse of that action observes the same resolution, including reuse from another thread in the project. Existing standalone-thread visibility remains isolated. There is no `resolveAction` tool, separate resolution table, or second resolution state machine.

Reused accepted nodes retain their earlier accepted actions. Those actions keep their original source-layer provenance even when the node appears in a later expansion or reference layer; reference-arrival restrictions apply only to actions newly authored from that context. Apart from the leased invoke target transition above, accepted action fields and accepted layer snapshots remain immutable. Legacy actions predate exact provenance and typed relations, so migration records their earliest accepted layer snapshot as the best available original source and classifies legacy navigation as expansion without rewriting immutable history.

Layers normally contain one to five nodes. Six to eight nodes require a bounded private justification in the submit-layer request; that reason is validated and discarded rather than persisted or rendered. More than eight nodes are rejected.

Harness prompts explain the task goal and the meanings of expansion and reference, but do not prescribe a fixed authoring sequence other than final submission coming last. Tool errors provide stable issue codes and natural-language repair guidance. The simulated-user judge separately grades whether expansion or references were needed and whether each worked; reference destinations are judged through their source action without regrading the destination node by node.

Harness-authored programs assign every persisted node, edge, layer, and action an explicit stable client key. Repairing a rejected write or submission may rerun the whole program with those same keys and therefore update the same current-interaction drafts rather than create duplicate records, provided each record's identity-owning context is unchanged. An action key is scoped to its source node, so moving an action to another source node creates a different action rather than updating the original draft. Harness repair guidance requires an action to retain its source node. The interaction permits only one active root action; a different client key cannot create a second active root.

When submission identifies an intentionally abandoned orphan draft layer, the owning interaction may explicitly discard that unreachable layer into the terminal `stopped` state. Discard is non-recursive, idempotent for the same stopped layer, and changes only the layer record: its nodes, edges, actions, and child layers remain unchanged and reusable. Accepted, foreign-owned, or currently reachable layers cannot be discarded. Harness guidance presents discard only as orphan recovery and forbids inventing navigate or reference actions to make abandoned drafts reachable.

## Consequences

- Flat accepted answers remain valid.
- Prime Agent remains the only recursive execution scheduler; GraphComplete owns graph semantics and acceptance only.
- Product and Eval clients use the same relation and provenance contract.
- Invoke results use existing graph authoring and submission. Generic Back, breadcrumbs, viewport restoration, and click-occurrence navigation history remain orthogonal and are not defined by this lease.
- Pre-lease invocations remain unchanged and unleased; no migration infers or creates leases for them.
- Legacy harness configurations remain available as baselines, but they use the same stricter graph tools.
