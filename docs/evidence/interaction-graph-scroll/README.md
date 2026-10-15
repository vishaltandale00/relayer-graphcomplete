# Interaction graph scroll continuity

Workspace reconciliation recreated the interaction graph's scroll viewport.
Scrolling down therefore jumped to the top on the next status refresh.
`renderTurnNavigation` now retains its heading and scroll host, replacing only
its graph surface. Reopening still reveals the selected interaction.

## Product seam and required verification

PRD section 7.2B / AN-006 owns accessible interaction navigation. The changed
production seam is the graph-popover DOM lifecycle in
`desktop/renderer/src/product-workspace/workspace.js`. Origin-layer design
remains separate in [issue #730](https://github.com/vishaltandale00/relayer-graphcomplete/issues/730).
This correction changes no graph projection, agent input or authority.

| Checkpoint | Production-seam proof |
| --- | --- |
| Preserve both scroll offsets on ordinary state reconciliation | `test/interaction-graph-workspace.test.mjs` renders the real workspace across failed, stopped, running and pending local interactions |
| Preserve real wheel scrolling, horizontal overflow and focused card across repeated updates | `npm run test:desktop:interaction-graph-layout` drives Chromium, actual wheel input, three repeated reconciliations and a focused-card precondition |
| Retain opening/selection, disabled-source guards, legacy mode and responsive bounds | Existing scenarios in the same workspace test and browser runner |
| Review the original symptom against the correction | `node scripts/capture-interaction-graph-scroll-video.mjs` records both versions with the same fixture and gesture |

The in-process tests check scroll-host state; Chromium verifies actual overflow
and browser behavior. They protect distinct boundaries. No tests were deleted.
Required handoff checks also include `npm run check` and `npm run build`.
Regenerate social-preview evidence after renderer edits, per its evidence README.
No paid inference is used.

## Actual results

Candidate base: `5156d906579625f1eda41bbcf0de7cc71827458d` (`origin/main`).
All candidate checks are fresh; earlier primary-checkout results are not reused.

- Focused Vitest: PASS, 3 files / 144 tests.
- Production Chromium layout runner: PASS. Native wheel scroll stays at
  `80 -> 80` after a status update; horizontal scroll and focus survive
  three reconciliations. Selection, dismissal, themes and layout cases pass.
- `npm run build`: PASS under pinned Node 22.23.2.
- `npm run evidence:share-preview`: PASS. Both 1200x630 captures, cancellation,
  window/server cleanup and renderer identity checks pass. Its generated
  receipt is checked in with the actual captured images.
- Follow-up annotation Electron capture: PASS, zero paid inference calls.
  Its full-renderer identity gate required fresh images/receipt after this edit.
  The capture proves exact annotation occurrence, confirmation and reload;
  the receipt integrity test also passes. All four raw images were inspected.
- Full `npm run check`: PASS under pinned Node 22.23.2, exit 0. Cargo formatting,
  Clippy, workspace and crash-reconciliation tests, package checks/builds,
  TypeScript, 326 Vitest files / 4,325 tests (one file / three tests skipped),
  two secret-boundary process tests, 99 Python tests, Ladybug receipt checks
  and PRD readability all pass.

The first candidate full-check attempt failed under ambient Node 26.0.0:
its annotation receipt still identified the old renderer, and its real-client
exact-port egress test raised `ERR_ACCESS_DENIED`. The annotation evidence was
regenerated. The unchanged egress test passed under repository-pinned Node
22.23.2, followed by the complete successful check above. No permission/security
code or assertions were relaxed. An earlier primary-checkout project-environment
failure is historical; this isolated candidate's full run passes that test.

Verification used official Node 22.23.2, verified against its published SHA-256
`5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1`.
Dependencies were installed with `npm ci --offline --ignore-scripts` using the
lockfile. The isolated workspace uses the existing warm Cargo target cache and
installed pinned Electron 43.0.0 dependency runtime. Cargo still builds/checks
this checkout, and every test runs freshly. No cold Ladybug build or unverified
native artifact restoration was needed.

## Baseline versus treatment

[Watch the comparison](baseline-vs-treatment.mp4). Both recordings use the same
production renderer fixture and native 196-pixel wheel gesture. Refresh calls
the production workspace render seam after changing a turn's status.

- Baseline: `196 -> 0`, reproducing the jump.
- Treatment: `196 -> 196`, retaining the reader's position.

The recorder currently requires macOS with Homebrew FFmpeg at
`/opt/homebrew/bin/ffmpeg`, plus the pinned Playwright Chromium browser.

The recorder reverses only this fix's four scroll-host substitutions in the
baseline's served JavaScript. The resulting baseline source was independently
checked against the exact base-commit `workspace.js`; their hashes match. It
never changes the production file. Synthetic graph data and recording captions
are fixture-only. This is Chromium production-renderer evidence, not an
installed-app, provider or release proof.

[The video receipt](video-receipt.json) binds both workspace sources, recorder,
served dependencies, observed offsets and MP4. Its `sourceCommit` identifies the
base commit at capture time; source hashes identify the uncommitted treatment
exactly. Before/after video frames and both social-preview images were inspected.

## Adversarial review

Independent implementation/standards and product/evidence reviews passed
with no blocking findings for source manifest `46d116c40a8486d8665b371d419039eeae815f083f2462911458702463d0efd6`.
The manifest hashes sorted `path + NUL + file SHA256 + newline` for the workspace,
in-process test, browser layout runner and comparison recorder. Review assertions
must be renewed if those source files change.

Reviewers: `/root/scroll_standards` and `/root/scroll_review`. The latter
also independently verified baseline derivation, video dependencies and offsets,
and the complete social-preview receipt. A follow-up review verified all four
annotation PNG identities, capture script, source/baseline hashes, confirmation
occurrence and reload checkpoint. Runtime hashes in that receipt identify the
binaries executed during capture; shared Cargo outputs later rebuilt during
verification, so it does not assert equality with current `target/debug` bytes.
The FFmpeg prerequisite was documented after review. These
assertions become certifying only when attached to the exact PR source.
