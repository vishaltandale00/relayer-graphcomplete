# Independent completion judge and evaluator release

Approved scope: PRD 13.2.3–13.2.4, independent completion revisions and the explicit three-component evaluator configuration agreed October 4, 2026. Base: merged checkpoint `5582ae13498d7fd8522a696be18b169c4faa7187`.

This increment provides immutable identities and exact evidence capture. It does not calibrate the completion judge, improve actor realism, establish task success, or authorize paid inference. Human stopping-point labels, frozen completion partitions, offline scoring and fresh closed-loop validation remain subsequent increments. Historical failures and assessments are unchanged.

## Changed seams and checkpoints

| Checkpoint | Changed executable seam and boundary | Smallest deterministic observation |
| --- | --- | --- |
| EVAL-001 | Completion YAML loading/publication, filename version, exact bytes/digest, predecessor/feedback and code-owned no-tools/schema/evidence authority | `test/eval-evaluator-releases.test.mjs`: changed/stale files, invalid authority, exact native prompt, reopen |
| EVAL-002 | Registry compatibility and immutable three-revision releases; initial bootstrap never rewrites legacy actor definitions or promotes components | Same fixture: historical registry migration, exact snapshots, tampering, unchanged promotions; existing registry lineage/persist-failure tests |
| EVAL-003 | Selection resolution, actor/judge preflight before dispatch, conflicting component rejection, independent override and historical fallback | `test/eval-setup-registry.test.mjs`: explicit release native config/session pins and failed completion preflight; existing historical-contract test |
| EVAL-004 | Session finish/evidence authority and exact native judge input/digest, screenshot and proposed finish; preservation across export/reopen | Same integrated session fixture plus `test/eval-task-completion-judge.test.mjs` bounded native evidence/invalid result/cancellation and existing actor tests |
| EVAL-005 | Dashboard publication/selection authority and actor-surface isolation; file-only editor and release controls | Existing web-host authorization fixture with new release API forbidden to actor; actual `test:eval-web` publication/selection/start chapter |
| EVAL-006 | Actor comparison keeps exact independent completion revision fixed; completion calibration cannot masquerade as graph calibration | Integrated calibration fixture uses two same-spec, different-ID completion revisions and rejects their substitution; original frozen graph/actor tests remain |

No tests were deleted. Registry-only tests cover source integrity and immutable publication, while session tests cover real preflight, finish and persistence seams. Browser proof covers form submission and production workspace routing; injected inference does not prove live model quality. Every checkpoint has a deterministic observation; full check remains the required fallback and repository gate.

Graph-presentation revision in an evaluator release is a saved immutable grader identity. Human-session deterministic task grading remains its existing path; release selection does not automatically execute presentation grading. The three pins do not include candidate harness, catalog, budgets or calibration-set identity; those remain separate experiment inputs.

## Verification plan

Warm loop: focused registry, completion judge, actor/session and actor failure tests with injected native inference. Before handoff: `npm run check`, `npm run build`, `npm run test:eval-compiled-runtime`, all compatible chapters of `npm run test:eval-web` (existing runner has no chapter selector). No paid, release, signed or live-provider proof applies. Adversarial reviews cover fixed evaluator identity, stopping authority, feedback isolation, immutable evidence and actual browser mapping.

## Executed verification and evidence

Source scope: [source-scope.txt](source-scope.txt), SHA256 `443825765cd8ae20a6dcf82eac7e0be0c6aea4ecda0454eaa09f2fdcf8233d2f`. Algorithm: sorted relative path UTF-8 + NUL + exact file bytes + NUL. Evidence records are excluded. Local logs remain under `/tmp/evaluator-releases-*`.

Actually executed:

- Final warm loop: 5 files, 78 tests passed in 2.40 seconds. Production source and unit tests match this scope; subsequent changes only repaired the browser driver sequencing.
- `npm run build`: passed (Node 25.9.0); relevant compiled sources are unchanged in final scope.
- `npm run test:eval-compiled-runtime`: all 4 compiled-runtime tests passed (bundled Node 24.19.0); compiled sources unchanged in final scope.
- Final `npm run test:eval-web`: every chapter passed (bundled Node 24.19.0), including completion file publication, real release-selected form submission, exact task/export pins, stopping evidence, original actor comparison, input, graph judge and persistence. [Chapter results](browser-chapters.txt) preserve inner outcomes. Injected actor/judge decisions establish machinery, not live model quality.
- Final full `npm run check` under bundled Node 24.19.0, `RUST_TEST_THREADS=3`, `VITEST_MAX_WORKERS=3`: passed. All Rust and crash-reconciliation result blocks passed; package/type checks passed; 285 Vitest files passed, 1 skipped; 3,567 tests passed, 3 skipped; 2 separate secret-boundary tests passed; 68 Python tests, receipt lints and PRD readability passed. This run reached every required stage and returned zero. No code changed for the Node 24 rerun.

Retained failures: initial full check on Node 25.9.0 passed Rust/type/package stages and 3,566 Vitest tests (3 skipped), but failed one existing exact-port graph-authoring egress test. The isolated test reproduced `ERR_ACCESS_DENIED` on the allowed IPv4 endpoint under Node 25; it passed under bundled Node 24.19.0 without source changes. The initial full command stopped at Vitest, so its later secret/Python/receipt stages were not executed. First browser attempt timed out when a pending graph-publication render reset the newly selected completion editor. Second passed completion/release publication but failed because task-creation details were collapsed. The driver now waits exact publication IDs and opens the real details controls; third full browser attempt passed all chapters. These failures remain evidence, not pass claims.

No paid inference, candidate harness change, default promotion, merge, or release proof ran.

## Adversarial review

Reviewer `/root/independent_authority`; base `5582ae13498d7fd8522a696be18b169c4faa7187`; final source-scope digest `443825765cd8ae20a6dcf82eac7e0be0c6aea4ecda0454eaa09f2fdcf8233d2f`; reviewed all code/YAML/PRD/tests for immutable revisions/releases, stale publication, feedback lineage, no-tools authority, preflight/selection, legacy defaults, exact input capture, fixed evaluator calibration and actual dashboard submission. Verdict: no unresolved actionable findings. Final driver waits/details-control delta reviewed explicitly. Reviewer independently ran 20 registry/session tests before the value-preserving evidence-contract constant cleanup and browser-only repairs. Heavy results belong to the actual runs above, not the review.

README checkpoint mapping was separately reviewed before result additions. Final result additions summarize parent-owned logs and do not alter product promises or executable mappings. Earlier adversarial reviews found the identical-spec/different-revision calibration substitution and missing browser submission coverage; both were repaired and regression-tested. No tests were deleted. Without a PR, this assertion is non-certifying handoff evidence. Any changed scoped source invalidates it.

## October 5 improvements following the three-case live sample

Approved scope: the user requested the reported improvements after reviewing the live sample. PRD 13.2.3–13.2.4 records v2 evidence and v5 participant stopping. Existing v1 files, captured runs, actor contracts and promotions remain unchanged. No new live inference is part of this implementation proof.

| Checkpoint | Changed executable seams and boundary | Deterministic observation |
| --- | --- | --- |
| EVAL-007 | Code-owned v1/v2 contract validation, YAML v2 publication, EvalService trusted baseline routing, native event contract ID, exact input/export/reopen | `eval-setup-registry`: actual v2 release and production artifact route; v1 remains selected; existing file/source authority fixtures |
| EVAL-008 | HumanTaskService maps recorded accepted submissions to committed structured input values, participant role and timestamp; excludes unsent drafts/hidden metadata and bounds fields/count/trajectory | `eval-human-task`: delivered approval before booking, v1 compatibility, original aggregate evidence/settled/cancellation checkpoints |
| EVAL-009 | V2 artifact collector prioritizes changed code/tests, includes bounded diff/state and excerpts, disables or rejects executable Git helpers, checks workspace/content stability | `eval-task-completion-artifacts`: Node Redis-shaped large source/late test; diff/textconv helpers and links; clean/process filters; same-status mutation; legacy bounds/cancellation |
| EVAL-010 | Actor v8 guidance, code-owned v5 voluntary-stop authority, ActorService assessment/stop decision, HumanTaskService latest exact evidence authorization and termination | `eval-task-actor`: all three judge verdicts permit explicit unfinished participant stopping; existing v4 rejection/budget/cancellation tests; `eval-human-task`: legacy denial, reached denial, exact unfinished stop preserving remaining work/no attainment |
| EVAL-011 | Setup editor upgrade opts into current contract, revised stop/approval copy, dashboard v2 selection and release execution | `test:eval-web` actor/setup/release chapter: original reached rejection/continuation; explicit v2 file publication; real form task/export pins; uncertain unfinished stop with no attainment |

No tests are deleted. Collector tests protect bounded filesystem/Git authority; integrated session tests protect actual routing, native input and immutable evidence. The current actor definition is task-actor-v8: publishing that prompt version explicitly upgrades authority to v5. Historical records are not rewritten. Existing v1 completion selection stays unchanged; v2 must be selected explicitly. Deterministic task grading remains at its existing finish lifecycle and does not become completion-judge authority.

Verification plan: focused six-file in-process loop; `npm run check`, `npm run build`, `npm run test:eval-compiled-runtime`, all compatible `npm run test:eval-web` chapters. Adversarial reviews cover product/stopping meaning, legacy pins, Git authority/bounds and exact evidence. Actual final results and source digest will be appended after those gates; planned commands are not proof. Live sample outcomes remain private local evidence and are not human calibration labels.
