# Late Current actor review fixes

This is the current checkpoint map for four actor/gateway findings added after `26e5fc7a4d590f5064c328ab489ce6f2732b164c`. It supplements the historical README and merge-review/typecheck reports without changing their source bindings. The seven changed executable/test files are bound by `merge-actor-source.json`: 79-path source digest `89010de1df3fd0c63e5ced1bca2d8b8bf564270715a8cc88412426332fe1758d`.

Product meaning comes from the existing PRD §13.2.3 and §7.1/SOC promises, ADRs 0008/0009/0015/0016, and the user decision to let simulated users respond during a running completion. These fixes implement existing observation, explicit-input, authority and durable-evidence promises; no new product decision is inferred.

## Required checkpoints

| Promise and failure boundary | Changed production seam, including secondary behavior | Smallest deterministic checkpoint | Required assembled proof |
| --- | --- | --- | --- |
| Working navigation follows actual authored graph references; authored attributes cannot grant authority | `task-actor-browser.mjs`: observation, trusted compiled node-detail control registry, action gate and detached-control rebinding | Actor working-control exclusions and actual Close selector in `eval-task-actor.test.mjs` | Both Current variants in canonical `test:eval-web`; authored variant exercises a registered anchor, rejects a forged clone, replaces the mount through connected-node selection, rebinds the stale reference and navigates to historical Delivered |
| A visible Answer becoming Delivered is observable without a new Current revision; draft field values are not perception identity | `taskActorCurrentIdentity`: scoped, rendered Answer disabled/delivery status participates in deduplication and before/after capture binding | `same-revision identity distinguishes pending from Delivered without tracking field values` | Hold the ordinary receipt-reconciliation GET after a lost POST response; first observe pending, release GET, require Delivered at the same graph revision, then observe the next Advance |
| A non-dispatched unavailable working control gets one repair opportunity within the existing budget; uncertain dispatch cannot replay | `task-actor-service.mjs`: working recovery flag, failed-intent accounting and reset only after successful action | Repeated, last-slot and ambiguous scenarios; one fresh recovery; successful-action reset in `eval-task-actor.test.mjs` | Complete browser actor portfolio retains ordinary refusal, recovery, action-budget and cancellation scenarios |
| Recovered Product delivery survives reopen/export without rewriting original uncertainty | `HumanTaskService.readLiveAnswers` plus TaskSurface GET routing, including annotated operator workspaces | Real HTTP gateway plus graph-receipt fixture: text, order-independent selections and distinct Unicode keys; exact operation/completion/attempt/epoch/revision/occurrence/value/sequence matching; malformed/conflicting values; persistence rollback/retry; reopen and immutable old export in `eval-human-task.test.mjs` | Current browser lost-response path uses the actual Product graph receipt and one POST. The gateway-unknown persistence boundary is exercised by the real HTTP gateway fixture; compiled-runtime proof protects the unchanged canonical complete boundary |
| Judge evidence distinguishes an original unknown write from later recovered delivery and unproven incorporation | `completionEvidence`: chronological `live_answer_reconciled` projection linked to original product action | Existing current-native stopping-evidence test extended for append-only recovery chronology and `incorporation: not_established` | Browser ordered screenshot/reaction/export assertions remain; no endpoint or incorporation success claim |
| Recovery cannot grant extra execution authority | Gateway only reads task-owned Product state; the session remains interrupted; completion/admission counts and old exports stay unchanged | Receipt fixture requires one POST, one completion, unchanged interruption and original unknown event; repeated reads create only one resolution | Separate read-only ReviewSurface is unchanged; annotated TaskSurface is an operator workspace with additional annotation capability, not a separate read-only authority |

The in-process scenarios protect distinct authority, canonical-value, persistence and recovery-budget boundaries. The actual browser protects registry behavior, real DOM remounting, Product receipt projection, same-revision visibility and candidate SDK consumption. Neither substitutes for the other. No test is removed.

## Planned verification and source reuse

Before commit: `npm run check`, `npm run build`, the complete canonical `npm run test:eval-web`, and `npm run test:eval-compiled-runtime`. Native and Vitest execution use supported serialization (`RUST_TEST_THREADS=1`, `VITEST_MAX_WORKERS=1`) without changing assertions or per-test bounds. Builds and process/browser proof run sequentially.

Unchanged Product renderer, Input/Stop Electron, graph/SDK and managed Prime closures retain the historical exact-source qualifications in the prior reports. The current follow-up changes Eval service/browser/gateway code and its proof fixtures, so those paths require fresh execution. Fresh exact-head hosted `check` and `merge-freshness-status`, plus resolved review findings, remain merge prerequisites. No paid inference or release proof is added.

## Observed execution

| Execution | Actual result | Qualification |
| --- | --- | --- |
| Warm actor/human-task tests | 119 passed in two files; Vitest duration 9.84s | Final production/test closure; later changes were proof-helper-only |
| `npm run check` | FAILED, 623.141s: Clippy passed; app-server library 392 passed/1 failed | SHA-256 split-index expected Git but observed Unavailable. Downstream checks not reached; cause unestablished |
| Exact native isolation | 1 passed/392 filtered, 3.889s wall time | Original failed case, unchanged assertions and bounds; whole attempt stays failed |
| `npm run build` | Passed, 51.393s | Native plus root/workspace TypeScript builds |
| First complete Eval web attempt | FAILED, 62.384s | Interrupted-startup cleanup passed, then real graph-host readiness timed out before Current chapters |
| Isolated startup diagnostic | Passed, 3.490s | Same ten-second graph bound/temporal flags; no configured harnesses/full Eval host; original cause unestablished |
| Complete canonical Eval web retry | Passed, 287.508s | All chapters and cleanup; both Current variants observed [1,1,1,1,2], no capture gaps on this attempt; authored registered navigation/remount/rebind and actual SDK delivery/export passed; zero paid calls |
| First compiled-runtime portfolio | FAILED, 136.402s: 11 passed/1 timed out | Rich attached temporal/replay recipe exceeded original15s test bound |
| Exact compiled isolation | 1 passed/11 filtered, 19.779s wall time | Scenario12.26s within unchanged15s bound; source/assertions unchanged, original cause unestablished |
| Complete compiled-runtime retry | 12 passed/0 failed, 118.235s | Original source, assertions and per-test bounds |

`merge-actor-verification.json` binds commands, durations, raw-log/result hashes and inner outcomes. Historical exact26e hosted CI passed native776 tests across30 suite results, Vitest4247 passed/34 skipped and all selected chapters. That does not certify this follow-up. Fresh exact-head hosted CI/freshness remains required after push. No clean whole-local-suite claim is made.

## Retained failures and assertion repair

The first recovery red case also had an incorrect positive-fixture count. The corrected red case reproduced two real failures: repeated stale-control retries and an extra observation after the final action slot. The initial recovered-receipt red cases demonstrated missing durable resolution. An initial persistence repair exposed a generic error as HTTP 400; safe server failure now preserves the unknown evidence and permits a read retry.

The gated browser red case timed out after accepted delivery without a later same-revision observation. Subsequent intermediate browser failures are retained separately: the incorrect `inspectorClose` selector; a delivery-transition capture race; expecting close/reopen to replace a mount that the renderer preserves; a disconnected marker fixture; and a wrong fixture API (`submitEdge` instead of the existing `createEdge`). The final fixture uses a connected marker and real ordinary node selection. These attempts are failures, not final-source passes.

The first complete canonical browser attempt on this source passed interrupted-startup cleanup, then failed real-host graph readiness before any Current chapter. An isolated fresh graph/runtime start with the same ten-second bound and temporal flags passed (readiness output about two seconds after spawn); it used no configured harnesses and does not establish the full-host failure cause. A subsequent canonical retry retains the same source, assertions and deadlines; its actual result is recorded separately.

Adding rendered delivery status to capture identity makes a status transition during screenshot capture an honest gap. The old blanket no-gap assertion was replaced with a narrower checkpoint: only `presentation_changed_during_capture` at revisions 1 or 2 is permitted; `revisions_not_observed` remains a failure. All five required valid observations, real SDK receipt, one inference/admission/POST, budget and ordered export checks remain. Adversarial renderer review approved this as a checkpoint correction; it does not claim zero capture races or hide missed graph revisions.

The compiled-runtime first attempt timed out in the rich attached temporal/replay recipe (11 other cases passed). Its exact isolated scenario passed in12.26s under the original15s bound. One final full portfolio then passed all12 cases with the same source, assertions and bounds. The first timeout remains a failed attempt with unestablished cause.

## Limits

Receipt recovery proves Product acceptance and durable Eval evidence. It does not replay the POST, refund admission, automatically resume the interrupted actor, prove model incorporation or certify answer quality. The historical paid scenario and endpoint-judge limitations remain unchanged. Historical failed whole-check attempts remain failed regardless of later focused or hosted passes.
