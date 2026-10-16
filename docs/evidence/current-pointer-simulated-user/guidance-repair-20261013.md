# Authoring guidance repair, 2026-10-13

The corrected candidate recorded zero visible authoring failure outputs and one nonterminal Current Advance. The earlier baseline recorded five authoring failure origins and no Advance. This is a small behavioral observation, not a statistical improvement or task-quality pass.

## Source and comparison

Baseline source: `18c46db76ec9a70855836d64e5849b3802f154be`. Both treatments use that checkout plus the guidance/example changes. Candidate: codex-basic / gpt-6-luna. Actor: task-actor-v9 / gpt-5.6-luna, unchanged setup `setup-98dee801-7d74-4071-81b5-3b4190d3cf4c`. Case: `interactive.everyday.europe-trip`, catalog commit `2ae3ff3a24ea74d7f73fab5ebd5304e7ba49ffe4`.

| Attempt | Candidate completions | Observed authoring failure origins | Current Advances | Accepted live Answers |
| --- | ---: | ---: | ---: | ---: |
| Baseline, October 12 | 1 | 5 | 0 | 0 |
| Initial guidance, October 13 | 2 | 3 | 4 | 1 |
| Corrected example, October 13 | 1 | 0 | 1 | 0 |

Count visible failure origins once per native tool output, rather than counting the multiple compiler issues within one rejection. These counts are manual trace observations, not an exhaustive automatic error metric. Baseline had 33 candidate native tool calls and a separate search-index timeout. Initial treatment had 27 tool calls across two completions; all three observed failures occurred in its first completion. Corrected treatment had ten calls; every captured output was also inspected for error markers. See [guidance-live-results.json](guidance-live-results.json) for canonical histories, native trace hashes and immutable export hashes.

The initial treatment source digest was `ce8d344a330dbb5024b8cc38f372f85188abb64924d08a1413a36d08a0d95361`. Its errors were an unsupported `doc` artifact icon copied from the newly supplied example, a navigation target lacking an accepted-layer record, and an unsupported `people` icon. The invalid example was corrected to `box`. An acceptance test executing the exact delivered artifact fragment first reproduced `unsupported_icon`, then accepted the corrected Markdown artifact through the real graph server. The same icon literal is corrected in Python; that exact artifact acceptance checkpoint is JavaScript-only.

Corrected treatment source digest: `a9420890aeafbfca0ce7047978742c98c59a81de6a26178ed65ad4a079d2d038`. Its graph root 33 records initial → Advance(layer 12) → Return(layer 14). Initial treatment roots 21 and 26 each record two Advances followed by Return. No integrity or acceptance rule was weakened.

The initial session finished after two candidate admissions. The corrected session used the remaining one admission, preserving the total budget of three. Its reduced cap prevents a controlled whole-session quality comparison. Both sessions ran on the same isolated SSD profile with the same provider, model defaults and actor setup. Only existing authentication, verified native runtime and actor setup registry were copied into the initial fresh profile; no baseline databases were reused. Both baseline and treatments used the same local 60-second graph/Product startup allowance, so this is not standard-startup or latency proof.

## Remaining live limitations

Initial treatment accepted one live Answer, but the candidate called neither getLiveAnswers nor waitForLiveAnswers. Receipt therefore establishes delivery only, not incorporation. The actor finished with satisfaction 3 and endpoint incomplete; the independent completion judge also reported incomplete. Participant approval and a user-verifiable shared itinerary remained unresolved.

Corrected treatment's candidate returned successfully, but its actor was interrupted during act_current. Playwright reported a detached element while clicking. Recovery refused replay because the input recorder had changed (`untouchedInput=false`), leaving `actionDispatched=unknown`. Zero accepted live Answers were recorded. The failure is retained in the private actor diagnostic trace and export. It does not negate canonical Advance or certify the Answer path. No further paid retry was admitted.

## Verification

Required plan: actual baseline-turn and compiler checks, real JavaScript/Python communication recipes, exact scoped-artifact acceptance, compiled-runtime portfolio, full Eval web portfolio, build and full check. Production graph semantics, renderer and actor protocol are unchanged. Compatible private source-build objects were reused; no cold native build or new worker was provisioned. No test was removed.

Completed results:

- Actual-turn checks: 182 tests across three provider files passed. Configuration/compiler fragments: 33 tests across two files passed. Python fragment ran through the production Prime compiler.
- Real communication recipes/scoped artifact journeys: nine passed, six filtered. Compiled runtime: all 12 scenarios passed.
- Exact newly supplied artifact acceptance: one passed, two filtered after the red `unsupported_icon` reproduction. A separate attempt raced a build's dist cleanup and ran no tests; it is not counted as a product failure or pass.
- Final build passed on the corrected executable source.
- Native and authored Current browser chapters passed individually. The full Eval web portfolio failed before these chapters: first an unchanged individual task status was interrupted instead of completed; a diagnostic retry failed earlier waiting for a visible Create button. Scoped chapter success does not certify the full runner. No assertion or timeout was weakened.
- Earlier full checks failed on a native output-bound timing assertion, then on typing in the newly added test. The unchanged native test passed in isolation without establishing the original cause. The new test's unknown-value assertion was corrected. Final full check passed: 770 native workspace/doc tests, 361 crash-feature/doc tests, TypeScript/workspace gates, 4,254 Vitest tests (three skipped), two secret-boundary tests, 97 Python SDK tests, Ladybug receipt gates and PRD readability. The earlier failed attempts remain preserved; their outcomes are not rewritten.

Source/mapping review by `design_authority_review` passed for the corrected-source digest above. Evidence review passed on workspace digest `75d8403555d55149635d948f4138500dc24655f548d2efe37417fe37d4ec5799` and sanitized results SHA `87334dd329eb038e7fb0aaa7abb74e61f8c7dae921e2fa489c165868539cef2b`, before this full-check result was added. Final source-bound assertion is recorded in the PR. The review does not certify model incorporation, coherence-score calibration, task attainment, overall browser portfolio or release readiness.
