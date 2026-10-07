# Issue #697: artifact viewer, phase 1

Product meaning is PRD §6.6 and §11.11 and ADR 0014, from the spec in #684. This folder holds the deterministic desktop proof and a captioned recording of it. No paid inference ran, and no release claim is made.

## Checkpoints and production seams

| Checkpoint | Promise | Deterministic observation |
| --- | --- | --- |
| ART-001 | An artifact layer has exactly one member node with valid artifact details | `crates/relayer-graph-core/tests/artifact_layers.rs`: wrong member counts, a plain node, an unknown renderer and an artifact node in a graph layer all reject with repairable issues; acceptance re-checks a node resubmitted after its layer. |
| ART-002 | Paths stay inside the thread folder, links included | `packages/harness-host/test/artifact-files.test.ts` with real files, a symlink and an outside folder; graph-core rejects `..`, absolute paths, unknown fields and bad kinds before any write. |
| ART-003 | Artifact content has no Relayer authority and no shared storage | Desktop run: the artifact's `fetch` of the product API is blocked, it has no cookie, no preload bridge and no parent; two artifact nodes get different storage; storage is empty on reopen. `test/artifact-viewer-main.test.mjs`: the scheme serves nothing outside the folder (`%2e%2e`, `..` and a symlink). |
| ART-004 | Acceptance pins fingerprints; the viewer reports drift and missing files | Graph-core `acceptance_pins_the_fingerprint_taken_just_before_it`. Desktop run: the fixture edits the site after submitting its node, and the first open shows no badge; an edit after acceptance shows Changed since this was accepted; a deleted video shows the missing card. `test/artifact-viewer-main.test.mjs`: desktop and host fingerprints agree. |
| ART-005 | Agents see their artifact before acceptance; the image is advisory | `packages/harness-host/test/draft-preview-bridge.test.ts`: the renderer gets the run's thread folder. `test/artifact-viewer-main.test.mjs`: Eval's headless renderer draws the artifact at the graph frame and at phone size. Desktop run: all 11 fixture artifact layers return a rendered preview (images in `agent-previews/`). |
| ART-006 | Address always visible, Esc returns, no actions or description, ⋯ holds Open externally | `test/artifact-viewer-renderer.test.mjs` on the production module. Desktop run: the toolbar hides after 3 s while the strip stays; Esc inside the artifact returns to the graph. |
| ART-007 | Parts open where asked | Desktop run, one case per kind: site, route on a phone, PDF (viewer started) and page 4, video and a 10–15 s segment that stops at 15 s, image, Markdown heading, https site. |
| ART-008 | Shares and Eval: https plays, others show a card | `test/public-share-viewer.test.mjs` boots the share viewer with an artifact layer; `test/artifact-viewer-renderer.test.mjs` covers the same module without a native view, as Eval review uses it. |

## Heavy entry point

`npm run test:desktop:artifact-viewer` runs the real `desktop/main/index.mjs` with the `fixture.artifact-viewer` harness in place of Codex. A question is typed into the composer and sent; the fixture builds a launch kit and authors the graph. The script then opens every artifact and writes `results.json` and screenshots.

`RELAYER_ARTIFACT_VIDEO=<file>.mp4` paces the same run and records it with captions. Frames come from the app itself (the window plus the artifact view), so nothing else on screen is recorded.

## Files

- `artifact-viewer-demo.mp4`: the recorded run.
- `results.json`: every check from the recorded run.
- `agent-previews/`: the preview image the agent saw for each artifact layer.
