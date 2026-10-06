# Eval turn authoring errors

## Approved meaning and scope

The user approved a separate per-turn authoring-error metric on 2026-10-06.
PRD §9.4 owns its meaning. This implementation is partial-observation version 1:
`observed` counts supported origin records; `total` is always null. A zero observed
count is not a zero-error claim. Unknown methods, Python pre-transport validation,
older or pinned clients, and diagnostic delivery loss remain coverage gaps.

Metrics do not alter graph acceptance, task/graph grades, or promotion rules.
Diagnostics have independent event/byte budgets. Their overflow cannot truncate
ordinary graph proof. No test is deleted. No paid inference is used in the
deterministic suite.

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
runtime/dashboard changes. No signed/release proof is applicable. The default
suite uses no paid inference; the live probe below ran after explicit user authorization.
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

## Implementation snapshot results

These results apply to implementation commit `09b144d88d9015a0bdb69c95a6a09cac6a24c964`,
before integration with publication timing. Executable/test/PRD source digest (17 files, sorted path + NUL + bytes + NUL):
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

No signed/release proof, exhaustive-error coverage, performance gain, or
task/graph quality improvement is claimed.

## Live capture probe — 2026-10-06

User-authorized live execution used the connected Codex subscription,
`gpt-6-luna`, and the checksum-validated cached `codex@0.159.3` managed runtime.
The tested production source is commit `09b144d88d9015a0bdb69c95a6a09cac6a24c964`.
An isolated profile cloned the existing authenticated Eval setup; the original
profile was not edited. One root turn ran, with no delegated model children and
the deterministic graph-contract judge.

This was a deliberate capture probe, not the ordinary task-quality benchmark.
A preamble supplied a Node program that caught known failures before completing
the built-in one-turn task. The local runner changed only this experiment's
task input. The production Codex harness, product runtime, operation recorder,
metric computation and Eval persistence were unchanged.

| Known origin | Expected | Recorded |
| --- | --- | --- |
| Missing client edge arguments | 1 client | 1 client (`client_validation`) |
| Nested template caught before a graph method | 1 compiler | 1 compiler (`detail_template_nested`) |
| Forbidden CSS in two separate checkpoint attempts | 2 compiler | 2 compiler (`unsafe_css`) |
| Malformed node write rejected by the real graph server | 1 server rejection | 1 server rejection (HTTP 422) |
| Failed ordinary read | Excluded | Excluded (HTTP 404) |

All **5/5 planned authoring-error origins were captured**, with no duplicate or
unexpected counted origins. The probe program exited **0** despite catching its
errors. The model then produced an accepted graph; the Eval run passed and
persisted `observed: 5`, `{ client: 1, compiler: 3, server_rejection: 1 }`,
`coverage: partial`, and `total: null`.

The complete candidate trace contains 169 events. The untruncated graph ledger
contains 19 receipts; its digest, byte length and event count match the exported
descriptor. The private trace confirms the probe ran once, diagnostics were
enabled, and the five labeled outcomes agree with the ledger. An additional
ordinary output-read 404 was also excluded. Successful submission remains HTTP 200.

[Live receipt](live/receipt.json), [origin ledger](live/graph-operations.jsonl),
[captured probe output](live/probe-output.json), and
[portable probe program](live/probe-program.mjs) retain the comparison and hashes.
The portable program normalizes only its client-module import; the receipt also
records the exact executed-program hash and complete private trace digest. Raw
provider trace and full prompt remain in the isolated local evidence profile.

Two setup attempts stopped before inference: the first lacked the required
macOS target key; the second guard incorrectly expected an adapter ID on the
model-selection object. Supplying the actual target and checking the connected
provider definition repaired the local runner. Production code did not change.

This establishes capture of these five targeted failures through a live model
and persisted Eval turn. It is not a general recall estimate, natural-error
baseline, or proof of exhaustive coverage. Python, unknown methods, older clients
and lost diagnostic delivery remain the declared gaps.

## Integration with main — 2026-10-06

Integrated publication-timing PR #687 from main commit
`de686561c465f1ed6c4afc6ac9fb59291861bb56`. The two overlapping service and
dossier seams preserve both metrics: both transient maps are cleaned up after
persistence, and both dossier sections remain visible. Recorder timing/control
receipts and authoring diagnostics retain their respective integrity boundaries.

Additional checkpoints use existing production journeys: the caught-error recorder
fixture confirms diagnostic origins do not inflate timing's rejected-write count;
the browser dossier checks both metric sections. No tests were removed.
Required integration verification was the six mapped focused suites, a fresh full
`npm run check`, `npm run build`, compiled-runtime proof, the browser runner, and
refreshed adversarial review. No new live inference or release proof was required.

Exact integrated executable/test/PRD digest (17 paths relative to the main commit
above, sorted path + NUL + bytes + NUL; evidence excluded):
`de7f8363a3c3739b43f872f8c5f7117dd0411ec2af735d55bcd84b8b7c131e4e`.

| Actual integration checkpoint | Result |
| --- | --- |
| Six focused metric, recorder, timing, model and Eval persistence suites | 57 tests passed |
| `npm run check`, pinned Node 22.23.2 | Passed: native fmt/clippy/workspace/crash tests, package checks, 290 Vitest files / 3,624 tests passed (1 file / 3 tests skipped), 2 secret-boundary tests, 68 Python tests, receipt integrity and PRD readability |
| `npm run build`, pinned Node 22.23.2 | Passed: both native runtime binaries, root TypeScript and all workspace packages |
| `npm run test:eval-compiled-runtime`, pinned Node 22.23.2 | All 4 tests passed |
| `npm run test:eval-web`, pinned Node 22.23.2 | All declared chapters passed, including both dossier metrics, startup/reopen, review authority, evaluator release, actor dispatch/input, calibration and human persistence |

Preserved failure: the first integration aggregate run failed the unchanged native
`environment::tests::command_runner_enforces_start_timeout_and_output_bounds`
fixture under overlapping verification load (356 other app-server tests passed).
The identical fixture passed in isolation. A fresh full run with
`RUST_TEST_THREADS=4` and `VITEST_MAX_WORKERS=3` passed; test cases and time limits
were unchanged. The verified Ladybug bundle and private warm native target were
reused; no cold provisioning was performed. Log hashes are retained in
[integration verification receipts](integration-verification.json).

Adversarial assertion: reviewer `/root/design_authority_review`; exact integrated
17-file digest above; scope both capture/persistence/cleanup/projection/rendering
paths, origin counting, diagnostic-budget independence, timing rejection exclusion,
partial/unknown coverage, and evidence source qualification; verdict **PASS**, no
unresolved findings. The reviewer independently ran four focused suites with
38 passing tests on this exact digest, including the cross-metric assertion.
Aggregate, build and browser results are separate local proofs. This assertion
expires after an included-source change.

The live probe remains evidence for production commit `09b144d88d9015a0bdb69c95a6a09cac6a24c964`.
It is not a new live run of the integrated source or a natural-error baseline.
