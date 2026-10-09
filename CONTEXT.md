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

**CompletionContract**:
The immutable, versioned input, exceptional authority and Return requirements owned by one sealed InteractionNode.
_Avoid_: Harness configuration, private prompt

**Live answer**:
An accepted supplemental user answer to a published question in the same still-active completion. It is separate from that completion's immutable initial input.
_Avoid_: Draft input, new interaction, automatic resume

**Answer receipt**:
The durable acknowledgment that a live answer was accepted for its exact question and execution attempt. It confirms delivery, not the model's consumption or incorporation.

**InvokeAction**:
A callable definition owned by one response Node. It permits one call by default; reusable definitions explicitly permit multiple distinct calls.
_Avoid_: Invocation, execution attempt

**Invoke input binding**:
An explicit relationship from an InvokeAction to the input actions whose current values that call accepts and consumes as arguments. Nearby fields are not implicitly bound.

**Invocation**:
A durable call reference binding one InvokeAction to at most one child InteractionNode and its recorded outcomes.
_Avoid_: Provider session, action conversion

**SubCompletion Graph**:
The derived view of source response Nodes, Invocation relationships and their child InteractionNodes within the cumulative graph.
_Avoid_: Provider subagent topology, separate graph store

**Current Layer**:
The latest published response Layer of a completion that may still be working.

**Returned Layer**:
The Layer selected as an interaction's full response when it Returns.

**Accepted-history change**:
A narrowly authorized change to graph content accepted before the interaction, staged as part of that interaction's response transaction.

**Attached response navigation obligation**:
A frozen acceptance requirement for every distinct attached native node to expose a new control leading to the interaction's response. It is separate from permission to add navigation.

**Invoke resolution**:
The recording of an Invocation's returned graph while retaining its InvokeAction identity. Historical versions may instead retain a one-time action conversion.

**Context attachment**:
A user-selected node and its causal occurrence, supplied as input to an interaction.
It may confer narrowly bounded navigation authority on the node, never general edit authority.

**Input declaration reference**:
An authoring-time reference from an Invoke declaration to an exact Input declaration on the same response Node, resolved to a canonical Input action identity when persisted.

**Shared thread snapshot**:
An immutable, public, read-only conversation-export v1 projection of one local
thread's accepted history, frozen for one owner-bound publication attempt. It is
not a live thread, provider session, product-data backup, or source of graph
authority.
_Avoid_: Shared thread, cloud thread, remote workspace
