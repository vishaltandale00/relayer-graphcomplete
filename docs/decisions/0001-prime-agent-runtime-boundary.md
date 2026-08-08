# ADR 0001: Prime Agent is the recursive execution runtime

Status: accepted

## Decision

GraphComplete will use Prime Agent's package boundary for agent sessions, nested RLM children, parent-child communication, model selection, persistence, and cancellation.

GraphComplete will not copy Prime Agent's scheduler or place Prime Agent underneath another RLM orchestration layer.

## Consequences

- Graph-specific policy remains independently testable and reusable.
- Prime Agent upgrades require compatibility testing.
- Generic missing capabilities, such as per-child thinking selection, should be contributed upstream.
- Product hosts do not need to know Prime Agent's internal session representation.
- Completion is determined by graph acceptance, not by an agent turn ending.

