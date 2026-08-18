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
    -> Rust Relayer app server
        -> HTTP API
            -> product service
                -> SQLite product storage
        -> desktop renderer files
```

Electron owns native windows, provider setup, updates, and the Rust child-process lifecycle. One Electron main process owns each desktop profile; a later application launch exits after asking the primary process to restore and focus its window. The primary process keeps product data inside a permission-restricted app directory, sends the per-launch control token through the Rust child's standard input, and keeps that pipe open as the ownership signal; the Rust server shuts down on pipe EOF if Electron exits or crashes, as well as on the normal termination signals. The Rust app server owns durable project, thread, and product interaction chronology records and serves the renderer over a random loopback port. The renderer uses the app server as its product API. Product state does not project those chronology records into graph nodes.

Within the app-server crate, each layer has one concrete responsibility:

- `app_server.rs` composes the server and owns its startup boundary.
- `api.rs` and `api/` own HTTP authentication, routes, request/response shapes, and product-error mapping.
- `product.rs` and `product/` own typed identifiers, product records, validation, and use-case orchestration.
- `storage.rs` and `storage/sqlite/` own SQL, transactions, connection policy, and schema migration.

SQLite migrations are storage implementation details. `SqliteProductStore::open` requires any existing product tables to carry Relayer's SQLx migration history, applies the embedded versioned files under `storage/sqlite/migrations/`, and validates the exact resulting schema and row invariants before the store becomes available. This permits a recognized predecessor to migrate while an unmanaged, incompatible, partially initialized, or corrupt schema fails startup. Electron, the HTTP API, and the product service neither run nor interpret migrations. The storage pool is asynchronous, bounded, configured for foreign keys and WAL, and is not guarded by a process-wide blocking mutex. Composite product-state and thread-detail reads use SQLite snapshot transactions so each API response is internally consistent. Operations that allocate per-thread interaction sequence numbers acquire an immediate SQLite transaction before assigning their timestamp or sequence, so concurrent requests cannot select the same next sequence or move a thread's chronology backward.

This path deliberately ends before graph or harness execution. Those capabilities are reported as unavailable until their product contracts are integrated. A later integration will let graph core create the canonical user-interaction node with the product interaction's positive integer ID in the app server's SQLite transaction; PR #4 does not depend on that graph operation.

## Base graph-completion invariants

1. Product hosts own project and thread records. Graph core stores their positive-integer IDs only as graph-record provenance; it does not create parallel project or thread objects.
2. Accepted graph records are visible to every thread with the same project ID. A standalone thread has no project ID and can see only records carrying its own thread ID.
3. A turn is centered on one canonical user-interaction graph node. Its `NodeId` is the interaction identity; there is no separate interaction-graph record.
4. Harnesses inspect and mutate graph state only through the typed graph clients and loopback Rust API.
5. Every capability maps to one canonical interaction `NodeId`. `GraphDatabase::writer_for_subgraph(node_id)` derives project/thread visibility and draft-write ownership from that node instead of trusting repeated caller context.
6. Prior stable nodes may be referenced across turns rather than duplicated.
7. Draft records remain distinct from atomically accepted completion closures. Accepted layers snapshot their exact node, edge, and action membership so later graph writes cannot rewrite prior output.
8. A model turn ending is not completion; the root must explicitly submit or stop.
9. Prime Agent owns recursive execution; GraphComplete does not add another scheduler.

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

`codex.basic` proves the harness boundary before the production Prime Agent policy is implemented. The string key resolves through a code-owned implementation map; selector UI, prompt ablations, and generalized capability configuration are deferred.

The reference harness uses the TypeScript Codex SDK with the existing local Codex login. It keeps one resumable Codex thread per Relayer thread and asks Codex to execute the TypeScript graph client. The graph is not returned as structured JSON: Codex submits objects to the Rust engine, reacts to repairable validation errors, and ends with `graph.submit(interactionNode)`.

The default and opt-in live evals start from an empty temporary folder and run two interactions through one cached harness object. Each interaction receives a distinct graph capability; the host rotates that capability between serialized Complete calls while the harness retains its provider-session identity. The live path applies two gates to each turn:

1. deterministic graph-contract checks; and
2. a fresh structured Codex judge that scores six declared task-system facts plus graph and detail usefulness.

The ordinary test suite never invokes inference. The pre-app-server slice saves a movable-node HTML result; replay inside the product is a later app-server acceptance requirement.

## Runtime package boundaries

- `crates/relayer-graph-core/src/graph.rs` is the graph behavior boundary. `graph/database` and `graph/writer` expose the public control flow, `graph/model` owns the node, edge, layer, action, ID, and state objects, and `graph/completion` separates closure planning from atomic acceptance.
- `crates/relayer-graph-core/src/storage.rs` is the persistence boundary. `SqliteGraphStore` owns the SQLx pool and connection lifecycle, its table-specific modules contain all queries, and `storage/sqlite/migrations` contains both the embedded migration runner and versioned SQL. Graph behavior does not import SQLx. This mirrors the app server's `SqliteProductStore` boundary without introducing a transport API inside graph core.
- `crates/relayer-graph-server` exposes that same core through the loopback API.
- `packages/graph-client` is the typed Node authoring client and contains no graph persistence.
- `packages/harness-host` owns persistent per-thread harness objects and code-owned implementations such as `codex.basic`.
- `packages/eval-runner` starts the real graph server and harness host, evaluates accepted output, and writes replayable artifacts.
- `python/relayer-graph` is the Python authoring client and contains no graph persistence.

The root `src` directory contains only the canonical GraphComplete boundary and its runtime contract. There is intentionally no TypeScript graph kernel alongside the Rust graph core.

The standalone server keeps only an in-memory map from opaque graph capability token to root `NodeId`. It does not cache project/thread authority supplied by the caller. After a server restart, the trusted control authority can remint a token for a persisted canonical interaction node; ordinary harness clients cannot. Each request resolves a short-lived `GraphWriter` from the persisted node, so graph authority is never reconstructed from caller-supplied project/thread values. `GraphDatabase` is cheaply cloneable because it holds an async SQLx pool; SQLite writes use short `BEGIN IMMEDIATE` transactions while reads remain pooled, and the HTTP server never holds a Rust lock across agent work.

Registering a newer interaction for an existing thread is serialized on that thread's host queue. The live harness object receives the replacement capability, but the host persists only the thread binding and the harness implementation's versioned resumable state. Graph URLs, tokens, and interaction-node capabilities remain live runtime authority and never enter the harness state file. After a host or graph-server restart, trusted control code must remint and register a fresh capability before the host recreates the harness object. `codex.basic` then rebuilds its lightweight SDK execution wrapper with the fresh URL, token, and node ID while resuming the same persisted Codex thread ID; it does not start a new provider conversation.

Harness factories may initialize asynchronously so provider runtimes such as Prime Agent can open durable sessions before registration completes. The host serializes both first construction and capability rotation per thread, forwards cancellation through an `AbortSignal`, aborts active work during shutdown, and disposes every live harness object exactly once.

This runtime slice does not make product metadata writes and graph writes share one SQLite transaction. The desktop app-server slice remains independently mergeable with provisional product interaction chronology. A later integration change will pass real product IDs into graph core, store the returned canonical `NodeId` as the product interaction identity, and decide the shared transaction boundary without adding a duplicate interaction node.

## Desktop release boundary

Relayer Desktop owns its packaging, signing, notarization, update channels, and product-facing update lifecycle independently of Prime Agent and GraphComplete execution. The production desktop identity is `ai.relayer.desktop`; unsigned development packages use `ai.relayer.desktop.development`. Signed candidates are Apple Silicon builds for macOS 13 or newer and begin at version `0.2.0`.

Release configuration resolves through one fail-closed contract. The contract seals the numeric version, source commit, product identity, Apple team, architecture, minimum macOS version, channel manifest, and exact HTTPS update base into both the application package and its release receipt. The updater and publisher consume this contract rather than maintaining parallel identity or channel rules. See [ADR 0002](decisions/0002-desktop-release-contract.md).

Preview publication is a separate Linux job after the signed macOS candidate job. It is reachable only from a version-matching `desktop-vX.Y.Z` tag and a protected GitHub environment using short-lived AWS OIDC credentials. The publisher revalidates candidate provenance, checksums, blockmaps, and feed metadata; writes immutable release/history objects; verifies the public CDN bytes; and changes `beta-mac.yml` last with an S3 precondition. Manual candidate builds cannot publish.

Stable promotion is a separate protected workflow on `main`. It requires committed screenshot-backed evidence that an older Preview installation discovered, installed, and relaunched into the exact candidate. The promoter revalidates the immutable Preview receipt and all hosted bytes, rejects non-increasing versions, writes immutable Stable history, and conditionally changes `latest-mac.yml` without rebuilding or re-signing. A retry can only recover the same byte-identical promotion. At this stage, release recovery means withdrawing a bad feed pointer before installation or issuing a forward-fix version; automatic application downgrades and local-data migration recovery are not updater responsibilities.
