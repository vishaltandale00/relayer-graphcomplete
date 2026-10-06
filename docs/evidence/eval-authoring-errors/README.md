# Eval turn authoring errors

## Approved meaning and scope

The user approved a separate per-turn authoring-error metric on 2026-10-06.
PRD §9.4 owns its meaning. This implementation is partial-observation version 1:
`observed` counts supported origin records; `total` is always null. A zero observed
count is not a zero-error claim. Unknown methods, Python pre-transport validation,
older or pinned clients, and diagnostic delivery loss remain coverage gaps.

Metrics do not alter graph acceptance, task/graph grades, or promotion rules.
Diagnostics have independent event/byte budgets. Their overflow cannot truncate
ordinary graph proof. No test is deleted. No paid inference is used.

## Changed executable seams and checkpoints

| Seam / promise | Smallest deterministic checkpoint |
| --- | --- |
| JS client construction, bound private methods, single-flight and original errors | `test/eval-authoring-errors.test.mjs`; existing graph-client objects/ownership suites; packaged detail suite |
| Compiler-origin and caught nested-template diagnostics, per-attempt deduplication | real recorder/client/compiler journey in `test/graph-operation-recorder.test.mjs` |
| Completion diagnostic opt-in and Codex/Claude environment propagation | host, Codex and Claude provider fixture suites |
| Recorder token-owned attribution, closed diagnostic fields, credential/content exclusion | real recorder journey and existing recorder boundary fixtures |
| Independent diagnostic budgets and preserved graph proof | diagnostic-overflow recorder fixture |
| Write error-code preservation, server origins, repeated attempts, infrastructure/read exclusion | recorder journey plus `test/eval-authoring-errors.test.mjs` |
| Ledger digest, byte/event counts, interaction identity, missing/legacy/truncated coverage | `test/eval-authoring-errors.test.mjs` |
| Measurement persistence and real production Eval capture | graph-memory fixture in `test/eval-app-integration.test.mjs` |
| Per-turn dossier projection and historical unknowns | `test/eval-authoring-errors.test.mjs`; dashboard model suite |
| Dossier rendering | `npm run test:eval-web`: real two-turn dossier has two metric rows, observed-zero display, and explicitly unknown total |

## Required verification plan

Run the mapped focused suites during editing, then `npm run check`, `npm run build`,
`npm run test:eval-compiled-runtime`, and `npm run test:eval-web` for the shared
runtime/dashboard changes. No signed/release/paid proof is applicable.
Use an adversarial source review and bind its final assertion to the PR's exact
workspace digest. Future source changes invalidate that assertion.

## Build acceleration

Checked `docs/agents/ci.md` before native preparation. The local trusted Ladybug
bundle at `thread-icons-622-lbug` was verified with the repository's
`lbug-artifact.mjs verify`: manifest identity, pinned 0.18.0 source/features,
macOS arm64, Rust 1.98.0, Cargo.lock and library/content hashes passed.
The development Cargo target was cloned to private storage for warm compilation;
Cargo revalidates current source and all required tests run freshly. That clone
is not a sealed runtime artifact or test evidence. No prebuilt runtime receipt
was adopted. Source compilation remains the runtime authority.

## Actual results

Final executable/test/PRD source digest (17 files, sorted path + NUL + bytes + NUL):
`854010b76f49e1441d542741c41a0fcd7c77a3a9910e11a034f04aa1b86c6e2b`.
Evidence prose is excluded from this digest.

| Actual command / checkpoint | Result |
| --- | --- |
| Focused recorder and metric fixtures | 17 passed; caught/compiler/server origins, shared-promise deduplication, independent diagnostic budgets |
| Client objects/detail ownership plus recorder/metric fixtures | 58 passed on their editing snapshot |
| Host, Codex, Claude, packaged detail and dashboard model fixtures | 234 passed on their editing snapshot |
| Production Eval capture plus recorder/metric fixtures | 32 passed on their editing snapshot; persisted two-turn metrics |
| `npm run check` with pinned Node 22.23.2 | Passed: Rust fmt/clippy, workspace and crash-reconciliation tests, package build/checks, 288 Vitest files / 3,616 tests passed (1 file / 3 tests skipped), 2 secret-boundary tests passed, 68 Python tests passed, Ladybug receipts and PRD readability passed |
| `npm run build` with pinned Node 22.23.2 | Passed: both native runtime binaries, root TypeScript and all workspace packages |
| `npm run test:eval-compiled-runtime` with pinned Node 22.23.2 | 4 passed on the final source |
| `npm run test:eval-web` with pinned Node 22.23.2 | Final unchanged rerun passed all declared chapters: startup/shutdown/reopen, metric rows, review authority, settings, human tasks, actor diagnostics/dispatch, setup revisions, file-only judges, evaluator release, calibration, actor input and human persistence |

Adversarial source review by `/root/design_authority_review` passed the exact
17-file digest above, including the browser synchronization fix. No unresolved
findings. The reviewer independently ran 17 focused tests on its earlier stated
snapshot; the refreshed browser assertion review is source review, not an
independent browser run. No test was removed or subsumed.

Preserved failed attempts: the initial harness typecheck ran before package outputs
existed and failed on missing declarations; package builds repaired that prerequisite.
An initial nested-template fixture exposed a separate TypeError origin; instrumentation
was added and its replacement passed. The first browser metric assertion raced the
observer's terminal snapshot; waiting for the second turn row repaired it. The first
aggregate run under system Node 25.9.0 failed its network-permission fixture
(3,615 other tests passed). That fixture and the complete aggregate pass under
the repository-pinned Node 22.23.2. The first pinned browser run passed the metric
chapter but timed out in an existing evaluator-release scenario after task-status
polling closed its human-task form; one final unchanged browser rerun passed all
declared chapters after the aggregate check finished. The final-source Node 25
browser run also passed all chapters.

No live or paid inference, signed/release proof, exhaustive-error coverage,
performance gain, or task/graph quality improvement is claimed.
