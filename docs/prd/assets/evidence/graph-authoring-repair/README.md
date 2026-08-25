# Graph-authoring repair evidence

This opt-in, zero-inference workflow is the visual and deterministic evidence path for GitHub issue
#134. It launches the real Rust graph server, Rust product app server, isolated SQLite stores, an
Electron `BrowserWindow`, and the production `ProductWorkspace`. It does not render mock HTML.

The deterministic harness deliberately:

1. authors a graph plus an orphan draft layer with explicit stable client keys;
2. confirms that submission rejects the orphan;
3. reruns the complete authoring program with the same keys and confirms every record ID is reused;
4. confirms a second root action key is rejected without persistence;
5. discards the orphan twice, accepts the intended graph, and reads the discarded layer back as
   `stopped` after acceptance.

The production workspace cannot and should not expose the abandoned draft. The screenshot and video
therefore prove that the intended accepted graph renders and navigates in the real product. The
same-run `deterministic-artifact.json` proves the stopped-layer and replay-safety invariants without
asking viewers to infer hidden database state from the UI.

## Capture command

Build the integrated feature first:

```sh
npm run build
```

Capture the deterministic artifact and production-workspace screenshot:

```sh
RELAYER_CAPTURE_GRAPH_AUTHORING_REPAIR_EVIDENCE=1 electron scripts/capture-graph-authoring-repair-evidence.mjs
```

Capture the real Electron window as an MP4 in the same run:

```sh
RELAYER_CAPTURE_GRAPH_AUTHORING_REPAIR_EVIDENCE=1 RELAYER_RECORD_GRAPH_AUTHORING_REPAIR_VIDEO=1 electron scripts/capture-graph-authoring-repair-evidence.mjs
```

The run writes `manifest.json`, `deterministic-artifact.json`,
`accepted-replay-safe-graph.png`, and, when requested, `graph-authoring-repair.mp4` into this
directory. Review the manifest hashes and ensure `workingTreeDirty` has the intended value before
using the files as PR evidence.

## Recording constraints

- Video capture records frames directly from the real Electron `BrowserWindow`, then `ffmpeg`
  converts them to a browser-friendly MP4. `ffmpeg` and `ffprobe` must be installed.
- The recording is intentionally silent and contains only the Relayer window content. It does not
  record the desktop, microphone, or system audio.
- Do not run the capture until the integrated graph client, server, core, and renderer build is
  ready. A failed attempt is not evidence; inspect several MP4 timestamps before attaching it to
  the PR.

`manifest.schema.json` documents the generated manifest shape. It is not capture evidence.
