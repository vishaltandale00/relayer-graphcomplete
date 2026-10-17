# PR 755 review fixes: observed results

The [required MCI-009/010 checkpoints](ci-review-fixes-20261017.md) repair two blocking automated findings on head `893a3603a64d7615b43b4b9ae902b308e7865c70`. That head's hosted CI run `39048598624` passed; its review threads remained unresolved. This patch needs new hosted evidence and publication before those threads can be resolved.

The [159-file source/plan manifest](ci-review-fixes-source-20261017.json) binds digest `e5e515ba4c85002330da98138f8b66322455d2d65cad5980aee094e410c106ec`. The delta from the previous qualified 158-file scope is exactly the two Eval host modules, their two tests and the new checkpoint document. All other 154 prior paths remain byte-identical.

| Actual entry point on this source | Observed result |
| --- | --- |
| Four focused provider/task/judge service files | 201 tests passed. |
| `npm run build` | Passed, with compatible normal local Cargo source fingerprints. No external native artifact adopted. |
| `npm run test:eval-web` | Entire runner passed, including Decisions actor/judge publication and stage reconstruction, three-completion native journey, both current-input variants, navigation/scroll, adverse dispatch, judging and reopen/persistence/export. |
| `npm run test:eval-compiled-runtime` | All 12 scenarios passed, 18.65 seconds. |
| `npm run check` | Passed: native formatting/Clippy/workspace/doc/crash tests, package/native builds, TypeScript, 336 Vitest files with 4,434 tests (one file/three tests skipped), two separate secret-boundary tests, 99 Python tests, receipt lint and PRD readability. |

The [verification receipt](ci-review-fixes-verification-20261017.json) binds all nine logs and actual closed outer return codes. Development failures remain distinct: both initial findings reproduced with four failing tests; the subsequently discovered jointly forged judge revision reproduced with two failing tests. Intermediate 197/201-test passes precede the final pinned-judge repair and are not final-source proof. The final focused201, build, whole browser, compiled and check results all ran after that repair. No test, assertion or deadline was removed or relaxed.

Earlier desktop, social/annotation capture and telemetry receipts remain historical at their exact source identities. Their consumed desktop/main, renderer, native and explicit test sources exclude these four changed paths, independently audited in the review. They are not relabeled as new invocations on this patch. Prior fixture failures, October 16 unknown failure causes and recorded warnings/skips remain explicit in their original receipts.

The final adversarial assertion separately binds this source and the completed outcomes. No paid application inference, live Decisions judge calibration, general latency/cost advantage, signed release or deployment proof is claimed. Digest consistency is not authenticity against coordinated rewriting of the entire local log. Fresh published-head hosted CI, freshness and review-thread resolution remain separate; no merge is performed by this proof.
