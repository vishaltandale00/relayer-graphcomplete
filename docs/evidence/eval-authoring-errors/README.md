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
| Recorder token-owned attribution, closed diagnostic fields, SDK payload sanitization (unattested reports; see trust checkpoint below) | real recorder journey and existing recorder boundary fixtures |
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

## Initial integration snapshot — 2026-10-06

These results apply to commit `ec20187eb88fc3bd3e5a275f76e0cdd326fe7a06`.
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

## Review follow-up snapshot — 2026-10-06

These results apply to commit `3a773a1280e3afcc0c4c5f30ab656b9f0611c084`.

GitHub blocked merge on four unresolved review threads despite passing CI. All
four map to the existing PRD §9.4 measurement promise; they require no new product
decision or graph authority. The executable seams and checkpoints are:

| Changed seam / boundary | Production checkpoint |
| --- | --- |
| Visual-asset POST mutation classification | Real `RelayerGraphClient.visualAssets` sends all six mutations and six reads through the recorder; rejected mutations count, POST reads do not; unknown nested kinds and top-level spoofing stay unclassified |
| Sanitized operation discriminator | The same recorder fixture retains only known kinds and excludes asset names, bytes, tag names and capability tokens |
| Independent evidence extraction before provider validation | Existing real Eval artifact-failure journey preserves a partial metric with corrupt provider events while capture stays failed/non-promotable; foreign ledger receipts stay unavailable |
| Pinned launcher clean environment | Existing real macOS launcher fixture receives the trusted `RELAYER_GRAPH_AUTHORING_ERRORS` opt-in, catches unsafe-CSS compilation and records one origin while inherited provider secrets and unauthorized egress remain excluded |
| Child dossier projection and rendering | Metric projection fixture distinguishes root/child identities, counts and provenance; legacy child evidence is unavailable; browser fixture renders separate child rows without changing root counts |

No test was deleted. Required verification remains the full check/build, compiled
runtime and browser runner, with refreshed source review. No new inference or
release proof applies. Native and TypeScript sources are unchanged.

A refreshed reviewer found that the first visual-asset fix read a top-level kind,
while the production client sends `operation.kind`. The initial manual fixture
masked this mismatch. The corrected recorder reads the real envelope, and the
replacement fixture calls the real public client. The initial 180-test focused
pass is historical proof for its pre-repair source, not proof of the final asset
path. The final warm metric/recorder/dashboard suites passed all 33 tests.

Final 19-file executable/test/PRD digest, sorted paths relative to main
`de686561c465f1ed6c4afc6ac9fb59291861bb56` + NUL + bytes + NUL, evidence excluded:
`e2083e3ff90538b749cd920d70212a11b8a1bebf666dfd5edddd16e0014f9268`.

Adversarial assertion: reviewer `/root/design_authority_review`; all 19 paths at
the exact digest above; scope all four review repairs plus origin counting,
privacy/authority, independent budgets, unknown coverage and timing separation;
verdict **PASS**, no unresolved findings. Reviewer independently ran 33 tests in
three lightweight suites on this exact digest. Full-check/build/browser/compiled
runtime proof is separate. Included-source changes invalidate this assertion.

Actual final verification with pinned Node 22.23.2 and the same private verified
native setup:

| Final checkpoint | Result |
| --- | --- |
| Warm metric/recorder/dashboard suites | 33 tests passed on final digest |
| `npm run check` | Passed: native workspace/crash tests, fmt/clippy, package checks, 290 Vitest files / 3,625 tests passed (1 file / 3 tests skipped), 2 secret-boundary tests, 68 Python tests, receipt integrity and PRD readability |
| `npm run build` | Passed native runtimes and all TypeScript packages |
| `npm run test:eval-compiled-runtime` | All 4 tests passed |
| `npm run test:eval-web` | All declared chapters passed, including both metric sections, distinct root/child counts, parent provenance, unavailable legacy child evidence, process reopen and review authority |

The final asset-envelope edit preceded the aggregate's JavaScript prerequisites
and test chapter; native/Rust and TypeScript sources stayed unchanged during that
run. The independent final warm suites and review also observe the repaired
source. Log hashes are in [final verification receipts](final-verification.json).
Historical proof above remains bound to its recorded snapshots. No new live
inference ran; exhaustive coverage and task/graph-quality improvement remain unclaimed.

## Patch integration snapshot — 2026-10-06

These results apply to commit `01667c58a35d657b513b76b609005001be5c4371`.

Main advanced during final CI: #688 repaired fork-run freshness selection and
#661 introduced named graph-program patch retries. CI for `3a773a1280e3afcc0c4c5f30ab656b9f0611c084`
passed, but the fresh guard correctly blocked its conflicting head. Integration
uses main `d9fc380c6172651482e44f2b916d160bf97ba368`.

The two executable conflict seams are client `fromEnv()` option construction and
host graph-scope construction. Both retain the diagnostics opt-in alongside the
per-turn program directory and program capture. Provider environment auto-merges
preserve both features; existing host ownership and cleanup stay unchanged.
The existing real stdin program-save/patch journey now asserts that diagnostics
remain enabled. The program, Codex, Claude and host bridge suites passed all
117 tests. No tests were removed. Required final verification is full check/build,
compiled runtime, browser proof and renewed source review; default tests remain
inference-free. No new live or release proof applies.

Exact 20-path executable/test/PRD digest relative to that main commit, sorted path
+ NUL + bytes + NUL, evidence excluded:
`0a5863af2bafb53c964a354b47c7e6879c444dd29e2df23a3603b567408c965b`.

Adversarial assertion: reviewer `/root/design_authority_review`; all 20 paths at
the exact digest above; scope final metric implementation plus program capture,
patch context, host scope ownership/cleanup, provider environment propagation,
recorder attribution/budgets and separation from program-helper bookkeeping;
verdict **PASS**, no unresolved findings. Reviewer independently ran 33 lightweight
metric/recorder/dashboard tests on this digest. Heavy/live receipts above remain
historical. This assertion expires after an included-source change.

Actual combined-source verification with pinned Node 22.23.2:

| Checkpoint | Result |
| --- | --- |
| Program/Codex/Claude/host bridge suites | 117 tests passed; diagnostics remain enabled while real saved programs are patched |
| `npm run check` | Passed native workspace/crash tests, fmt/clippy, package checks, 292 Vitest files / 3,652 tests passed (1 file / 3 tests skipped), 2 secret-boundary tests, 68 Python tests, receipt integrity and PRD readability |
| `npm run build` | Passed both native runtimes and all TypeScript packages |
| `npm run test:eval-compiled-runtime` | All 4 tests passed |
| `npm run test:eval-web` | All declared chapters passed; both metric sections, root/child distinction and unknown evidence remain correct alongside startup/reopen, review authority, actor, evaluator release, calibration and human persistence |

Source stayed unchanged during final verification. The unchanged Rust/Cargo
inputs reuse the verified Ladybug bundle and private warm target; all required
tests ran afresh. Log hashes are in
[patch integration verification receipts](patch-integration-verification.json).
No new live inference or release proof ran. Prior receipts remain historical.

## Public-write capture audit — 2026-10-06

CI passed for `01667c58a35d657b513b76b609005001be5c4371`, but an automated
review identified recursive preparation outside the supported observer/route set.
The final audit of public client mutations adds `prepareComplete` and
`proposeThreadIcon` observations plus rejected `/api/graph/completions/prepare`
and `/api/graph/thread-icon` POST origins. A non-throwing icon proposal result is
not invented as a failure. POST search, detail-asset resolution, icon discovery
and visual-asset reads remain excluded.

The real client/recorder fixture observes one pre-transport preparation failure,
one rejected preparation POST, and one rejected icon POST. A failed node read is
excluded; server origins emit no duplicate client diagnostic. Publication timing
keeps its own rejection classification. No arguments, icon content or tokens are
retained. This adds no child authority or execution scheduler. Existing acceptance,
grading, trace validity and diagnostic-budget boundaries remain unchanged.

Required verification is the focused capture journey, full check/build, compiled
runtime/browser runners, and a renewed source review. No test was deleted and no
paid/live or release proof is required. Final focused metric/recorder suites
passed all 20 tests.

Exact 20-path executable/test/PRD digest relative to main
`d9fc380c6172651482e44f2b916d160bf97ba368`, sorted path + NUL + bytes + NUL,
evidence excluded:
`6009a136c80d2e848b0b90be6c85c1a6acb34bce61b3d1a10ae2d56acc27d124`.

Adversarial assertion: reviewer `/root/design_authority_review`; all 20 paths at
the exact digest above; scope full public mutation-route audit, recursive/icon
origins and read exclusion, all prior capture/reporting repairs, authority,
privacy/budgets, program-retry integration and timing separation; verdict **PASS**,
no unresolved findings. The reviewer independently ran 34 metric/recorder/dashboard
tests on this digest. Heavy/CI proof is separate; source changes invalidate this
assertion. Capture remains partial, and the historical live probe remains bound
to its original production commit.

Actual final verification with pinned Node 22.23.2 and the same verified warm
native setup:

| Checkpoint | Result |
| --- | --- |
| Focused metric/recorder capture suites | All 20 tests passed |
| `npm run check` | Passed native workspace/crash tests, fmt/clippy, package checks, 292 Vitest files / 3,653 tests passed (1 file / 3 tests skipped), 2 secret-boundary tests, 68 Python tests, receipt integrity and PRD readability |
| `npm run build` | Passed both native runtimes and all TypeScript packages |
| `npm run test:eval-compiled-runtime` | All 4 tests passed |
| `npm run test:eval-web` | All declared chapters passed, including both metrics, root/child provenance and unknown evidence, reopen, review authority, actor/evaluator workflows, calibration and persistence |

The executable source stayed unchanged throughout these commands. Log hashes
are in [public-write verification receipts](public-write-verification.json).
Historical receipts above do not substitute for these final checks. No new live
inference, exhaustive-error coverage, optimization efficacy or quality gain is claimed.

## Diagnostic settlement, trust, and interrupted-run checkpoints

The approved V1 metric uses **unattested client reports**. A graph token binds a request to its completion; it does not attest that a client/compiler incident really occurred. Server write rejections remain independently recorded transport observations. The SDK sends only a fixed vocabulary, mapping unsupported compiler codes to `compiler_validation`; the recorder rejects arbitrary identifier-shaped codes, extra fields, unsupported phases, and invalid authentication. This closes arbitrary prose in the `codes` field. It does not eliminate candidate-controlled UUID, count, timing, or order channels, and the combined count is not tamper-proof evidence or an unconditional lower bound against a malicious candidate. Isolation and reporter-only authority would require a separately approved execution contract. None of these diagnostics changes acceptance, scores, or graph trace validity.

Changed seams and checkpoints:

- Recorder request registration and export settlement: register authenticated graph and diagnostic requests before reading their bodies. Real HTTP `100-continue` fixtures hold the body across export without fixed sleeps, proving capture before sealing, diagnostic-only timeout omissions, and bounded ordinary graph-body failure. Diagnostic omissions leave graph proof complete/promotable; ordinary graph omissions still fail partial. The existing hung-upstream test protects the distinct outbound timeout boundary.
- Reporter and recorder diagnostic vocabulary: a real SDK-to-recorder fixture proves fixed compiler fallback, rejected prose/token codes, phase/field closure, and graph-token completion attribution. This is attribution and sanitization proof, not attestation.
- Dossier projection: known root and child rows reconcile persisted metrics without duplicates. Unmatched captured entries display as `Captured completion`, with no guessed parent or turn identity. A real two-turn EvalService run captures its first metric, fails later model preparation, persists, and reopens with the earlier count and failed trace still visible. The production browser fixture displays the unmatched captured row alongside root and child rows.

The initial focused run caught a regression where timeout cancellation closed a fully received graph request before its existing 502 response could be delivered. Cancellation now destroys inbound requests only when their body is incomplete; fully received requests preserve the original upstream abort/502 behavior. The failing run is retained at `/tmp/eval-errors-686-settlement-focused.log`; final verification is recorded separately below.

### Final settlement snapshot results

All results below apply to the exact 22-file executable/test/PRD digest
`d9d9404e471e742da18fcb935e1608beefbe1602139aae16adcd17febd5e8c0d`,
relative to main `d9fc380c6172651482e44f2b916d160bf97ba368`.
Sorted path + NUL + bytes + NUL defines the digest; `docs/evidence/` is excluded.
No included source changed during the final checks.

| Actual checkpoint | Result |
| --- | --- |
| Focused metric/recorder/dashboard suites | 39 tests passed, including real partially transmitted diagnostic and graph requests |
| `npm run check` | Passed: native workspace/crash tests, package checks, 292 Vitest files / 3,659 tests passed (1 file / 3 tests skipped), 2 secret-boundary tests, 68 Python tests, receipt integrity, PRD readability |
| `npm run build` | Passed: native runtimes and TypeScript workspace packages |
| `npm run test:eval-compiled-runtime` | All 4 tests passed |
| `npm run test:eval-web` | All declared chapters passed, including root/child/captured metric rows, unknown totals, failure/reopen display, timing, and review authority |

Log hashes/lengths and exact source identity are retained in
`settlement-verification.json`. No new live or paid inference ran.

Adversarial assertion: reviewer `/root/design_authority_review`; exact digest
above; all 22 changed executable/test/PRD paths reviewed, including settlement,
closed codes, unattested authority, failure/reopen reconciliation, and secondary
ordinary graph-body cancellation; verdict **PASS**, no unresolved findings.
Independent verification: 4 suites / 74 tests passed. Browser additions were
source-reviewed; the actual browser runner above is separate evidence. This
assertion is invalidated by an included-source change.
