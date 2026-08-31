# GraphComplete

GraphComplete is a graph-native workspace in which semantic work remains durable independently of the harness or provider that executes it.

## Language

**Thread**:
A saved graph of completions belonging to one continuing body of work. It may be presented conversationally, but it is not a provider conversation or session.
_Avoid_: Provider thread, provider session

**Completion**:
One semantic unit of work created or exactly recovered by `complete(inputGraph)`, with its own graph identity, current, lifecycle, and authority.
_Avoid_: Model turn, provider turn

**Execution attachment**:
The provider-native execution associated with one completion. It is independently runnable and replaceable without changing the completion's graph identity.
_Avoid_: Completion identity, thread identity

**Provider session**:
Optional provider-owned continuity state that an adapter may reuse when safe and useful. It is not the authoritative source of thread identity or graph context.
_Avoid_: Thread, completion

**Native helper**:
A provider-owned subagent or recursive helper operating inside one completion's execution attachment. It does not become a semantic child unless agent-authored code calls Complete.
_Avoid_: Completion child
