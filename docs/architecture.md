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

## Sealed interaction completion

For newly prepared interactions, trusted preparation seals one immutable CompletionContract before `complete(inputGraph)` admits execution. The graph server owns its exact input snapshots, authorities, Return requirements, schema version and digest. The complete contract is visible to the executing harness; provider credentials and execution switches are not contract fields. Exact recovery never replaces its original policy. Recognized legacy records retain their frozen semantics rather than receiving a synthetic contract.

Advance validates the full prospective Return plan, but publishes only the completion's Current Layer closure. Accepted-history changes remain staged until Return revalidates and commits them atomically. Return ends this interaction's authoring, not the user's task.

An InvokeAction is a reusable definition, not a child identity. Keyed Invocations store separate child identities, source-action snapshots and the exact source response Node as parent. Calls can be prepared from an owned draft. Returned results are joined per call without converting the source action. GraphComplete records these semantics; each provider still owns native recursive execution. No graph-level scheduler is introduced.

[ADR 0015](decisions/0015-sealed-completion-contract-and-invocations.md) and PRD section 12.1A define the compatibility and delivery boundaries. The first slice stops at its recorded and hands-on human gate; execution retry histories and inert Eval Replay follow in separate gated slices.

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

Electron also owns one deep managed-runtime installer for code-owned harness capabilities. Connect requests the exact recipe selected by the Desktop release, verifies every recorded artifact identity, assembles and probes in isolated staging, and atomically activates one immutable installation descriptor per runtime and platform before provider authentication. The current release owns exact Codex 0.159.3 and Claude SDK 0.3.286 / CLI 2.1.286 recipes for macOS arm64, macOS x64, and Windows x64. External app-update metadata remains version-shaped for predecessor compatibility and maps to those code-owned recipe identities before staging. Ordinary startup performs only local receipt, file, and readiness validation; it performs no vendor lookup or automatic retry. Explicit preparation repairs the same requested recipe and never adopts a mutable latest release. Provider definitions retain only their isolated authentication, configuration, and session state. Native vendor runtimes are excluded from the application bundle, and ambient `claude`, `codex`, uv, Python, npm, Homebrew, shell PATH, and Prime profile state are never adopted.

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
6. Electron owns one credential-free readiness coordinator for loaded production harness configurations. Connect, reconnect, and explicit repair resolve exact access-contract and model-rule candidates, prepare shared recipes once, and publish one digest-guarded availability batch. Rust persists only global configuration availability and derives provider routes through the existing catalog joins; there is no provider-by-harness persistence. That persisted row is the only readiness record: Electron publishes only to Rust, and Rust rejects a generation older than one it accepted in the same process. Loaded configurations start unavailable unless startup restores Rust's own ready row, and startup, catalog background work, renderer reads, and Send perform no readiness probes. Secret provider access contains only provider material; Codex and Claude managed runtime descriptors are injected by their harness factories.

Threads pin a harness-configuration identity, not an immutable copy of catalog or family state. Unsent turns resolve lazily against current semantic revisions when the picker opens or Send is pressed. A still-valid exact selection is preserved; an invalid selection may move only within its current family. The product never selects another family implicitly. Once an attempt is sent, its provider/model identity cannot change or fall back mid-flight.

Every provider row carries a connection generation owned by the Rust catalog. Creating a provider starts it at 1. Reconnect completion and sign-out publish their catalog with a lifecycle event that advances the generation in the same transaction; removal advances it with the lifecycle change. Every catalog publish names the generation its result started with, and Rust refuses an older one inside the write transaction with `provider_connection_superseded`, so a superseded refresh, recovery, or discovery changes nothing (PROV-002). Electron tags a refresh when it starts: the model-catalog service resolves the provider's adapter and generation at that point, not at request time, and skips the publish if the generation moved. Harness readiness is global per configuration and outside this rule. A refused publish rereads the generation, which recovers from a lifecycle write whose response was lost; a reconnect also reads the generation when it starts, and a refused sign-out retries once at the current generation. Sign-out commits its disconnected state itself and does not wait inside the provider queue for its refresh. A cancelled or failed reconnect leaves the provider a catalog adapter: a fresh runtime replaces a reused one, and the recovery adapter stays when the reconnect created its own runtime. Recovery refuses while a reconnect is pending, and no refresh runs or publishes then: the refresh generation is null from the reconnect's first check, through runtime preparation and the start of its sign-in, until it settles. A cancelled or failed reconnect commits its signed-out state with the next generation before it wipes the provider home, as sign-out does, so a refresh that straddled the reconnect is stale. If that commit fails, or the service is closing, the cancel keeps the login and the reconnect's runtime instead, as an unknown outcome does, unless a sign-out the app server answered already superseded the reconnect; that sign-out stands and the login is wiped. An explicit refresh rechecks the refresh generation after its readiness evaluation, immediately before it publishes. Desktop shutdown calls `beginShutdown()` before it awaits the app server, so provider access closes first. A sign-out whose publish fails leaves the provider signed out locally while the app server may read it connected; execution leases are refused until the app server records a signed-out state (a sign-out or cancel publish, or a published catalog that is not connected), or the service confirms a sign-in again (a completed reconnect, including one whose outcome is unknown, or a cancel whose account check reads connected). The block is process-local: after a restart, the startup refresh reads the account and publishes its state. A cancel keeps a login only when the account does not read signed out; its account check is bounded (`ACCOUNT_CHECK_TIMEOUT_MS`), and a check that times out leaves the outcome unknown. A reconnect whose publish gets no answer rereads the generation. A sign-out the app server answered meanwhile settles it as failed, and so does an unmoved generation. It is adopted only when the generation is exactly one past a baseline it read at its start, no sign-out ran meanwhile, and no earlier lifecycle write for the provider is still unanswered (a lost request may commit late; an answered write that advances the generation ends that doubt); any other outcome keeps its runtime and login without adopting it. Execution leases refuse while a reconnect is pending and once the provider service is closing, and a settling reconnect never closes or wipes a runtime a lease holds (PROV-004).

Connect is all-or-nothing (PROV-007). The credential is written just before the staged create so a committed definition always has it; a refused create removes it. The runtime and catalog adapter are registered only after the create commits, so nothing refreshes or publishes for a provider before its definition exists. A create with no answer is resolved by reading the definitions back; if that read fails, the credential and runtime state stay for startup reconciliation, which keeps them only for a persisted definition.

Provider removal uses atomic admission and draining. Marking a definition `removal_pending` immediately blocks new attempts through it while already admitted work finishes. Credential deletion and the non-secret historical tombstone occur only after the last execution reference is released. Family deletion needs no drain because a sent attempt no longer consults family membership.

A pending managed connection reserves its provider name until it settles, so the reservation is owned in the main process rather than in renderer memory. The renderer that began an attempt owns it, and the attempt is cancelled when that renderer's contents are destroyed. A failed browser handoff cancels the attempt it created. A check that cannot reach a verdict keeps the attempt pending for a bounded run of consecutive attempts, after which it settles and frees the name; only a disconnected account means the login is still open. Issue #448 tracks the two ways an attempt can still outlive its owner.

Every execution attempt has an immutable receipt and a durable effect boundary: `none`, `partial_output`, `graph_write`, `tool_effect`, or fail-closed `unknown`. For an ordinary message, a model-related failure returns the same interaction to an editable unsent state, including failures after partial output, graph writes, tool effects, or an unknown boundary. For an input-assisted Send, failure or stop instead restores its snapshotted attachments to the thread draft without reopening or retrying that immutable attempt; retry requires a new explicit Send and a new root interaction. A draft edit committed after the failed attempt was reserved wins over restoration for the same occurrence. Both paths deliberately accept duplicate-effect risk: durable graph writes remain authoritative, and only the product binding and transient execution capability state are cleared. Pre-execution model failures also persist the exact provider, model, family, and harness-policy snapshot available at failure time; adapter implementation version `0` records that provider admission did not complete. Non-model failures remain failed and inspectable. Trace events conservatively raise the boundary for streamed output and tool starts, observable graph neighbors raise it for graph writes, and an accepted graph discovered while recovering a harness failure is adopted without rerunning the harness. Attempt finalization and the matching interaction transition commit in one SQLite transaction, while startup converts any genuinely interrupted running attempt to terminal `unknown` and reconciles graph-authoritative acceptance first. Issue #158 may later replace this accepted duplicate-risk behavior with effect-aware replay protection.

This contract applies equally to `codex.basic`, `prime.agent`, and future harness implementations. It adds no scheduler and does not change `complete(inputGraph)` or graph acceptance authority.

## Personal presentation profile

Relayer owns one hidden profile thread whose accepted completions are immutable personal-presentation versions. Before provider execution, product preparation atomically pins either the active version or an explicit Eval override to the interaction. Graph core represents that pin as a control-owned attachment, not an edge, action, context occurrence, or response record. It is excluded from ordinary completion closure, graph navigation, product history, Node Details, and conversation export. A harness receives the resolved accepted graph only through its interaction capability and renders it after generic graph guidance but before task input. Candidate traces and Eval artifacts retain only the exact version interaction ID. See [ADR 0009](decisions/0009-personal-presentation-graph-attachments.md).

Activation changes only future human-authored pins. Existing interactions, retries, and recovery retain their original version and effective execution identity. Invoke-created semantic children atomically copy the source interaction's exact pin rather than resolving the newly active policy. V0 is neutral; active V1 encodes the decision-useful and progressive-disclosure preferences. Published but inactive V2 is one self-contained accepted completion whose single root layer adds Visible working state to those two version-owned concepts. The Eval-only layered Codex V0/V1 configurations use the same existing cases, matrix, judges, artifact schema, and read-only production renderer.

## Shared product and Eval workspace

Relayer is an Electron build target; Relayer Eval is a developer-only local web host. Relayer exposes the ordinary product window and lets each new thread pin an available catalog configuration. Relayer Eval exposes a test-run dashboard and selects named configurations for its matrix, but executes each case through the same product app server. A case may create one or more ordinary product threads and interactions.

Opening one case × harness execution creates a separate review page using the exact production renderer and `ProductWorkspace` component. The web bridge supplies Eval navigation context: the run's cases and product thread IDs for the selected harness. Product graph reads, accepted-layer navigation, turn navigation, layout, and node inspection remain owned by the ordinary product API and workspace. The gateway uses the same app server’s read-only capability and the app server rejects product writes at the API boundary; workspace review mode also removes composition and mutating controls. See [ADR 0003](decisions/0003-shared-product-eval-workspace.md).

Node-input round-trip evaluation does not relax that read boundary. A separately credentialed, occurrence-scoped operator uses the ordinary input-draft and interaction HTTP routes only after versioned input-action captures have been durably persisted with their node rating. Independent per-action locks exclude writes while pixels and ratings are bound, one receipt atomically commissions the complete capture set, and the read-only presentation revision includes the opaque selected-thread input-draft revision. The operator verifies the route's returned occurrence, action, value, and draft revision before it may Send. The opt-in live gate then joins the accepted authored action, consuming product interaction, provenance-exact graph input children, and the next harness prompt trace containing the same normalized semantic input. Model grounding ratings are recorded separately and never replace this structural gate.

Every newly authored layer carries a versioned layout with exactly one normalized
placement per member node. Graph core validates and persists those placements as
part of the draft and accepted layer snapshot. The shared Product/Eval renderer
projects normalized coordinates into a stable world plane; responsive fitting,
panning, zooming, and inspector changes affect only the camera. Historical
accepted layers without layout data remain readable through one deterministic,
viewport-independent renderer fallback and are never rewritten during reads.
The placement list order is the layer's reading order; keyboard and screen-reader
order follow it. The layout also names one agent-chosen edge shape for all of the
layer's edges (PRD §6.1, §11.2). It is required when a layer is submitted, but
reads, the acceptance re-check, import, and share snapshots accept its absence on
older layers as `default`, which the design resolves to a concrete shape at draw
time only. An optional list of edge routes lets the agent give a single edge its
own shape, the side of each node where it attaches, and up to four waypoints.
Graph core validates routes with the layout and stores them as JSON beside it;
export, import, and share snapshots carry them unchanged.

Layers may carry an explicit `defaultNodeId` chosen by the author from their member nodes. Graph core validates membership and preserves the choice through publication, persistence, and portable import/export. Missing values from older clients or accepted layers remain readable. Product opens the chosen detail automatically when no valid user selection exists; legacy layers use their first canonical member. Per-thread, interaction, and layer presentation memory preserves the user's later choice without mutating the accepted layer. Explicit history selection takes precedence. Empty layers do not fabricate a detail node.

Each product or Eval review window owns one bounded renderer-side navigation history for thread, turn, authored layer path, and remembered node selection. Restoration resolves accepted product data before committing the presentation and cursor together. Eval's judge history command delegates to this controller; the Eval main process records and validates the result but does not own a second stack. Hierarchy breadcrumbs and direct chronological turn controls remain separate presentations of layer ancestry and durable interaction order.

## Base graph-completion invariants

1. Product hosts own project and thread records. Graph core stores their positive-integer IDs only as graph-record provenance; it does not create parallel project or thread objects.
2. Accepted graph records are visible to every thread with the same project ID. A standalone thread has no project ID and can see only records carrying its own thread ID.
3. A turn is centered on one canonical user-interaction graph node. Its `NodeId` is the interaction identity; there is no separate interaction-graph record.
4. Harnesses inspect and mutate graph state only through the typed graph clients and loopback Rust API.
5. Every capability maps to one canonical interaction `NodeId`. `GraphDatabase::writer_for_subgraph(node_id)` derives project/thread visibility and draft-write ownership from that node instead of trusting repeated caller context.
6. Navigate actions are explicitly `expand` or `reference`. Expansion is acyclic decomposition; references may share or revisit accepted supporting context. Non-root actions record their exact source layer.
7. Prior stable nodes and layers may be referenced across turns rather than duplicated. A reference destination is an accepted boundary, not a request to reaccept historical records.
8. Draft records remain distinct from atomically accepted completion closures. Harness-authored programs use explicit stable client keys for every persisted node, edge, layer, and action so a whole-program repair rerun upserts the same current-interaction drafts. On the fallback heredoc path the graph client saves each program that reaches `fromEnv()` under its own id in a host-granted per-turn folder, so a retry may send exact-match edits to that id through the same heredoc instead of retyping it; the edited program reruns with the same keys and prints its own new id. An unreachable owned draft layer may be explicitly discarded into terminal stopped history without deleting or cascading state to its nodes, edges, actions, or child layers; artificial navigation is not a valid orphan repair. Accepted layers snapshot their exact node, edge, and action membership so later graph writes cannot rewrite prior output. The only accepted-action mutation is the one-shot leased-invoke transition defined below.
9. An invoke-created user-interaction node may carry one immutable nullable `leased_action_id`, unique when present, plus a private immutable nullable `lease_source_interaction_id`; both are null or both non-null, preserving the exact accepted source/action pair for retries even when a node-owned action is reused. Neighbor reads derive its accepted source node through the leased action without persisting a semantic `GraphEdge`; pre-lease invocations remain unleased and are not backfilled.
10. New layer submissions include complete versioned normalized placement data. Layout integrity is deterministic graph validation; spatial meaning remains model judgment. Legacy accepted layers may lack layout, but reads never infer and persist replacement graph content.
11. A model turn ending is not completion; the root must explicitly submit or stop. Submission validates authored closure, expansion cycles, reference visibility, orphan drafts, layer size, and current-draft layout completeness. For a leased interaction, the same submission transaction also changes the exact accepted source action's `target_layer_id` once from `null` to the accepted result root layer. Its kind remains `invoke`; no `resolveAction` authoring API or resolution table exists.
12. A resolved invoke is project-visible cross-interaction navigation wherever its node-owned action is reused, not an `expand` or `reference` relation. Generic renderer navigation history remains an independent product concern.
13. The selected harness owns model execution and any provider-native child scheduling. GraphComplete does not add a model-call or recursive-agent scheduler. See [ADR 0005](decisions/0005-layered-navigation-contract.md) and [ADR 0006](decisions/0006-harness-provider-agnostic-product-boundary.md).
14. A personal-presentation attachment is a control relation from one interaction to one published accepted profile completion. It never participates in ordinary response topology or graph authority, and one interaction can pin it only once. See [ADR 0009](decisions/0009-personal-presentation-graph-attachments.md).

The Issue #363 client foundation attaches one `NodeDetailAuthoring` builder to each draft `NodeObject`. That owner supplies immutable source-node provenance for every graph-action mount, and a draft source layer must contain the exact owner. The authored program can hold only bounded logical asset references; it cannot inject asset resolvers, verified records, compiled packages, or a finalization result. Before its first await, `RelayerGraphClient.checkpointNodeDetail` or `submitNode` snapshots the complete ordered component program—HTML/CSS template arrays, typed bindings, actions, layer provenance, navigate targets, and asset identities—from ordinary own data descriptors. It validates and deduplicates references from that snapshot before authenticated host resolution, validates the resolver response as untrusted data, then compiles only the same immutable snapshot. The first submit registers shared submission and detail-finalization promises in module-private client `WeakMap`s before executing envelope, compiler, resolver, or transport work, so synchronous re-entry and ordinary concurrency join the same operation. Resolution or compilation failure removes only the matching placeholders while the live builder remains editable; successful compilation freezes the builder before one shared transport request. The client descriptor-snapshots the exact successful node envelope and fields once, validates only that snapshot, then creates one frozen accepted value in private response state. `NodeObject.ref` is a non-configurable read-only projection of that state; concurrent calls and successful retries receive the same cached value. Repeated placements of one asset have stable occurrence mounts while resolver requests and package assets remain deduplicated. Standards-based HTML and CSS parsers emit canonical opaque mounts under fail-closed markup, selector, function, property, stable-identity, count, and total-package byte rules. The build bundles the pinned parser closure into the sole `graph-client/index.js` resource used by Product’s exact dynamic import path; compiler internals are not copied as siblings. Eval uses the checkout’s built graph client.

Issue #365 makes that compiler output an immutable graph record. The graph server verifies the shared canonical SHA-256 before storing `authoredDetail`; SQLite reopen, accepted-closure reads, TypeScript node responses, and conversation export/import all carry the same package beside the legacy Markdown fallback. Draft resubmission follows a three-state rule (omit retains, `null` clears, a package replaces), and conversation export omits a package that would carry a private project path in any raw or decoded form, recording `authoredDetailOmitted` beside the redacted fallback. The visual-assets Module owns digest-addressed catalog storage, provenance, scope, and media validation. The graph capability derives completion scope and calls a private host bridge with an independent token and generation. Submission prepares the exact canonical package through that bridge and pins validated bytes to graph nodes; accepted-image reads require an accepted node association. Conversation export carries globally deduplicated `visualAssetContent` records between the header and turns, with each content record bounded by the existing JSONL line limit. Import validates media through the same host library, stages bytes by digest within the private import session, and publishes node associations and content atomically. Product reads additionally require accepted-node membership in a layer readable by the selected thread interaction. This uses the ordinary graph layer authority for current and historical accepted state. Development and packaged harnesses receive the same HTML, CSS, capability, and logical asset authoring surface. Product's isolated runtime still validates the complete persisted package and degrades unavailable legacy or imported asset mounts safely; #371 owns Eval proof through that runtime.

Authored theme presentation (#519) is renderer state, not graph state or harness execution. The public reference exposes `[data-relayer-theme="light"]` and `[data-relayer-theme="dark"]` theme selectors on a runtime-owned inner scope; the compiler still rejects host and ancestor selectors. Product and Eval mirror the document's active appearance onto the inner scope, initially and on changes, without replacing controls or altering package bytes. Only stylesheets whose parsed selectors reference the theme attribute receive the inner scope and observer. Unthemed packages retain their existing DOM ancestry. Disposal and failed mounting release the observer. Theme variants remain ordinary accepted CSS and pinned assets, so storage and portable import need no new schema. Generic harness guidance supplies theme references without imposing a palette, layout, or deterministic aesthetic gate. Unthemed output keeps its original styling. Existing containment and capability authority remain unchanged.

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
3. The host copies the selected configuration onto the thread and persists the implementation's opaque JSON resume state. For `codex.basic`, that state is the root Codex thread ID with the personal presentation version and the Codex home it belongs to. Prompts carry only the current turn, so a thread's native session is the only holder of its prior conversation ([#584](https://github.com/vishaltandale00/relayer-graphcomplete/issues/584)). Native history is therefore kept whenever it can be resumed, and a reset is never silent.

- A thread is kept only once Codex accepted a turn on it, because only then does its rollout exist to resume.
- A Codex thread resumes only in the Codex home that holds its rollout. The home is the turn's effective `CODEX_HOME`, recorded as its configured path, or as `codex-default-home` for Codex's default home, so it stays stable across restarts. The Codex subscription runs in its own `CODEX_HOME`. API-key providers get no managed runtime, so today they share Codex's default home.
- A follow-up on another provider that shares the home keeps resuming the thread. A follow-up in another home starts a fresh thread, because the old one cannot be resumed there. State from an earlier release records no home; its thread binds to the home it first resumes in.
- A saved thread that Codex reports has no rollout is forgotten, and the same turn starts a fresh thread instead of failing.
- These rules decide only whether the provider the product selected can resume the saved native conversation. Which providers and harnesses an existing conversation may select is owned by the legacy compatibility policy (the P0 work on `codex/p0-legacy-conversation-compatibility`), not by the harness.

Whenever a root turn cannot continue the previous native conversation, it still starts fresh and records a native-session reset. The reason is one of `home_changed`, `provider_changed` (Claude), `presentation_changed`, `no_rollout`, `force_stopped`, `stopped_during_start` or `session_unavailable`. The notice uses the channels the host uses for a force-stop: a product log line without provider text, and a `warning` event with `nativeSessionReset` in the turn's trace when a trace is kept. A reason that arises when no turn is running, such as a force-stop, is saved with the harness state, so the next root turn reports it even after a restart. `claude.basic` and `prime.agent` report their resets the same way. The notice makes a reset visible; it does not restore the lost context.
4. The current graph URL, token, and interaction node form a per-call graph scope. They are never factory inputs or harness state. The host closes its in-memory scope when the call settles; the calling runtime that minted the capability owns token revocation.

The packaged `codex.basic` harness uses Relayer's TypeScript Codex app-server client and approval/event bridge with the selected provider access and an explicit managed executable. It keeps one resumable Codex thread per Relayer thread, makes Codex-native subagents available under shared interaction authority, and asks Codex to execute the TypeScript graph client. `claude.basic` loads the matching managed Claude Agent SDK module and supplies its explicit managed executable. Neither harness searches ambient `PATH`. The graph is not returned as structured JSON: harnesses submit objects to the Rust engine, react to repairable validation errors, and end with `graph.submit(interactionNode)`. The optional `prime.agent` implementation uses the same host and graph contracts while owning its own recursive runtime policy.

Relayer Eval runs cases through the product app server and waits for each interaction to reach a terminal state before starting the next turn. The product runtime owns capability issuance and revocation, while the harness host retains provider-session identity. Cases own harness-agnostic deterministic checks; the selected Eval judge adds quality assessment without changing case execution.

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

The runner input is a test-run ID, selected test-case IDs, selected harness-configuration names, and one judge configuration. At the Eval service boundary, configuration names resolve to validated snapshots. The runner expands their Cartesian product into executions identified by `(testRunId, testCaseId, harnessConfigurationName)` and passes each resolved `HarnessConfiguration` into case execution. Every execution artifact stores that exact snapshot and its canonical SHA-256 digest. Two configurations may select the same implementation; that is ordinary run selection, not a harness-specific case or matrix.

The ordinary test suite never invokes inference. Evaluation execution and review belong to the Eval application through the product app server and shared production graph/chat workspace. The retired standalone CLI and HTML viewer are no longer supported.

## External capability catalog

The ten Issue #278 capability cases live in `relayer-capability-evals`.
That repository owns their tasks, fixtures, references, mutants, verifiers,
platform requirements, suite membership, and admission evidence. Older built-in
H3, frontier, and calibration cases remain in this checkout.

Relayer Eval loads an explicitly selected local catalog checkout at the commit
in `eval-catalog.lock.json`. It checks provenance before importing trusted
catalog code and rechecks it before queuing and executing external work.
Startup never clones repositories, installs dependencies, or builds a catalog.
This is a developer-code trust boundary, not a sandbox for untrusted plugins.

A catalog registers case definitions and materialize, grade, and mandatory-gate
callbacks. Its definitions expose only public snapshots. The host retains the
ordinary case × harness matrix, product threads, graph acceptance, read-only
review, and independent outcome and presentation grades. Catalog provenance and
suite identity persist with each external execution and survive reopen without
loading the package. Each harness still owns its native recursive execution.

## Runtime package boundaries

- `crates/relayer-graph-core/src/graph.rs` is the graph behavior boundary. `graph/database` and `graph/writer` expose the public control flow, `graph/model` owns the node, edge, layer, action, ID, and state objects, and `graph/completion` separates closure planning from atomic acceptance.
- `crates/relayer-graph-core/src/storage.rs` is the persistence boundary. `SqliteGraphStore` owns the SQLx pool and connection lifecycle, its table-specific modules contain all queries, and `storage/sqlite/migrations` contains both the embedded migration runner and versioned SQL. Graph behavior does not import SQLx. This mirrors the app server's `SqliteProductStore` boundary without introducing a transport API inside graph core.
- `crates/relayer-graph-server` exposes that same core through the loopback API.
- `packages/graph-client` is the typed Node authoring client and contains no graph persistence. Its authored-detail compiler owns draft checkpoints and the `submitNode` request seam, not durable storage or rendering.
- `packages/visual-assets` owns the deterministic logical visual-assets interface, scope and tag semantics, and the private generic-content Module used for digest indexing. It does not compile Node Details or inject asset inventory into harness prompts.
- `packages/harness-host` owns persistent per-thread harness objects and code-owned implementations such as `codex.basic`.
- `packages/eval-runner` owns the Eval application's harness-agnostic case/run expansion, deterministic checks, fixtures, and judge contracts. The Relayer Eval shell composes those contracts around the production app server and renderer.
- `python/relayer-graph` is the Python authoring client and contains no graph persistence.

The root `src` directory contains only the canonical GraphComplete boundary and its runtime contract. There is intentionally no TypeScript graph kernel alongside the Rust graph core.

The standalone server keeps only an in-memory map from an opaque graph capability token to one completion identity and its durable capability epoch. It does not cache project/thread authority supplied by the caller. After a server restart, trusted control can remint a token for a persisted active canonical interaction; reminting atomically expires older generations and ordinary harness clients cannot mint. Each request resolves a short-lived `GraphWriter` from that completion-bound identity and epoch, so graph authority is never reconstructed from caller-supplied project/thread values. Terminal model capabilities lose general graph reads and all writes; the exact current generation retains only the accepted-output receipt needed for its supervising harness to settle `complete(inputGraph)`. Trusted control retains product reads and other exact-receipt recovery. `GraphDatabase` is cheaply cloneable because it holds an async SQLx pool; SQLite writes use short `BEGIN IMMEDIATE` transactions while reads remain pooled, and the HTTP server never holds a Rust lock across agent work.

Each completion stores an append-only revision sequence and a compare-and-swap current head. Advance and return validate and publish one owned closure, append the immutable revision and idempotency receipt, move the head, and enqueue its projection event in the same `synchronous=FULL` SQLite transaction. Return additionally establishes the existing accepted completion output; stop and trusted-control failure retain the last current without a final result. Product projection consumers reconnect by outbox sequence and apply pointer-aware follow behavior: only a view still following the prior revision advances automatically, while explicit navigation remains pinned. See [ADR 0008](decisions/0008-temporal-current-and-completion-brokers.md).

Each human-root interaction is serialized on its thread's host queue and receives a new `HarnessRunContext`. Agent-invoked completions receive the same context shape with trusted invocation provenance and remain independently runnable. The context contains `inputGraph` plus a host-owned graph-scope handle; it is not factory input or persistent session state. `codex.basic` may reuse a root Codex thread ID, but session reuse is an adapter optimization rather than the source of GraphComplete context or identity. `prime.agent` passes the run context to `promptAndWait`; a stable `relayer.graph.current` handler returns the matching capability to root or child IPython kernels. The Python kernel calls Rust directly through `GraphSession.current()`. When the call settles, the host closes the handle and the calling runtime revokes the Rust token.

The recursive target keeps `complete(inputGraph)` as one deep module interface. A GraphComplete thread is a graph of completions, not a provider conversation. Product-authored human interactions and agent-authored recursive code enter through trusted origins but receive the same completion handle: one durable current pointer and one result promise. Each call creates or recovers a distinct completion identity and scoped capability. The harness associates each completion with an independently runnable, replaceable provider execution attachment. This separation avoids making provider-session identity a semantic obstacle if mixed-harness routing is designed later; it does not make mixed-harness threads a V1 capability. Current V1 threads still pin one harness configuration. Agent code decides what to invoke, inspect, search, and await; the harness owns no recursive work queue or incorporation policy.

The common harness-configuration envelope optionally declares `complete.agentAuthored`. Absence or `false` fails closed. `true` permits the product to issue completion-broker authority only when the runtime's recursive temporal substrate is also active; the app server and harness host both revalidate that conjunction for roots and invoked children. This is capability authority, not an implementation-specific recursion policy and not a scheduler. Relayer Eval uses this seam for a paired Codex comparison whose two configurations are otherwise execution-equivalent. The shipped Desktop catalog does not opt in.

For `prime.agent`, a prompt settling is not the run boundary. The adapter waits for that Prime session's recursive runtime to become quiescent before returning or releasing graph and provider access. Human-root turns remain serialized around the persistent root session. Each explicit invoked Complete uses a fresh ordinary Prime session, so it can run independently without replacing root continuity or converting Prime's RLM topology into GraphComplete topology. External cancellation targets only the owning session and still waits for quiescence and cleanup; barrier and abort failures remain visible rather than releasing authority early. The per-turn force-stop below is the one exception: it force-disposes that turn's own session and stops waiting for it. For an invoked child, that is the child's session only. Every native session reads its own interaction's presentation instructions through its own view of the shared resource loader, so a rotated root session and each invoked child are built from their own pin, never from the instructions another session last loaded. For a root turn force-stopped while running on the root session, that session is disposed and the next root turn starts a fresh native session rather than resuming a file the stopped session may still write. A root turn force-stopped while still acquiring its session, for example in a reload or a session creation that never settles, abandons that acquisition: the root session it was working on is force-disposed, and a session it creates too late is disposed instead of installed. An invoked child force-stopped before its own session existed force-disposes that session once it is created.

Harness factories may initialize asynchronously so provider runtimes such as Prime Agent can open durable sessions before registration completes. The host serializes first construction and Complete calls per thread, forwards cancellation through an `AbortSignal`, aborts active work during shutdown, and disposes every live harness object exactly once.

Product and graph metadata remain in separate SQLite databases, so the app server uses an explicit recoverable handoff rather than pretending they share a transaction. It first creates the durable product interaction and conditionally reserves `submitted`; an input-assisted Send creates the root plus immutable submitted-input attempt before that reservation. It then prepares the canonical graph interaction and stores the graph `NodeId`, frozen configuration/model identity, effective-execution digest, and permission receipt. Only a conditional transition on that exact prepared identity may claim `running` and enter the harness. The graph capability token remains transient runtime memory and is never product data. Product graph reads use control-authenticated read endpoints rather than minting harness writer capabilities.

Provider execution access lives exactly as long as the native turn that uses it, unless that turn is force-stopped (below). The harness host releases a claimed lease when that turn settles, whether or not the product has persisted the outcome yet. A release requested by the product while the native turn still runs cancels the turn and takes effect when it settles, or within ten seconds of a force-stop. The product's release after the outcome is durable acknowledges the access to its provider. That acknowledgement retries a removal the catalog refused while the attempt still counted as running, so removal during a turn finishes without a restart. A release for a lease the host no longer tracks retries every drained removal instead.

A cancelled turn that has not settled within two minutes is force-stopped. The host arms one timer per completion when that completion is cancelled, including by the owner's release, and clears it when the completion returns, so only that turn is ever stopped; sibling turns and invoked children on the same thread keep running with their access. The harness receives the force-stop through `HarnessRunContext.forceSignal` and ends that one turn's native work: `codex.basic` kills the turn's own app-server process group, and `prime.agent` force-disposes the turn's own session. Codex settles once the killed process group exits; Prime's native disposal is synchronous, so it stops waiting for the disposed session at once. In any case the host waits at most ten more seconds for the turn to settle and releases its access even if the harness never settles; a later settlement changes nothing. A force-stop only ever follows a cancellation, so the turn settles as a settled cancellation, whether the harness resolves, rejects, or never settles while being stopped. The host logs the force-stop with the thread, completion, origin, product interaction and native outcome kind, and no provider text; when a trace is kept, it also records the force-stop and the native outcome as a warning. The product records a user's Stop as stopped, because it stops the graph completion and then sees a settled cancellation. A turn cancelled by its owner's release, when the product gives up on it, or by host close is never recorded as stopped by this path: the product has already stopped waiting for the turn or is shutting down, and its graph completion is not stopped. The force-stop is best effort: it relies on the process kill or session disposal actually ending the provider work, and PROV-004 is relaxed for a force-stopped turn only. The next Prime root turn never waits for an abandoned acquisition; it starts a fresh native session. A root turn force-stopped while its native conversation ran also drops that conversation: `codex.basic` forgets the thread the killed process may have left mid-write when the force fires, and ignores a turn accepted after it, so the next root turn starts a fresh thread, as Prime starts a fresh session. A Stop that lands while a Codex `turn/start` is still pending also kills the app-server, so it drops the thread the same way. The host starts persisting that forgotten state as soon as the force fires, not when the turn's run ends. The write is asynchronous and best effort, so a crash before it lands, or a failed write, can still restore the stopped conversation (the `prime-root-crash` model check). Force close, when the app quits, kills root turns the same way: each harness's force shutdown forgets a root conversation that was running, and force close persists that state itself, because the killed turn may not settle before the process exits. A conversation that was not yet running is kept: a Codex root turn that had not sent `turn/start`, or a Prime root turn still acquiring its session. A root turn already force-stopped dropped its conversation then, so force close keeps the session a later root turn left idle. Recording is best effort: a harness whose state cannot be captured keeps its previous saved state, and force close still resolves. A Codex root turn force-stopped before it sent `turn/start` keeps the saved thread, which nothing wrote. The next turn still receives its graph context. A harness that does not declare `supportsForceStop`, currently `claude.basic`, whose SDK already terminates its process on cancellation, keeps a turn that never settles holding its access, which is the safe fallback.

The catalog's removal drain counts an attempt only while its outcome is undecided and Relayer still waits on its native run. When the execution task stops waiting without persisting the attempt's outcome, it ends that wait with bounded retries. If the interaction already failed or stopped, for example through an expired, aborted, or cancelled approval, the attempt ends with that outcome. Otherwise the interaction is pending reconciliation: the attempt keeps its `running` outcome, and `native_wait_ended_at` records the end of the wait. Canonical graph output can still settle that attempt later. Startup records the same for attempts it leaves open for reconciliation, since their process exited with the application. Either way the attempt's lease becomes debt and is released once, and the drain stops counting it. The drain is necessary but not sufficient while Relayer runs: Relayer may stop waiting while the native turn still runs. Live native work stays guarded by the harness host's claim and by the provider service's lease count. The claim is released when the turn settles, or at most ten seconds after a force-stop. After a restart, startup observes each recursive child still unwinding once before it serves Desktop. A child the harness no longer runs ends first, so Desktop's startup removal does not wait on it; a child it still runs keeps waiting in the background. Desktop's startup reconciliation attempts each pending removal on its own, then sweeps runtime state and orphaned credentials. It records each failure and never throws, so one provider cannot stop Relayer from starting or other providers from activating. A removal that fails or is deferred before its tombstone stays pending for the next start; cleanup that fails after the tombstone is swept by the next start.

Terminal provider-execution lease debt is handled by one app-owned reconciliation worker. It covers terminal attempts and undecided attempts that Relayer no longer waits on. Startup, a thread, state, or action-destination read that settles a quarantined attempt, and later release failures only wake that worker; they never spawn competing retry loops. The worker serially scans durable debt, retries with capped backoff, and returns to an idle notification wait after the debt is clear.

Invoke preparation supplies the accepted source interaction/action pair to graph control. That pair is the graph-side idempotency key, so retrying a lost create response recovers the same leased graph interaction while the product-side invocation record recovers the same result interaction. At startup, bound interrupted invokes are reconciled against canonical graph completion output: an accepted graph finalizes product history using its already persisted execution receipt, while the absence of graph acceptance fails the product result and leaves the leased action unresolved. This closes the graph-accepted/product-uncommitted crash window without a distributed transaction or a second scheduler.

A child an agent launched through its completion broker is marked in `action_invocations.agent_invoked`, which the thread view exposes as `agentInvoked`. It never counts toward the thread's one active human turn, a new turn never inherits its model, and the product's Stop refuses it; only its parent agent's broker grant may stop it. The renderer's composer, retry, model inheritance and Stop target follow the latest human turn for the same reason. A user's invoke of the same action never runs it on the product path. Once the broker's launch has claimed the child, a failure it cannot recover fails the child in both stores: a failed capability activation through the launch-failure cleanup (`capability_activation_failed`), and an ambiguous or failed preparation, reservation or launch claim through the refused-launch cleanup (`preparation_failed`). The refused-launch cleanup fails the product row first, bound to the child's graph interaction, which fences out later launches, and then the graph current; a launch that already reached its claim owns the child instead. At startup, results an older build left unmarked are marked when only an agent could have created them: their source was never accepted, or was accepted after they were created, which a launched source's settled execution or a root's accepted attempt dates. An interrupted agent child that no launched execution covers is recovered from its own invoke occurrence, whatever its parent's status, and failed in both stores with `application_restart`; a reserved execution row settles with it. An unbound child is located through that occurrence directly in the graph, without the live harness catalog or a revalidated model, since it is only failed. A deterministic failure still fails its graph current when the node carries the child's own occurrence, then its product row; a transient error on that path keeps the child for the background retry rather than quarantining its product row alone. A child kept after a transient startup failure is retried in the background with capped exponential backoff until it ends. A refused child whose graph half a restart interrupted stays marked (`graph_failure_pending`) until startup, or its background retry, confirms its current is terminal. An agent's exact retry of a recursive invocation an older build left unmarked marks it, but only on proof that no user created it: a completion execution, or a source that was never accepted. The broker refuses a result that a user's own invoke of the same action created, for launch, Stop, current and result alike. A child the product never recorded, because the application stopped between the parent's `prepareComplete` and the broker's first write, stays a graph-only orphan.

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
explicitly continues without an account. Once resolved, Account stays in the sidebar footer beside Settings. At widths
up to 760px, the existing sidebar starts as a collapsed icon rail. Its existing
toggle expands the same sidebar in normal flow, leaving the workspace to fit
the remaining width; an explicit expansion stays open until the viewport leaves
the narrow breakpoint. The footer shows icons while collapsed and labels while
expanded. Both actions remain in the single footer controller: signed out or
error starts sign-in directly, while an existing or uncertain account opens
Account settings. There is no dropdown or floating Account overlay. The
Account panel contains only concise status
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

V1 reports unhandled process crashes, supervised-child startup failures, and
supervised-child unexpected exits. One closed Electron-main exception admits
share export, oversize, upload, service, and unexpected deletion failures using
the user-visible attempt reference. Cancellation, sign-in requirements, quota,
and all other handled or expected product states remain excluded. Every adapter emits a closed record with stable component,
operation, and failure codes plus a code-owned message. JavaScript frames are
application-relative, limited to 32, and limited to 256 characters per module
name. Rust frames name only approved workspace crates and modules. Absolute paths,
third-party frames, arbitrary maps, and raw errors are rejected. Module names must
also occur in the checked-in packaged-module inventory, so a caller cannot encode
private data inside a valid-looking application path. The final event is validated
again immediately before transport.

The handled-share schema adds the reference, closed stage/code, optional
oversize byte count, and the bounded diagnostics described below. It reuses verified-account admission, the main-owned
pseudonym, bounded encrypted queue, final transport validation, and recursion
suppression. Main deduplicates account + reference + stage + code in process;
the durable publish-attempt owner must preserve the same identity for restart
deduplication. A handled failure is admitted only after that durable key saves;
save failure suppresses reporting. Renderer and public viewer receive no reporting or network
authority.

The Electron-main publish coordinator writes a versioned, atomically replaced
attempt record beneath private desktop user data before any upload. The record
contains the exact frozen bytes, attempt/reference identity, original owner,
source-thread identity, last closed result, and handled-failure deduplication
keys, but never a bearer token or signed upload fields. Recovery is visible only
for the matching open source thread after the original owner is verified. A
successful response replaces snapshot bytes with a lightweight URL receipt;
closing the result or explicitly dismissing a failure removes only that local
record. Invalid or corrupt records fail closed, and capacity rejects new
records instead of evicting an undisclosed frozen attempt.

The approved share-diagnostics extension retains the first available approved app
stack from the original exception or its causes, bounded to four inspected error
objects and the existing 32-frame inventory limit. It additionally admits an
optional integer HTTP status (100–599) and a network code from the fixed allowlist
in `desktop/main/services/share-error-diagnostics.mjs`; unknown codes are omitted.
TimeoutError maps to the code-owned `TIMEOUT` value. No raw error, cause message,
host, URL, request/response body, header, or frame local is admitted. Diagnostic
inspection cannot alter the product result. Sentry frames use oldest-to-newest
order. Legacy records with no diagnostics remain accepted. Encrypted queue
entries still require the existing same-account, release, and platform checks;
this does not introduce cross-release replay. Deduplication still uses account/reference/stage/code, and the
share attempt store never persists diagnostic stacks or raw exceptions.

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

On restart, Electron writes the configuration catalog by temporary file and
rename. It never reads readiness back from that file. For each coordinated
configuration it records only whether cheap local validation passed: the
exact managed receipt, owned real state directory, installation marker, and
entrypoints whose resolved targets remain inside that exact installation.
Rust then restores a ready route only when its own previous row said ready
for the same configuration digest and that validation passed. Migration 0034
clears every ready row once, because a row from an older build may not come
from an evaluation; each route then waits for its next evaluation. Each app-server
process starts a new readiness ordering epoch. The desktop never restarts the
app server alone; if it did, the restored row stays the record and the
coordinator's generations keep increasing. Startup's own path does not download,
prepare, invoke a readiness probe, or contact a provider. A digest mismatch or corrupt
local descriptor keeps the harness unavailable and records a sanitized error.

Two post-upgrade steps are the exceptions. Activating a runtime staged by an app
update runs a local version probe of that runtime before the app server starts.
Startup's catalog also names the exact runtime recipe (`recipeId#recipeDigest`) each
coordinated harness requires. `initialize_model_catalog` keeps the recipe each row last
loaded in `runtime_recipe`, and a changed recipe does not restore an old ready. When an
upgrade changes a coordinated route's digest or recipe, it marks the row
`readiness_update_due`; that covers an update whose staged runtime activated and one
whose activation failed. Startup also flags each runtime its own activation changed
(`runtimeUpdated`): a new recipe, any other replaced installation (a frozen schema-v1
receipt an older Desktop staged, or the same recipe rebuilt because the active
installation was unusable), or a failed activation. That counts even before a
recipe was recorded, as on the first
start after migration 0039. When the first recipe is recorded, a ready route whose files
no longer validate counts too, because an update whose prefetch failed staged nothing to
report. The eval app records recipes too. After provider startup, Electron reads the marks and starts
one background evaluation through the `recipe-update` trigger. A runtime recipe newly
activated by the update also starts it for the harnesses that use it. The evaluation covers every active provider with a published
route through those harnesses, so ChatGPT and OpenRouter share one result for
`codex-basic`. It goes through the same coordinator and publication chain as Repair
(PROV-005), and the app server's row stays the only record (PROV-006). Startup does
not wait for it. Like Repair, it probes the runtime and may install the exact recipe
again, but it skips a harness whose runtime was never installed on this machine; that
route waits for Connect or Repair, so an upgrade never installs Prime by itself. A
managed provider whose activation failed on a broken runtime publishes no models and so
has no route; the step first recovers each such provider, as Repair does, when its
recipe is installed and due. Recovery reinstalls the exact recipe if needed and publishes
the catalog from its one discovery without evaluating, so the step then evaluates each due harness
once for all its providers. The eval app runs the same step at its startup and waits for
it. Quitting stops the step before the quit guard looks, so no preparation starts behind
it; if the user keeps downloading, an unfinished step starts again. Shutdown cancels any
installer operation the step started and awaits it before the app server closes. The
stop reaches provider recovery and every readiness checker. The Prime check stops waiting
for its kernel probe; the bridge's probe takes no signal and disposes its kernel when it
settles. A stopped evaluation publishes nothing, not even one queued behind another
publication, so its mark stays for the next start. The next committed result
for the harness clears the mark, so it runs once per changed digest or recipe; a start
before the commit tries again. Migration 0039 also marks every loaded route startup
left in `harness_readiness_pending`. The evaluation runs once per process with the
models already published; a route without one waits for the next start or Repair.

Repair, app-update staging and post-update activation reuse an installation only
when it passes the same layout validation as startup: exact receipt, ownership
marker, owned private state, and confined entrypoints. Otherwise Repair and staging
reinstall the exact recipe, so Repair cannot publish ready for an installation the next
start rejects. Activation discards the pending generation; the changed recipe then marks
the route due, and the post-upgrade evaluation reinstalls it.
`models/tla/ReadinessRepair.tla` models these rules.

Release configuration resolves through one fail-closed contract. The contract seals the numeric version, source commit, product identity, target, architecture, signing authority, channel manifest, and exact HTTPS update base into both the application package and its release receipt. macOS targets additionally seal the Apple team and minimum OS; Windows seals the Artifact Signing endpoint, account, profile, and publisher. The updater and publisher consume this contract rather than maintaining parallel identity or channel rules. See [ADR 0002](decisions/0002-desktop-release-contract.md).

Preview publication is a separate Linux job after the signed target matrix settles. It is reachable only from a version-matching `desktop-vX.Y.Z` tag and a protected GitHub environment using short-lived AWS OIDC credentials. Each successful target publishes through its own job, so a failed or disabled target cannot block another. The publisher revalidates target-specific candidate provenance, checksums, blockmaps, and feed metadata; writes immutable release/history objects; verifies the public CDN bytes; and changes the applicable Preview pointer last with an S3 precondition. Manual candidate builds cannot publish. Windows candidates use a separate manual workflow and version file. Their signing job requires exact-source main CI and Windows native qualification. Unsigned native qualification may run on pull requests without signing credentials. Windows publication remains excluded until signing and native desktop acceptance succeed. Stable additionally requires the interactive updater canary.

Stable promotion is a separate protected workflow on `main`. It requires committed screenshot-backed evidence that an older Preview installation discovered, installed, and relaunched into the exact candidate. The promoter revalidates the immutable Preview receipt and all hosted bytes, rejects non-increasing versions, writes immutable Stable history, and conditionally changes `latest-mac.yml` without rebuilding or re-signing. A retry can only recover the same byte-identical promotion. At this stage, release recovery means withdrawing a bad feed pointer before installation or issuing a forward-fix version; automatic application downgrades and local-data migration recovery are not updater responsibilities.

## Planned shared thread snapshots

The optional share service hosts immutable conversation-export V1 snapshots when accepted
history is asset-free and V2 snapshots when accepted authored Node Details carry visual content,
up to 16 MiB each. Rust owns export scrubbing; Electron main owns Auth0 and
one frozen byte sequence plus an owner-bound attempt/reference identity. Renderer
code receives neither bearer tokens nor direct network authority. Electron main
owns short-lived signed uploads to private S3 staging. A small HTTP API reserves and
finalizes uploads, lists shares, and accepts owner deletion. It never transports
the snapshot body through API Gateway. DynamoDB stores owner hashes and share
state; finalization validates the exact object before publication. Concurrent
retries of one owner-scoped attempt recover the same immutable result and charge
the UTC-day quota once.

Public graph records replace harness-authored layer, node, and action keys with
export-local ID aliases. Compiled detail bindings resolve against exact accepted
action provenance before Rust derives and validates a public package with those
aliases and a new integrity digest. Privacy filtering and asset collection consume
that same derived package. Ordinary export and accepted storage are unchanged.
Asset collection uses the same rich-detail privacy predicate as node export, so
omitted detail cannot leave orphan content. The V2 reader permits the canonical
base64 expansion of an 8 MiB decoded asset while the whole snapshot remains
bounded to 16 MiB. A renderer dialog binds to its source thread before preflight
and closes when navigation changes that source.

A separate Lambda streams safe inline snapshot HTML through a CloudFront-protected
function URL. The stripped browser shell reuses the production graph workspace.
Its versioned reader starts at the first accepted turn, keeps navigation out of
the URL, and disables execution while preserving nested layers and Node Details.
CloudFront reads only viewer assets from S3. Page reads check deletion and bypass
caches. Public code is outside desktop telemetry and has no reporting client.
These are planned service boundaries, not implemented product capabilities. See
[ADR 0011](decisions/0011-shared-thread-snapshot-service.md),
[ADR 0012](decisions/0012-immutable-shared-thread-snapshots.md), and PRD section 8.4.

The public viewer also has an explicit embed presentation for the website and
online white paper (PRD 8.4.1). It shares the snapshot reader, adapter, and
ProductWorkspace. Embed-specific chrome and reading behavior include compact attribution, a
canonical standalone-share link, equal wide graph/details columns, full-width
narrow details, explicit wheel zoom, and host-selected theme. The default
standalone template and hosted CSP contract remain unchanged. A loopback-only
fixture host exercises the iframe seam locally; hosted routing/framing policy
belongs to the private service and a later delivery slice.

## Developer Eval host

Relayer Eval starts from the checkout under Node and serves its dashboard on
loopback. It supervises the same Rust product/graph servers and harness host.
It has no Electron package or launch-time build. Developers explicitly rebuild shared
Rust and TypeScript artifacts when their inputs change. Each human review has a separate loopback origin;
a capability header authenticates requests and a gateway supplies only read-only
Rust authority plus a scoped human annotation credential. Browser-supplied
cookies never become upstream credentials. Judges use fresh Chromium contexts
and the shared production renderer. The terminal owns shutdown; browser tabs do
not own execution. See ADR 0003 and PRD section 9 for the product contract.

## Prime instruction discovery boundary

Prime filters native context-file admission to canonical descendants of the selected
workspace and its managed private agent directory. This preserves workspace-owned
instructions while preventing a standalone app workspace nested under a development
checkout from inheriting that checkout’s AGENTS.md. The same filter runs on resource
reload and excludes symlinks that resolve outside the admitted roots. This boundary
controls model instructions; it does not redefine filesystem read permissions.

### Explanatory presentation delivery

Production Codex and Prime configurations select the immutable V4 presentation
for new threads. It adds task-adaptive explanatory presentation without changing
V0–V3 or existing pins. Shared semantics belong in the presentation graph. Each
harness supplies a compact capability overview and language-appropriate public
API recipes; examples demonstrate mechanics, not response design. Native
parents are instructed to pass the pinned preference and applicable recipes to
graph-authoring children. That instruction is not automatic child injection.
Acceptance establishes graph integrity; rendered-result review establishes
whether the chosen representation communicates the task effectively.

## Typed interaction permissions (gated Slice 1)

Graph preparation freezes a closed permission description after validating origin
and context, before execution. One graph-owned authorization seam checks the exact
operation and active lifecycle. Atomic Return may consume `invoke.resolve` by
converting that action to node-owned expansion; a durable graph-only receipt admits
the exact old compiled binding. Search updates preserve each publication's scope.
The graph-server `--interaction-permissions` qualification flag defaults off.
Persistent attached-node mutation and portable conversion export remain unavailable;
see [ADR 0010](decisions/0010-typed-interaction-permissions.md).

## Discoverable icon authoring

Issue #624 extends the pinned Lucide vocabulary from one checked-in metadata catalog.
Catalog records join deterministic shared-search candidate ranking without becoming
accepted conversation Content. Graph-server discovery intersects image candidates
with the completion's existing asset authority; symbols are universal. Registered
image icons use the existing accepted asset read boundary and retain their pinned
bytes independently of catalog organization. Nodes and source-owned actions carry
legacy symbol strings or typed image references. Portable snapshots collect the
union of icon pins and visible Detail pins; omission of a private Detail does not
remove an independently visible graph icon. `complete(inputGraph)` and provider-native
execution ownership remain unchanged.
