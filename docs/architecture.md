# Architecture

## Ownership boundary

Relayer is the product host. GraphComplete owns graph semantics and acceptance. A thread-selected harness owns model execution behind a provider-agnostic product contract.

```text
Product host
    -> complete(interaction-node pointer)
        -> persistent Node host resolves the thread's selected harness object
        -> selected harness implementation
            -> selected provider adapter and model
            -> direct execution
            -> or harness-owned native delegation
        -> graph.submit(interaction node)
        -> accepted resolved root layer or explicit failure
    -> product persistence and activation
```

Product records pin stable provider, model, harness-configuration, and permission identifiers. Harness implementations and provider adapters translate those selections into runtime-specific credentials, sessions, and model calls. Each harness owns any provider-native delegation it uses, including Codex subagents and Prime Agent RLM children. Supporting a new implementation requires an explicit adapter; agnostic does not mean arbitrary runtimes work without integration.

## Working desktop product path

```text
Electron desktop
    -> Rust graph server + Node harness host
    -> Rust Relayer app server
        -> HTTP API
            -> product service
                -> SQLite product storage
            -> authenticated runtime client
                -> canonical graph interaction
                -> pinned thread harness completion
        -> desktop renderer files
```

Electron owns native windows, provider setup, updates, the Rust child-process lifecycles, and the in-process Node harness host. One Electron main process owns each desktop profile; a later application launch exits after asking the primary process to restore and focus its window. The primary process keeps product and runtime data inside permission-restricted app directories, gives the app server authenticated loopback coordinates for the graph server and harness host, sends product and graph control tokens through each Rust child's standard input, and keeps those pipes open as ownership signals. An unexpected service exit closes the owning application instead of leaving a partially live runtime. The Rust app server owns durable project, thread, and product interaction chronology records and serves the renderer over a random loopback port. The renderer uses only the app server as its product API.

Electron also owns one deep managed-runtime installer for code-owned harness capabilities. Connect requests the exact recipe selected by the Desktop release, verifies every recorded artifact identity, assembles and probes in isolated staging, and atomically activates one immutable installation descriptor per runtime and platform before provider authentication. The current release owns exact Codex 0.147.0 and Claude 0.3.250 recipes for macOS arm64, macOS x64, and Windows x64. External app-update metadata remains version-shaped for predecessor compatibility and maps to those code-owned recipe identities before staging. Ordinary startup performs only local receipt, file, and readiness validation; it performs no vendor lookup or automatic retry. Explicit preparation repairs the same requested recipe and never adopts a mutable latest release. Provider definitions retain only their isolated authentication, configuration, and session state. Native vendor runtimes are excluded from the application bundle, and ambient `claude`, `codex`, uv, Python, npm, Homebrew, shell PATH, and Prime profile state are never adopted.

The recipe schema can describe exact verified executables, archives, CPython artifacts, wheel-only Python closures, and app-owned client bytes without exposing them to harness configuration. Every mutable HOME, temporary, XDG, uv cache, Python, tool, and tool-bin path is redirected beneath the private managed-runtime root. Source distributions and source builds fail closed. Staging passes its code-owned readiness function before the active pointer changes; failed preparation preserves the prior descriptor. Frozen schema-v1 receipts are reusable only when their version and artifact identities exactly match the requested recipe. Cleanup recognizes only managed descendants and preserves unknown or unsafe legacy state rather than widening deletion authority. Production Prime assembly, composite kernel readiness, provider-by-harness visibility, updater gating, and packaged-runtime removal remain separate stacked boundaries.

The app server holds graph control authority because it creates interactions and owns capability revocation. The harness host receives a distinct credential for its own loopback API plus only the per-call graph capability it translates into the selected harness. It never receives the graph control token.

Within the app-server crate, each layer has one concrete responsibility:

- `app_server.rs` composes the server and owns its startup boundary.
- `api.rs` and `api/` own HTTP authentication, routes, request/response shapes, and product-error mapping.
- `product.rs` and `product/` own typed identifiers, product records, validation, and use-case orchestration.
- `storage.rs` and `storage/sqlite/` own SQL, transactions, connection policy, and schema migration.

SQLite migrations are storage implementation details. `SqliteProductStore::open` requires any existing product tables to carry Relayer's SQLx migration history, applies the embedded versioned files under `storage/sqlite/migrations/`, and validates the exact resulting schema and row invariants before the store becomes available. This permits a recognized predecessor to migrate while an unmanaged, incompatible, partially initialized, or corrupt schema fails startup. Electron, the HTTP API, and the product service neither run nor interpret migrations. The storage pool is asynchronous, bounded, configured for foreign keys and WAL, and is not guarded by a process-wide blocking mutex. Composite product-state and thread-detail reads use SQLite snapshot transactions so each API response is internally consistent. Operations that allocate per-thread interaction sequence numbers acquire an immediate SQLite transaction before assigning their timestamp or sequence, so concurrent requests cannot select the same next sequence or move a thread's chronology backward.

## Planned graph-search boundary

Graph search uses one application-owned Ladybug database as a derived search store. SQLite remains the canonical GraphComplete write store for the initial release. Ladybug serves every graph query; production search never falls back to SQLite. One broken logical target cannot stall other targets because publication order and readiness are tracked per project or standalone thread inside the shared store.

An accepted SQLite transition records an idempotent projection event in the same SQLite transaction. The author is not acknowledged until the complete closure is committed and verified in one Ladybug transaction. This is an acknowledgement-level freshness guarantee, not physical ACID across both databases. A concurrent query may observe the prior published revision, but never a partial closure.

The Rust graph core owns query parsing, semantic validation, read-permit intersection, budget enforcement, lowering, and normalized results. The server and TypeScript/Python clients expose that module without reproducing query or authority rules. Callers select a thread or project dataset, but the selector never grants access. Query text cannot name a physical database or broaden the completion-bound read permit.

Ladybug stores only accepted, published graph material. Its searchable supergraph contains content nodes, layers, canonical authored connections, derived layer membership, and accepted `expand` or `reference` action occurrences. `interaction.context`, drafts, and unresolved invokes are excluded. Accepted current or resolved-invoke facts may enter only through future typed contract additions from their owning features.

Engine, storage-format, Relayer-schema, query-contract, and derived-index versions are independent. Incompatible Ladybug bytes are quarantined and rebuilt from SQLite before an atomic active-store swap. The initial release uses official pinned Ladybug bytes plus narrow extensions or upstream hooks, without a permanent core fork. Vector retrieval and a Ladybug canonical-write cutover remain deferred. The exact v1 language, values, limits, and compatibility rules live in [the graph-query contract](graph-query-v1.md).

For every ordinary message product interaction, the app server durably creates the product interaction and atomically reserves its `submitted` preparation state before graph control. Input-assisted Send instead snapshots the thread's committed input attachments into one immutable submitted-input attempt while creating a `not_started` root interaction; a conditional claim on that exact attempt later reserves `submitted`. It then creates the canonical user-interaction graph node with product project/thread provenance, stores that node plus the frozen execution identity, claims `running`, and only then supplies the transient graph capability to the matching `complete()` call. Explicit graph submission runs in background work owned by the app-server process, which persists accepted output or explicit failure on the product interaction. This lets every product host display the thread and waiting state while polling the same product record to terminal state. Product and graph writes remain separate SQLite transactions; the stored graph node ID is the durable join between them.

## Product permission profiles

Rust product policy defines exactly `ask`, `auto`, and `full`, including their labels, enabled state, default, and authority semantics. A thread pins one profile and one named harness configuration before inference. Each harness configuration carries implementation-specific bindings for the supported profile IDs, while product APIs and Eval cases exchange only the stable IDs. Accepted interactions persist a combined effective-execution digest and normalized permission receipt alongside the harness digest. Full-access receipts disclose that the process was not hard-confined from the host filesystem or network. See [ADR 0004](decisions/0004-product-permission-profiles.md).

Prime Ask and Auto are two cooperating run-scoped capabilities, not configuration labels. The tool authority covers the root and recursive children and recognizes the complete IPython cell as the initial tool unit. The kernel authority launches the real kernel inside an attested version-1 workspace-write boundary before provider inference. That bounded mode permits workspace writes and loopback TCP for Jupyter, but denies subprocess creation, launchd job creation, Unix-domain outbound sockets, AppleEvents, and Mach lookup/registration so a kernel cannot daemonize past terminal cleanup or reach host control sockets. Ask routes the exact cell, canonical working directory, validated-argument digest, and boundary identity through the shared approval coordinator. Auto is a deterministic allow for that recognized request only after attestation; it never asks the orchestrator to review itself. Terminal cleanup is awaited and emitted as sanitized trace evidence. Full deliberately omits both capabilities and retains ordinary subprocess support.

The desktop New Thread composer loads profile labels, availability, and the default from the Rust product API. It sends only the selected stable ID during ordinary thread creation and displays the pinned profile on saved threads. Unavailable profiles remain visible but disabled; provider-specific bindings never enter the renderer contract.

## Provider, model-family, and harness boundaries

Provider access, model-family organization, and harness execution are separate product concepts:

1. A code-owned provider-adapter registry defines the runnable adapter types and their versioned execution-access contracts. The registry owns connection flow, endpoint validation, model discovery and normalization, and execution-scoped access. It does not create model families or inspect harness configurations.
2. A user-owned provider definition identifies one exact access path. Its generated ID, adapter ID, endpoint, and access mode are immutable. Credentials remain in secure desktop storage; product records retain only a credential or managed-runtime reference. Two definitions may use the same adapter, endpoint, and model IDs while remaining distinct identities.
3. A product-owned model family is an ordered list of exact provider-definition/model pairs. Families contain no credentials or execution behavior and may span providers. Managed read-only families are derived by versioned product policy; custom families remain harness-agnostic.
4. A named harness configuration declares its versioned execution-access contract and exact or regular-expression model rules over stable adapter ID plus model ID. It never contains a user provider-definition ID or credential.
5. Product resolution is the only join among the thread-pinned harness configuration, the selected family, current provider/catalog state, and the unsent exact selection. Send atomically pins the resolved provider definition and model to one execution attempt. The harness host defensively revalidates the adapter/model rule and access contract before invoking the selected harness implementation.
6. Electron owns one credential-free readiness coordinator for loaded production harness configurations. Connect, reconnect, and explicit repair resolve exact access-contract and model-rule candidates, prepare shared recipes once, and publish one digest-guarded availability batch. Rust persists only global configuration availability and derives provider routes through the existing catalog joins; there is no provider-by-harness persistence. Loaded configurations start unavailable, and startup, catalog background work, renderer reads, and Send perform no readiness probes. Secret provider access contains only provider material; Codex and Claude managed runtime descriptors are injected by their harness factories.

Threads pin a harness-configuration identity, not an immutable copy of catalog or family state. Unsent turns resolve lazily against current semantic revisions when the picker opens or Send is pressed. A still-valid exact selection is preserved; an invalid selection may move only within its current family. The product never selects another family implicitly. Once an attempt is sent, its provider/model identity cannot change or fall back mid-flight.

Provider removal uses atomic admission and draining. Marking a definition `removal_pending` immediately blocks new attempts through it while already admitted work finishes. Credential deletion and the non-secret historical tombstone occur only after the last execution reference is released. Family deletion needs no drain because a sent attempt no longer consults family membership.

Every execution attempt has an immutable receipt and a durable effect boundary: `none`, `partial_output`, `graph_write`, `tool_effect`, or fail-closed `unknown`. For an ordinary message, a model-related failure returns the same interaction to an editable unsent state, including failures after partial output, graph writes, tool effects, or an unknown boundary. For an input-assisted Send, failure or stop instead restores its snapshotted attachments to the thread draft without reopening or retrying that immutable attempt; retry requires a new explicit Send and a new root interaction. A draft edit committed after the failed attempt was reserved wins over restoration for the same occurrence. Both paths deliberately accept duplicate-effect risk: durable graph writes remain authoritative, and only the product binding and transient execution capability state are cleared. Pre-execution model failures also persist the exact provider, model, family, and harness-policy snapshot available at failure time; adapter implementation version `0` records that provider admission did not complete. Non-model failures remain failed and inspectable. Trace events conservatively raise the boundary for streamed output and tool starts, observable graph neighbors raise it for graph writes, and an accepted graph discovered while recovering a harness failure is adopted without rerunning the harness. Attempt finalization and the matching interaction transition commit in one SQLite transaction, while startup converts any genuinely interrupted running attempt to terminal `unknown` and reconciles graph-authoritative acceptance first. Issue #158 may later replace this accepted duplicate-risk behavior with effect-aware replay protection.

This contract applies equally to `codex.basic`, `prime.agent`, and future harness implementations. It adds no scheduler and does not change `complete(inputGraph)` or graph acceptance authority.

## Personal presentation profile

Relayer owns one hidden profile thread whose accepted completions are immutable personal-presentation versions. Before provider execution, product preparation atomically pins either the active version or an explicit Eval override to the interaction. Graph core represents that pin as a control-owned attachment, not an edge, action, context occurrence, or response record. It is excluded from ordinary completion closure, graph navigation, product history, Node Details, and conversation export. A harness receives the resolved accepted graph only through its interaction capability and renders it after generic graph guidance but before task input. Candidate traces and Eval artifacts retain only the exact version interaction ID. See [ADR 0009](decisions/0009-personal-presentation-graph-attachments.md).

Activation changes only future human-authored pins. Existing interactions, retries, and recovery retain their original version and effective execution identity. Invoke-created semantic children atomically copy the source interaction's exact pin rather than resolving the newly active policy. V0 is neutral; active V1 encodes the decision-useful and progressive-disclosure preferences. Published but inactive V2 is one self-contained accepted completion whose single root layer adds Visible working state to those two version-owned concepts. The Eval-only layered Codex V0/V1 configurations use the same existing cases, matrix, judges, artifact schema, and read-only production renderer.

## Shared product and Eval workspace

Relayer and Relayer Eval are separate Electron build targets. Relayer exposes the ordinary product window and lets each new thread pin an available catalog configuration. Relayer Eval exposes a test-run dashboard and selects named configurations for its matrix, but executes each case through the same product app server. A case may create one or more ordinary product threads and interactions.

Opening one case × harness execution creates a separate review window using the exact production renderer and `ProductWorkspace` component. The review preload supplies only Eval navigation context: the run's cases and product thread IDs for the selected harness. Product graph reads, accepted-layer navigation, turn navigation, layout, and node inspection remain owned by the ordinary product API and workspace. The same app server issues the review window a read-only session capability and rejects writes at the API boundary; workspace review mode also removes composition and mutating controls. See [ADR 0003](decisions/0003-shared-product-eval-workspace.md).

Node-input round-trip evaluation does not relax that read boundary. A separately credentialed, occurrence-scoped operator uses the ordinary input-draft and interaction HTTP routes only after versioned input-action captures have been durably persisted with their node rating. Independent per-action locks exclude writes while pixels and ratings are bound, one receipt atomically commissions the complete capture set, and the read-only presentation revision includes the opaque selected-thread input-draft revision. The operator verifies the route's returned occurrence, action, value, and draft revision before it may Send. The opt-in live gate then joins the accepted authored action, consuming product interaction, provenance-exact graph input children, and the next harness prompt trace containing the same normalized semantic input. Model grounding ratings are recorded separately and never replace this structural gate.

Every newly authored layer carries a versioned layout with exactly one normalized
placement per member node. Graph core validates and persists those placements as
part of the draft and accepted layer snapshot. The shared Product/Eval renderer
projects normalized coordinates into a stable world plane; responsive fitting,
panning, zooming, and inspector changes affect only the camera. Historical
accepted layers without layout data remain readable through one deterministic,
viewport-independent renderer fallback and are never rewritten during reads.

Each product or Eval review window owns one bounded renderer-side navigation history for thread, turn, authored layer path, and remembered node selection. Restoration resolves accepted product data before committing the presentation and cursor together. Eval's judge history command delegates to this controller; the Eval main process records and validates the result but does not own a second stack. Hierarchy breadcrumbs and direct chronological turn controls remain separate presentations of layer ancestry and durable interaction order.

## Base graph-completion invariants

1. Product hosts own project and thread records. Graph core stores their positive-integer IDs only as graph-record provenance; it does not create parallel project or thread objects.
2. Accepted graph records are visible to every thread with the same project ID. A standalone thread has no project ID and can see only records carrying its own thread ID.
3. A turn is centered on one canonical user-interaction graph node. Its `NodeId` is the interaction identity; there is no separate interaction-graph record.
4. Harnesses inspect and mutate graph state only through the typed graph clients and loopback Rust API.
5. Every capability maps to one canonical interaction `NodeId`. `GraphDatabase::writer_for_subgraph(node_id)` derives project/thread visibility and draft-write ownership from that node instead of trusting repeated caller context.
6. Navigate actions are explicitly `expand` or `reference`. Expansion is acyclic decomposition; references may share or revisit accepted supporting context. Non-root actions record their exact source layer.
7. Prior stable nodes and layers may be referenced across turns rather than duplicated. A reference destination is an accepted boundary, not a request to reaccept historical records.
8. Draft records remain distinct from atomically accepted completion closures. Harness-authored programs use explicit stable client keys for every persisted node, edge, layer, and action so a whole-program repair rerun upserts the same current-interaction drafts. An unreachable owned draft layer may be explicitly discarded into terminal stopped history without deleting or cascading state to its nodes, edges, actions, or child layers; artificial navigation is not a valid orphan repair. Accepted layers snapshot their exact node, edge, and action membership so later graph writes cannot rewrite prior output. The only accepted-action mutation is the one-shot leased-invoke transition defined below.
9. An invoke-created user-interaction node may carry one immutable nullable `leased_action_id`, unique when present, plus a private immutable nullable `lease_source_interaction_id`; both are null or both non-null, preserving the exact accepted source/action pair for retries even when a node-owned action is reused. Neighbor reads derive its accepted source node through the leased action without persisting a semantic `GraphEdge`; pre-lease invocations remain unleased and are not backfilled.
10. New layer submissions include complete versioned normalized placement data. Layout integrity is deterministic graph validation; spatial meaning remains model judgment. Legacy accepted layers may lack layout, but reads never infer and persist replacement graph content.
11. A model turn ending is not completion; the root must explicitly submit or stop. Submission validates authored closure, expansion cycles, reference visibility, orphan drafts, layer size, and current-draft layout completeness. For a leased interaction, the same submission transaction also changes the exact accepted source action's `target_layer_id` once from `null` to the accepted result root layer. Its kind remains `invoke`; no `resolveAction` authoring API or resolution table exists.
12. A resolved invoke is project-visible cross-interaction navigation wherever its node-owned action is reused, not an `expand` or `reference` relation. Generic renderer navigation history remains an independent product concern.
13. The selected harness owns model execution and any provider-native child scheduling. GraphComplete does not add a model-call or recursive-agent scheduler. See [ADR 0005](decisions/0005-layered-navigation-contract.md) and [ADR 0006](decisions/0006-harness-provider-agnostic-product-boundary.md).
14. A personal-presentation attachment is a control relation from one interaction to one published accepted profile completion. It never participates in ordinary response topology or graph authority, and one interaction can pin it only once. See [ADR 0009](decisions/0009-personal-presentation-graph-attachments.md).

## Target self-assessing policy invariants

The following apply when the optional recursive self-assessment policy is enabled; they are not prerequisites for the initial direct recursive completion slice.

1. Every scope has one content owner.
2. Every scope is reviewed by a separate self-assess agent.
3. Reviewers search the workspace and do not trust the content owner's claims blindly.
4. A parent judges the coverage and quality it requires from its direct children.
5. Each child owns further decomposition needed within its scope.
6. Concept nodes contain code grounding or connect to descendants that provide it.
7. Existing concepts are connected rather than duplicated when possible.
8. Draft nodes may be visible, but acceptance and unfinished state remain explicit.
9. The graph is terminal only when accepted or stopped with a recorded reason.
10. Budgets limit recursion without converting incomplete work into accepted work.

## Harness-owned model policy

Model selection is a stable product choice resolved against the selected harness's declared provider and model compatibility. Thinking level is a separate choice. Execution must fail clearly when the selected combination is unavailable.

A harness may define an internal multi-model policy for native delegation or review. Codex coordination remains Codex-owned, and Prime Agent may assign different supported models to content ownership, revision, and self-assessment. Those policies belong to their configurations and must not become Relayer product invariants.

## Harness configurations and evaluation

The packaged product `codex-basic` configuration selects the `codex.basic` implementation with layered navigation and Codex-native subagents available when useful. `codex-basic-high` remains a checked-in internal Eval configuration and is not loaded or packaged by Relayer Desktop. Before interrupted-turn recovery, product storage migrates threads formerly pinned to that retired configuration only when the active runtime catalog includes `codex-basic` and omits `codex-basic-high`; Eval catalogs that include both preserve the high configuration. Harness-state schema v6 backs up schema-v4/v5 bytes without guessing the caller's catalog. When Desktop later registers the exact layered `codex-basic` replacement for a revision-1 or revision-2 prior Codex configuration, the host preserves its native provider state and persists the current descriptor; deferred legacy sessions follow the same registration-scoped rule, while Eval high registrations remain unchanged. A named YAML configuration selects an implementation, contains that implementation's settings, declares provider/model compatibility, and supplies bindings for the three product permission profiles. The host treats implementation settings and bindings as opaque. A code-owned implementation map connects implementation types to executable factories without adding implementation-specific fields to product records.

Configuration, implementation code, session state, and live authority are deliberately separate:

1. Files such as `harnesses/codex-basic.yaml` and `harnesses/codex-basic-high.yaml` are durable named configurations, but release inclusion determines which are product-facing. Each has a unique `name`, while `implementation` selects executable code. Many configurations commonly select the same implementation with different settings.
2. The implementation registry maps `codex.basic`, `prime.agent`, or a test implementation to a factory.
3. The host copies the selected configuration onto the thread and persists the implementation's opaque JSON resume state. For `codex.basic`, that state is only the Codex thread ID.
4. The current graph URL, token, and interaction node form a per-call graph scope. They are never factory inputs or harness state. The host closes its in-memory scope when the call settles; the calling runtime that minted the capability owns token revocation.

The packaged `codex.basic` harness uses Relayer's TypeScript Codex app-server client and approval/event bridge with the selected provider access and an explicit managed executable. It keeps one resumable Codex thread per Relayer thread, makes Codex-native subagents available under shared interaction authority, and asks Codex to execute the TypeScript graph client. `claude.basic` loads the matching managed Claude Agent SDK module and supplies its explicit managed executable. Neither harness searches ambient `PATH`. The graph is not returned as structured JSON: harnesses submit objects to the Rust engine, react to repairable validation errors, and end with `graph.submit(interactionNode)`. The optional `prime.agent` implementation uses the same host and graph contracts while owning its own recursive runtime policy.

The default and opt-in live evals start from an empty temporary folder and run two interactions through one cached harness object. Each serialized Complete call receives a distinct graph capability while the harness retains its provider-session identity, and the eval runtime revokes that capability after the call settles. The case owns harness-agnostic graph-contract checks. The Eval application waits for each product interaction to reach a terminal state before starting the next turn. A selected judge configuration may add semantic scoring without changing the case:

1. deterministic graph-contract checks; and
2. a fresh structured Codex judge that scores six declared task-system facts plus graph and detail usefulness.

Project-case presentation judging runs in an immutable, network-disabled artifact
snapshot with read-only shell and filesystem inspection enabled. The judge may use
non-mutating Git, search, and file-reading commands to discover what work matters;
file mutation, graph mutation, invoke execution, and non-review MCP capabilities
remain disabled. The host supplies the original request and may include a compact,
size-bounded receipt of verifier and task-outcome facts as a starting point rather
than a substitute for artifact investigation. Captured production-workspace
screenshots remain the sole evidence for what the graph communicates.

The presentation judge builds a recursive semantic result tree bottom-up. Expansion
actions consume finalized child `LayerResult`s; references reuse results without
starting another recursive pass; invoke and input actions are never executed. At every node,
the judge compares expansion, reference, invoke, input, and stop sequentially, while keeping
allocation quality separate from destination delivery. Each layer preserves aligned
node score and semantic-summary vectors. A parent semantically compresses child
findings and applies qualitative depth decay without a numeric propagation formula.
The final turn judgment consumes the current root `LayerResult`; descendants remain
inspectable evidence and are not arithmetically reaggregated. Explicit critical-
omission ceilings apply to that model-authored root judgment. Judge lifecycle
completion remains independent from both task-outcome qualification and graph-
presentation score, and historical rubric records retain their legacy projection.
The active human-experience rubric judges the accepted output only as a graph-native
interface: it values discoverable inspect-or-act choices and layouts whose edges
and placement communicate real relationships, while penalizing missing obvious
paths, semantically empty geometry, and action spam. Artifact inspection may reveal
useful presentation opportunities, but implementation correctness, verifier results,
and task-outcome contradictions can neither raise nor lower this independent grade.
The rubric does not require media capabilities that the graph contract and renderer
do not yet support. Recursive review contract v6 records basic rendered integrity
as a separate node-level `polish` score. Polish covers clipping, readability,
density, alignment, and control rendering only; it is inspectable in the score
vector and cannot raise or offset semantic, interaction, navigation, layer, turn,
or task-outcome grades. The v11 human-experience rubric requires an independent
reason and screenshot evidence for every scored criterion on its ordered 1-8 scale;
the integers intentionally have no canned meanings. Only action delivery, recursive
quality, and inapplicable follow-up progress may be null; the node criteria require
no assessable destination or expansion child respectively. A material missing action caps affected turn-level
criteria at 6; repeated material omissions or one critical omission cap them at 4.
Input actions are rated from their visible prompt, control, and authored options before
any answer is supplied. The same rubric penalizes asking for facts already present in
the artifact, delegating judgment the response should make, and splitting one decision
into needless per-node questions.
Historical recursive reviews retain their original scale when projected alone and
are proportionally normalized only when a multi-turn grade contains mixed scales.

The Eval application's deterministic graph-contract judge scores only durable graph structure; it does not use phrase matching as a semantic proxy. A separate hierarchical-overview case checks for a useful node-level navigate action so navigation capability is measured without requiring artificial child layers in every answer.
Judge-only calibration reruns reuse the immutable accepted candidate turn, append a
new judgment result, and write each attempt under its own artifact directory so
historical judgments and screenshots are never overwritten.

Deep calibration cases sit behind one manifest-driven fixture module. They form a graph-presentation calibration corpus for recursive-judge tuning and human labels, not the full verifiable-work benchmark. The module owns generated baseline files, immutable source identity, materialization, evaluator-only reference expectations, and lightweight deterministic completion checks through a small materialize/grade interface. Seven coding cases expose behavioral contracts that are red in the seeded workspace. Five noncoding cases begin without curated research content and deterministically check only artifact presence, source-ledger shape, and task-specific consistency; semantic outcome criteria remain partial until scoped review. Completion checks confirm that inspectable work exists but do not qualify its substantive quality. This prevents structural checks from masquerading as implementation, historical, creative, travel, technology, or sports expertise.

The runner input is a test-run ID, selected test-case IDs, selected harness-configuration names, and one judge configuration. At the CLI boundary, configuration names resolve to validated snapshots. The runner expands their Cartesian product into executions identified by `(testRunId, testCaseId, harnessConfigurationName)` and passes each resolved `HarnessConfiguration` into case execution. Every execution artifact stores that exact snapshot and its canonical SHA-256 digest. Two configurations may select the same implementation; that is ordinary run selection, not a harness-specific case or matrix.

The ordinary test suite never invokes inference. `runtime-basic` remains a harness-agnostic lower-level integration case. Its pre-app-server movable-node HTML is intentionally minimal; execution review through the product app-server and shared production graph/chat workspace belongs to the Eval application.

## Runtime package boundaries

- `crates/relayer-graph-core/src/graph.rs` is the graph behavior boundary. `graph/database` and `graph/writer` expose the public control flow, `graph/model` owns the node, edge, layer, action, ID, and state objects, and `graph/completion` separates closure planning from atomic acceptance.
- `crates/relayer-graph-core/src/storage.rs` is the persistence boundary. `SqliteGraphStore` owns the SQLx pool and connection lifecycle, its table-specific modules contain all queries, and `storage/sqlite/migrations` contains both the embedded migration runner and versioned SQL. Graph behavior does not import SQLx. This mirrors the app server's `SqliteProductStore` boundary without introducing a transport API inside graph core.
- `crates/relayer-graph-server` exposes that same core through the loopback API.
- `packages/graph-client` is the typed Node authoring client and contains no graph persistence.
- `packages/harness-host` owns persistent per-thread harness objects and code-owned implementations such as `codex.basic`.
- `packages/eval-runner` owns harness-agnostic case/run expansion, deterministic checks, and the lower-level CLI artifact path. The Relayer Eval shell composes those contracts around the production app server and renderer.
- `python/relayer-graph` is the Python authoring client and contains no graph persistence.

The root `src` directory contains only the canonical GraphComplete boundary and its runtime contract. There is intentionally no TypeScript graph kernel alongside the Rust graph core.

The standalone server keeps only an in-memory map from an opaque graph capability token to one completion identity and its durable capability epoch. It does not cache project/thread authority supplied by the caller. After a server restart, trusted control can remint a token for a persisted active canonical interaction; reminting atomically expires older generations and ordinary harness clients cannot mint. Each request resolves a short-lived `GraphWriter` from that completion-bound identity and epoch, so graph authority is never reconstructed from caller-supplied project/thread values. Terminal model capabilities lose general graph reads and all writes; the exact current generation retains only the accepted-output receipt needed for its supervising harness to settle `complete(inputGraph)`. Trusted control retains product reads and other exact-receipt recovery. `GraphDatabase` is cheaply cloneable because it holds an async SQLx pool; SQLite writes use short `BEGIN IMMEDIATE` transactions while reads remain pooled, and the HTTP server never holds a Rust lock across agent work.

Each completion stores an append-only revision sequence and a compare-and-swap current head. Advance and return validate and publish one owned closure, append the immutable revision and idempotency receipt, move the head, and enqueue its projection event in the same `synchronous=FULL` SQLite transaction. Return additionally establishes the existing accepted completion output; stop and trusted-control failure retain the last current without a final result. Product projection consumers reconnect by outbox sequence and apply pointer-aware follow behavior: only a view still following the prior revision advances automatically, while explicit navigation remains pinned. See [ADR 0008](decisions/0008-temporal-current-and-completion-brokers.md).

Each human-root interaction is serialized on its thread's host queue and receives a new `HarnessRunContext`. Agent-invoked completions receive the same context shape with trusted invocation provenance and remain independently runnable. The context contains `inputGraph` plus a host-owned graph-scope handle; it is not factory input or persistent session state. `codex.basic` may reuse a root Codex thread ID, but session reuse is an adapter optimization rather than the source of GraphComplete context or identity. `prime.agent` passes the run context to `promptAndWait`; a stable `relayer.graph.current` handler returns the matching capability to root or child IPython kernels. The Python kernel calls Rust directly through `GraphSession.current()`. When the call settles, the host closes the handle and the calling runtime revokes the Rust token.

The recursive target keeps `complete(inputGraph)` as one deep module interface. A GraphComplete thread is a graph of completions, not a provider conversation. Product-authored human interactions and agent-authored recursive code enter through trusted origins but receive the same completion handle: one durable current pointer and one result promise. Each call creates or recovers a distinct completion identity and scoped capability. The harness associates each completion with an independently runnable, replaceable provider execution attachment. This separation avoids making provider-session identity a semantic obstacle if mixed-harness routing is designed later; it does not make mixed-harness threads a V1 capability. Current V1 threads still pin one harness configuration. Agent code decides what to invoke, inspect, search, and await; the harness owns no recursive work queue or incorporation policy.

The common harness-configuration envelope optionally declares `complete.agentAuthored`. Absence or `false` fails closed. `true` permits the product to issue completion-broker authority only when the runtime's recursive temporal substrate is also active; the app server and harness host both revalidate that conjunction for roots and invoked children. This is capability authority, not an implementation-specific recursion policy and not a scheduler. Relayer Eval uses this seam for a paired Codex comparison whose two configurations are otherwise execution-equivalent. The shipped Desktop catalog does not opt in.

For `prime.agent`, a prompt settling is not the run boundary. The adapter waits for that Prime session's recursive runtime to become quiescent before returning or releasing graph and provider access. Human-root turns remain serialized around the persistent root session. Each explicit invoked Complete uses a fresh ordinary Prime session, so it can run independently without replacing root continuity or converting Prime's RLM topology into GraphComplete topology. External cancellation targets only the owning session and still waits for quiescence and cleanup; barrier and abort failures remain visible rather than releasing authority early.

Harness factories may initialize asynchronously so provider runtimes such as Prime Agent can open durable sessions before registration completes. The host serializes first construction and Complete calls per thread, forwards cancellation through an `AbortSignal`, aborts active work during shutdown, and disposes every live harness object exactly once.

Product and graph metadata remain in separate SQLite databases, so the app server uses an explicit recoverable handoff rather than pretending they share a transaction. It first creates the durable product interaction and conditionally reserves `submitted`; an input-assisted Send creates the root plus immutable submitted-input attempt before that reservation. It then prepares the canonical graph interaction and stores the graph `NodeId`, frozen configuration/model identity, effective-execution digest, and permission receipt. Only a conditional transition on that exact prepared identity may claim `running` and enter the harness. The graph capability token remains transient runtime memory and is never product data. Product graph reads use control-authenticated read endpoints rather than minting harness writer capabilities.

Terminal provider-execution lease debt is handled by one app-owned reconciliation worker. Startup and later release failures only wake that worker; they never spawn competing retry loops. The worker serially scans durable debt, retries with capped backoff, and returns to an idle notification wait after the debt is clear.

Invoke preparation supplies the accepted source interaction/action pair to graph control. That pair is the graph-side idempotency key, so retrying a lost create response recovers the same leased graph interaction while the product-side invocation record recovers the same result interaction. At startup, bound interrupted invokes are reconciled against canonical graph completion output: an accepted graph finalizes product history using its already persisted execution receipt, while the absence of graph acceptance fails the product result and leaves the leased action unresolved. This closes the graph-accepted/product-uncommitted crash window without a distributed transaction or a second scheduler.

## Optional desktop account boundary

Relayer Desktop remains local-first and fully usable without a Relayer account. The
optional account is a direct Auth0 Native Application session; no Relayer API,
custom session broker, database row, or Relayer user UUID participates in desktop
authentication. The desktop opens the branded
`https://app.relayerlabs.ai/desktop/login` launcher, then exchanges the resulting
Authorization Code with Auth0 using PKCE.

Electron main owns the complete protocol boundary: generation of state and the
PKCE verifier/challenge, binding one registered loopback callback before launching
the browser, exact callback validation, direct token/refresh/revoke requests, OIDC
issuer/audience/signature/expiry validation, rotating refresh-token custody through
Electron `safeStorage`, and the current account generation. Stable uses only ports
49152-49154 and Preview uses only 49155-49157. The saved update-channel selection
chooses the launcher label and callback pool; changing it invalidates an in-flight
login without changing the signed application identity.

The renderer receives only the presentation union `signed-out`, `signing-in`,
`signed-in`, `uncertain`, or `error`, plus the selected channel, a pseudonymous
Auth0 subject where useful, and closed diagnostic reason codes. Authorization
codes, state, verifiers, tokens, Auth0 configuration, email/profile data, and
network authority never cross IPC. Only a currently verified signed-in generation
is eligible to supply a telemetry identity; offline or unverifiable sessions leave
all local features available and pause authenticated telemetry admission. Logout
invalidates that generation and clears encrypted local credentials before best-
effort remote revocation, without signing the browser out. See
[ADR 0008](decisions/0008-direct-auth0-desktop-account.md).

After provider setup, the optional account decision is a dedicated full-screen
onboarding step. The desktop workspace is not revealed until the user signs in or
explicitly continues without an account. Once resolved, a sidebar-footer control
beside Settings starts sign-in directly while signed out and opens Account
settings for an existing account. The Account panel contains only concise status
and the applicable sign-in or logout action. Stable or Preview is not part of the
account UX; callback-pool diagnostics remain main-owned.

## Authenticated desktop error-reporting boundary

Electron main is the only Sentry authority. It owns admission, pseudonymous
identity, event validation, the encrypted retry queue, SDK configuration, release
metadata, and outbound transport. The renderer, Node harness host, Rust app
server, and Rust graph server receive only constrained local reporting
capabilities. Each capability is bound to one account generation and one process
generation. A child restart or account-generation change invalidates the old
capability. No child receives Auth0 material, a DSN, upload credentials, or direct
Sentry network authority. Renderer records cross one private preload IPC channel;
Rust capabilities cross the existing private startup stdin and are removed when
the supervised process exits. No reporting capability is placed in argv or the
environment. The same private stdin carries replacement or null capabilities
after sign-in, account replacement, logout, or restored-account verification;
telemetry rotation never restarts the product process.

Admission requires the current verified Auth0 account generation from the account
service. Electron main derives the stable Sentry user identifier as
`SHA-256("graphcomplete-sentry-user-v1\0" || UTF-8(Auth0 sub))`. The domain
separator prevents reuse as another product identity. The result is stable across
installations for the same Auth0 subject. Renderer presentation state is never an
authority input.

V1 reports only unhandled process crashes, supervised-child startup failures, and
supervised-child unexpected exits. Handled operation failures and expected product
states are excluded. Every adapter emits a closed record with stable component,
operation, and failure codes plus a code-owned message. JavaScript frames are
application-relative, limited to 32, and limited to 256 characters per module
name. Rust frames name only approved workspace crates and modules. Absolute paths,
third-party frames, arbitrary maps, and raw errors are rejected. Module names must
also occur in the checked-in packaged-module inventory, so a caller cannot encode
private data inside a valid-looking application path. The final event is validated
again immediately before transport.

Authenticated transport failures may enter one `safeStorage`-encrypted queue. The
queue holds at most 32 records and 256 KiB of encrypted bytes. Records expire after
seven days. Overflow evicts the oldest record. Any corrupt queue is deleted rather
than repaired or partially uploaded. Retry requires a fresh verification of the
same Auth0 subject. Unsigned, uncertain, expired, revoked, or replaced generations
never create deferred records. Logout or account replacement disables admission
and deletes the old queue before the new presentation state appears. Rejection,
queue failure, and transport failure never report themselves.

Runtime events take immutable candidate and release identity only from sealed
package metadata. Electron main validates the current update channel and supplies
`development`, `preview`, or `stable` as the Sentry environment. Callers cannot
supply either identity. Symbol and source-map upload remains a release-authority
operation and never places upload credentials in application bytes. Preview and
Stable packaging produces a hash-verified telemetry manifest with JavaScript
source maps and native Rust debug artifacts; only the target-matched release CI
step receives the upload token and may publish that manifest. Packaging compares
each mapped source byte with the packaged ASAR or resource byte and correlates each
dSYM UUID or PDB identity with its packaged Rust executable before upload.

The versioned shared privacy corpus is the common contract across all five failure
domains and both repositories. `npm run evidence:telemetry` is the deterministic,
zero-inference local portfolio for admission, privacy, queueing, restart, and
release identity. Live Auth0, packaged protected storage, real system-browser,
artifact upload, and symbolication proof run only for Preview or Stable release
candidates. macOS Apple Silicon, macOS Intel, and Windows x64 evidence is
target-specific. Missing native target evidence remains indeterminate and cannot
be replaced by another platform. See
[ADR 0009](decisions/0009-authenticated-desktop-error-reporting.md).

## Desktop release boundary

Relayer Desktop owns its packaging, signing, notarization, update channels, and product-facing update lifecycle independently of any selected harness, provider, or GraphComplete execution. The production desktop identity is `ai.relayer.desktop`; unsigned development packages use `ai.relayer.desktop.development`. Signed candidates target Apple Silicon and Intel macOS 13.3 or newer plus Windows x64 and begin at version `0.2.0`.

Optional packaged harnesses are admitted through an exact runtime contract rather
than filesystem discovery. Prime Agent is installed from four checked-in,
content-addressed archives built reproducibly from the commit recorded in its
manifest. The packaged desktop carries only the Basic and Deep production
configurations plus the trusted Python graph client. Startup verifies the
manifest identity, installed package versions, required run-scope APIs,
recursive-quiescence barrier, configurations, and Python assets before adding
either Prime configuration to the catalog. Failure leaves the Codex and Claude
configurations available and records a local diagnostic; explicitly requesting
an unavailable Prime default fails closed before the product runtime starts.
The product catalog retains unavailable Prime entries and their stable reason for
diagnostics and validation, while ordinary Harness Settings, executable
configuration lookup, onboarding, and the composer exclude them. Harness Settings
uses the backend's exact provider, model, family, and access-contract projection
rather than treating runtime installation as current feasibility. The diagnostic
and execution trace contain only the reviewed source commit and package name/version
pairs. Current bounded Ask and
Auto support is macOS-only, so a Windows build never advertises Prime as runnable.

The macOS-arm64 Prime prototype is exact recipe `prime@0.8.1`. A connection,
reconnect, explicit repair, or recipe-update trigger downloads hash- and
size-bound uv, CPython, and wheels, then invokes pinned uv by absolute path with
configuration, index, dependency resolution, network, and source-build paths
disabled. The recipe seals distinct repository and packaged JavaScript closure
digests, and each assembly path accepts only its own byte layout. Assembly verifies and copies the packaged JavaScript closure, Prime
Python runtime, all 12 Python-backed skills, and `relayer_graph`. The ready
module URL, isolated Python launcher, and receipt-owned private state root enter
the Prime harness factory. Prime uses explicit agent and session directories
there and never consults `~/.prime`; user execution never prepares or
synchronizes. A provider-free real-kernel probe
imports all 14 first-party modules, evaluates a deterministic expression, and
shuts down before availability is published. Failure is sanitized and does not
affect Codex or Claude. `npm run test:prime-managed-runtime` owns the clean-root
checkpoint. Signed release proof, updater publication (#378), and downloadable
JavaScript reconstruction (#379) remain separate.

On restart, an unchanged configuration may recover a previously ready route
only after cheap local validation of its exact managed receipt, owned real
state directory, installation marker, and entrypoints whose resolved targets
remain inside that exact installation. A recovered ready boolean starts a new
process-local readiness ordering epoch. Startup does not download, prepare,
invoke a readiness probe, or contact a provider. A digest mismatch or corrupt
local descriptor keeps the harness unavailable and records a sanitized error.

Release configuration resolves through one fail-closed contract. The contract seals the numeric version, source commit, product identity, target, architecture, signing authority, channel manifest, and exact HTTPS update base into both the application package and its release receipt. macOS targets additionally seal the Apple team and minimum OS; Windows seals the Artifact Signing endpoint, account, profile, and publisher. The updater and publisher consume this contract rather than maintaining parallel identity or channel rules. See [ADR 0002](decisions/0002-desktop-release-contract.md).

Preview publication is a separate Linux job after the signed target matrix settles. It is reachable only from a version-matching `desktop-vX.Y.Z` tag and a protected GitHub environment using short-lived AWS OIDC credentials. Each successful target publishes through its own job, so a failed or disabled target cannot block another. The publisher revalidates target-specific candidate provenance, checksums, blockmaps, and feed metadata; writes immutable release/history objects; verifies the public CDN bytes; and changes the applicable Preview pointer last with an S3 precondition. Manual candidate builds cannot publish. Windows candidate execution is temporarily disabled until its publisher identity is configured. Windows publication remains excluded until Azure signing succeeds. Stable additionally requires the interactive updater canary.

Stable promotion is a separate protected workflow on `main`. It requires committed screenshot-backed evidence that an older Preview installation discovered, installed, and relaunched into the exact candidate. The promoter revalidates the immutable Preview receipt and all hosted bytes, rejects non-increasing versions, writes immutable Stable history, and conditionally changes `latest-mac.yml` without rebuilding or re-signing. A retry can only recover the same byte-identical promotion. At this stage, release recovery means withdrawing a bad feed pointer before installation or issuing a forward-fix version; automatic application downgrades and local-data migration recovery are not updater responsibilities.
