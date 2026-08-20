# Architecture

## Ownership boundary

Prime Agent is the execution runtime. GraphComplete is the graph algorithm. Relayer is one product host.

```text
Product host
    -> complete(interaction-node pointer)
        -> persistent Node host resolves the thread's selected harness object
        -> selected harness implementation
            -> Prime Agent root content owner (production target)
                -> child content owners
                -> independent self-assess reviewers
                -> targeted revisers
            -> or basic Codex reference harness (first eval)
        -> graph.submit(interaction node)
        -> accepted resolved root layer or explicit failure
    -> product persistence and activation
```

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

For every product interaction, the app server durably creates the product interaction and marks it running before acknowledging the write. It then creates the canonical user-interaction graph node with product project/thread provenance, supplies that graph capability only to the matching `complete()` call, awaits explicit graph submission in background work owned by the app-server process, and persists the accepted output or explicit failure on the product interaction. This lets every product host display the thread and waiting state immediately while polling the same product record to terminal state. Product and graph writes remain separate SQLite transactions; the stored graph node ID is the durable join between them.

## Product permission profiles

Rust product policy defines exactly `ask`, `auto`, and `full`, including their labels, enabled state, default, and authority semantics. A thread pins one profile and one named harness configuration before inference. Each harness configuration carries implementation-specific bindings for the supported profile IDs, while product APIs and Eval cases exchange only the stable IDs. Accepted interactions persist a combined effective-execution digest and normalized permission receipt alongside the harness digest. Full-access receipts disclose that the process was not hard-confined from the host filesystem or network. See [ADR 0004](decisions/0004-product-permission-profiles.md).

The desktop New Thread composer loads profile labels, availability, and the default from the Rust product API. It sends only the selected stable ID during ordinary thread creation and displays the pinned profile on saved threads. Unavailable profiles remain visible but disabled; provider-specific bindings never enter the renderer contract.

## Shared product and Eval workspace

Relayer and Relayer Eval are separate Electron build targets. Relayer exposes the ordinary product window and a fixed production harness configuration. Relayer Eval exposes a test-run dashboard and enables named harness overrides, but executes each case through the same product app server. A case may create one or more ordinary product threads and interactions.

Opening one case × harness execution creates a separate review window using the exact production renderer and `ProductWorkspace` component. The review preload supplies only Eval navigation context: the run's cases and product thread IDs for the selected harness. Product graph reads, accepted-layer navigation, turn navigation, layout, and node inspection remain owned by the ordinary product API and workspace. The same app server issues the review window a read-only session capability and rejects writes at the API boundary; workspace review mode also removes composition and mutating controls. See [ADR 0003](decisions/0003-shared-product-eval-workspace.md).

Each product or Eval review window owns one bounded renderer-side navigation history for thread, turn, authored layer path, and remembered node selection. Restoration resolves accepted product data before committing the presentation and cursor together. Eval's judge history command delegates to this controller; the Eval main process records and validates the result but does not own a second stack. Hierarchy breadcrumbs and direct chronological turn controls remain separate presentations of layer ancestry and durable interaction order.

## Base graph-completion invariants

1. Product hosts own project and thread records. Graph core stores their positive-integer IDs only as graph-record provenance; it does not create parallel project or thread objects.
2. Accepted graph records are visible to every thread with the same project ID. A standalone thread has no project ID and can see only records carrying its own thread ID.
3. A turn is centered on one canonical user-interaction graph node. Its `NodeId` is the interaction identity; there is no separate interaction-graph record.
4. Harnesses inspect and mutate graph state only through the typed graph clients and loopback Rust API.
5. Every capability maps to one canonical interaction `NodeId`. `GraphDatabase::writer_for_subgraph(node_id)` derives project/thread visibility and draft-write ownership from that node instead of trusting repeated caller context.
6. Navigate actions are explicitly `expand` or `reference`. Expansion is acyclic decomposition; references may share or revisit accepted supporting context. Non-root actions record their exact source layer.
7. Prior stable nodes and layers may be referenced across turns rather than duplicated. A reference destination is an accepted boundary, not a request to reaccept historical records.
8. Draft records remain distinct from atomically accepted completion closures. Accepted layers snapshot their exact node, edge, and action membership so later graph writes cannot rewrite prior output.
9. A model turn ending is not completion; the root must explicitly submit or stop. Submission validates authored closure, expansion cycles, reference visibility, orphan drafts, and layer size.
10. Prime Agent owns recursive execution; GraphComplete does not add another scheduler. See [ADR 0005](decisions/0005-layered-navigation-contract.md).

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

## Model policy

The initial policy is configurable rather than hard-coded:

- Luna: primary orchestrator and ordinary content ownership.
- Terra: difficult revisions and upgrades.
- Sol: independent self-assessment.

Model and thinking level are separate choices. The runtime must fail clearly when the requested model or effort cannot be provided.

## Basic Codex reference harness and eval

`codex.basic` proves the harness boundary before the production Prime Agent policy is implemented. A named YAML configuration selects the `codex.basic` implementation, contains that implementation's settings, and supplies its bindings for the three product permission profiles. The host treats settings and bindings as opaque; the selected implementation validates and interprets them. A code-owned implementation map still connects implementation types to executable factories, so adding a Prime Agent configuration does not require adding Prime Agent-specific fields to the host.

Configuration, implementation code, session state, and live authority are deliberately separate:

1. Files such as `harnesses/codex-basic.yaml` and `harnesses/codex-basic-high.yaml` are durable production configurations. Each has a unique `name`, while `implementation` selects executable code. Many configurations commonly select the same implementation with different settings.
2. The implementation registry maps `codex.basic`, `prime.agent`, or a test implementation to a factory.
3. The host copies the selected configuration onto the thread and persists the implementation's opaque JSON resume state. For `codex.basic`, that state is only the Codex thread ID.
4. The current graph URL, token, and interaction node form a per-call graph scope. They are never factory inputs or harness state. The host closes its in-memory scope when the call settles; the calling runtime that minted the capability owns token revocation.

The reference harness uses the TypeScript Codex SDK with the existing local Codex login. It keeps one resumable Codex thread per Relayer thread and asks Codex to execute the TypeScript graph client. The graph is not returned as structured JSON: Codex submits objects to the Rust engine, reacts to repairable validation errors, and ends with `graph.submit(interactionNode)`.

The default and opt-in live evals start from an empty temporary folder and run two interactions through one cached harness object. Each serialized Complete call receives a distinct graph capability while the harness retains its provider-session identity, and the eval runtime revokes that capability after the call settles. The case owns harness-agnostic graph-contract checks. The Eval application waits for each product interaction to reach a terminal state before starting the next turn. A selected judge configuration may add semantic scoring without changing the case:

1. deterministic graph-contract checks; and
2. a fresh structured Codex judge that scores six declared task-system facts plus graph and detail usefulness.

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

Harness factories may initialize asynchronously so provider runtimes such as Prime Agent can open durable sessions before registration completes. The host serializes first construction and Complete calls per thread, forwards cancellation through an `AbortSignal`, aborts active work during shutdown, and disposes every live harness object exactly once.

This runtime slice does not make product metadata writes and graph writes share one SQLite transaction. The desktop app-server slice remains independently mergeable with provisional product interaction chronology. A later integration change will pass real product IDs into graph core, store the returned canonical `NodeId` as the product interaction identity, and decide the shared transaction boundary without adding a duplicate interaction node.

## Desktop release boundary

Relayer Desktop owns its packaging, signing, notarization, update channels, and product-facing update lifecycle independently of Prime Agent and GraphComplete execution. The production desktop identity is `ai.relayer.desktop`; unsigned development packages use `ai.relayer.desktop.development`. Signed candidates target Apple Silicon and Intel macOS 13 or newer plus Windows x64 and begin at version `0.2.0`.

Release configuration resolves through one fail-closed contract. The contract seals the numeric version, source commit, product identity, target, architecture, signing authority, channel manifest, and exact HTTPS update base into both the application package and its release receipt. macOS targets additionally seal the Apple team and minimum OS; Windows seals the Artifact Signing endpoint, account, profile, and publisher. The updater and publisher consume this contract rather than maintaining parallel identity or channel rules. See [ADR 0002](decisions/0002-desktop-release-contract.md).

Preview publication is a separate Linux job after the signed target matrix settles. It is reachable only from a version-matching `desktop-vX.Y.Z` tag and a protected GitHub environment using short-lived AWS OIDC credentials. Each successful target publishes through its own job, so a failed or disabled target cannot block another. The publisher revalidates target-specific candidate provenance, checksums, blockmaps, and feed metadata; writes immutable release/history objects; verifies the public CDN bytes; and changes the applicable Preview pointer last with an S3 precondition. Manual candidate builds cannot publish. Windows candidate execution is temporarily disabled until its publisher identity is configured. Windows publication remains excluded until Azure signing succeeds. Stable additionally requires the interactive updater canary.

Stable promotion is a separate protected workflow on `main`. It requires committed screenshot-backed evidence that an older Preview installation discovered, installed, and relaunched into the exact candidate. The promoter revalidates the immutable Preview receipt and all hosted bytes, rejects non-increasing versions, writes immutable Stable history, and conditionally changes `latest-mac.yml` without rebuilding or re-signing. A retry can only recover the same byte-identical promotion. At this stage, release recovery means withdrawing a bad feed pointer before installation or issuing a forward-fix version; automatic application downgrades and local-data migration recovery are not updater responsibilities.
