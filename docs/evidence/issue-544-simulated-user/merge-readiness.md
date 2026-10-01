# Actor review repairs

Authority: PRD §13.2.3, including screenshots and visible control names only,
fifteen-minute deadline, cancellation, independent human feedback, and durable
observation/action/completion evidence. The actor prompt revision is v3 because
select actions now use displayed labels. Existing v2 evidence stays unchanged.

## Changed executable seams and checkpoint mapping

| Boundary | Production seam | Smallest deterministic checkpoint |
| --- | --- | --- |
| Deadline and Stop include discovery before candidate creation | TaskActorService.create, startup ID, dashboard Cancel starting user | actor tests: cancel/deadline discovery and preparation; source-reviewed Cancel button wiring; browser ordinary startup; provider preflight |
| Fifteen minutes cannot be widened by request configuration | actorConfiguration | actor discovery test rejects one-hour configuration |
| Actor model accepts screenshots | provider-setup runtime resolution | provider test rejects text-only model |
| No evaluator metadata, budget counters, field values, closed options or control taxonomy in observations | actor browser and service projection | actor trajectory projection plus real browser clipped-field/closed-select sentinels and exact observation/control keys |
| Navigation settles before another decision | browser fetch tracker | browser delayed destination GET, then ordinary node/Send/invoke trajectory |
| Stop releases observation and workspace-grade admission | gateway signal, HumanTaskService, EvalService grader wrapper | session tests cancel presentation read and noncooperative next-step/finish grading; no late dispatch/export |
| Known cancellation before dispatch refunds reservation; ambiguous dispatch remains charged | startThread/write/nextStep | session tests cancel while reservation persists; existing unknown-write/reopen tests |
| Last permitted action retains its resulting observation | actor loop | action-limit test observes three times for two actions, no extra inference |
| Endpoint claim and successful finish stay consistent | action validation, task finish | actor endpoint-at-budget test, contradiction rejection, linked finish completion event |
| Growing simulated review remains scoped to its task | review context refresh, annotation token renewal, current-step link | gateway dynamic roster test including failed registration and denied unrelated thread/product write; renderer current-step/draft-preservation test; real active graph grading browser chapter |
| Screenshots do not inflate mutable session JSON | actorEvent artifact write, actorScreenshot read, export hydration, lazy dashboard loader | reopen/export and corrupt artifact test; browser six observations exported with screenshot references |
| Design reference checker cannot truncate piped output | design-config test regular-file stdout | unchanged nine assertions including exact 282 rows; historical checker unchanged |

`abortable.mjs` bounds the caller's wait and checks cancellation before starting
an operation. It cannot terminate arbitrary third-party JavaScript. The grader
and actor entry points check the signal before later dispatch/publication; tests
release a noncooperative callback after cancellation to verify no late work.

## Required verification

Warm loop: focused actor, session, provider, and web-host tests. Before commit:
`npm run check`, `npm run build`, and all chapters of `npm run test:eval-web`.
No paid inference belongs to these gates. Whole-stack review must also check
calibration lineage and external-catalog integration after restacking.

## Results

Actor-only snapshot results. Focused tests: 85 passed across five files, plus one production renderer test
for current-step navigation and preserved draft feedback. All nine browser chapters passed before the final current-step query cleanup;
that cleanup has the renderer test above. Full `npm run check` passed freshly:
3,308 Vitest tests passed, three skipped; two separate secret-boundary tests,
60 Python tests, native/workspace/crash checks, receipt and readability gates
passed. `npm run build` passed. These results apply to the executable/test
digest below, except the explicitly earlier browser run. Whole-stack checks
after integrating main/calibration/catalog remain pending.

The two native binaries used by browser proof were copied from the previously
source-built private catalog runtime after comparing native source inputs
(no Cargo/crates changes) and verifying SHA-256 before and after copying:

- app server: `73cb8b59670b88acd19be7cd2890859768c91113331e216186f6f9f66bb07ea1`
- graph server: `28a5f930089908200a95289e111efb18a0c98b6142b207f162dec81d7d32d08b`

The full check uses the existing warm Cargo target and still runs fresh tests.
No downloaded or unverified artifact substitutes for testing.

## Limits

No human-realism calibration, live inference, useful-first-graph latency,
automatic improvement, or release proof is claimed. The full stack remains
unmerged until the user's human gate. Native dropdown popup interaction and startup cancellation-button clicks remain
unverified by browser proof; service cancellation and screenshot observation
boundaries are tested independently.

## Adversarial review

Reviewer `/root/eval_facts`, executable/test digest
`e467d2e926ba8d29283f30e6b6519b5d1eca5abfe8def41ef39b198e62ff1cc0`, exact paths in
[scope](merge-readiness-scope.txt). Digest hashes sorted path + NUL + raw
SHA-256 file digest. Verdict: no concrete unresolved source blocker among the
16 inherited PR review findings. No tests run by reviewer. Changes to this scope
invalidate this assertion; dependent calibration/catalog integration is separate.
