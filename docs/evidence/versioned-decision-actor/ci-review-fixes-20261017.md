# PR 755: completion-stage integrity and missing-model recovery

Two automated review findings on `893a3603a64d7615b43b4b9ae902b308e7865c70` remained after hosted CI passed. These enforce the existing PRD §13.2.4 and CJ-005 promises; no judge policy, revision, default, or completion authority changes.

## Required checkpoints and verification

| Checkpoint | Executable seam and failure boundary | Smallest deterministic production observation |
| --- | --- | --- |
| MCI-009 / CJ-005 | HumanTaskService export validates every stage envelope independently of its claimed phase; ordered request/result pairs bind exact packet, model, provider and session-pinned judge. Invalid, orphaned, duplicate or reordered stages cannot become a new evidence bundle. | Actual Decisions judge and persisted/reopened service journey: corrupt payload, phase, terminal digest, duplicate request, reporter-before-selector, orphan result, and jointly forged evidence/stage judge revision. Both reporter success and failure paths reject corruption. |
| MCI-009 partial execution | Valid request-only, selector-result-only and reporter-request-only prefixes remain exportable as interrupted partial work. Native historical sessions need no Decisions stage. Existing finish authority remains unchanged. | Interrupt the actual judge immediately after each of its first three durable stage callbacks; reopen/export and assert interrupted status, actor failure and absence of a completion judgment. Existing native and judge-gating service tests remain. |
| MCI-010 / CJ preflight | Shared actor/judge Decisions runtime classifies only discovery GET model 404 as unsupported model before text preflight or candidate inference; request failures retain sanitized runtime errors. | Provider setup actor/judge preflight fixtures assert missing-model error, no text preflight and no POST; successful discovery followed by inference POST404 retains generic classification and excludes private response body. |

The warm loop runs the four affected service/provider/judge test files. Required handoff entries are fresh `npm run build`, `npm run check`, the entire `npm run test:eval-web`, and `npm run test:eval-compiled-runtime` as required by the judge evidence plan. No paid inference. Compatible normal local Cargo source fingerprints may be reused; no cold worker or external artifact is adopted.

Previously completed desktop, renderer capture and telemetry receipts retain their original tested snapshots. Only two Eval host modules and their two tests change here; the standalone desktop/capture/native/renderer sources stay byte-identical. These prior results are historical, not fresh invocations on this patch. Adversarial review verifies the consumed-input boundary before claiming scoped reuse.

Digest checks establish consistency of retained packets and pinned configuration, not authenticity against coordinated rewriting of the entire local log. Export does not rescore judgments. No test or assertion is deleted or deadline relaxed. Required plan, observed outcomes and exact-source review are recorded separately. Hosted CI and thread resolution must bind the published fix before a readiness claim.
