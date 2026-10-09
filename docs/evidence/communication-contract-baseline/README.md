# Communication contract as the harness baseline

The user explicitly selected B on 2026-10-08, then requested it for Codex, Claude, and Prime Agent. All three now treat current as the way to explain ongoing work: publish a useful finding, uncertainty, or consequential question, then update when understanding materially changes. Authorized semantic children remain optional; when used, their changed currents are observed, read, and meaningfully incorporated. User answers enter the next ordinary interaction.

The implementation promotes the tested contract and early-publication recipe onto current main, retaining main's newer scoped-authoring API, root-label/icon, provider, and authority guidance. It covers Codex basic and both layered profiles, Claude's native query prompt, and Prime's basic and layered Python prompts. The same contract uses supported language-specific APIs; providers retain their native helper infrastructure. It adds no harness setting, scheduler, graph acceptance rule, presentation-version activation, or paid default test.

## Changed seams and verification plan

| Seam / promise or boundary | Smallest production checkpoint |
| --- | --- |
| Default Codex, Claude, and Prime native-turn prompt delivery, with and without broker | Actual-turn checkpoints in `codex-basic.test.ts`, `claude-basic.test.ts`, and `prime-agent.test.ts` |
| Conditional semantic broker use; no invented child findings or same-completion answer resume; credential exclusion | The same actual-turn test, plus existing broker and normalized-input tests |
| Shared JavaScript and translated Python contract preserve provider APIs and native recursion | Actual Claude/Prime turn checkpoints plus existing session, broker, and scope suites |
| Actual runnable early-publication example, active Advance, explicit terminal Return, prior-current integrity | `test/recursive-complete-e2e.test.mjs`: `executes the JS communication recipe: %j` through real graph/client/app-server |
| Prime Python scoped authoring, actual visual-host compilation, prior-current and control bindings | `test/graph-authoring-replay.test.mjs`: `writes scoped TS and Python programs through canonical compilation and Rust authority`, including both prior-current branches, interrupted fresh-process retry, and all-off compatibility |
| Existing scoped API, exact prior-layer target, same root action retarget, stable identity and explicit layouts | JavaScript/Python recipe checkpoints plus actual-turn prompt assertions and existing graph authority suite |
| Authored final summary, retained asset/export/reopen/presentation pins, and navigation to working findings | `test/prime-visual-integration.test.mjs`: both shipped basic/deep configuration scenarios, plus final mount/reference assertions in both language recipe checkpoints |
| Build and assembled runtime | `npm run check`, `npm run build`, `npm run test:eval-compiled-runtime` |

Product meaning follows PRD §4.3 and §12.1, temporal-current ADR 0008, node-authored-input ADR 0008, and personal-presentation ADR 0009. The PRD records the explicitly authorized Codex baseline decision. These are prompt expectations, not deterministic Advance-count requirements. No tests were removed; placeholder assertions now observe the new runnable example while preserving their API/authority boundaries.

Required before commit: full check/build and the compiled runtime entry. The real-runtime recipe is a separate process proof, not an in-process edit-loop test. Release and paid inference proof are outside this change's context.

## Pre-merge recipe repair

Hosted review exposed three gaps: basic Codex omitted executable broker instructions, all-off diagnostic mode rejected the first current read, and rerunning after Advance could rewrite accepted history. Basic Codex now receives broker imports/preparation/watch/result guidance only when authorized. Both language recipes probe current before writes; only typed `feature_disabled` selects direct final submission. All other errors propagate. Enabled reruns compare the exact scoped first-layer identity with the fetched current, skip committed writes/Advance, and repair final drafts while retaining the exact prior current. Successful or unknown terminal submission is outside model replay authority.

Additional checkpoints use the real JS app/client/server stack and real Python visual-host/server stack, with both prior-current branches. Each interrupted scenario fails after first Advance and final draft writing, then reruns in a fresh client/process; the accepted initial layer and revision must remain equal, final drafts must accept, and final navigation must retain exact prior current. All-off cases accept a fully authored final summary without first-phase publication or reference controls. Actual Codex turns verify broker instructions present only when authorized. No tests or authority checks were removed.

Required plan: targeted six-file provider/recipe/Prime visual suite, `npm run check` with the same supported one-worker qualification, `npm run build`, and `npm run test:eval-compiled-runtime`. The [pre-merge receipt](merge-fixes-verification.json) separately records the exact source and actual command results. The exact ten-path repaired source digest is `dbeef786d460f52fd4cd4cdb1656de4bb6249da107e2e8a6307106b5a96fa2c6`. Targeted tests passed 195/195. Full check passed with one worker: 3,850 JavaScript tests, three existing skips, two secret-boundary tests and 77 Python tests; native/crash, types, receipt and readability checks also passed. Build passed; compiled runtime passed nine tests. Earlier receipts below remain historical and do not certify the repaired source. No new live inference or release proof is requested.

## Initial Codex-only verification

The earlier Codex-only [verification.json](verification.json) binds the five changed source/test/PRD files to digest `80f6f9b25a4bb0e9bb295f63da68e5d942a426853d2be111c4ca68cad33a1b11` and records command results separately from the plan. On this exact source, `npm run check` and `npm run build` passed. The full Vitest suite passed 3,843 tests with three existing skips; the explicit secret-boundary suite passed two and Python passed 77. Native workspace and crash-reconciliation scenarios, package/type checks, receipt lint, and PRD readability also passed. The compiled eval-runtime entry passed six tests. The targeted real recipe and module inventory entry passed seven tests.

The first full check had three failures: test observation used a presentation-edit-authority read, and stale generated output violated the packaged-module inventory. After using ordinary layer reads, an intermediate assertion still expected an authoring key instead of the compiled mount identity. The final assertions verify real expand/reference mounts and accepted action bindings. All failures are preserved separately from the final pass; no production authority was widened.

Before native verification, the official cache verifier rejected the old Ladybug bundle because Cargo.lock identity changed. No compatible sealed runtime was available. A private compiler-object cache clone accelerated ordinary source-based Cargo checks/builds; no cached result supplied proof. Local log hashes and an adversarial review assertion are recorded in the receipt. Hosted PR CI remains separate.

## All-harness verification

The scope extension changes shared JavaScript prompt delivery and the Prime Python recipe. Its required plan is full `npm run check`, `npm run build`, and `npm run test:eval-compiled-runtime`, plus targeted actual native-turn and real recipe checks. The [all-harness receipt](all-harness-verification.json) binds the ten source/test/PRD paths to digest `c4937a818f0b28e2abaa692f7976a3d61a9e694a39b0f63b15887bfc1927e48a`, separately from the earlier Codex-only receipt. Existing pilot measurements remain Codex-only; they do not establish Claude or Prime timing or quality.

## Live pilot evidence and adoption tradeoff

`pilot.json` is a sanitized projection of 32 frozen original attempts: six coding roots per cell and one delegation plus one question probe per cell. Candidate was Luna/medium, V4; first-view rater and final simulated-user judge were Sol/high. The pilot source predates current main; these measurements do not certify the transplanted PR source.

| Cell | Repair first/final median seconds | Investigation first/final median seconds | Coding first Advance | Partial observed root authoring incidents | Meaningful first coding views |
| --- | --- | --- | --- | --- | --- |
| A unchanged baseline | 54.3 / 54.3 | 60.2 / 60.2 | 0/6 | 4 | 4/6 |
| B communication contract | 33.1 / 79.7 | 39.0 / 55.6 | 4/6 | 7 | 4/6 |
| C publish/observe/continue | 36.5 / 70.0 | 64.7 / 98.0 | 6/6 | 8 | 6/6 |
| D decision triggers | 86.3 / 88.9 | 69.3 / 113.7 | 4/6 | 12 | 3/6 |

B's median first backend publication was 39% earlier for repair and 35% earlier for investigation. Its repair final acceptance was slower. B had three more observed authoring incidents and no observed meaningful-first-view gain. B's first-view scores were four 2/4 and two 1/4; A's were six 2/4. This is an authorized baseline choice, not a causal quality winner or broad nonregression claim.

All 24 coding candidates accepted. Coding gates passed 21 times, failed twice, and were unavailable once after ENOSPC interruption. The two failures were strict verifier test-file scope failures (one A, one C); available functional checks passed. Qualitative task ratings remain unavailable. Coding final graph scores completed 17/24; all-case final scores completed 20/32. Missing reviews remain null, and differing score ceilings are retained.

All 32 original native root deliveries were verified. A/B/D delegation probes accepted and created two semantic children each; C failed authoring before publication or delegation. Successful historical child-layer reads do not establish current-at-read-time or incorporation. B/C/D question probes published accepted input actions before Return; A did not. Graph-stage crops omit the inspector, so they cannot establish control usability, responses, or full interactive quality.

## Operational and measurement limits

Original failures and unknowns were retained with no replacements. An ENOSPC interruption affected D repair repetition 1. After the first 20 roots, the eval profile moved to SamsungSSD with a verified backup on 2T-SSD; restart and path-only rater requalification were recorded. A subsequent read-only ECONNRESET interrupted the dispatcher; the native judge finished naturally and only the unstarted suffix resumed. Serial shared-account/runtime conditions, storage moves, restarts, and three repetitions confound timing.

The original summary reader rejected accepted mechanism probes because their structural gate receipts had empty evidence references. Its failure is preserved. A supplemental deterministic reader keeps coding reference validation unchanged and derives unique same-execution passing probe-check matches by exact name and detail. It changes no raw receipt or production code and runs no inference. `pilot.json` binds the sealed snapshot, summary, ratings, native-delivery/publication, mechanism and supplemental-reader identities. The primary agent independently reviewed that mapping before using it here.


The expanded native-turn suites pass 182 tests; real recipe and production Prime visual scenarios pass ten. Both language recipes retain authored final detail and a bound control to the exact prior current. The first full run exposed the missing final visual summary; that real omission was repaired. The existing asset, export/import, reopen and presentation-pin checks remain intact.

The full `npm run check` passes with the supported `VITEST_MAX_WORKERS=1` environment: 3,847 JavaScript tests, three existing skips, two explicit secret-boundary tests, 77 Python tests, and the native/crash, type, receipt and readability checks. `npm run build` passes; compiled eval runtime passes six tests. The same-source default parallel run failed a public-share 10,000-layer timeout and an eval graph-memory attempt check. Those two files pass unchanged with one worker (81 tests). High machine load and cache waits support possible contention but do not prove its cause. The receipt retains every failure and the one-worker qualification; no test timeout or assertion was weakened.
