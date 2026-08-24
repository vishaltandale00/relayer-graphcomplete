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
- a graph-tool `codex.basic` harness using the OpenAI Codex TypeScript SDK;
- a `prime.agent` harness that passes the current graph scope through Prime Agent's run-scoped IPython host context;
- an inference-free evaluation that starts the real Rust server and Node host and checks two interactions in one empty-project thread;
- a separate internal Relayer Eval desktop application that runs test-case × harness matrices through the product app server and opens their threads in the production graph/chat workspace;
- one Rust-owned product permission contract with Ask for approval (`ask`), Approve for me (`auto`), and Full access (`full`), translated by each harness configuration;
- Rust, TypeScript, Python, and process-level integration tests.

The Node runtime is split into explicit workspace packages: `@relayer/graph-client`, `@relayer/harness-host`, and `@relayer/eval-runner`. The Rust graph core is the only graph implementation; Node and Python code access it through typed clients rather than maintaining another graph store.

## Core design

- The selected harness owns model execution and any internal delegation; GraphComplete does not add another scheduler.
- GraphComplete owns graph records, active-interaction write authority, validation, immutable accepted history, and explicit submission.
- Product hosts such as Relayer own workspace lifecycle, durable product storage, activation, and user experience.
- The Node harness host owns live per-thread harness objects and provider-session resume state, not graph rules or product lifecycle.
- Provider adapters own authentication, model discovery, and provider-specific execution details. Product records use stable provider, model, harness, and permission identifiers.

The implemented basic loop is:

1. A trusted runtime supplies its existing positive-integer project/thread IDs; graph core creates the canonical user-interaction node and activates a capability for that node.
2. The Node host resolves the thread's harness once and keeps that object alive.
3. The host supplies the current graph scope only for that `complete()` call. The harness submits node objects, creates undirected edges, packages the exact visible layer, and adds the interaction's response navigate action. It may also attach useful navigate or invoke actions to output nodes; nested layers are an available authoring capability, not a per-node requirement.
4. The host reads the accepted output and closes the turn's in-memory graph scope. The calling runtime that minted the graph capability revokes its token after the Complete call settles. The host has a separate API credential and never receives graph control authority. A cached client from an earlier IPython turn cannot modify a later interaction.
5. `graph.submit(interactionNode)` recursively validates typed `expand` and `reference` navigation, exact source-layer provenance, and layer size, then atomically accepts only the current authored closure. Flat answers remain valid. See [ADR 0005](docs/decisions/0005-layered-navigation-contract.md).
6. Complete returns the resolved root layer for immediate display; later navigation reads the persisted layer.

Independent self-assessment will later add an optional review gate to this same loop.

The `prime.agent` adapter targets the run-context API in
[Prime Agent PR #1538](https://github.com/PrimeIntellect-ai/prime-agent/pull/1538).
Its inference-free adapter tests run in this repository. A clean live install
still needs that forked package exposed under its canonical
`@earendil-works/pi-coding-agent` package name; the PR branch is a monorepo, not
an installable npm subdirectory.

Prime Agent is one optional recursive harness implementation, not the product runtime. See the [visual Product Requirements](docs/prd/index.html), [Architecture](docs/architecture.md), [ADR 0006](docs/decisions/0006-harness-provider-agnostic-product-boundary.md), and the adapter-specific [ADR 0001](docs/decisions/0001-prime-agent-runtime-boundary.md).

## Run the GraphComplete runtime eval

The default run is deterministic and makes no inference calls. It launches the Rust graph server and Node host, completes two interactions through one live harness object with separately scoped graph capabilities, exercises the real TypeScript client, and saves `result.json` plus an interactive turn-navigable `index.html` under `.relayer/evals/runtime/<test-run-id>/<test-case-id>/<harness-configuration-name>/`:

```sh
npm run eval:basic
```

The opt-in live path requires the runner to select one or more named harness configurations. This command loads `harnesses/codex-basic.yaml`, resolves its `codex.basic` implementation, reuses the local Codex login, and then runs the structured judge:

```sh
npm run eval:basic:live -- --configuration codex-basic
```

Selecting two configurations expands the same harness-agnostic case into two executions in one test run. `codex-basic` and `codex-basic-high` both select the `codex.basic` implementation with different settings:

```sh
npm run eval:basic:live -- --configuration codex-basic --configuration codex-basic-high
```

The CLI resolves configuration files before case execution. Every saved execution records its `(testRunId, testCaseId, harnessConfigurationName)` identity, exact resolved configuration snapshot, and stable digest. Live inference is deliberately excluded from `npm test` and `npm run check`. Its saved HTML remains a lower-level debugging artifact; product-faithful review belongs to Relayer Eval.

## Relayer Desktop

Relayer Desktop is an Electron application backed by the Rust graph and product servers, a persistent Node harness host, and SQLite product storage. Each question becomes a canonical graph interaction, runs through the thread's pinned harness, and persists its accepted output for replay in the production graph/chat workspace. The current packaged provider adapter uses Codex login; provider-specific setup remains outside the product record contract.

```sh
npm install
npm run desktop:dev
```

Ask a question in the composer to open the thread immediately while the default `codex-basic` harness builds its graph in the background. Follow-up turns reuse the same harness/provider session while receiving a fresh graph capability. The graph workspace supports node arrangement and background-drag canvas panning; the same interactions are available in read-only Eval review windows.

To try the Prime Agent harness in the real Relayer chat, first build the Prime Agent
[run-context branch](https://github.com/vishaltandale00/prime-agent/tree/codex/run-scoped-kernel-context)
and expose its coding-agent workspace under the package's canonical name:

```sh
cd /path/to/prime-agent
npm install
npm run build

cd /path/to/relayer-graphcomplete
npm install
npm install --no-save /path/to/prime-agent/packages/coding-agent
npm run desktop:dev:prime
```

The Prime launcher selects `prime-agent-basic`, adds the local Python graph client
to every IPython kernel, and uses a separate ignored desktop profile. Prime Agent
reads its normal local provider credentials. Use
`npm run desktop:dev:prime -- --configuration prime-agent-deep` to try the deeper
configuration. Packaged builds expose only configurations whose implementations
and provider adapters are included and available; they omit the unpublished Prime Agent options.

Every thread pins a product permission profile before execution. New Thread loads the available Ask for approval, Approve for me, and Full access choices from Rust product policy, selects the product default, and sends that choice through ordinary thread creation. The saved thread shows its pinned profile. The public contract is `ask`, `auto`, or `full`; raw provider sandbox and approval flags remain harness implementation details. Full access is intentionally unrestricted and is not a hard filesystem or network boundary. See [ADR 0004](docs/decisions/0004-product-permission-profiles.md).

## Relayer Eval

Relayer Eval is a separate internal application and profile. Its dashboard configures cases, named harness configurations, and a judge; shows persisted test runs and aggregate results by harness; and opens any specific case × harness execution in a separate read-only production workspace window.

```sh
npm run eval-app:dev
```

The default `fixture-task-system` harness is deterministic and does not call inference, so the complete Eval UX can be exercised safely. `codex-basic` and `codex-basic-high` are also selectable for live internal runs. When the local Prime Agent package is linked as described above, the development picker also exposes `prime-agent-basic` and `prime-agent-deep` and supplies the Python graph client to their IPython kernels. Packaged Eval builds omit those unpublished development-only options. Build the unsigned internal application with `npm run eval-app:pack`.

The public Relayer and internal Relayer Eval builds use distinct application identifiers, entry points, data profiles, and dashboard assets. They share the graph runtime, harness host, app server, product records, API contracts, and production workspace. See [ADR 0003](docs/decisions/0003-shared-product-eval-workspace.md).

Build an unsigned development application for the host platform (Apple Silicon or Intel macOS, or Windows x64), including both Rust servers and the external graph client used by harness-authored scripts, with:

```sh
npm run desktop:pack
```

Desktop packaging and release metadata are target-aware. On macOS it packages Electron plus the Rust product and graph servers for Apple Silicon or Intel; on Windows x64 it packages the corresponding `.exe` services and Codex binary. Each target has independent Preview and Stable artifacts and feed pointers under `desktop/macos/arm64`, `desktop/macos/x64`, or `desktop/windows/x64`.

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
