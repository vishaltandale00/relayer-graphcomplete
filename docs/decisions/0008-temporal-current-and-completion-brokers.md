# ADR 0008: Temporal current is durable and completion scoped

## Status

Accepted.

## Decision

The canonical interaction node is also the durable identity of one GraphComplete completion. Every newly created completion starts active at revision 0 with its interaction anchor as the conceptual current. Later current revisions are immutable and completion local; a separate compare-and-swap head identifies the latest revision.

`advance` atomically validates authority, validates the candidate closure and exact prior-current accessibility, accepts newly published records, appends a revision and durable operation receipt, moves the head, and appends a projection-outbox event. `return` performs the same transaction and also establishes the final current and the existing accepted completion output. `stop` and trusted-control `fail` append terminal revisions while retaining the last current. Exact retries replay their committed receipts; a reused operation key with different input and distinct operations against a stale expected revision fail without mutation. SQLite uses WAL with `synchronous=FULL` for acknowledged transitions.

The interaction-local write boundary remains unchanged. The graph server resolves a runtime token to an exact completion identity, immutable read entitlement, and graph-persisted authority epoch. Reminting cuts over the epoch, and every broker operation validates it in the same transaction that reads or writes graph state. Terminal model brokers lose all graph reads and writes. The response of the Return operation may contain the output that operation committed; subsequent result observation and exact-receipt recovery use trusted supervision/control. `fail` is never a model-broker operation.

This foundation does not yet make the provider transport host-only. The existing Codex and Claude subprocess environment and Prime Agent `relayer.graph.current` response still expose the runtime URL and bearer to model-controlled code. Those adapters must be replaced by provider-specific typed host channels before the single-root rollout can be enabled. Epoch, lifecycle, and entitlement enforcement limit what a leaked bearer can do, but they are not a substitute for the non-transferable `HostOnlyCompletionBroker` required by #234/#235.

The graph-local outbox orders projection changes by a durable sequence. Consumers recover gaps from the persisted projection surface. A view follows a newer revision only while it is still displaying that pointer's previous current; explicit user navigation pins the view. Accepted historical layers and invoke slots remain immutable, and live current resolution is derived instead of rewriting them.

`complete(inputGraph)` remains the canonical external boundary, and the existing `graph.submit(interactionNode)` path is a compatibility return operation. Provider harnesses retain ownership of execution, native recursion, concurrency, and messaging. This decision introduces no scheduler. Root execution can adopt the durable completion contract independently after its provider transport is converted to a host-only broker; semantic children additionally require distinct completion identities and brokers before recursive rollout.

Rollout state is persisted as versioned, dependency-checked feature configuration. The compatibility default is all flags off. Schema reads precede root writes; root writes precede projection UI; projection precedes invoke resolution; invoke resolution precedes provider recursion. The command-line switches are development qualification controls, not evidence that the host-only broker gate has passed.

## Consequences

- Current history survives restart and cannot be overwritten by last-writer-wins behavior.
- Published history remains navigable and terminal stop/failure retains useful work.
- Read eligibility does not widen interaction-local write authority.
- Deterministic tests can prove persistence, idempotency, epoch cutover, projection ordering, and follow-versus-pin behavior without paid inference.
- Recursive child issuance, provider-native child binding, search freshness, and product-faithful canary evidence remain separate rollout gates.
- The raw provider credential paths remain an explicit release blocker for #234/#235 and single-root enablement.
