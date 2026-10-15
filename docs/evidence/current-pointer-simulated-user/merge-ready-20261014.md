# Merge preparation — 2026-10-14

PR 728 makes the simulated participant observe Current while completion runs and answer eligible root questions during that completion. Ordered observations and graph-owned Answer receipts remain reviewable. The initial contract stays sealed; providers retain recursive execution and GraphComplete retains acceptance and temporal authority.

## Source and required verification

Main `8c8e05694c69c40ad5f173e9613a7ef739846f41` is integrated into prior head `e9fb86662ac0a596c2db70b9641a6bd586fd969a`. The combined baselines are Codex 18, Claude 12 and Prime 14, with Structure/V6 defaults and prior immutable pins preserved. [The source manifest](merge-ready-source.json) binds 76 executable/configuration/test paths at `87c0e33be5432ff15ba9ad7841c02fe5b4e548691cb2f6264c077b7db91b0249`; unchanged main source is bound by the immutable main parent.

The delivered JS/Python example now provides a bounded 30-second participant opportunity. Exact real-server journeys send an accepted answer 1.5 seconds after the actual SDK wait begins: the former one-second examples fail and both updated examples consume the matching value/cursor. A separate fixture-only short wait covers empty expiry; fresh-client finalization preserves accepted content. No acceptance, scheduling or admission rule changes.

The [checkpoint map and plan](README.md#merge-preparation-and-participant-response-window-2026-10-14) require warm production-seam tests, full check/build, complete Eval web, compiled runtime, managed Prime identity verification, actual Electron Input/Stop, bounded live confirmation and adversarial review. Compatible trusted private native objects are reused; changed main Rust source is compiled. No downloaded cache restoration, cold native provisioning, test deletion or release-candidate proof is claimed.

## Proof-runner repairs

Provider capture now configures a blank browser target before its single scene navigation. The previous double boot can dismiss onboarding before the capture waits for it; both deterministic adversarial variants fail with the old sequence and pass with the repair. The Eval settings fixture waits for its animated family editor to settle before typing; actual fill, Save and API persistence remain required.

Aggregate provider-video and multi-decision actor proof budgets are bounded workload allowances. Per-scene readiness and product action/admission deadlines are unchanged. They do not qualify startup, TTFG or performance.

The shared Electron proof parent retains its isolated profile through child exit. Both parents require zero exit, no signal and an explicit final positive receipt. Stop writes success after fixture reset and owns last-window close until its explicit exit. A timeout/signal retains the profile because main-process termination does not prove descendants settled; a real descendant-writer fixture checks that boundary. Existing child-reset failure assertions remain. Production Electron/runtime behavior is unchanged.

## Live confirmation

[The live record](merge-ready-live-results.json) documents task `human-ba2eb609-2ef7-4bb2-9da7-f1852928b474`, the same pinned Europe-trip case, Codex/gpt-6-luna and task-actor-v9/gpt-5.6-luna. It used one candidate completion against a cap of three and actually attached V6.

Current advanced to layer 19 with one accepted Input, then returned layer 20 successfully. One accepted Answer (sequence 2, Current revision 1) arrived during the 30-second wait; the SDK returned it after about 9.4 seconds. The candidate used its group, origin, duration, budget, mobility, interests and hotel-change constraints in the final response/artifact. The sealed initial-contract digest remained unchanged. All nine candidate output envelopes were inspected; there were zero accepted-node rejections and one local nested-detail-template error repaired before Return. All six actor actions completed without a fatal actor error.

This proves delivery, read and observable use for this run. Actor satisfaction was 3/4, but both actor and independent judge reported the endpoint incomplete: dates, approval, accessible/bookable detail and the agreed deliverable remained missing. It does not establish task attainment, calibrated graph quality, statistical or causal error-rate improvement. V6 versus the prior V4 attachment is a comparison confound. The retained private startup allowance does not qualify standard startup/TTFG. No further paid retry was admitted.

The frozen export is `sha256:74658229d19ddd41b0de5c04214dfd142bcada7d13d5756ac7902ae1b8f5cb42`. Post-shutdown reads included SQLite WAL and retained the accepted receipt/terminal Current. Owned services stopped and their verified-dead lock was removed. Earlier stale-answer and detached-click failures remain historical records.

## Execution and review

Completed execution, failed attempts, exact log hashes and reuse qualifications are recorded separately in [verification outcomes](merge-ready-verification.json). A completed scenario print alone is insufficient: the actual Electron gates require final cleanup receipts and successful process exit.

| Required execution | Result |
| --- | --- |
| Final build | Passed |
| Complete plain Eval web | Passed, including native/authored Current Answer, ordinary inputs, actor authority, settings and persistence |
| Compiled runtime | 12 passed; unchanged runtime dependencies qualified in verification record |
| Actual Electron Input and Codex/Prime Stop | Passed through final canonical parents, final reset receipts and zero exits |
| Managed Prime macOS ARM64 | Ready, exact combined configuration/SDK seals verified |
| Warm guidance/config/host / CI planner | 330 / 89 passed |
| Final secret boundary / Python SDK | 2 / 97 passed |
| Native receipt gates / PRD readability | Passed |
| Whole check, second invocation | **Failed:** native/doc 771, crash/doc 361, static/package checks passed; Vitest 4,268 passed, six failed, three skipped |
| Exact affected integration isolation | Six passed: three Claude pin variants, Lantern, Invoke input and deep share; unchanged assertions/bounds |
| Exact known-good calibration isolation | Passed, original bound |
| Unchanged Homebrew closure fixture | Failed at its original 30-second bound in the full suite and twice in isolation; qualified diagnostic security assertions passed; uninstrumented timing remains unknown |

The five generic case deadlines were Homebrew 30 seconds, calibration 20 seconds, Claude V3 pin 20 seconds, Invoke 20 seconds and share 15 seconds. Lantern's internal 60-second completion wait expired with two executions passed, the third running, fourth queued and no recorded execution errors. Exact isolated passes establish checkpoint success and non-reproduction for those invocations; they do not establish the failed-command causes or turn either whole command green.

The unchanged main-owned Homebrew scenario discovered 24 dependencies, copied 25 files/116,105,408 bytes, sealed the closure and passed sandbox execution in a standalone diagnostic (21.58 seconds). The original Vitest case also passed with only diagnostic stage logging/publication callback, retaining every assertion and the 30-second bound (23.36 seconds). Its success stage logs were hidden by the reporter, so no original-case stage breakdown is claimed. The wrapper restored the exact original fixture (`f99d56ff4fe0f2ce70fd55c13240e8f9e28bb95170295f0270b17bb21ff8837f`). No timeout/security assertion changed and no repeated attempt is relabeled. This is qualified security-checkpoint evidence for unchanged source, not an uninstrumented timing pass or a proven flaky-test diagnosis. Hosted Linux CI cannot certify this macOS-only seam.

The final 76-path source manifest is unchanged. Native/TypeScript inputs stayed fixed throughout the second whole check; the final 74-path runtime/proof snapshot was frozen before JavaScript imports. CI owner mapping and two planner cases were edited afterward and separately passed all 89 checks. The final manifest includes them; documentation/evidence edits add no executable seam. Prior intermediate browser/Electron/full-check failures and diagnostic attempts remain hash-bound in the verification record. No scenario print is substituted for process exit or final cleanup.

Reviewer `design_authority_review` approved source/mapping at the 76-path digest and the qualified unchanged-Homebrew checkpoint above. The final source/evidence assertion is recorded durably in PR 728 against its reviewed snapshot. Exact-head hosted `check` and `merge-freshness-status` remain separate merge requirements; this local report does not pre-certify either. No merge into main is performed by this preparation.
