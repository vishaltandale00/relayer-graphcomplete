# ADR 0006: The product contract is harness and provider agnostic

## Status

Accepted.

## Decision

Relayer product records and workflows use stable provider, model, harness-configuration, permission-profile, project, thread, and interaction identifiers. They do not make Codex, Prime Agent, or another runtime a foundational product concept.

Each thread pins a supported harness configuration and permission profile before its first interaction. Each interaction records its selected model identity. The app server invokes the selected harness through the canonical GraphComplete boundary and accepts only graph-tool writes completed by explicit submission.

Every invocation also has a durable GraphComplete completion identity, append-only current revisions, and a completion-bound capability generation. Harnesses may publish coherent intermediate current layers, but only GraphComplete validates and atomically publishes them. Human interactions and agent-authored recursive code invoke the same `complete(inputGraph)` function. Every semantic child receives a distinct GraphComplete completion and never inherits parent write authority. See [ADR 0008](0008-temporal-current-and-completion-brokers.md).

The persistent harness host resolves a named configuration to a code-owned implementation factory. A GraphComplete thread is a graph of completions, not a provider conversation. The selected harness owns model execution and may reuse provider sessions as a behavior-preserving optimization. Human and agent-authored work both use the canonical `complete(inputGraph)` function with trusted origin metadata. Codex may coordinate native subagents and Prime Agent may coordinate native RLM children; their adapters associate each semantic call with a distinct completion execution. GraphComplete supplies neither with a separate scheduler. A provider adapter owns authentication, model discovery, credentials, and provider-specific execution details. GraphComplete owns graph semantics, interaction-scoped authority, validation, and acceptance. Relayer owns product lifecycle, persistence, activation, and user experience.

One GraphComplete completion owns one independently runnable provider execution attachment. Codex subagents and Prime RLM helpers remain provider-native implementation details inside that attachment and may share its completion authority. Creating a native helper never creates semantic graph identity. An explicit `complete(inputGraph)` call creates a fresh GraphComplete completion and a distinct execution attachment. The adapter may implement that attachment with a fresh provider session or with safe provider-native multiplexing; semantic context and identity cannot depend on hidden session history. The new execution retains the harness's ordinary native helper infrastructure.

For Codex, the adapter starts a fresh app-server thread and turn for the semantic child. That child orchestrator may use Codex-native subagents inside its completion scope. For Claude, the adapter starts a fresh Agent SDK query without resuming or replacing the root session. For Prime Agent, the adapter starts a fresh ordinary Prime session and execution for the semantic child. That execution may use Prime's native RLM and subagent infrastructure inside its completion scope. Native helpers can report a semantic opportunity to their orchestrator, but Relayer does not mirror provider execution topology into GraphComplete.

Harness configurations declare compatible providers, models, and product permission-profile bindings. Product APIs expose only stable catalog identifiers and normalized receipts. Raw provider credentials, sandbox flags, runtime session records, and implementation-specific recursion policy do not enter the product record contract.

Harness- and provider-agnostic means the product contract remains stable across supported implementations. It does not create a generic agent protocol or make arbitrary providers and harnesses work without explicit adapters, compatibility declarations, tests, and release inclusion.

The packaged application includes the `codex.basic` implementation through `codex-basic`, the `claude.basic` implementation through `claude-basic`, plus the reviewed `prime.agent` implementation through `prime-agent-basic` and `prime-agent-deep`. The product Codex configuration uses layered navigation and makes Codex-native subagents available when useful. `codex-basic-high` remains available to internal Eval but is not loaded or packaged by Relayer Desktop. Before startup recovery, a runtime catalog that includes `codex-basic` and omits `codex-basic-high` migrates existing product threads to `codex-basic`; catalogs that still include both configurations retain the high selection. The host preserves exact revision-1 and revision-2 schema-v4/v5 provider state, including deferred legacy sessions, only when the caller registers the current layered product replacement. Eval high registrations remain unchanged, and historical execution receipts keep their original configuration identity. Prime is included only when its content-addressed runtime, exact API contract, harness configurations, and Python client pass packaged integrity verification. No implementation defines the product identity.

## Consequences

- Product requirements and acceptance criteria describe capabilities through the selected harness and provider rather than naming one implementation.
- Implementation-specific setup, limitations, evidence, and tests remain explicit and separately scoped.
- Each harness owns any provider-native delegation it uses. It executes and associates agent-invoked `complete(inputGraph)` calls; GraphComplete does not add another scheduler.
- Provider-native helper topology and GraphComplete semantic-completion topology remain independent.
- Provider sessions are replaceable execution state. The semantic boundary does not preclude separately designed mixed-harness routing, but V1 threads pin one harness configuration and provide no such routing.
- Adding a supported provider or harness requires an adapter, catalog compatibility, permission translation, lifecycle tests, and product evidence.
- Eval cases remain harness agnostic and may compare supported configurations without changing the underlying product workflow.
- [ADR 0001](0001-prime-agent-runtime-boundary.md) is narrowed to the optional `prime.agent` implementation and is otherwise superseded.
