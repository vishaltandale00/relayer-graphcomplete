# Relayer GraphComplete

Relayer GraphComplete is an open-source recursive graph-construction system built on [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).

The canonical future product boundary remains conceptually:

```ts
const result = await complete(inputGraph);
```

This top-level function is not exported by the first runtime slice yet. `inputGraph` is the pointer to the current user-interaction node. The selected thread harness already holds its graph capability, working directory, and provider session. A root model ending its turn does not mean the graph is complete; the harness must finish with `graph.submit(interactionNode)`.

The executable first slice enters through the persistent `HarnessHost` while the app-server integration behind the canonical product boundary remains future work. There is intentionally no second structured-output harness path: accepted product output must come from graph-tool writes and explicit submission.

## Status

Pre-alpha executable runtime slice. The repository now includes:

- a Rust SQLx/SQLite graph core and async loopback server with interaction-scoped capability tokens;
- object-based TypeScript and Python clients for nodes, undirected edges, layers, actions, and submission;
- a persistent Node harness host that loads named file-backed configurations, caches one harness object per thread, persists opaque provider resume state without graph credentials, and supports cancellation and deterministic disposal;
- a graph-tool `codex.basic` harness using the OpenAI Codex TypeScript SDK;
- an inference-free evaluation that starts the real Rust server and Node host and checks two interactions in one empty-project thread;
- a separate internal Relayer Eval desktop application that runs test-case × harness matrices through the product app server and opens their threads in the production graph/chat workspace;
- Rust, TypeScript, Python, and process-level integration tests.

The Node runtime is split into explicit workspace packages: `@relayer/graph-client`, `@relayer/harness-host`, and `@relayer/eval-runner`. The Rust graph core is the only graph implementation; Node and Python code access it through typed clients rather than maintaining another graph store.

## Core design

- Prime Agent owns recursive model execution when the production harness is added; GraphComplete does not add another scheduler.
- GraphComplete owns graph records, active-interaction write authority, validation, immutable accepted history, and explicit submission.
- Product hosts such as Relayer own workspace lifecycle, durable product storage, activation, and user experience.
- The Node harness host owns live per-thread harness objects and provider-session resume state, not graph rules or product lifecycle.

The implemented basic loop is:

1. A trusted runtime supplies its existing positive-integer project/thread IDs; graph core creates the canonical user-interaction node and activates a capability for that node.
2. The Node host resolves the thread's harness once and keeps that object alive.
3. The harness submits node objects, creates undirected edges, packages the exact visible layer, and adds the interaction's response navigate action. It may also attach useful navigate or invoke actions to output nodes; nested layers are an available authoring capability, not a per-node requirement.
4. `graph.submit(interactionNode)` recursively validates navigate targets and atomically accepts only the reachable drafts.
5. Complete returns the resolved root layer for immediate display; later navigation reads the persisted layer.

Independent self-assessment will later add an optional review gate to this same loop.

See the [visual Product Requirements](docs/prd/index.html), [Architecture](docs/architecture.md), and [ADR 0001](docs/decisions/0001-prime-agent-runtime-boundary.md).

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

Relayer Desktop is an Electron application backed by the Rust graph and product servers, a persistent Node harness host, and SQLite product storage. Each question becomes a canonical graph interaction, runs through the thread's pinned harness, and persists its accepted output for replay in the production graph/chat workspace. Codex provider setup remains an Electron-owned service.

```sh
npm install
npm run desktop:dev
```

Ask a question in the composer to run the default `codex-basic` harness and render its accepted graph. Follow-up turns reuse the same harness/provider session while receiving a fresh graph capability.

## Relayer Eval

Relayer Eval is a separate internal application and profile. Its dashboard configures cases, named harness configurations, and a judge; shows persisted test runs and aggregate results by harness; and opens any specific case × harness execution in a separate read-only production workspace window.

```sh
npm run eval-app:dev
```

The default `fixture-task-system` harness is deterministic and does not call inference, so the complete Eval UX can be exercised safely. `codex-basic` and `codex-basic-high` are also selectable for live internal runs. Build the unsigned internal application with `npm run eval-app:pack`.

The public Relayer and internal Relayer Eval builds use distinct application identifiers, entry points, data profiles, and dashboard assets. They share the graph runtime, harness host, app server, product records, API contracts, and production workspace. See [ADR 0003](docs/decisions/0003-shared-product-eval-workspace.md).

Build an unsigned Apple Silicon development application, including both Rust servers and the external graph client used by harness-authored scripts, with:

```sh
npm run desktop:pack
```

Desktop packaging intentionally targets Apple Silicon only. The build packages Electron plus the Rust product and graph servers for `arm64`, then rejects the package if either bundled server has a different architecture or the external graph-client module is missing. Intel Mac support is deferred.

The accepted desktop release contract starts at version `0.2.0`, supports Apple Silicon on macOS 13 or newer, and uses the existing Relayer Developer ID identity. Signed candidates fail closed unless the worktree is clean and signing, notarization, provenance, and the sealed update URL are all present. Build a signed, notarized candidate without publishing it with:

```sh
npm run desktop:dist:preview
```

Preview and Stable are channels for the same `ai.relayer.desktop` application. Preview uses `beta-mac.yml`; Stable uses `latest-mac.yml`. The exact Preview artifact is promoted to Stable after the real update canary rather than rebuilt. See [ADR 0002](docs/decisions/0002-desktop-release-contract.md).

The `Desktop Signed Preview Candidate` workflow always builds a sealed candidate, but publishes only for a matching protected `desktop-vX.Y.Z` tag whose commit is on `origin/main`. Publication uploads immutable versioned artifacts, verifies their public bytes, and conditionally moves `beta-mac.yml` last. A manual workflow run never changes the update feed.

After that exact Preview version passes the committed previous-version updater canary, the protected `Promote Relayer Desktop to Stable` workflow can move `latest-mac.yml` to the same artifact bytes. Stable promotion does not rebuild or re-sign the application and rejects downgrades, replacement bytes, unverified canaries, and concurrent pointer changes.

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
