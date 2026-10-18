# PR 755 final review correction: observed results

The [MCI-011..014 plan](ci-final-review-20261017.md) maps complete judge audit, observed fill capability, explicit standalone family roles and deterministic Windows fixture failure cleanup. Previous no-blocker reviews missed the two subsequent findings; their exact source identities and limitations remain historical. This correction changes no judge policy, native recursion, default, release authority or deadline.

The [final161-file manifest](ci-final-review-source-20261017.json) binds digest `fb80bc9b8cf10e815fc213b0d2923223920f682f162354cd48290218a8537178`. The [qualified160-file evaluator manifest](ci-final-review-evaluator-source-20261017.json) retains digest `1efd7ff8ff00b4140451328ca97e5a9ee66f84cd98b33bb911676828f3792387`. After its evaluator proofs passed, only the unrelated Windows unit fixture and checkpoint document changed. All bound evaluator executable/test inputs remain byte-identical. No previous invocation is relabeled as a fresh161 run.

| Required entry | Actual observed outcome and source |
| --- | --- |
| Focused actor/task/judge service files | 182 tests passed on qualified160. |
| Standalone `test:eval-actor-inputs` | Passed on qualified160: real observation excludes checkbox/radio/readonly fill, retains click, fills text/textarea/supported range through Playwright, and completes existing multi-select/Send/second-response proof. |
| Entire `test:eval-web` | Passed on qualified160, including exact metadata/privacy assertions, Decisions actor/judge stages and reopen/export, three-candidate native multi-turn recovery, both current-input variants, scroll, adverse dispatch, judging and process persistence. |
| `test:eval-compiled-runtime` | All12 scenarios passed on qualified160,18.59s. |
| Fresh `npm run build` | Passed on final161, using compatible normal Cargo source fingerprints; no external native artifact adopted. |
| Windows candidate unit suite | All10 tests passed on final161. Full-resource positive signing/copy/inventory/source-byte assertions remain. A directory matcher filtered to one native EXE tests partial-signature rejection and untouched source bytes without concurrent sibling writers. |
| Fresh `evidence:telemetry` | Passed on final161: native panic5, explicit19-file portfolio184 tests. New artifact archived separately; original canonical historical artifact restored byte-identically. Local evidence only. |
| Fresh `npm run check` | Passed on final161: formatting/Clippy/native workspace/doc/crash tests, builds/TypeScript,336 Vitest files4437 tests (one file/three tests skipped), separate secret-boundary2, Python99, receipt lint and PRD readability. |

The [verification receipt](ci-final-review-verification-20261017.json) binds24 logs and actual closed outer return codes, the two qualified source snapshots, controlled probe and fresh telemetry artifact. Prior failures remain explicit:

- Three regressions reproduced before the complete-chain/fill fix. Two standalone setup attempts failed before input proof (missing roles, then incorrect singular role).
- The pilot full browser passed new input/judge chapters but failed its old exact-field whitelist; later chapters were unreached. The corrected assertion remains exact and adds only boolean/type metadata and scalar checks.
- The first root check on qualified160 failed one Windows fixture cleanup with ENOTEMPTY after4436 tests passed. Secret-boundary, Python and lint/readability chapters after Vitest were unreached. The library's aggregate rejects without draining sibling writers; a controlled production-library probe proved a sibling can finish writing after rejection. The exact sibling responsible for the original error remains unidentified. The fixture was corrected, then the full declared check passed; this was not an unchanged retry or a cleanup-retry workaround.

Historical hosted CI on ae3 remains separate: attempt1 timed out in an unchanged Ladybug beforeAll and skipped its14 assertions; one diagnostic failed-job retry ran all14 and passed4499 tests. The slowdown's cause remains unknown, with contention plausible. Both attempts retain the original creation-time freshness window. Those logs and the isolated local14-test pass are hash-bound in this receipt; they do not qualify the new source for hosted readiness.

Prior desktop/capture proof remains at its exact historical identities, with unchanged consumed-input review. Telemetry was refreshed because its portfolio consumes the repaired Windows test. The final adversarial assertion binds the exact source, substitution boundaries and actual outcomes separately. Fresh published-head hosted CI/freshness and resolution of the two new review threads remain publication gates. No paid application inference, live Decisions calibration, general latency/cost or judgment-quality claim, signed release or deployment proof is made.
