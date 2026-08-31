# ADR 0001: Prime Agent is the recursive execution runtime

Status: superseded by [ADR 0006](0006-harness-provider-agnostic-product-boundary.md)

This decision remains valid for the optional `prime.agent` harness implementation. It no longer defines Prime Agent as the product-wide execution runtime.

## Decision

When the `prime.agent` harness is selected, that implementation will use Prime Agent's package boundary for agent sessions, nested RLM children, parent-child communication, implementation-owned model policy, persistence, and cancellation.

GraphComplete will not copy Prime Agent's scheduler or place Prime Agent underneath another RLM orchestration layer.

## Consequences

- Graph-specific policy remains independently testable and reusable.
- Prime Agent upgrades require compatibility testing.
- Generic missing capabilities, such as per-child thinking selection, should be contributed upstream.
- GraphComplete supplies one in-memory run context per `complete()` call. Prime Agent propagates it to root and recursive IPython host requests without persisting it.
- A stable `relayer.graph.current` host handler exposes the completion's graph scope for the exact execution generation; Prime Agent does not own, persist, widen, or interpret graph authority. Prime RLM and subagent work stays inside that completion. An explicit `complete(inputGraph)` call receives its own durable completion identity and runs as a fresh ordinary Prime session rather than being mapped onto RLM topology.
- Product hosts and product records do not know Prime Agent's internal session representation.
- Completion is determined by graph acceptance, not by an agent turn ending.
