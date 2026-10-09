# Communication contract as the Codex baseline

The user explicitly selected B on 2026-10-08. Codex now treats current as the way to explain ongoing work: publish a useful finding, uncertainty, or consequential question, then update when understanding materially changes. Authorized semantic children remain optional; when used, their changed currents are observed, read, and meaningfully incorporated. User answers enter the next ordinary interaction.

The implementation promotes the tested contract and early-publication recipe onto current main, retaining main's newer scoped-authoring API, root-label/icon, provider, and authority guidance. It changes Codex basic and both layered profiles. Claude's shared layered prompt and Prime's Python prompt retain their baselines. It adds no harness setting, scheduler, graph acceptance rule, presentation-version activation, or paid default test.

## Changed seams and verification plan

| Seam / promise or boundary | Smallest production checkpoint |
| --- | --- |
| Default basic, layered, and multi-agent Codex native-turn prompt delivery, with and without broker | `packages/harness-host/test/codex-basic.test.ts`: `uses the communication contract by default in actual %s turns` |
| Conditional semantic broker use; no invented child findings or same-completion answer resume; credential exclusion | The same actual-turn test, plus existing broker and normalized-input tests |
| Shared layered prompt remains provider specific | `preserves Claude's shared layered prompt while promoting the Codex default`, plus actual Claude and Prime harness suites |
| Actual runnable early-publication example, active Advance, explicit terminal Return, prior-current integrity | `test/recursive-complete-e2e.test.mjs`: `executes the Codex baseline recipe with prior current %s and preserves it at final submission` through real graph/client/app-server |
| Existing scoped API, exact prior-layer object target, same root action retarget, stable identity and explicit layouts | Actual recipe checkpoint plus actual-turn prompt assertions and existing graph authority suite |
| Build and assembled runtime | `npm run check`, `npm run build`, `npm run test:eval-compiled-runtime` |

Product meaning follows PRD §4.3 and §12.1, temporal-current ADR 0008, node-authored-input ADR 0008, and personal-presentation ADR 0009. The PRD records the explicitly authorized Codex baseline decision. These are prompt expectations, not deterministic Advance-count requirements. No tests were removed; placeholder assertions now observe the new runnable example while preserving their API/authority boundaries.

Required before commit: full check/build and the compiled runtime entry. The real-runtime recipe is a separate process proof, not an in-process edit-loop test. Release and paid inference proof are outside this change's context.

## Executed verification

[verification.json](verification.json) binds the five changed source/test/PRD files to digest `80f6f9b25a4bb0e9bb295f63da68e5d942a426853d2be111c4ca68cad33a1b11` and records command results separately from the plan. On this exact source, `npm run check` and `npm run build` passed. The full Vitest suite passed 3,843 tests with three existing skips; the explicit secret-boundary suite passed two and Python passed 77. Native workspace and crash-reconciliation scenarios, package/type checks, receipt lint, and PRD readability also passed. The compiled eval-runtime entry passed six tests. The targeted real recipe and module inventory entry passed seven tests.

The first full check had three failures: test observation used a presentation-edit-authority read, and stale generated output violated the packaged-module inventory. After using ordinary layer reads, an intermediate assertion still expected an authoring key instead of the compiled mount identity. The final assertions verify real expand/reference mounts and accepted action bindings. All failures are preserved separately from the final pass; no production authority was widened.

Before native verification, the official cache verifier rejected the old Ladybug bundle because Cargo.lock identity changed. No compatible sealed runtime was available. A private compiler-object cache clone accelerated ordinary source-based Cargo checks/builds; no cached result supplied proof. Local log hashes and an adversarial review assertion are recorded in the receipt. Hosted PR CI remains separate.

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
