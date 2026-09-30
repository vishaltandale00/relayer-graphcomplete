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

**Interaction permission**:
A frozen description of the exact graph operations a completion may perform,
derived from that interaction's product origin and attachments.
_Avoid_: Runtime token, permission profile

**Attached response navigation obligation**:
A frozen acceptance requirement for every distinct attached native node to expose a new control leading to the interaction's response. It is separate from permission to add navigation.

**Invoke resolution**:
The one-time acceptance of an invoked interaction's response, turning its exact
source action into navigation while preserving that action's identity.

**Context attachment**:
A user-selected node and its causal occurrence, supplied as input to an interaction.
It may confer narrowly bounded navigation authority on the node, never general edit authority.

**Shared thread snapshot**:
An immutable, public, read-only conversation-export v1 projection of one local
thread's accepted history, frozen for one owner-bound publication attempt. It is
not a live thread, provider session, product-data backup, or source of graph
authority.
_Avoid_: Shared thread, cloud thread, remote workspace

**Continuation conversation**:
A thread created with the `continuation-v1` format. Its earlier turns are read from the graph on demand, so each turn may choose its harness, provider, and model.
_Avoid_: Portable thread, migrated conversation

**Legacy conversation**:
A thread with the `legacy` format. Its earlier turns exist for the agent only in a native provider session, so it keeps its original execution route.
_Avoid_: Old thread, unmarked thread

**Conversation read**:
The read-only, completion-scoped graph API that returns a continuation conversation's earlier root turns in order. It is not graph search and grants no authority.
_Avoid_: History bootstrap, transcript
