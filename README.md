# Relayer GraphComplete

Relayer GraphComplete is an open-source recursive graph-construction system built on [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).

The canonical boundary is:

```ts
const result = await complete(inputGraph, options);
```

The input is an existing graph. The output is a graph that was accepted or stopped with an explicit reason. A root model ending its turn does not mean the graph is complete.

## Status

Pre-alpha architecture skeleton. The public contracts exist; the Prime Agent runtime and graph algorithm are intentionally not implemented yet.

## Core design

- Prime Agent owns model execution, nested agent sessions, parent-child messaging, persistence, and continuation.
- GraphComplete owns recursive content construction, scope ownership, self-assessment, adaptive depth, graph mutations, acceptance, and budget-aware stopping.
- Product hosts such as Relayer own workspace lifecycle, durable product storage, activation, and user experience.
- Generic runtime improvements should be contributed to Prime Agent. Graph-specific behavior stays here.

The intended recursive loop is:

1. A content owner inspects its assigned scope and the workspace.
2. A separate reviewer checks child structure and coverage before judging the node itself.
3. The reviewer accepts the scope or requests evidence, revision, decomposition, or stopping.
4. Decomposition creates three to eight child content owners unless the correct child count is zero.
5. Every child repeats the same ownership and self-assessment process.
6. Parent acceptance depends on sufficient child coverage, not direct control over every deeper decision.

See [Architecture](docs/architecture.md) and [ADR 0001](docs/decisions/0001-prime-agent-runtime-boundary.md).

## Desktop Slice 1

The first Relayer Desktop slice is an Electron shell for Codex provider setup, the New Thread entry surface, full-page Settings, appearance, folder selection, and the initial local interaction view. Agent execution and graph output are intentionally not connected in this slice.

```sh
npm install
npm run desktop:dev
```

Build an unsigned Apple Silicon development application with:

```sh
npm run desktop:pack
```

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
