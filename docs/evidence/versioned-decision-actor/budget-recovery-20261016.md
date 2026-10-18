# Response budget recovery and multi-turn comparison

The user approved keeping the graph frozen while allowing navigation and recovery,
and separately requested multi-turn interactions. PRD §13.2.3 records that product
decision. A response cap limits candidate execution; it does not establish that
the participant has finished inspecting existing output.

Source snapshot: `96fa71926cb61a62e0d7f397b8ed5db0272147d161ce3385b88681f18d2a4d2b`.
[The source receipt](budget-recovery-source-20261016.json) preserves the exact
16 files. Earlier experiment receipts and failures remain historical evidence.

## Changed seams and verification plan

| Checkpoint | Production seam | Deterministic observation |
| --- | --- | --- |
| REC-001: A declined finish at the response cap allows inspection and reassessment | `TaskActorService` declined-finish continuation | Real actor/task services with an injected browser, cap one: declined finish, successful injected browser navigation action, accepted reassessment; exactly one candidate response |
| REC-002: Reassessment requires a successful intervening interaction | Existing finish schema and judgment repair | REC-001 asserts finish absent before navigation and restored afterward; unchanged finish-repair tests |
| REC-003: Recovery grants no candidate-write authority | Existing `HumanTaskService.write` admission, revised limit message | Separate Send, retry and invoke paths reject at the actual response-cap guard; no upstream execution dispatch |
| REC-004: Action/time/cancellation authority remains | Existing actor loop and task lifecycle | Cap-one incomplete and uncertain recovery still exhaust the action budget; existing timeout, cancellation and ambiguous-write tests |

The only behavior edit removes immediate termination after a declined finish when
the candidate-response cap has been reached. The limit error message now explains
that browsing remains available. Actor prompts, published actor revisions, action
and time budgets, response admission, native recursion, and judge semantics retain
their existing contracts. Controls offered by the browser can still fail admission;
an attempted response write at the cap remains an explicit actor failure.

The obsolete test requiring immediate budget termination was retired after its
replacement passed and adversarial review found the old behavior explicitly
superseded. The three response-write tests cover distinct admission routes. The
action-budget tests protect a different boundary from response admission.

Required handoff entry points are `npm run check`, `npm run build`,
`npm run test:eval-compiled-runtime`, and `npm run test:eval-web`.
The warm loop uses injected inference only. Live comparisons are separately
authorized experiments, excluded from default tests.

## Deterministic execution record

The six-file focused portfolio passed 171 tests in 6.97 seconds before the final
error-message copy edit. After that edit and retirement of the obsolete assertion,
the actor and human-task files passed all 129 tests in 4.20 seconds.
An initial new fixture used contradictory endpoint-reached satisfaction fields;
correcting that fixture made the intended recovery path observable. Its earlier
failure is not evidence that the production fix was needed.

`npm run build` passed. The compiled-runtime entry point passed all 12 scenarios.
The browser entry point passed its Decisions revision chapter and the following
dispatch/select/redraw chapters, then failed in the existing native actor journey
with an observe timeout after Invoke. The whole browser runner failed; subsequent
chapters remain unproved. It was not retried unchanged.
`RUST_TEST_THREADS=2 npm run check` failed in the full Vitest portfolio: 4,358
tests passed, one failed, and three were skipped (327 files passed, one failed,
one skipped). The existing graph-memory application integration test reported
both fixture responses failed acceptance. The Rust workspace suite, including all
398 app-server tests, crash-reconciliation stage, native build, TypeScript and
workspace checks passed before that failure. An isolated invocation of the one
graph-memory scenario then passed in 8.89 seconds; its broad-run failure remains
preserved and its cause is not established.

Because the root command stopped before its trailing stages, those entry points
ran separately: secret-boundary tests passed 2/2, Python client tests passed 99/99,
Ladybug receipt lint passed, and PRD readability passed. No unchanged broad suite
was retried. The build, focused recovery tests and twelve compiled-runtime
scenarios passed, but the required portfolio as a whole is not green.
Logs are retained under `.relayer/verification/budget-recovery-20261016/`.
Their hashes and command outcomes are in
[the verification receipt](budget-recovery-verification-20261016.json).

## Live protocol

Both experiments reuse the exact experimental native and Decisions actor revisions
from `20261016-paired`, without publication or default promotion. Each is one
sequential pair, native first, with a 60-action and 15-minute bound per actor.

1. Frozen navigation: byte-identical twelve-card fixture and harness from
   `20261016-navigation`, one candidate response, with corrected host recovery.
   Deterministic visible-detail and screenshot bindings measure exposure, not
   comprehension. Autonomous early stopping remains an outcome.
2. Multi-turn deployment: a run-local clone of the existing internal node-input
   case, four-response cap, live Codex candidate, and the same fictional participant
   choices for both actors. Temporal features are explicitly `{}` for both arms;
   this exercises ordinary Send between responses, not current-native live answers.
   Proof requires an accepted input and a later accepted rendered plan incorporating
   that input. Fill intent, a submission receipt, or a judge claim alone is insufficient.

These scenarios answer different questions. The live candidate can produce
different graphs and generation latency for each actor. Neither one-pair result
establishes a general latency or cost advantage. Native subscription usage permits
an API-rate counterfactual estimate, not measured per-run subscription dollars.

## Adversarial review

Reviewer `/root/review_versioned_actor` verified the source digest above and reviewed
the recovery boundary, three admission routes, test retirement, product mapping,
and separate live protocols. Verdict: no static blocker. It required explicit
temporal-mode disclosure and submission-to-rendered-incorporation evidence for any
multi-turn success claim. Heavy results and live outcomes require separate review.
This review is non-certifying without a PR.
The [outcome review receipt](budget-recovery-review-20261016.json) records exact
report/metrics hashes and the separate evidence audit.

## Live results

The [frozen navigation pair](navigation-recovery-20261016.md) demonstrated the
corrected recovery: Decisions navigated after its declined finish at cap one,
increased observed coverage from 11/12 to 12/12, and voluntarily stopped incomplete.
Native reached an accepted endpoint. Decisions selected shared navigation faster
but had a higher standard API-rate cost proxy.

The [multi-turn attempt](multiturn-comparison-20261016.md) used the supported
`codex-basic` revision 18 after preserved custom-harness preflight failures.
Neither actor sent a follow-up: native failed on select controls; Decisions stopped
voluntarily with choices still in the draft. The intended multi-turn incorporation
checkpoint remains unmet for both exact actor revisions. No failed model trajectory
was replayed or silently replaced.
