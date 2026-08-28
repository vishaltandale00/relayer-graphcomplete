# Relayer GraphComplete

Relayer GraphComplete is an open-source, graph-native agent workspace with a harness- and provider-agnostic product contract. Each thread pins a supported execution configuration behind the same GraphComplete boundary.

The canonical external product boundary remains conceptually:

```ts
const result = await complete(inputGraph);
```

The root package does not export this top-level function yet. `inputGraph` points to the current user-interaction node. The selected thread harness keeps its working directory and provider session, while each `complete()` call receives a separate graph scope. A model turn ending does not mean the graph is complete; the harness must finish with `graph.submit(interactionNode)`.

The working desktop reaches this boundary through the Rust app server and persistent `HarnessHost`. There is intentionally no second structured-output path: every supported harness produces accepted product output through graph-tool writes and explicit submission.

## Status

Pre-alpha product and executable runtime. The repository now includes:

- a Rust SQLx/SQLite graph core and async loopback server with interaction-scoped capability tokens;
- object-based TypeScript and Python clients for nodes, undirected edges, layers, actions, and submission;
- a persistent Node harness host that loads named file-backed configurations, caches one harness object per thread, persists opaque provider resume state without graph credentials, and supports cancellation and deterministic disposal;
- graph-tool `codex.basic` and `claude.basic` harnesses using Relayer's Codex app-server bridge and the Claude Agent SDK respectively;
- a `prime.agent` harness that passes the current graph scope through Prime Agent's run-scoped IPython host context;
- an inference-free evaluation that starts the real Rust server and Node host and checks two interactions in one empty-project thread;
- a separate internal Relayer Eval desktop application that runs test-case × harness matrices through the product app server and opens their threads in the production graph/chat workspace;
- one Rust-owned product permission contract with Ask for approval (`ask`), Approve for me (`auto`), and Full access (`full`), translated by each harness configuration;
- Rust, TypeScript, Python, and process-level integration tests.

The Node runtime is split into explicit workspace packages: `@relayer/graph-client`, `@relayer/harness-host`, and `@relayer/eval-runner`. The Rust graph core is the only graph implementation; Node and Python code access it through typed clients rather than maintaining another graph store.

## Core design

- The selected harness owns model execution and any provider-native delegation it uses. Codex may use native subagents and Prime Agent may use its native RLM children; GraphComplete does not add another scheduler.
- GraphComplete owns graph records, active-interaction write authority, validation, accepted-history integrity, and explicit submission. Accepted records are immutable except for ADR 0005's exact one-shot leased-invoke target transition.
- Relayer owns a hidden, versioned personal-presentation profile. Each execution atomically pins one accepted profile completion through a control-only attachment; the harness renders it without adding preference records to visible response topology or exports. See [ADR 0009](docs/decisions/0009-personal-presentation-graph-attachments.md).
- Product hosts such as Relayer own workspace lifecycle, durable product storage, activation, and user experience.
- The Node harness host owns live per-thread harness objects and provider-session resume state, not graph rules or product lifecycle.
- Provider adapters own authentication, model discovery, and provider-specific execution details. Product records use stable provider, model, harness, and permission identifiers.

The implemented basic loop is:

1. A trusted runtime supplies its existing positive-integer project/thread IDs; graph core creates the canonical user-interaction node and activates a capability for that node.
2. The Node host resolves the thread's harness once and keeps that object alive.
3. The host supplies the current graph scope only for that `complete()` call. Harness-authored programs give every persisted node, edge, layer, and action an explicit stable client key, so editing and rerunning the whole program updates the same current-interaction drafts while their identity-owning context remains unchanged. An action's source node is part of that identity, so repair keeps each draft action on its original source node. The harness submits node objects, creates undirected edges, packages the exact visible layer with one versioned normalized placement per node, and adds the interaction's response navigate action. It may also attach useful navigate or invoke actions to output nodes; nested layers are an available authoring capability, not a per-node requirement. An intentionally abandoned orphan draft layer may be preserved as stopped history with `discardLayer`; authors must not invent navigation merely to make abandoned work reachable.
4. The host reads the accepted output and closes the turn's in-memory graph scope. The calling runtime that minted the graph capability revokes its token after the Complete call settles. The host has a separate API credential and never receives graph control authority. A cached client from an earlier IPython turn cannot modify a later interaction.
5. `graph.submit(interactionNode)` recursively validates typed `expand` and `reference` navigation, exact source-layer provenance, layer size, and complete authored layouts, then atomically accepts only the current authored closure. Flat answers remain valid. See [ADR 0005](docs/decisions/0005-layered-navigation-contract.md).
6. Complete returns the resolved root layer for immediate display; later navigation reads the persisted layer.

Independent self-assessment will later add an optional review gate to this same loop.

Issue #55's accepted, not-yet-implemented invoke-resolution contract extends this
same boundary without adding another authoring API. An invoke-created interaction
carries the exact source/action lease pair, with source interaction provenance kept
private by graph core; ordinary `graph.submit(interactionNode)`
atomically fills that accepted `invoke` action's target with the accepted result
root exactly once. Derived neighbor reads expose the source node without an
authored edge, and pre-lease invocations are not backfilled.

The `prime.agent` adapter uses the exact reviewed Prime Agent build recorded in
`vendor/prime-agent/manifest.json`. Its four content-addressed package archives,
runtime API contract, production configurations, and Python graph client are
installed and packaged by the ordinary repository build. Prime configurations
are omitted from the runtime catalog unless that complete contract passes the
desktop preflight. Unavailable packaged runtimes remain in the authoritative
catalog with a stable reason, but ordinary Harness Settings, onboarding, and
model selection show only harnesses with an exactly resolvable connected
provider, available model, and enabled family. Prime Ask and Auto currently
require the macOS boundary; Windows therefore records both packaged Prime
configurations as unavailable.

Prime Agent is one optional recursive harness implementation, not the product runtime. See the [visual Product Requirements](docs/prd/index.html), [Architecture](docs/architecture.md), [ADR 0006](docs/decisions/0006-harness-provider-agnostic-product-boundary.md), and the adapter-specific [ADR 0001](docs/decisions/0001-prime-agent-runtime-boundary.md).

## Harness-owned browser use

The shipped Codex, Claude, and Prime harnesses can each attach to an already-running Chrome instance at `http://127.0.0.1:9222`. Start Chrome yourself with remote debugging enabled and a dedicated, non-default persistent profile; Chrome 136 and later do not honor remote-debugging switches for the default data directory. Relayer does not launch, stop, authenticate, or coordinate Chrome, and it has no shared browser service or browser setting.

- `codex.basic` uses Codex's native MCP support with the packaged `chrome-devtools-mcp@1.8.0` helper. Its helper process follows the Codex app-server lifecycle; Chrome does not. If the exact packaged helper is missing or incompatible, only this Codex browser route is omitted and Desktop continues normally.
- `claude.basic` supplies one bounded in-process Claude SDK MCP tool for navigation, text reads, clicks, and fills. With one page it can attach implicitly; with multiple pages the agent must provide a unique target ID, URL substring, or title substring. The helper closes only its own fetch/WebSocket connections.
- `prime.agent` discovers Prime Agent's bundled dependency-free Python browser skill. The skill uses in-process loopback CDP inside Prime's existing kernel confinement and closes only its own connections. Prime Ask and Auto retain their current macOS confinement requirements.

Browser use stays inside each harness's existing native approval unit. Ask, Approve for me, and Full access remain the same `ask`, `auto`, and `full` product profiles described below; Relayer does not classify or approve individual actions inside a native browser tool or cell. For `claude.basic`, Ask leaves the coarse browser MCP tool unlisted, Auto keeps SDK `acceptEdits` and pre-approves that one code-owned tool through `allowedTools`, and Full keeps `bypassPermissions`. SDK 0.3.250 therefore runs the Auto unit without a user prompt or a separate model or Relayer reviewer. Codex and Prime retain their existing native enclosing-tool or cell approval. No browser-specific permission mode or inner-action review is added.

Unsupported setup fails as an ordinary harness limitation: Codex reports its native MCP connection or packaged-helper failure, Claude returns a sanitized unavailable/no-page/ambiguous-target/timeout error, and Prime raises its browser skill's loopback CDP failure. None of these paths may claim unread content or an action that did not execute. Site behavior, authenticated access, prompts, downloads, CAPTCHA handling, and compatibility are harness- and site-specific rather than a cross-harness guarantee. The sanitized delivery ledger is in [issue #257 evidence](docs/evidence/issue-257-browser-harnesses/README.md).

## Run the GraphComplete runtime eval

The default run is deterministic and makes no inference calls. It launches the Rust graph server and Node host, completes two interactions through one live harness object with separately scoped graph capabilities, exercises the real TypeScript client, and saves `result.json` plus an interactive turn-navigable `index.html` under `.relayer/evals/runtime/<test-run-id>/<test-case-id>/<harness-configuration-name>/`:

```sh
npm run eval:basic
```

The opt-in live path requires the runner to select one or more named harness configurations and receive an explicit managed Codex executable path through `RELAYER_CODEX_BINARY`. This command loads `harnesses/codex-basic.yaml`, resolves its `codex.basic` implementation, reuses the matching Codex login, and then runs the structured judge:

```sh
RELAYER_CODEX_BINARY=/absolute/path/to/managed/codex npm run eval:basic:live -- --configuration codex-basic
```

Selecting two configurations expands the same harness-agnostic case into two executions in one test run. `codex-basic` and `codex-basic-high` both select the `codex.basic` implementation with different settings:

```sh
npm run eval:basic:live -- --configuration codex-basic --configuration codex-basic-high
```

An additional opt-in live case exercises graph-authoring recovery through the
ordinary Codex harness Complete path. It requires a whole-program stable-key
replay, observes orphan validation, explicitly discards the orphan twice, and
then verifies the accepted output plus the stopped layer through graph control:

```sh
npm run eval:graph-repair:live -- --configuration codex-basic
```

Its durable `result.json` and viewer are written under
`.relayer/evals/runtime/<test-run-id>/graph-authoring.replay-repair/<configuration>/`.
The live command is not part of `npm run check` and is the only part of this
case that invokes inference; its evidence parser and grader run in the default
deterministic test suite.

The opt-in Ask-profile desktop proof intentionally bypasses npm so inherited
`NODE_OPTIONS` cannot execute before its trust boundary. Invoke the fixed system
shell by its repository path with an explicit, operator-trusted absolute path
to the installed Node executable, for example on an Apple Silicon Homebrew install:

```sh
RELAYER_CAPTURE_ASK_PROFILE_EVIDENCE=1 /bin/sh "$PWD/scripts/launch-ask-profile-evidence.sh" \
  /opt/homebrew/opt/node/bin/node
```

The command is intentionally macOS-only: the fixed system shell removes inherited
Node, Electron, OpenSSL, and dynamic-loader overrides before the first capture
process starts, executes the launcher from already-open committed bytes after
unlinking its snapshot pathname, authenticates the remaining private-snapshot controls,
and rejects an Electron executable that changes after macOS code-signature and
byte authentication. The explicitly supplied Node installation, the
checked-out shell file, and the installed Electron package are the documented
pre-invocation trust roots; none of their paths is read from the environment or
discovered through `PATH`. The installed Electron package and the absence of a
concurrent same-user mutation between its final authentication and spawn are
pre-invocation trust assumptions; the launcher detects ordinary identity or byte
changes but does not claim an immutable pathname across that interval.
Unsupported platforms fail before Electron or paid inference runs.

The CLI resolves configuration files before case execution. Every saved execution records its `(testRunId, testCaseId, harnessConfigurationName)` identity, exact resolved configuration snapshot, and stable digest. Live inference is deliberately excluded from `npm test` and `npm run check`. Its saved HTML remains a lower-level debugging artifact; product-faithful review belongs to Relayer Eval.

## Relayer Desktop

Relayer Desktop is an Electron application backed by the Rust graph and product servers, a persistent Node harness host, and SQLite product storage. Each question becomes a canonical graph interaction, runs through the thread's pinned harness, and persists its accepted output for replay in the production graph/chat workspace. The current packaged provider adapter uses Codex login; provider-specific setup remains outside the product record contract.

```sh
npm install
npm run desktop:dev
```

Ask a question in the composer to open the thread immediately while the default `codex-basic` harness builds its graph in the background. The product configuration uses layered navigation, makes Codex-native subagents available when useful, and retains medium reasoning while the model remains an independent picker selection. Follow-up turns reuse the same harness/provider session while receiving a fresh graph capability. The accepted layer owns semantic node placement in normalized coordinates. The graph workspace projects it into a stable world plane while fit, pan, zoom, resizing, and the details inspector change only the camera. Dragging a node is an ephemeral local view override. Historical coordinate-free layers use a deterministic viewport-independent fallback without rewriting accepted history. Product and read-only Eval use this same renderer path. `codex-basic-high` remains an internal Eval configuration and is rejected by Relayer Desktop even as a development override. Before startup recovery, a runtime that includes `codex-basic` but omits `codex-basic-high` migrates product threads formerly pinned to the high configuration; Eval catalogs that still include both configurations are unchanged. Harness-state schema v6 backs up older state, then preserves provider continuity when Desktop registers the exact layered `codex-basic` replacement for a revision-1 or revision-2 schema-v4/v5 Codex session, including deferred legacy sessions. Eval registration keeps its high sessions unchanged.

To try the Prime Agent harness in the real Relayer chat, install the repository
dependencies and use the checked-in runtime:

```sh
cd /path/to/relayer-graphcomplete
npm install
npm run desktop:dev:prime
```

The Prime launcher verifies the vendored manifest, installed package versions,
required API surface, production configuration files, and trusted Python graph
client before selecting `prime-agent-basic`. It uses a separate ignored desktop
profile. Use
`npm run desktop:dev:prime -- --configuration prime-agent-deep` to try the deeper
configuration. Packaged builds carry `prime-agent-basic` and `prime-agent-deep`;
the development-only layered Luna configuration is not packaged.

Every thread pins a product permission profile before execution. New Thread loads the available Ask for approval, Approve for me, and Full access choices from Rust product policy, selects the product default, and sends that choice through ordinary thread creation. The saved thread shows its pinned profile. The public contract is `ask`, `auto`, or `full`; raw provider sandbox and approval flags remain harness implementation details. Full access is intentionally unrestricted and is not a hard filesystem or network boundary. See [ADR 0004](docs/decisions/0004-product-permission-profiles.md).

Prime Agent binds the same three IDs when the installed Prime runtime exposes
both version-1 run-scoped authority APIs and the host can initialize its process
boundary. On macOS, Ask and Auto run the IPython kernel tree inside an attested
Seatbelt workspace-write boundary with network access enabled. Ask uses the
ordinary desktop approval lifecycle; Auto deterministically permits only the
recognized IPython cell after boundary attestation. Full passes no bounded
authority and retains unrestricted subprocess support and the unrestricted
disclosure. The bounded modes preserve loopback TCP for Jupyter but deny
subprocesses, launchd jobs, Unix-domain outbound sockets, AppleEvents, and Mach
service access. Unsupported bounded runtimes fail before inference.

## Relayer Eval

Relayer Eval is a separate internal application and profile. Its dashboard configures cases, named harness configurations, and a judge; shows persisted test runs and aggregate results by harness; and opens any specific case × harness execution in a separate read-only production workspace window.

```sh
npm run eval-app:dev
```

The default `fixture-task-system` harness is deterministic and does not call inference, so the complete Eval UX can be exercised safely. `codex-basic` and `codex-basic-high` are also selectable for live internal runs. Development Eval exposes Prime configurations when the checked-in runtime passes preflight and supplies the trusted Python graph client to their IPython kernels. Packaged Eval builds still omit those internal options. Build the unsigned internal application with `npm run eval-app:pack`.

The candidate catalog includes twelve deep calibration cases: seven coding cases, including three evaluator-owned greenfield products, and five research, planning, creative, and forecasting cases. They are a graph-presentation calibration corpus for recursive-judge tuning and human labeling, not the full verifiable-work benchmark. Each materializes an isolated Git workspace and records a sealed reference, lightweight deterministic completion gates, and an outcome rubric separately from graph-presentation judgment. Coding fixtures begin with a failing behavioral contract; open-research fixtures provide no curated source bundle and require the candidate to leave a durable deliverable and source trail. A passing completion gate does not claim that the implementation or artifact is substantively good. Candidate cases remain calibration-only until human review promotes them.

To run the paid, opt-in personal-presentation comparison through the real Eval
application, use an isolated profile and an explicitly trusted managed Codex
binary:

```sh
RELAYER_EVAL_USER_DATA_DIR=/absolute/path/to/isolated-profile \
RELAYER_CODEX_BINARY=/absolute/path/to/managed/codex \
RELAYER_EVAL_AUTORUN_PERSONAL_PRESENTATION=1 \
./node_modules/.bin/electron desktop/eval-main/index.mjs
```

The autorun holds the case, judge, model selection, and harness settings fixed,
then executes only the checked-in V0 and V1 configurations. It remains disabled
by default and outside `npm run check`.

The public Relayer and internal Relayer Eval builds use distinct application identifiers, entry points, data profiles, and dashboard assets. They share the graph runtime, harness host, app server, product records, API contracts, and production workspace. See [ADR 0003](docs/decisions/0003-shared-product-eval-workspace.md).

Build an unsigned development application for the host platform (Apple Silicon or Intel macOS, or Windows x64), including both Rust servers and the external graph client used by harness-authored scripts, with:

```sh
npm run desktop:pack
```

Desktop packaging and release metadata are target-aware. On macOS it packages Electron plus the Rust product and graph servers for Apple Silicon or Intel; on Windows x64 it packages the corresponding `.exe` services. Native Claude and Codex runtimes are installed from integrity-verified vendor npm artifacts only when a compatible provider is connected, rather than being carried in the application bundle. Each target has independent Preview and Stable artifacts and feed pointers under `desktop/macos/arm64`, `desktop/macos/x64`, or `desktop/windows/x64`.

The accepted desktop release contract starts at version `0.2.0`, supports Apple Silicon and Intel on macOS 13 or newer plus Windows x64, and uses the existing Relayer Developer ID identity on macOS and Azure Artifact Signing on Windows. Signed candidates fail closed unless the worktree is clean and target-specific signing, provenance, and the sealed update URL are present. Build a signed candidate without publishing it with `RELAYER_DESKTOP_TARGET` set to `macos-arm64`, `macos-x64`, or `windows-x64`:

```sh
npm run desktop:dist:preview
```

Preview and Stable are channels for the same `ai.relayer.desktop` application. macOS uses `beta-mac.yml` and `latest-mac.yml`; Windows uses `beta.yml` and `latest.yml`. The exact target-specific Preview artifact is promoted to Stable after its real update canary rather than rebuilt. See [ADR 0002](docs/decisions/0002-desktop-release-contract.md).

The `Desktop Signed Preview Candidates` workflow currently builds sealed Apple Silicon and Intel candidates. It publishes only for a matching protected `desktop-vX.Y.Z` tag whose commit is on `origin/main`. Publication uploads immutable versioned artifacts, verifies their public bytes, and conditionally moves each target's Preview pointer last. A manual workflow run never changes an update feed. One failed macOS target does not block publication for the other. The Windows candidate job remains disabled until the exact certificate publisher is configured. Windows publication remains excluded until Azure Artifact Signing succeeds, and Stable additionally requires the interactive Windows updater canary.

After that exact Preview version passes the committed previous-version updater canary, the protected `Promote Relayer Desktop to Stable` workflow can move that target's `latest-mac.yml` or `latest.yml` pointer to the same artifact bytes. Stable promotion does not rebuild or re-sign the application and rejects downgrades, replacement bytes, unverified canaries, and concurrent pointer changes.

The [desktop release operations runbook](docs/desktop-release-operations.md) covers Azure Artifact Signing, GitHub OIDC, target-specific AWS authority, the native Apple Silicon and Intel canaries, and the interactive Windows 11 canary. Its Windows environment has a reviewable, non-CI [Azure deployment definition](infra/azure/desktop-canary/README.md) that remains inert until an operator explicitly approves and runs it. Reviewable [GitHub release rulesets](infra/github/desktop-release-authority/README.md) and a read-only live authority audit keep branch, tag, environment, and OIDC policy aligned with the workflows.

The living [Product Requirements](docs/prd/index.html) webpage records what is verified, partial, open, deferred, and planned for the updater slice. Run `npm run prd` to review it and save local comments to the ignored `docs/prd/comments.json` file. User-visible proof is stored with the PRD under `docs/prd/assets/evidence/`.

## Development

Requires Node.js 22.8 or newer.

```sh
npm install
npm run check
npm run build
```

## License

Apache-2.0
