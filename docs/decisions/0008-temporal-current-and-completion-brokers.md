# ADR 0008: Temporal current is durable and completion scoped

## Status

Accepted.

## Decision

The canonical interaction node is also the durable identity of one GraphComplete completion. Every newly created completion starts active at revision 0 with its interaction anchor as the conceptual current. Later current revisions are immutable and completion local; a separate compare-and-swap head identifies the latest revision.

`advance` atomically validates authority, validates the candidate closure and exact prior-current accessibility, accepts newly published records, appends a revision and durable operation receipt, moves the head, and appends a projection-outbox event. `return` performs the same transaction and also establishes the final current and the existing accepted completion output. `stop` and trusted-control `fail` append terminal revisions while retaining the last current. Exact retries replay their committed receipts; a reused operation key with different input and distinct operations against a stale expected revision fail without mutation. SQLite uses WAL with `synchronous=FULL` for acknowledged transitions.

The interaction-local write boundary remains unchanged. The graph server resolves a runtime token to an exact completion identity, immutable read entitlement, and graph-persisted authority epoch. Reminting cuts over the epoch, and every graph operation validates it in the same transaction that reads or writes graph state. Terminal completion capabilities lose all graph reads and writes. The response of the Return operation may contain the output that operation committed; subsequent result observation and exact-receipt recovery use trusted supervision/control. `fail` is never a model operation.

`complete(inputGraph)` is the single recursive semantic function. A human interaction invokes it through the product, while agent-authored code invokes the same function through the harness provider's defined recursive mechanism. Every invocation runs against one already-prepared canonical interaction/completion identity and receives a fresh capability bound to that identity and epoch. Trusted preparation creates or exactly recovers that identity in a separate prior step; `complete(inputGraph)` establishes no identity of its own and rejects an unprepared pointer. A new semantic child therefore receives new ownership through its own `complete(inputGraph)` call; the parent capability remains parent scoped. Same-completion helpers may intentionally share their owning completion context, but they do not become semantic children.

Each completion also owns one independently runnable provider execution attachment. Provider-native subagents or RLM helpers operate inside that attachment without acquiring semantic child identity. An explicit Complete call creates both a new GraphComplete completion and a distinct execution attachment. Provider-session reuse is optional: the adapter may start a fresh session or safely multiplex an existing one, but hidden provider history cannot be required to reconstruct GraphComplete context or identity. The child attachment may use the same provider-native helper infrastructure as its parent.

Each invocation returns a live completion handle containing a durable current pointer and a result promise. Stop and failure settle that promise by rejection with the retained current snapshot; a never-settling promise is not the contract. Restart never reattaches an interrupted active completion: it fails the completion safely with `application_restart` and preserves its retained current. Agent-authored code decides which recursive calls to make, which current pointers and graph-search results to inspect, which results to await, and how to build its own current and final layers. The provider harness associates each call with provider execution and resolves its result from durable GraphComplete terminal state. GraphComplete and the harness host add no recursive scheduler.

The graph URL and runtime token are scoped execution inputs for one `complete(inputGraph)` invocation. They need not be host-only, and no provider-specific typed graph-operation channel is introduced. Passing a capability to another helper does not change its server-derived subject or widen its ownership. A distinct semantic completion must enter through `complete(inputGraph)` to receive its own identity and capability.

The graph-local outbox orders projection changes by a durable sequence. Consumers recover gaps from the persisted projection surface. A view follows a newer revision only while it is still displaying that pointer's previous current; explicit user navigation pins the view. Accepted historical layers and invoke slots remain immutable, and live current resolution is derived instead of rewriting them.

`complete(inputGraph)` remains the canonical external boundary, and the existing `graph.submit(interactionNode)` path is a compatibility return operation. Provider harnesses retain ownership of execution, recursion, concurrency, and messaging. Root execution can adopt the durable completion contract independently. Recursive rollout additionally requires every agent-invoked semantic child to call `complete(inputGraph)` and receive a distinct completion identity, current pointer, result promise, and scoped capability.

Rollout state is persisted as versioned, dependency-checked feature configuration. The compatibility default is all flags off. Schema reads precede root writes; root writes precede projection UI; projection precedes invoke resolution; invoke resolution precedes recursive `complete(inputGraph)` binding. The command-line switches are development qualification controls, not evidence that the recursive harness gate has passed.

## Consequences

- Current history survives restart and cannot be overwritten by last-writer-wins behavior.
- Published history remains navigable and terminal stop/failure retains useful work.
- Read eligibility does not widen interaction-local write authority.
- Deterministic tests can prove persistence, idempotency, epoch cutover, projection ordering, and follow-versus-pin behavior without paid inference.
- Recursive child issuance, agent-invoked `complete(inputGraph)` binding, search freshness, and product-faithful canary evidence remain separate rollout gates.
- Root qualification does not wait for recursive harness binding. Recursive qualification requires every semantic child to use the same `complete(inputGraph)` function as human-root work.
