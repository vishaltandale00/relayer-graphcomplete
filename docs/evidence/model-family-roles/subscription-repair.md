# Subscription-only role-guidance repair

The original sixteen-cell comparison pinned candidate source `77372779` on
main `37589c77`. Seven tasks completed, two were interrupted, and seven were
not admitted. Eight original accepted graphs had partial graph reviews with
zero coverage after evaluator subscription admission failed. Those outcomes
and their once-only journals remain unchanged.

The user authorized evaluator repairs, regrading the existing accepted graphs,
and fresh attempts for the nine missing or interrupted cells. Candidate
prompts, native model plans, family guidance ON/OFF, immutable actor/completion
judge/graph judge revisions, case fixtures, and native runtimes remain fixed.
This is an explicit evaluator protocol amendment, not an identical-code replay.

## Changed seams and deterministic checkpoints

Product authority: PRD §13.2.3 and provider promises PROV004/008; ADR0003
(shared Product/Eval workspace) and ADR0006 (provider-neutral native execution).

| Promise or failure boundary | Executable seam | Checkpoint |
| --- | --- | --- |
| Refresh stale discovery without reviving explicit sign-out | `provider-setup.mjs` evaluator route → leased native catalog discovery | Provider setup fixture: stale cached false recovers; explicit logout still refuses; pending connection lifecycle tests retained |
| Evaluators use a Codex subscription independently of the candidate default | Same resolver, managed-runtime access and native model/image/effort checks | Claude candidate default retained; no defaults writes; unsupported model/effort/image refused; existing API secret boundary retained |
| Missing native installation does not authorize provisioning or candidate work | Resolver lease admission | Cold-profile production fixture: canonical absent-runtime errors require sign-in; zero prepare calls; browser asserts zero created tasks |
| Cancellation reaches native discovery | Resolver → catalog `refresh(..., {signal})` | Inert native discovery receives abort; route does not return; lease subsequently permits logout |
| A native actor request cannot silently stall for the whole session | `createRestrictedCodexActor` → SDK `thread.run` | Fake-time five-minute deadline aborts one native request; no retry/action returned; late cancellation rejected |
| Preserve overall deadline and unknown dispatch | Same actor boundary → `TaskActorService` | Outer cancellation and already-aborted cases; no retry; native cancellation awaited; existing orchestration/cancel/unknown-write cases retained |
| Failures are diagnosable without storing native text | Actor wrapper → service `actor_error` | Closed prepare/execute/validate and none/unknown/completed values; malformed output and forbidden tool rejected; provider secrets omitted |
| Implicit stop identity is discoverable without influencing a rating | MCP published tool description → ordered allocation validator | Real MCP leaf journey: forged stop ID rejected with exact expected encoding and zero stored nodes; JSON null accepted while preferred choice remains input |
| Operational budget is visible in receipts | Service `actor_started` | Native call timeout recorded separately from immutable actor setup; actor orchestration fixture |

The five-minute per-call bound is operational containment. The historical
actor error occurred before the third native request acquired a durable
`task_started` event. Original SDK stderr/error details were not retained, so
its exact cause remains unknown. One explicitly authorized read-only native
resume diagnostic returned a decision in 4.2 seconds. It dispatched no browser
action and does not establish a historical root cause.

## Required verification plan

Warm production-seam fixtures, then `npm run check`, `npm run build`, and
`npm run test:eval-web` as required by the simulated-user evidence README.
No paid inference belongs to these deterministic tests. Verify trusted native
cache identity before native build. Live subscription regrades are a separate
authorized context, followed by at most nine new candidate sessions.

## Actual evidence

Warm production-seam suite: 115 tests passed across four files. The stale
subscription regression reproduced the original admission error before the
fix. Native deadline and stage tests failed against the original implementation
before the containment change. Trusted Ladybug 0.18.0 cache verified for
macOS ARM64 / Rust 1.98.0; the warm source target remains in use.

The first aggregate check passed Rust, type/package and 4,358 JavaScript tests,
with three skips, but failed one input-invocation integration test at its
20-second bound. That unchanged test passed separately in 11.1 seconds; this
does not erase the aggregate failure or establish its cause. Build passed.
The unrun tail gates were executed separately: secret boundary, Python,
Ladybug receipt lint and PRD readability passed. The first browser journey
caught the cold-profile classification regression described above; its
assertions were retained and a deterministic red regression added before repair.
Final-source browser journey passed all chapters, including Current/settled
actor interaction, evaluator release, exact original-turn judge context,
artifacts, and native Product/task-service reopen. Final-source build passed.
A second aggregate check (two JS workers) stopped earlier in Rust: 433 app-server
library tests passed and two environment timing fixtures failed. The unchanged
setsid fixture passed individually; the unchanged command-output-bound fixture
still failed individually at its one-second bound. Its underlying cause is not
established, and no assertion or native code was changed for this repair.
The first aggregate's native checks observed the same unchanged Rust sources.
Neither aggregate command is claimed green. The mapped repair fixtures and
full browser journey passed; live regrades and remaining sessions are pending.
Private evidence directory: `~/.relayer/role-guidance-repair-20261016`.
Raw native streams, bearer URLs, auth files, actor private briefs and diagnostic
native histories are excluded from public evidence and evaluator packets.

## Adversarial review

Reviewer `/root/repair_authority_review`; seven executable/test files at HEAD
`77372779` plus working changes. Scope SHA256 (sorted relative path + NUL +
bytes + NUL):
`52af50c255db30d35eb9318a9b5f75ee5f1b1854b6de2bf185ea8b2507c26692`.
Verdict: no remaining implementation blocker in subscription routing,
model/effort/default authority, actor timeout/no-replay and closed diagnostics.
One cancellation finding was repaired and covered. Focused reviewer run:
44/44 passed. Does not certify the historical actor cause, process termination
when native cancellation is ignored, live review coverage, or aggregate gates.
This assertion must be invalidated if its source scope changes.

Private continuation review: `/root/repair_authority_review`, nine-file control
scope digest `1e6477b369721178b6d456b6267f2099adbb08a9ff9d7ed75b731121c73f7843`
using the same digest algorithm. No static blockers: original native/fixture
hashes enforced, original Product profiles/tasks/journals retained, separate
versioned regrade attempts, eight original complete reviews before admission,
nine missing/interrupted cells only, durable unknown dispatch and independent
owned cleanup. Actual freeze, native lifecycle and live outcomes remain
uncertified until observed. No implementation or inference was delegated.

Additional deterministic transport evidence: the real pinned Codex SDK launched
an inert local executable, received cancellation, and observed its exit in 2 ms
without returning an action or retrying. This uses no provider authentication,
model inference or browser dispatch. It verifies SDK-to-child cancellation,
not behavior of a native process that ignores termination.

## Follow-up: implicit-stop tool guidance

The first two repaired live judges authenticated and inspected original graphs
and artifact screenshots, then repeatedly invented string action IDs for the
implicit stop. Neither attempted literal JSON null. Both owned native judge
processes were stopped; partial review artifacts, journals and the halted
supervisor are retained. No new candidate session was admitted.

The initial hypothesis of an inconsistent nullable schema was disproved: the
MCP schema and validator already accepted null, and the existing real MCP test
proved it. The failure was undiscoverable encoding and unhelpful errors.
The follow-up adds explicit stop encoding to published tool descriptions and
reports expected authored identity in validation errors. Acceptance predicates,
preferred-choice judgment, rubric, scoring and immutable revisions are unchanged.
The valid leaf fixture still prefers input over the authored stop; null is an
identity encoding, not a requirement to judge stop best.

Three-file review `/root/repair_authority_review`, digest
`11a76254c4f38828d57d13dfe31e1e3fee2f879729ba0a4df661860cc4d8f18c`
(same digest algorithm), no authority/scoring blockers; reviewer30/30 MCP and
recursive review tests passed. Independent MCP, recursive review and native
judge-runner fixtures:40/40 passed. The follow-up aggregate passed native checks and 4,357 JavaScript tests, with
three skipped tests. It failed the unchanged input-invocation and 10,000-layer
public-share timing tests, plus provider Electron capture. The aggregate is
not green. Build and the complete final-source Eval browser journey passed.
Actual native compliance with the clarified stop guidance remains pending. A separate v3 protocol directory
preserves the failed regrade attempt and will regrade the same original graphs
before admitting the same nine remaining/replacement cells.

V3 continuation review: `/root/repair_authority_review`, ten-file digest
`1a29fd6b51e9f930b77d946c571e58c28b2ab9e43fd35850ed93b3aa94fb09d4`,
no static blockers. Original cases, models, families, immutable setups, profiles
and budgets match the prior protocol. Prior partial reviews and journals remain
separate; reopened task/accepted-turn identities must equal the pre-regrade
baseline. All ten controller syntax checks passed. Actual freeze and live
outcomes remain separately required.

## Follow-up: visible artifact attribution

V3 completed both original Claude artifact-case reviews with full coverage.
Their accepted topologies each contain one ordinary graph layer and no artifact
layer; their complete evidence is retained without another inference call.
The Codex artifact-case review remained partial. Production navigation opened
the artifact viewer while preserving its source graph, but the judge bridge
continued reporting the source layer/node. This caused a false navigation
failure and correctly rejected destination evidence. The observed browser
viewer displayed an availability card, not a running local web app.

Product authority: PRD §§6.6.1, 6.6.2, 6.6.10, 13.4.3–4; ADR 0014.
No product decision, scoring rule or evidence predicate changed.

| Checkpoint | Changed production seam | Smallest deterministic evidence |
| --- | --- | --- |
| Accepted artifact identity and traversed path describe visible pixels, retaining source graph | `threads.js` accepted navigation; `artifact-viewer.js` cloned modal presentation; `main.js` judge getter | `eval-artifact-review-proof.mjs`: actual native acceptance, read-only production review, successful navigation, target IDs/path, availability-card pixels, exact Graph/Esc restoration |
| Covered graph controls cannot activate or stand in for artifact detail | `review-tools.js` current trusted review root, enumeration and target lookup | Same Product journey rejects stale covered controls and source capture; exposes viewer region; rejects closed viewer and wrong-turn identity |
| Source/wrong-turn screenshots still fail artifact evidence | Existing recursive evidence validator, unchanged | Same journey validates actual viewer capture and rejects source/wrong-turn metadata |
| A close/navigation during platform capture cannot mislabel pixels | `review-session.mjs` before/after checks for every tile | Two in-process `review-session.test.mjs` cases: viewport and element races reject, persist no bytes/metadata or success trace, restore element capture |
| Heavy fixture executes with ordinary Eval proof | `test-eval-web.mjs` new chapter | Existing `npm run test:eval-web` entry point; no paid default-suite inference |

The accepted Product fixture first reproduced the exact false navigation error.
The capture-race fixtures first failed twice by accepting mislabeled pixels;
after the guard they passed. Focused final verification: 140 tests across five
selected files passed. `npm run build` passed. The full check failed in the
unchanged native `command_runner_enforces_start_timeout_and_output_bounds`
test (434 passed, one failed); it did not reach the later aggregate chapters.
The aggregate remains failed, not certified by focused passes. The complete
Eval browser entry was also attempted twice: the new accepted-artifact chapter
passed both times, but later chapters failed (Current actor Product startup
timeout, then settled actor fixture startup interruption). Their causes are not
established by the discarded exception details; no complete-browser pass is
claimed for this snapshot. Earlier successful browser proof does not certify
these new source bytes. The relevant accepted-artifact and capture-race pilots
are green; the wider failures remain explicit limits on readiness.

Adversarial reviewer `/root/repair_authority_review`: eight source/test files,
scope digest `a28c51e66b2292f7135b2422b0a404f4c20240fcc25388ddee1433134f67612a`
(same digest algorithm). No remaining authority/presentation blockers. Reviewer
independently observed the capture-race red and reran its two regressions green.
Source graph preservation, strict evidence, trusted modal scoping and wrong-turn
rejection reviewed. No implementation or inference delegated. This assertion
does not certify aggregate gates or live review outcomes.

V4 retains V2/V3 partial attempts and permanent admission journals. Two complete
V3 grades carry their exact source/evidence provenance and verified absence of
artifact layers. Six original accepted graphs remain to review before any of
the same nine missing/replacement candidate cells can start. All inference
routes remain subscription-only; the original candidate native binaries,
prompts, models and family/guidance assignments remain pinned. The evaluator
and viewer operational amendments prevent an identical-code replay claim.

## Follow-up: compiled input capture regions

V4 reached six complete original grades. Guidance-on collaboration ended partial
because its compiled Node Detail input had no occurrence-bound capture target.
The visible textarea existed, but the judge correctly refused generic detail
screenshots as proof of that exact input. The final proof review remained
unstarted. No new candidates were admitted. A separate read-only review of that
same accepted graph reproduced `Unknown review target: input-action-33-10-11`
without inference; after repair its exact capture succeeded.

Authority: PRD §§13.4.1–13.4.3 and authored Node Detail review registration.
Read-only inputs remain disabled; evidence predicates, canonical action
identity, scoring, evaluator revisions and operator commission are unchanged.

| Checkpoint | Changed executable seam | Deterministic evidence |
| --- | --- | --- |
| Compiled inputs have the same exact occurrence evidence as standard inputs | Workspace supplies trusted interaction/layer/node context; Node Detail runtime registers resolved input captures privately; `main.js` supplies the current presentation owner | Extended accepted Product fixture authors a compiled input, discovers its exact ref, captures the actual prompt/control, and satisfies strict input evidence validation |
| Capture shows authored content, without injecting semantic prompt text | Runtime aliases the existing detail surface and uses a neutral label | Same Product fixture; in-process distinct unrendered-prompt sentinel is absent from review metadata |
| No author-supplied capture authority, stale owner, covered target or disposed capability | `review-tools.js` resolves only current trusted registry entries, with current thread interaction/layer/selected-node ownership and existing modal root | Registry fixture rejects unrelated shadow root/forged attributes, wrong interaction, adapter-boundary change and disposal; Product artifact modal excludes the input capture |
| Failed requalification revokes every prior input capture | Runtime clears all registrations before its first asynchronous action lookup | Two-input fixture: first lookup throwing leaves neither prior capture; unresolved action also revokes capture |
| Role-aware families are used by deterministic visual-evidence fixtures | Follow-up annotation capture script assigns its sole fixture member the required orchestrator role | Real capture first failed `model_family_orchestrator_required`, then the ordinary native setup and A→B proof succeeded; no admission bypass |

Final warm suite: 213 tests across six files passed. Full Eval browser journey
passed all chapters on the final executable source, including Current and
settled actors, input, artifact review, judge capture and native reopen. Build
passed. Full check passed native/type/package stages and 4,361 JavaScript tests
(three skipped), then failed only two stale visual-evidence receipts. Both were
regenerated through their actual Electron runners, visually inspected and
subsequently tested. Existing evidence and the failed fixture receipt are
preserved privately; no receipt hash was substituted for a capture. The outer
aggregate failure remains recorded, separately from the repaired checkpoints.

Adversarial reviewer `/root/repair_authority_review`: six-file input scope digest
`ecfffcd8a5dc6f9703cf073f7db8cbf27f3fe0f0fb92c4a5cde3ad7b144a2fde`
(same algorithm), no remaining scoped blockers; targeted lifecycle fixture
independently passed. Two findings were repaired: unrendered prompt leakage in
capture names, and incomplete revocation when the first of several lookups
throws. This assertion covers its exact source scope; other new evidence and
fixture review is recorded separately in the PR.

V5 retains six complete grades with their original source/evidence provenance.
Their inventories contain zero input actions, so this repair does not
invalidate them. Only the partial collaboration and still-unstarted proof
receive new judge attempts. Eight complete original grades still gate the
same nine missing/replacement subscription-only sessions. Historical partials,
unknown actor cause, stopped attempts and immutable once journals remain.

Final evidence/fixture delta review by the same reviewer: seven-file digest
`74bb84b4e07da581a23fe0fa925eb65db996375e5f0a5100a5b035a39023d6d2`,
no blockers. Normal family admission retained, captures/source hashes checked,
A/B visually inspected, receipt tests independently 2/2 passed. V5 ten-file
controller digest `6ce0e9ae2c6b37816ec7a178c9d90fd2d37e38bef639400dd3dd5da2d5f4bae4`;
no unapproved frozen source/native/fixture changes, all candidate inputs remain
pinned. These assertions do not certify pending live outcomes. Separate
remaining check chapters passed: secret boundary 2, Python 99, Ladybug receipts
and PRD readability. An initial secret-suite import attempt overlapped package
rebuilding and ran no tests; its failure is retained separately from the
subsequent post-build 2/2 pass.
