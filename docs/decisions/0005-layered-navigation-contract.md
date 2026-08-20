# ADR 0005: Layered navigation is relation-typed and submit-enforced

## Status

Accepted.

## Decision

GraphComplete distinguishes two navigate relations. `expand` continues an answer's decomposition and must form an acyclic graph. `reference` opens supporting accepted or current-turn context, may be shared, and may contain cycles. Every non-root action records the exact source layer in which it was authored. The interaction root has exactly one `expand` action and no source layer.

The Rust `graph.submit` boundary validates and atomically accepts the current interaction's authored closure. It traverses expansion recursively, traverses references with visited-layer tracking, treats prior accepted reference targets as boundaries, rejects orphan drafts, and prevents a new target from being both expansion and reference. Reference-arrived layers may author only reference actions.

Layers normally contain one to five nodes. Six to eight nodes require a bounded private justification in the submit-layer request; that reason is validated and discarded rather than persisted or rendered. More than eight nodes are rejected.

Harness prompts explain the task goal and the meanings of expansion and reference, but do not prescribe a fixed authoring sequence other than final submission coming last. Tool errors provide stable issue codes and natural-language repair guidance. The simulated-user judge separately grades whether expansion or references were needed and whether each worked; reference destinations are judged through their source action without regrading the destination node by node.

## Consequences

- Flat accepted answers remain valid.
- Prime Agent remains the only recursive execution scheduler; GraphComplete owns graph semantics and acceptance only.
- Product and Eval clients use the same relation and provenance contract.
- Legacy harness configurations remain available as baselines, but they use the same stricter graph tools.
