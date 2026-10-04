# Agent draft preview evidence

The accepted behavior is PRD §11.10, PREV-001 through PREV-005 (issues #617 and #618). A successful `submitLayer`, and `submitNode` for a node with authored detail, returns an image of the agent's own draft. The image is advisory and never affects acceptance.

## Deterministic checkpoints

- **PREV-001:** `crates/relayer-graph-server/src/draft_preview.rs` tests use a fake render bridge. They cover layer and authored-node previews, no image for plain nodes, fresh images after a change, cached images for identical content, a failed render that still commits the write, no `preview` field without support or a renderer, the render ceiling, and interaction scoping.
- **PREV-002:** `packages/graph-client/test/preview.test.ts` and `python/relayer-graph/tests/test_preview.py` cover the `preview` field and the written PNG. `packages/harness-host/test/draft-preview-bridge.test.ts` covers the transient preview folder, the render route's authorization, and metadata-only trace events. `packages/harness-host/test/codex-basic.test.ts` and `configuration.test.ts` cover the flag, the Codex environment, and guidance omission. `test/draft-preview-framing.test.mjs` covers sizing a page frame to the in-app frame.
- **PREV-002, Claude (#618):** `packages/harness-host/test/claude-basic.test.ts` covers the preview folder in the environment, and registering and pre-approving `view_graph_preview` in Ask, Auto and Full only when the host granted a folder. It also covers the guidance, and the tool handler: it returns image content only for a PNG directly inside the folder and refuses outside paths, subfolders, symlink escapes and non-PNG files. Its trace records the file name and size, never the image.
- **PREV-002, Prime (#618):** `python/relayer-graph/tests/test_visual_authoring.py` covers `GraphSession.submit_node` and `submit_layer` keeping the preview the host wrote. `packages/harness-host/test/prime-visual-authoring.test.ts` sends a real Python-built layer through the host bridge. It checks that the same body reaches the graph server, that the PNG lands in the host's folder, and that rejections return for repair. `packages/harness-host/test/prime-agent.test.ts` covers handler registration and its authority fence, `attach_image` guidance only with a folder, trace redaction of image data, and a tool-result image reaching the real native provider payload only when the model accepts images. `test/prime-visual-integration.test.mjs` runs the real host handlers, with Prime's envelope fields, against the real graph server. The Python tests emulate the reply envelope Prime's kernel adds; no deterministic test runs a real Prime kernel, so PREV-005 is the proof for that hop. `test/agent-preview-viewers.test.mjs` covers how the PREV-005 runner reads each harness's trace.
- **PREV-003:** `npm run test:eval-graph-preview` runs `fixture.graph-preview` through the real Eval host process and its Playwright renderer. It checks the author, see, fix and see-again loop, the cached repeat, metadata-only trace events, and the three PNGs Eval keeps beside the candidate trace.

## Real Electron capture (PREV-004)

Run `npm run prepare:renderer`, `cargo build -p relayer-app-server -p relayer-graph-server`, `npm run build:packages`, then `npm run evidence:agent-preview`. The runner drives `fixture-graph-preview` through the real graph server, harness host and Electron render bridge, once per theme. It checks:

- each PNG's size against the in-app frames: the graph pane is 1164×703 with Node Details closed, and the Node Details panel is 576×844;
- that light and dark images differ;
- that storage planted in the `draft-preview-capture` partition does not survive the next render;
- that no capture window remains.

It then opens a real 1420×900 product window on the accepted turn and re-measures both frames, failing if they drift from `DRAFT_PREVIEW_FRAMES`. The PNGs and `receipt.json` here are the inspected output. The receipt binds them to the source files that produced them.

## Live model proof (PREV-005)

`RELAYER_AGENT_PREVIEW_LIVE=1 npm run evidence:agent-preview:live -- --harness <name>` spends paid inference through the Eval profile's connected provider for that harness. It runs the harness on `empty-project.hierarchical-overview.single-turn` and writes its receipt under `.relayer/evidence/agent-preview-live/<name>/`. It passes only when the turn was accepted and, before the successful `graph.submit`, the model received a `submitLayer` preview image:

- `codex-basic` (the default): Codex's trace shows an `imageView` of it.
- `claude-basic`: `view_graph_preview` returned it.
- `prime-agent-basic`: `attach_image` attached it to an ipython result.

It makes no claim that previews improve quality.

Result on 2026-09-30: run `run-2026-09-30T06-13-12-053Z-74edf54b` passed. The turn was accepted, and the Eval turn limit was raised to 30 minutes with `RELAYER_EVAL_TURN_TIMEOUT_MS`. The host rendered 18 node and 5 layer previews. Codex opened two layer previews with `view_image` before its successful `graph.submit` at 06:27:21Z. `live/` holds the receipt and the two images the model viewed.

Two earlier attempts did not produce a result. One hit Eval's default 10-minute turn limit before any `submitLayer`; the 13 node renders in it took about 3 s in total. The other could not start because Codex had written a project trust entry into the Eval profile's `config.toml`. That is a separate, pre-existing Eval problem.

The #618 runs on 2026-10-03 used commit `3f302e69` on macOS arm64. The receipts do not record the model, so it is named here.

**`claude-basic`: passed on Opus 5.5, after a failure on Sonnet 5.5.**
- **Sonnet 5.5 (failed):** run `run-2026-10-03T02-24-10-187Z-0a5a3843` was accepted, and the host rendered 2 layer previews. The model then called `graph.submit` from the same program that wrote the layers, and it never called `view_graph_preview`. The guidance was in its prompt. Its final message said it had submitted without viewing the draft previews. `live/claude-basic/sonnet-5.5-failed-receipt.json` keeps this receipt.
- **Opus 5.5 (passed):** run `run-2026-10-03T03-05-43-654Z-49f1a9e0` was accepted, and the host rendered 10 layer previews. Before its successful `graph.submit` at 03:08:50Z, the model viewed two of the first-pass layer previews with `view_graph_preview`: layers 18 and 21, at 03:08:05Z and 03:08:06Z. All five layers then rendered again with new fingerprints before the submit. `live/claude-basic/` holds the receipt and the two images the model viewed.

**`prime-agent-basic`: passed** on OpenRouter `z-ai/glm-5.3-flash`. The profile's default OpenRouter models are text-only on OpenRouter, so `attach_image` would have refused. Run `run-2026-10-03T02-26-16-617Z-e30846e7` was accepted, and the host rendered 16 node and 5 layer previews. `attach_image` attached the root layer 17 preview to a successful ipython result at 02:29:42Z, before the successful `graph.submit` at 02:29:43Z. The kernel read the image from the host's per-turn preview folder under the macOS temporary directory. This proves the real Prime kernel reply hop and the macOS bounded kernel's read of that folder. `live/prime-agent-basic/` holds the receipt and the image.
