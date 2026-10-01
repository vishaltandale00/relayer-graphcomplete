# External interactive catalog integration

Approved scope: external interactive cases use the existing SDK, pinned catalog and
production Human Grader. The exploratory set has two unchanged coding cases and
eight everyday tasks. It is not a comparative baseline. Case content and the
fictional restaurant fixture belong to the capability repository.

## Executable seams and checkpoints

| Promise/boundary | Changed seam | Required proof |
| --- | --- | --- |
| Optional private interaction contract, unchanged legacy identities | SDK snapshot creation/digest/public projection and catalog validation | autonomous-case-contract + eval-catalog tests: private edits affect identity, public metadata excludes private facts/rubric, mutable inputs cannot change bound snapshots, legacy cases unchanged |
| Native account proves subscription rather than API billing | live credential validator | live-credentials tests: account kind and provider adapter preserved; API-key login rejected on subscription adapter |
| External Human Grader uses trusted callbacks and pins authority | EvalService preparation/thread/grading | eval-service-live-authorization: bound consent, API denial, ordinary thread creation, pinned model, catalog provenance and drift, external grading |
| Interactive tasks cannot silently become unattended benchmarks | matrix admission and case/suite selectors | eval-service-live-authorization rejects interactive matrix runs before authorization or queueing; Human Grader availability remains |
| Later submissions preserve catalog identity | HumanTaskService dispatch | eval-human-task: drift before completion admission; existing budget, replay and reopen scenarios remain distinct |
| External launch is available and consent visible | Human Grader UI | test:eval-web: external launch, follow-up, finish, human review/export using fixture inference |
| Private participant context stays out of candidate requests | preparation and actor prompt | external service sentinel test plus existing actor privacy trajectory tests |

Required gates: focused tests during editing; npm run check and npm run build;
npm run test:eval-web after the integrated build. Adversarial review must cover
privacy, authority, compatibility and evidence claims. No live inference is
part of this change's proof.

## Dependencies and limits

Based on calibration PR #628. The providerAdapterId and ChatGPT account-kind check
reuse the separately inspected subscription work; its original checkout remains
untouched. No timing changes from that checkout are copied here.

Initial dispatch still precedes observer attachment. Existing rendered evidence
must keep that fact explicit; backend graph timestamps do not prove visible
first-graph latency. Correct pre-dispatch observer timing remains a separate
integration checkpoint, not certified by this catalog change.

## Observed results

Final `npm run build` passed using the compatible warm Cargo cache.

The required `npm run check` was executed under Node 22.23.2. Rust formatting,
Clippy, workspace and crash-reconciliation tests, package type checks and the
main Vitest suite passed (245 files, 3,313 tests; one file and three tests skipped).
The outer command failed afterward: both Codex secret-provider process tests
hit their five-second `features list` startup deadline. The unchanged isolated
`npm run test:codex-secret-boundary` rerun passed both tests in 1.48 seconds.
This does not turn the original outer command into a clean pass.

The remaining declared checks were run explicitly: 60 Python tests, Ladybug
receipt lint, and PRD readability passed. The focused external authorization
suite passed 19 tests. Full `npm run test:eval-web` passed all chapters, including
external launch and follow-up, matrix-disabled UI, grading/export/reopen,
calibration, actor actions and provider settings. Its final run used the same
native binaries copied from the successful warm-cache build:
app-server SHA-256 `73cb8b59670b88acd19be7cd2890859768c91113331e216186f6f9f66bb07ea1`
and graph-server SHA-256 `28a5f930089908200a95289e111efb18a0c98b6142b207f162dec81d7d32d08b`. The first
added matrix assertion needed the actual New Run view opened; after correcting
that test, one run timed out during native startup, and an unchanged rerun passed.
No application startup workaround or increased timeout was added.

Production Git catalog loading passed for capability commit
`3e0e9711aa0d5732933f6c2928a478fc5f8b5d6f`, tree
`6c54df6d1d00833ed6ef34b4a1940d5e1396de27`, entrypoint
`interactive-catalog.mjs`: 18 registrations and two suites. Case-package build,
124 focused tests (16 skipped), and the restaurant browser lifecycle passed.
See capability PR https://github.com/vishaltandale00/relayer-capability-evals/pull/2.

Adversarial reviewer `/root/eval_facts` found no unresolved privacy, authority,
identity or browser-test-subsumption findings in source snapshot
`568037a4061d61b8a3d6fe8c6dcf2a81e0053b0c7954dc544861852265059c94`
(18 changed/untracked files, before this evidence-only result update). The PR
records final commit-scoped review. No inference, comparative score, current
research correctness, or rendered first-graph timing is certified.


## Merge-readiness follow-up

CI on the initial head found the preserved design prototype's forced exit could
truncate piped stdout (170 of 282 expected comparison rows). The design test now
captures its unchanged checker through a regular file descriptor; the same exit
status and all 282 comparisons remain required. This is a test transport change,
not a palette or product-rule change. The smallest checkpoint is the existing
`test/design-config.test.mjs` integration comparison; all nine focused tests pass.
Adversarial review by `/root/eval_facts` found no assertion weakening or resource
cleanup gaps in diff SHA-256
`b935cb2f952f632172990ab63c727efba6a619605163d3158a144c36bc3d0393`.

## Whole-stack integration gate (2026-09-30)

The stack is rebased on main `fa9ecb01`, with actor repairs and refreshed renderer
capture evidence from #608 and immutable calibration repairs from #628.
The design-check transport fix now lives in the actor dependency.

Additional changed seams and checkpoints:

| Seam | Product promise / failure boundary | Deterministic checkpoint |
| --- | --- | --- |
| External human preparation | Cancellation during credential/catalog/materialization work permits no late product dispatch | eval-service-live-authorization stalled callback scenarios |
| External thread/grading callbacks | Stop releases noncooperative callbacks; late results cannot launch a thread or capture a grade | eval-service-live-authorization thread and grade cancellation scenarios |
| Follow-up admission | A stalled catalog check does not hold the session queue or consume a completion after cancellation | eval-human-task stopped catalog-check scenario |
| Frozen external calibration | Different catalog code cannot stand in for the frozen catalog despite identical case/harness/model descriptors | eval-setup-registry new and legacy frozen-set reopen, pre-dispatch rejection and observation rejection |
| Legacy evidence | Missing identity projection is recovered from sealed evidence without rewriting frozen sets | Same legacy-set reopen scenario |

Actor startup cancellation, v3 visible-label selection, screenshot artifacts,
terminal observations and endpoint-at-budget tests remain in the inherited
portfolio. Human-create form retains startup cancellation, revision selection
and case-bound subscription consent. Inference is not used by these tests.

Reviewer `/root/slice1_authority` reviewed HEAD
`ca3cbe4421ddc1bd189c567bab4ebbb17d13ec1f` plus six dirty files:
`desktop/eval-main/calibration-service.mjs`, `desktop/eval-main/eval-service.mjs`,
`desktop/eval-main/human-task-service.mjs`, `test/eval-human-task.test.mjs`,
`test/eval-service-live-authorization.test.mjs`, and
`test/eval-setup-registry.test.mjs`.
Sorted path + NUL + hexadecimal SHA256 + LF manifest SHA256:
`818d86f0652f500e292890697254aef85788c12aa0f17533b5e9d1f3741d2bcf`.
Verdict: catalog provenance blocker resolved; no remaining finding in the
reviewed cancellation, subscription consent, frozen identity and model-route
scope. Reviewer independently ran 14 setup/calibration tests. This does not
certify the separate full-stack gates or live inference.

The earlier focused run passed 64 tests. The two new provenance tests initially
expected the raw service error through the actor's intentional error redaction;
they now observe the actual task-admission seam and exact raw rejection.
All fourteen setup tests then passed. The final full `npm run check` passed:
3,459 Vitest tests, two secret-boundary tests, 66 Python tests, native workspace
and crash-recovery suites, type checks, receipts and PRD readability. Three
Vitest tests and one file remain skipped by the existing portfolio. Build passed.
All twelve browser chapters passed, including the integrated external human
lifecycle and retained actor/calibration flows. All four compiled-runtime tests
passed. These gates ran against the reviewed source bytes above; only this
result report changed afterward. No merge is authorized until the user's
whole-stack human gate is complete.

The human gate uses private copies of the successfully built native binaries:
app-server SHA256 `c333eea7da8a14151b9eac3d3c5143bc70f378e128b157eafdd742bf3ce9efeb`,
graph-server SHA256 `d8e03edcdda070914c0bdb53b8fd9c8d8cad45abf5cbc0ff95be7eac09d4a559`.
The existing profile's databases and Eval records were backed up after graceful
shutdown. Authentication, historical setup revisions and trajectories are kept.
The gate starts no paid inference and performs no setup promotion.

Independent restack reviewer `/root/eval_facts` found no remaining blocker in
SDK privacy projections, matrix denial, startup Cancel/revision/consent UI,
external callback cancellation, late materializer dispatch and frozen catalog
identity. Same HEAD and six-file scope; its sorted path + NUL + raw SHA256
manifest digest is `c5eb8cdba95e2a53d7bb38525a9f87cf8e556c5d4b50fb6489678980c178dcc3`.
The different digest format identifies the same reviewed bytes. This was a
source review, not an independent browser or live-inference run.

## Human Grader simplification

The user approved hiding setup complexity and unrelated sessions. PRD §13.2.2
records this display-only decision. No sessions, grades or revisions are removed.

| Changed executable seam | Checkpoint |
| --- | --- |
| Case shortlist and all-cases toggle | Existing browser flow checks participant shortlist and expands developer cases for actor fixture execution |
| Collapsed run settings and visible launch contract | Browser checks default collapse, expands actual controls, verifies actor notice and launches through unchanged consent |
| Invalid input under collapsed settings | Production renderer test dispatches invalid input and observes settings opening |
| Active sessions / latest completed / older history | Populated-session production renderer test covers all three active states, completed fallback, failed/interrupted history and unchanged stored records |
| Historical review and task form collapse | Renderer test opens a historical read-only review; browser verifies creation collapses the form while workspace controls remain available |
| Setup/calibration and raw trajectory disclosure | Existing browser publication, selected-revision execution, frozen comparison, export/reopen; raw trajectory remains available through disclosure |

Required: focused renderer test, `npm run test:eval-web`, and check/build before
commit. The first browser attempt passed the human lifecycle but stopped when
the old test tried selecting a revision inside the newly collapsed task form.
The test now opens that form through its visible summary; no forced visibility
or product workaround. Final results and adversarial review are recorded below.

The populated-session renderer test passed. All twelve final browser chapters
passed. A second intermediate browser run reached setup publication but raced
its asynchronous editor refresh before promotion; the final test waits for the
visible published-revision confirmation before selecting and promoting it.
No assertion was removed or weakened.

Reviewer `/root/eval_facts` found no remaining blocker at six-file sorted
path + NUL + raw SHA256 manifest digest
`371793cf1ad063785ed3d882c3547807e591a16be5088fa178a88a138c859840`.
Scope: `desktop/eval-renderer/human-tasks.js`, `desktop/eval-renderer/index.html`,
`desktop/eval-renderer/styles.css`, `docs/prd/index.html`,
`scripts/test-eval-web.mjs`, `test/eval-human-tasks-renderer.test.mjs`.
Review covers disclosure, session retention/reopening, launch consent and test
mapping. Browser evidence is parent-run; full check/build results follow.

Final refinement scopes the completed fallback to the selected case. All active
states remain visible regardless of case. The list API adds only `testCaseId`
from existing prepared execution; persistence and capabilities are unchanged.
The existing service scenario checks this projection, and the populated renderer
scenario puts a newer unrelated completion ahead of the matching completion.
Both suites passed (29 tests). Case selection refreshes the list.

This supersedes the six-file review above: reviewer `/root/eval_facts` found no
blocker in the final eight-file scope at raw manifest digest
`e5ffc222ae5215b5348f5bd90f9e7709d74e823329ead29442e041090e9d6108`.
It adds `desktop/eval-main/human-task-service.mjs` and
`test/eval-human-task.test.mjs` to that scope. Final full gates follow.

Final UX source verification passed: `npm run check` (3,460 Vitest tests, two
secret-boundary tests, 66 Python tests, native workspace/crash suites, type,
receipt and readability checks), `npm run build`, and all twelve final browser
chapters. Three Vitest tests and one file remain skipped by the existing
portfolio. No live inference was used. The running review profile was restarted
only after confirming it had no active tasks; its seven historical sessions and
authentication remain available. The manual gate is still required before merge.

### Human launch recovery (2026-10-01)

The existing review profile failed preparation before any completion. Two
independent blockers were reproduced and repaired:

| Changed seam / checkpoint | Deterministic evidence |
| --- | --- |
| Eval provider activation and reconnect preserve isolated file authentication after native Codex writes project trust metadata | `test/eval-provider-setup.test.mjs` drives real setup with preserved config bytes; accepts generated trust entries and rejects credential overrides, misplaced auth, multiline spoofing and MCP configuration before constructing an adapter |
| The pinned Luna eval configuration participates in managed-runtime readiness without switching to family selection | The existing configuration-owned scenario in `desktop/eval-main/live-credentials.test.mjs` now loads the actual YAML and drives readiness, route resolution and credential validation; retains pinned model and credential cleanup assertions |
| Browser model-family editing begins after explicit provider refresh settles | `scripts/test-eval-web.mjs` waits for the production refresh completion message, in addition to adapter discovery; family persistence assertions remain unchanged |

These implement the existing isolated-provider and human-task promises in ADR
0003 and PRD §13.2.2. No new login scope, family selection policy, session authority,
or task termination behavior is introduced. The auth reproduction failed one
of 20 tests; the readiness reproduction failed one of 16 tests. The repaired
focused suites passed all 36. A read-only HTTP check of the actual preserved
profile first reproduced the unavailable route, then verified connected Codex,
available Luna readiness and the exact configuration-owned `gpt-5.6-luna` route.
This is admission evidence, not live inference proof.

The first browser run passed interrupted startup, human lifecycle and host
chapters, then timed out waiting for custom-family persistence. Inspection found
that it began editing while refresh could still replace model-family state.
The visible refresh-completion wait addresses that race. Required final gates:
`npm run test:eval-web`, `npm run check`, and `npm run build`. Results follow.

Adversarial reviewer `/root/eval_facts` found no blocker in the five executable
and test files at sorted-path/raw-SHA256 manifest digest
`978ae3fa1fc80634f1d3baa709cd756e0d124c18b74032c1690d7640a9eadd0e`.
Scope: provider-setup implementation/test, Luna YAML, live-credentials test and
browser proof script. Review covers auth isolation, pinned-model admission and
unchanged assertions around the refresh wait; it does not certify live inference.

The first full check failed eight pre-existing native environment scenarios:
several reported `git_timeout` under default parallelism. No affected production
Rust was changed. The follow-up runs the same full check with
`RUST_TEST_THREADS=2` to reduce concurrent subprocess pressure; it does not skip
or weaken those tests. Both outcomes are retained in the execution record.

Final deterministic verification passed on the reviewed source: all twelve
browser chapters; full `npm run check` with two native test threads (3,464 Vitest
plus two secret-boundary and 66 Python tests, native/crash/type/receipt/readability
checks). The existing portfolio skips three Vitest tests and one file. Build
result is recorded with the final commit handoff. The recovered dashboard retains
eight historical sessions and stages the original trip/Luna/four-completion
settings. No new live inference or human grade was generated by this repair.

`npm run build` also passed. The exact tested executable/test source is the
five-file reviewed manifest above; subsequent changes only append this evidence.
