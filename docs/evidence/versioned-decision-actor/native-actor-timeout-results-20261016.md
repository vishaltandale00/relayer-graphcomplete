# Native actor timeout: final local verification

PR #755 adds independently versioned Decisions simulated-user and completion-judge revisions. This correction fixes native actor observation after Invoke and the browser fixture races exposed while verifying that integration. It preserves the source view until the user opens the visible result, waits for the exact applied invocation lifecycle, and preserves explicit completion authority and ambiguous-dispatch failures.

## Required plan

The product checkpoints and changed executable seams are recorded in [NAT-001..010](native-actor-timeout-20261016.md) and [NAT-011](native-actor-timeout-worker-policy-20261016.md). Product meaning comes from READ-001 and PRD sections 7.0 and 13.2.3: invoking an action retains the source, explicit navigation opens its result, and an ending model turn does not establish completion.

Required verification comprises the warm production-seam regressions, default `npm run check`, standalone `npm run build`, compiled-runtime runner, entire browser runner, the three declared desktop runners, actual affected renderer captures, and adversarial source/evidence review. No paid inference belongs in this default portfolio. No release context was requested.

## Tested source and actual results

The final qualified source is based on commit `14d60da93ad5bfdda6b2a0188261d9674594a794`. Its [40-file manifest](native-actor-timeout-qualified-source-20261016.json) has aggregate digest `1c93b250db31571086e0f25c7f9047d4cdbecd74145a2e29aff003a682a7f074`. Each file hash is verified when generating the [verification receipt](native-actor-timeout-verification-20261016.json). Evidence documents are separate from this executable-source digest.

| Required entry point | Observed result and boundary |
| --- | --- |
| `npm run check` | Passed on the exact qualified source. Rust formatting, Clippy, workspace/doc/crash/native stages, package builds and TypeScript passed. Vitest: 334 files passed, one skipped; 4,368 tests passed, three skipped. Secret-boundary tests: two passed. Python: 99 passed. Receipt lint and PRD readability passed. Repository worker policy was isolated three/process-bound one, with no CLI/environment override. |
| `npm run build` | Passed on the exact qualified source; standalone package builds and TypeScript completed. |
| `npm run test:eval-compiled-runtime` | Passed on the exact qualified source: all 12 scenarios, 30.51 seconds. |
| `npm run test:eval-web` | Entire entry passed on finalized digest `5a760ba458b7c1069c4bc4b0be7918489c53ab642f03100eb755ddc7c6ae1e13`. Includes Decisions actor/judge stages and reconstruction, billing guards, input/endpoints, dispatch authority, the native nine-action journey with three candidate completions and incomplete-to-complete recovery, both native/authored current-input proofs, judge readiness/capture, calibration fixtures and restart persistence. |
| `npm run test:desktop:node-input-actions` | Actual inference-free assembled proof passed on digest `7288fceb21bc8dbfbc4dbd997ae3c4ce8fcedc78adae62b842dc8fb489890fe0`. Production/desktop inputs are byte-identical in the final source. |
| `npm run test:desktop:interaction-context` | Actual inference-free lifecycle runner passed on finalized digest `5a760ba…`, including its nested build. Desktop inputs are byte-identical in the final source. |
| `npm run test:desktop:project-new-thread` | Actual runner passed on finalized digest `5a760ba…`, including nested build, project collapse, restart persistence and layer-selection persistence. Desktop inputs are byte-identical in the final source. |
| Renderer evidence | Actual social previews and follow-up annotation A/B Electron captures were regenerated and visually inspected. Four annotation PNGs, durable API/reload checks, and the annotation integrity test passed with zero paid inference. Updated receipts bind served source and image hashes. |

The final qualified source adds only `vitest.config.js` and `docs/agents/ci.md` to finalized source `5a760ba…`. All 38 predecessor file hashes remain identical. The standalone browser/desktop proofs therefore retain their tested snapshot identities and apply only to identical consumed inputs; they are not described as new invocations on the 40-file snapshot. Node-input proof predates the final current-input fixture script, which that runner does not consume. Desktop logs retain IPC/CSP/GPU warnings; these passes do not establish a warning-free application.

## Failures and correction boundaries

The verification receipt preserves failed, transitional and passing log hashes separately; unknown historical outer exits remain null. Raw logs stay in the ignored local verification directory. A focused test or an outer exit alone is not treated as proof that a whole inner scenario passed.

- The original Invoke regression waited for the child while the UI correctly retained its source. A second controlled regression held a real compiled asset mount and demonstrated that backing terminal state could appear before the source controls were applied. Exact source/action/result/attempt correlation and after-paint metadata repair these distinct boundaries.
- Browser adversarial scope was overwritten by a genuine queued paint. The fixture now retains the spoof across real frames, then restores genuine observations. Current-input fixtures wait for the original rendered semantic scope after a real detachment. They retain the original reference/pointer, one positive dispatch, all authority assertions, and the separate concurrent-redraw failure proof. Fixed-revision background reads are held only during the positive fill/Answer phase; ambiguous dispatch still fails terminally.
- An earlier root check failed the annotation receipt after renderer changes. The actual A/B capture was regenerated; the receipt was not repaired by copying expected hashes.
- The default check on source `5a760ba…` failed one native search assertion: `wall_time_exceeded` instead of `granted` at the unchanged 250 ms engine budget. The unchanged focused cases passed. The isolated-project cap of three matches the documented resource profile while retaining every file, assertion and deadline, and keeping process-bound serialization. Resource sensitivity is plausible; the original failure's cause is not conclusively established.
- The first qualified-source check failed the provider capture subprocess at its 180,000 ms aggregate ceiling, after one frame. Its cause remains unknown. The exact unchanged focused capture then passed in 44.5 seconds, and one unchanged full-check retry passed; its full and focused captures finished in 46.6 and 23.5 seconds. No capture deadline or expectation was relaxed. The first failure remains a failure.
- Discarded fixture experiments, including logs with misleading historical “green” filenames, remain explicitly classified as failed in the verification receipt. No existing production-authority test was deleted. The redundant second detached-handle assertion was replaced only after preserving the real first detachment and observing the same rebind boundary with the original actor reference.

## Review and limits

The [qualified static review](native-actor-timeout-qualified-review-20261016.json) binds reviewer `/root/review_versioned_actor` to the exact 40-file digest. Earlier source, render-authority, fixture-subsumption and image reviews remain bound to their own immutable receipts. The [final heavy review](native-actor-timeout-heavy-review-20261016.json) separately evaluates actual completed results, source reuse and evidence hashes; its verdict must be read within that scope.

Normal compatible Cargo source fingerprints were reused. An earlier Ladybug archive was rejected for incompatible Cargo.lock identity. No incompatible artifact was adopted and no cache substituted for required tests.

The historical live actor pair used the native judge on its separately recorded earlier source, with different paths and turn counts. It remains unchanged. No paid application inference or live Decisions-judge calibration was run for this correction. Judgment quality/equivalence, general latency/cost advantages, hosted CI/packaging and release readiness remain unproved by these local deterministic results. Fresh-head hosted CI is tracked on PR #755.
