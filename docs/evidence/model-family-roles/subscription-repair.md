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
