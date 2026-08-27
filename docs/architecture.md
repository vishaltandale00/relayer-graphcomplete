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
            -> or Prime Agent-owned recursive delegation
        -> graph.submit(interaction node)
        -> accepted resolved root layer or explicit failure
    -> product persistence and activation
```

Product records pin stable provider, model, harness-configuration, and permission identifiers. Harness implementations and provider adapters translate those selections into runtime-specific credentials, sessions, and model calls. Prime Agent alone owns recursive delegation. Supporting a new implementation requires an explicit adapter; agnostic does not mean arbitrary runtimes work without integration.

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

The app server holds graph control authority because it creates interactions and owns capability revocation. The harness host receives a distinct credential for its own loopback API plus only the per-call graph capability it translates into the selected harness. It never receives the graph control token.

Within the app-server crate, each layer has one concrete responsibility:

- `app_server.rs` composes the server and owns its startup boundary.
- `api.rs` and `api/` own HTTP authentication, routes, request/response shapes, and product-error mapping.
- `product.rs` and `product/` own typed identifiers, product records, validation, and use-case orchestration.
- `storage.rs` and `storage/sqlite/` own SQL, transactions, connection policy, and schema migration.

SQLite migrations are storage implementation details. `SqliteProductStore::open` requires any existing product tables to carry Relayer's SQLx migration history, applies the embedded versioned files under `storage/sqlite/migrations/`, and validates the exact resulting schema and row invariants before the store becomes available. This permits a recognized predecessor to migrate while an unmanaged, incompatible, partially initialized, or corrupt schema fails startup. Electron, the HTTP API, and the product service neither run nor interpret migrations. The storage pool is asynchronous, bounded, configured for foreign keys and WAL, and is not guarded by a process-wide blocking mutex. Composite product-state and thread-detail reads use SQLite snapshot transactions so each API response is internally consistent. Operations that allocate per-thread interaction sequence numbers acquire an immediate SQLite transaction before assigning their timestamp or sequence, so concurrent requests cannot select the same next sequence or move a thread's chronology backward.

For every product interaction, the app server durably creates the product interaction and atomically reserves its `submitted` preparation state before graph control. It then creates the canonical user-interaction graph node with product project/thread provenance, stores that node plus the frozen execution identity, claims `running`, and only then supplies the transient graph capability to the matching `complete()` call. Explicit graph submission runs in background work owned by the app-server process, which persists accepted output or explicit failure on the product interaction. This lets every product host display the thread and waiting state while polling the same product record to terminal state. Product and graph writes remain separate SQLite transactions; the stored graph node ID is the durable join between them.

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

Threads pin a harness-configuration identity, not an immutable copy of catalog or family state. Unsent turns resolve lazily against current semantic revisions when the picker opens or Send is pressed. A still-valid exact selection is preserved; an invalid selection may move only within its current family. The product never selects another family implicitly. Once an attempt is sent, its provider/model identity cannot change or fall back mid-flight.

Provider removal uses atomic admission and draining. Marking a definition `removal_pending` immediately blocks new attempts through it while already admitted work finishes. Credential deletion and the non-secret historical tombstone occur only after the last execution reference is released. Family deletion needs no drain because a sent attempt no longer consults family membership.

Every execution attempt has an immutable receipt and a durable effect boundary: `none`, `partial_output`, `graph_write`, `tool_effect`, or fail-closed `unknown`. In this initial release, every model-related failure returns the same interaction to an editable unsent state, including failures after partial output, graph writes, tool effects, or an unknown boundary. This deliberately accepts duplicate-effect risk: the user must explicitly send the restored draft, durable graph writes remain authoritative, and only the product binding and transient execution capability state are cleared. Pre-execution model failures also persist the exact provider, model, family, and harness-policy snapshot available at failure time; adapter implementation version `0` records that provider admission did not complete. Non-model failures remain failed and inspectable. Trace events conservatively raise the boundary for streamed output and tool starts, observable graph neighbors raise it for graph writes, and an accepted graph discovered while recovering a harness failure is adopted without rerunning the harness. Attempt finalization and the matching interaction transition commit in one SQLite transaction, while startup converts any genuinely interrupted running attempt to terminal `unknown` and reconciles graph-authoritative acceptance first. Issue #158 may later replace this accepted duplicate-risk behavior with effect-aware replay protection; no restore mechanism is implied here.

This contract applies equally to `codex.basic`, `prime.agent`, and future harness implementations. It adds no scheduler and does not change `complete(inputGraph)` or graph acceptance authority.

## Shared product and Eval workspace

Relayer and Relayer Eval are separate Electron build targets. Relayer exposes the ordinary product window and lets each new thread pin an available catalog configuration. Relayer Eval exposes a test-run dashboard and selects named configurations for its matrix, but executes each case through the same product app server. A case may create one or more ordinary product threads and interactions.

Opening one case × harness execution creates a separate review window using the exact production renderer and `ProductWorkspace` component. The review preload supplies only Eval navigation context: the run's cases and product thread IDs for the selected harness. Product graph reads, accepted-layer navigation, turn navigation, layout, and node inspection remain owned by the ordinary product API and workspace. The same app server issues the review window a read-only session capability and rejects writes at the API boundary; workspace review mode also removes composition and mutating controls. See [ADR 0003](decisions/0003-shared-product-eval-workspace.md).

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
13. The selected harness owns model execution. Prime Agent owns recursive child scheduling. GraphComplete does not add a model-call or recursive-agent scheduler. See [ADR 0005](decisions/0005-layered-navigation-contract.md) and [ADR 0006](decisions/0006-harness-provider-agnostic-product-boundary.md).

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

Prime Agent may define an internal multi-model policy for delegation or review. It may assign different supported models to content ownership, revision, and self-assessment. That policy belongs to its configuration and must not become a Relayer product invariant. Other harnesses execute directly under the current accepted boundary.

## Harness configurations and evaluation

The packaged `codex-basic` and `codex-basic-high` configurations currently select the `codex.basic` implementation. A named YAML configuration selects an implementation, contains that implementation's settings, declares provider/model compatibility, and supplies bindings for the three product permission profiles. The host treats implementation settings and bindings as opaque. A code-owned implementation map connects implementation types to executable factories without adding implementation-specific fields to product records.

Configuration, implementation code, session state, and live authority are deliberately separate:

1. Files such as `harnesses/codex-basic.yaml` and `harnesses/codex-basic-high.yaml` are durable production configurations. Each has a unique `name`, while `implementation` selects executable code. Many configurations commonly select the same implementation with different settings.
2. The implementation registry maps `codex.basic`, `prime.agent`, or a test implementation to a factory.
3. The host copies the selected configuration onto the thread and persists the implementation's opaque JSON resume state. For `codex.basic`, that state is only the Codex thread ID.
4. The current graph URL, token, and interaction node form a per-call graph scope. They are never factory inputs or harness state. The host closes its in-memory scope when the call settles; the calling runtime that minted the capability owns token revocation.

The current packaged harness uses the TypeScript Codex SDK with the existing local Codex login. It keeps one resumable Codex thread per Relayer thread and asks Codex to execute the TypeScript graph client. The graph is not returned as structured JSON: Codex submits objects to the Rust engine, reacts to repairable validation errors, and ends with `graph.submit(interactionNode)`. The development-only `prime.agent` implementation uses the same host and graph contracts while owning its own recursive runtime policy.

The default and opt-in live evals start from an empty temporary folder and run two interactions through one cached harness object. Each serialized Complete call receives a distinct graph capability while the harness retains its provider-session identity, and the eval runtime revokes that capability after the call settles. The case owns harness-agnostic graph-contract checks. The Eval application waits for each product interaction to reach a terminal state before starting the next turn. A selected judge configuration may add semantic scoring without changing the case:

1. deterministic graph-contract checks; and
2. a fresh structured Codex judge that scores six declared task-system facts plus graph and detail usefulness.

Project-case presentation judging runs in a read-only, network-disabled workspace
with shell, filesystem, and non-review MCP capabilities disabled. The host supplies
the original request plus a size-bounded packet of verifier and task-outcome facts;
candidate workspace paths and source access are not judge capabilities. Artifact
evidence establishes what work matters, while captured production-workspace
screenshots are the sole evidence for what the graph communicates.

The presentation judge builds a recursive semantic result tree bottom-up. Expansion
actions consume finalized child `LayerResult`s; references reuse results without
starting another recursive pass; invoke actions are never executed. At every node,
the judge compares expansion, reference, invoke, and stop sequentially, while keeping
allocation quality separate from destination delivery. Each layer preserves aligned
node score and semantic-summary vectors. A parent semantically compresses child
findings and applies qualitative depth decay without a numeric propagation formula.
The final turn judgment consumes the current root `LayerResult`; descendants remain
inspectable evidence and are not arithmetically reaggregated. Explicit critical-
omission ceilings apply to that model-authored root judgment. Judge lifecycle
completion remains independent from both task-outcome qualification and graph-
presentation score, and historical rubric records retain their legacy projection.

The Eval application's deterministic graph-contract judge scores only durable graph structure; it does not use phrase matching as a semantic proxy. A separate hierarchical-overview case checks for a useful node-level navigate action so navigation capability is measured without requiring artificial child layers in every answer.

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

The standalone server keeps only an in-memory map from opaque graph capability token to root `NodeId`. It does not cache project/thread authority supplied by the caller. After a server restart, the trusted control authority can remint a token for a persisted canonical interaction node; ordinary harness clients cannot. Each request resolves a short-lived `GraphWriter` from the persisted node, so graph authority is never reconstructed from caller-supplied project/thread values. `GraphDatabase` is cheaply cloneable because it holds an async SQLx pool; SQLite writes use short `BEGIN IMMEDIATE` transactions while reads remain pooled, and the HTTP server never holds a Rust lock across agent work.

Each interaction is serialized on its thread's host queue and receives a new `HarnessRunContext`. The context contains `inputGraph` plus a host-owned graph-scope handle; it is not factory input or persistent session state. `codex.basic` acquires the current capability to configure its lightweight SDK execution wrapper while resuming the same Codex thread ID. `prime.agent` passes the run context to `promptAndWait`; a stable `relayer.graph.current` handler returns the matching capability to root or child IPython kernels. The Python kernel calls Rust directly through `GraphSession.current()`. When the call settles, the host closes the handle and the calling runtime revokes the Rust token.

For `prime.agent`, a root prompt settling is not the run boundary. The adapter waits for Prime's recursive runtime to become quiescent before returning or releasing graph and provider access. HarnessHost serializes each thread, so every prior completion reaches this barrier before the next interaction can use the persistent session. External cancellation starts Prime abort and still waits for quiescence and cleanup; barrier and abort failures remain visible rather than releasing authority early.

Harness factories may initialize asynchronously so provider runtimes such as Prime Agent can open durable sessions before registration completes. The host serializes first construction and Complete calls per thread, forwards cancellation through an `AbortSignal`, aborts active work during shutdown, and disposes every live harness object exactly once.

Product and graph metadata remain in separate SQLite databases, so the app server uses an explicit recoverable handoff rather than pretending they share a transaction. It first creates the durable product interaction, conditionally reserves `submitted`, prepares the canonical graph interaction, and stores the graph `NodeId`, frozen configuration/model identity, effective-execution digest, and permission receipt. Only a conditional transition on that exact prepared identity may claim `running` and enter the harness. The graph capability token remains transient runtime memory and is never product data. Product graph reads use control-authenticated read endpoints rather than minting harness writer capabilities.

Terminal provider-execution lease debt is handled by one app-owned reconciliation worker. Startup and later release failures only wake that worker; they never spawn competing retry loops. The worker serially scans durable debt, retries with capped backoff, and returns to an idle notification wait after the debt is clear.

Invoke preparation supplies the accepted source interaction/action pair to graph control. That pair is the graph-side idempotency key, so retrying a lost create response recovers the same leased graph interaction while the product-side invocation record recovers the same result interaction. At startup, bound interrupted invokes are reconciled against canonical graph completion output: an accepted graph finalizes product history using its already persisted execution receipt, while the absence of graph acceptance fails the product result and leaves the leased action unresolved. This closes the graph-accepted/product-uncommitted crash window without a distributed transaction or a second scheduler.

## Desktop release boundary

Relayer Desktop owns its packaging, signing, notarization, update channels, and product-facing update lifecycle independently of any selected harness, provider, or GraphComplete execution. The production desktop identity is `ai.relayer.desktop`; unsigned development packages use `ai.relayer.desktop.development`. Signed candidates target Apple Silicon and Intel macOS 13 or newer plus Windows x64 and begin at version `0.2.0`.

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
Harness Settings, while executable configuration lookup, onboarding, and the
composer exclude them. The diagnostic and execution trace contain only the
reviewed source commit and package name/version pairs. Current bounded Ask and
Auto support is macOS-only, so a Windows build never advertises Prime as runnable.

Release configuration resolves through one fail-closed contract. The contract seals the numeric version, source commit, product identity, target, architecture, signing authority, channel manifest, and exact HTTPS update base into both the application package and its release receipt. macOS targets additionally seal the Apple team and minimum OS; Windows seals the Artifact Signing endpoint, account, profile, and publisher. The updater and publisher consume this contract rather than maintaining parallel identity or channel rules. See [ADR 0002](decisions/0002-desktop-release-contract.md).

Preview publication is a separate Linux job after the signed target matrix settles. It is reachable only from a version-matching `desktop-vX.Y.Z` tag and a protected GitHub environment using short-lived AWS OIDC credentials. Each successful target publishes through its own job, so a failed or disabled target cannot block another. The publisher revalidates target-specific candidate provenance, checksums, blockmaps, and feed metadata; writes immutable release/history objects; verifies the public CDN bytes; and changes the applicable Preview pointer last with an S3 precondition. Manual candidate builds cannot publish. Windows candidate execution is temporarily disabled until its publisher identity is configured. Windows publication remains excluded until Azure signing succeeds. Stable additionally requires the interactive updater canary.

Stable promotion is a separate protected workflow on `main`. It requires committed screenshot-backed evidence that an older Preview installation discovered, installed, and relaunched into the exact candidate. The promoter revalidates the immutable Preview receipt and all hosted bytes, rejects non-increasing versions, writes immutable Stable history, and conditionally changes `latest-mac.yml` without rebuilding or re-signing. A retry can only recover the same byte-identical promotion. At this stage, release recovery means withdrawing a bad feed pointer before installation or issuing a forward-fix version; automatic application downgrades and local-data migration recovery are not updater responsibilities.
