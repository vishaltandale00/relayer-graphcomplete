# Merge review follow-up

The user authorized merging PR #728 on 2026-10-15. Six automated findings arrived after the previous handoff and blocked merge. This follow-up fixes those boundaries before merging; prior `964e3488` CI and source-bound reports remain historical. Product authority is PRD §13.2.3 and ADRs 0008 (temporal Current and node-authored Input), 0015 and 0016. No product meaning or inference budget changes. GraphComplete still owns graph acceptance, providers own execution, and `complete(inputGraph)` remains canonical.

## Required checkpoints

| Changed executable seam / product promise | Smallest deterministic checkpoint |
| --- | --- |
| A retry cannot mix new graph authority with the preceding Product attempt | Real activation/attempt storage and Product GET/POST scenario during the authority/attempt gap; immutable epoch binding, unpaired legacy attempts fail closed, normal paired acceptance works |
| Existing accepted Answer retry identity survives retry and settlement | Same native trusted receipt scenario, including exact-key recovery and refusal of a different request; additive Product migration/reopen retains historical attempts without fabricated binding |
| Receipt recovery reaches answers beyond the first 100 after Current advances | Real Product GET/POST with graph-page fixtures verifies cursor forwarding; HumanTaskService authenticated gateway recovers receipt 101, persists its exact graph receipt and preserves original unknown POST/admission count |
| A partial, failed or cancelled receipt traversal cannot confirm delivery | Real service later-page HTTP failure, non-progressing cursor and cancellation; no partial evidence mutation, queue released |
| Stop/deadline cancellation reaches the actual reconciliation read | Authenticated actor surface → real HumanTaskService → stalled upstream fetch; supplied actor signal cancels request and releases queued actor evidence. Existing actor Stop/deadline callers remain separately covered |
| Same-revision approval/resume changes remain visible to the actor | Production identity/dedup checkpoint; real harness approval channel and Product decision HTTP in native/authored browser variants, with running → waiting_for_approval → running screenshots at one revision |
| Later questions cannot reuse earlier receipts or another node's same action key | Execute delivered JavaScript and Python guidance against real graph server: successive questions plus colliding per-node action keys, bounded wait for exact completion/layer/source/action occurrence |
| Graph rejection messages provide usable recovery instructions | Native/authored renderer Answer failure journey, nested message, malformed payload fallback and literal text rendering |

Tests cover distinct boundaries; product assertions and time limits remain intact. The later Prime/Codex privacy assertion correction is documented below. The newly added cancellation duplicate that varied only an error-message string is intentionally folded into one gateway checkpoint; existing actor Stop/deadline tests cover their distinct callers. No pre-existing test is retired.

## Required verification plan

Use the existing trusted compatible private SSD build cache; no cold native provisioning or paid inference. Run focused tests while editing. Freeze all source before broad proof. Run `npm run build`, recapture actual annotation/social evidence and verify receipts because renderer source changed, then run `npm run check`. Retain any failures with exact source/environment identity and inspect inner outcomes. Run canonical complete Eval web, compiled-runtime and actual Electron Input/Stop proof where the changed seams require them. Keep build, capture and runtime consumers serialized. Cross-review implementation, checkpoint mapping and completed evidence adversarially; bind durable assertions to final source/evidence digests. Commit and push, resolve only verified findings, require fresh exact-head hosted `check` and `merge-freshness-status`, recheck review threads, then merge the exact verified head using an allowed repository method. Never bypass branch protection.

## Execution status

Local follow-up execution is complete. Warm/intermediate tests establish individual regressions; the broad local check remains failed as specified below. Final independent outcomes, retained attempts and exact source identities are recorded in `merge-review-followup-verification.json`. Fresh hosted exact-head CI/freshness and the final review-thread read remain pending after push. No paid model, calibrated graph/task quality, performance or signed-release claim is made.

## Test assertion correction

The broad local check at source `20058fb4…` reported 782 native passes and 367 separate, overlapping crash-feature executions. Vitest reported 4,322 passed, three failed and three skipped. Two failures came from old global bans on the text `sourceNodeId` in delivered prompts: the repaired reply-reading recipe legitimately uses that public API property. The normalized-input privacy promise still applies. Both tests now require exactly one complete parsed normalized-input block and compare it to an independent exact semantic expectation, retaining context/annotation order, Codex permissions and child reread guidance. The key bans apply within that block; explicitly adversarial extra-field values must remain absent throughout the whole prompt. Independent actual-diff subsumption reviews passed. Complete Prime/Codex files passed 149 tests; harness-host typecheck passed.

Only those two test files changed between the broad-check/build/capture snapshot and final 90-path source `d074d0aff4e3d7473d2401c7e639e8fa05be814ecba401add783eb7d65a43d70`. Production, native and renderer closures are unchanged, so successful build/capture/native outcomes retain their original snapshot identities. They do not imply a clean final local whole check.

The third failure is the unchanged 10,000-layer public viewer depth case (15,219 ms against its unchanged 15-second limit). Test/parser/import hashes match main and the previous semantic diagnostic. That diagnostic does not prove the time bound. No timeout or parser change is made; fresh exact-head hosted CI must execute and pass the unchanged case. A hosted failure requires investigation, not waiver. The original failed check remains recorded.

## Final browser checkpoint

The complete canonical Eval web portfolio passed in 168.6 seconds on final source. Both native and authored Input variants accepted the real UI Answer, consumed its graph receipt through the candidate SDK, preserved sealed initial input and retained one inference/one admission/one Answer request. Both captured revisions `[1,1,1,1,1,1,2]`, including `running → waiting_for_approval → running` at revision one, and verified terminal provider read refusal. Native capture recorded one explicit `presentation_changed_during_capture` gap at revision one before successful recapture; authored capture recorded none. All seven expected observations are present. This proves fixture protocol behavior, not live-model task quality or answer incorporation judgment.

## Other completed outcomes

Build passed in 190.032 seconds at the original snapshot. Real annotation/social recapture, two receipt tests and bounded post-exit cleanup passed; all six images were independently inspected. Focused native authority/migration checkpoints passed five actual tests; service/actor tests passed 141 cases and guidance/renderer tests passed 79. A short native `--exact` precursor selected zero tests and is expressly excluded from proof. Intermediate schema-fixture failures and browser proof on the prior native binary remain retained attempts.

At final source, compiled runtime passed all 12 scenarios. Actual Electron Input passed with zero paid inference calls; actual Codex and Prime Stop each recorded one abort, stopped lifecycle and cancelled attempt. Bounded matching-script/profile post-exit inventories were empty. Independent continuation checks passed: both macOS secret-boundary cases, 99 Python cases, Ladybug receipt lint and PRD readability. These gates do not upgrade the failed local whole check.

Final adversarial assertions bind the 90-path source and assembled evidence manifest in `merge-review-followup-review.json`. Reviewers exclude their own implementation areas. Hosted proof is required on the resulting commit before merge, and is recorded in the PR rather than fabricating a pre-commit CI result here.
