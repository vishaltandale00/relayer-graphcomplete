# Optional Decisions completion judge

The user requested a PR for the tested Decisions simulated user and explicitly added the completion judge on 2026-10-16. PRD 13.2.4 records this additional execution choice. Defaults and historical actor/judge revisions remain unchanged. This is a separate completion judge, not the graph-presentation grader or a graph scheduler.

Decisions selects complete/incomplete/uncertain from bounded original evidence and its screenshot. Codex generates the required evidence explanation and ordinary-user continuation hint under a singleton verdict schema. Refusal, malformed output, changed verdict, provider failure or cancellation never becomes completion or native fallback. No speed, cost, quality or calibration advantage is claimed.

## Changed seams and required checkpoints

| Checkpoint | Executable seam | Smallest deterministic proof |
| --- | --- | --- |
| CJ-001: Explicit immutable execution and native defaults | Completion judge spec validator, YAML catalog/parser/publication/reopen, native bootstrap selection | New judge adapter and registry tests: strict separate contract, config/spec mismatch rejection, publish/reopen/select/release identity, native default unchanged |
| CJ-002: Real verdict selection and constrained feedback | Production createCompletionJudge branch, singleton native schema and existing assessment validator | Actual adapter tests for all three verdicts, unchanged native path, evidence/label isolation, malformed/refused/mismatched output and cancellation |
| CJ-003: Both routes ready before task/candidate work | Shared private Decisions provider transport and role-specific actor/judge resolvers, production index wiring | Provider tests for exact account/model/endpoint, host-only credentials, response/error projection, native route preflight and preserved actor behavior; real TaskActorService preflight test |
| CJ-004: Billing and finish authority | TaskActorService and direct HumanTaskService creation, independent/release/embedded judge resolution | Service tests reject API judge for subscription-only authorization before providers, task insertion or candidate creation; actual judge gating tests preserve rejection/recovery and no approval on partial failure |
| CJ-005: Durable partial model evidence | Awaited stage callback, fixed stage event kind, digest-bound original packet and stage request reconstruction, reopen/export integrity | Actual adapter/service tests persist request/result/usage before reporter; failure/cancellation retains partial stages; both reconstructed requests match dispatched packets; tampering blocks export |
| CJ-006: Explicit UI choice and inference disclosure | File-backed setup editor route summary, completion picker/release changes, start notice and subscription-only guard, task detail | Independent full-web chapter publishes/selects new YAML revision without promotion, verifies route disclosure, original/default isolation and release-aware billing guard |

The selector request uses a versioned text/image transform of the retained bounded packet. Reporter input reconstructs that same packet plus the host-owned selected verdict; its prompt and singleton schema are retained separately. Stage events preserve per-request selector usage and cumulative native-session usage with explicit field names. Partial stages are diagnostic evidence, never authoritative finish judgments. No test is removed or weakened.

## Required verification plan

Use injected model decisions in the warm adapter/registry/provider/task/session tests. Before commit, run build and resource-bounded check; run compiled-runtime and the full web entry point. Preserve all failures and unreached chapters. The previous exact-source results remain historical; new source and log receipts will bind this implementation. No paid inference is part of default tests. Live judge calibration and deployed behavior remain unproved unless separately observed.

Adversarial review covers semantic/authority boundaries, partial evidence, YAML identity/default isolation, billing disclosure and exact-source verification. A PR assertion will identify reviewer, source digest, scope, verdict and unresolved findings. No automatic promotion, merging or release is authorized by this PR task.

## Source and historical evidence boundaries

`completion-judge-source-20261016.json` binds 31 executable, test, configuration and PRD files at workspace digest `c67a5acedc3f370141c46ac4ffcea27d14f81e2795f43586b49fd3e5a4957dc1`, on main commit `c8225db3139f1c944022b50d2293c14d7f5862f0`. `completion-judge-review-20261016.json` records the adversarial static review of that exact source: no blocking findings; heavy verification and live calibration are separate.

The paired live actor comparison remains bound to its original `77b1b296022b17c29b06aa0da24522ead3344617` base and recorded source digests. It used the native completion judge. Its response paths, timings and cost proxies do not measure the new Decisions judge or the subsequently updated native runtime. Historical reports and their failed or unreached checks are retained unchanged.

Updating this branch to main required regenerating the social-preview receipt from the combined production renderer with the existing Electron capture workflow. Both themes were visually inspected; PNG bytes stayed unchanged. The new receipt replaces the conflicting receipt and does not establish hosted-preview or release proof. The existing local Cargo cache was used through normal source fingerprints. The previously inspected Ladybug archive was rejected for its incompatible Cargo.lock digest; no incompatible archive was adopted.

## Observed verification

`completion-judge-verification-20261016.json` binds the retained command logs and artifact hashes to the source above. Required work, executed commands and observed results remain separate:

| Entry point | Actual result on the final source |
| --- | --- |
| Focused production-seam tests | 10 files, 294 tests passed. |
| `npm run check` | Passed: formatting, Clippy, complete Rust workspace/doc tests, crash reconciliation, native/package builds, root/workspace TypeScript, 4,360 Vitest tests (3 skipped), secret-boundary 2 tests, Python 99 tests, receipt lint and PRD readability. |
| `npm run build` | Passed. |
| `npm run test:eval-compiled-runtime` | All 12 scenarios passed, 33.11 seconds. |
| `npm run test:eval-web` | Failed. New actor/judge, input/endpoint UI and input-v4 chapters passed, as did dispatch/native-select/redraw assertions. The existing native actor journey timed out in `observe` after Send/Invoke (two additional submissions after the initial request) and ended interrupted instead of completed at line 1145. Later chapters were not reached. |

The full required portfolio has **not** passed. The browser failure remains unresolved; it was neither retried unchanged nor hidden by changing deadlines or assertions. The PR stays draft. The new judge browser chapter establishes fixture execution, publication, route disclosure, reconstruction, reopen/export, native isolation and independent/release billing guards. It does not establish live judging accuracy or performance.

Earlier development failures remain in the receipt: a new preflight test initially expected a raw error instead of the correctly sanitized production error; the corrected assertion passed. A concurrent pilot attempted collection before the eval-runner package had been built and collected no tests. The subsequent built-source focused run passed. The pre-main full browser run also passed the new judge chapter before failing later in the native journey. None of those pilot runs is represented as a final-source pass.

Adversarial static review found no blocking issues at the bound source. Its exact scope and unresolved proof limits are in the review receipt; final heavy-evidence review is recorded separately. No paid judge inference was run, no test was removed or weakened, and no release proof is claimed.
