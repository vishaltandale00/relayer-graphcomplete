# Multi-turn deployment attempt

Neither actor reached a second candidate response. The native actor failed on
select controls; Decisions entered choices but voluntarily stopped incomplete
without sending. This is a failed attempt at multi-turn coverage, not evidence of
successful conversational adaptation or lower cost per completed conversation.

[Metrics and hashes](multiturn-comparison-20261016.json) preserve the exact source,
actor revisions, candidate route, fictional participant brief, task exports,
candidate traces, observation bindings and accepted-input records.

## Protocol and outcome

The existing internal deployment-input prompt asks the candidate to request an
exact window, one rollout strategy and two validation signals before planning.
A run-local case supplies the same private fictional choices to each actor:
2026-10-20 19:00–20:00 UTC, Canary, Health metrics and Synthetic checks. The endpoint
requires a later plan incorporating those choices and a concrete rollback trigger.
The response cap is four, with sixty actor actions and fifteen minutes per arm.

Both use unchanged `codex-basic` revision 18, Luna/medium, native managed execution
and the same validated product model route. The actor revisions are the exact
ones used in the earlier comparisons; no default promotion or fabricated feedback.
Temporal features are explicitly `{}` for both arms. This tests ordinary Send
between accepted responses, not current-native live answers or working reactions.

| Measurement | Native Codex actor | Decisions with Codex text |
| --- | ---: | ---: |
| Session wall time, including exports | 43.573 s | 58.511 s |
| Initial candidate execution | 26.230 s | 31.856 s |
| Actor decisions | 5, 15.922 s | 5, 20.442 s |
| Decisions HTTP, nested above | — | 1.616 s |
| Codex text, nested above | included above | 18.814 s |
| Completion judge | not called | 4.108 s, incomplete |
| Accepted candidate responses | 1 | 1 |
| Follow-up submissions | 0 | 0 |
| Later rendered incorporation | unmet | unmet |
| Final state | interrupted, actor failed | voluntary satisfied / incomplete |

The native actor filled the window, attempted Canary selection, clicked the
validation field, and attempted the two signals. Three select attempts were
rejected before dispatch as unavailable controls; after the last rejection the
actor stopped with `unavailable_control`. Only the window reached the accepted
draft-attachment record. The screenshots show the native multi-select field, but
do not establish that the intended selections were committed.

Decisions filled the window and composed the full choices in Follow up, cleared
that text once, and entered it again. It then stopped `satisfied / incomplete`,
explicitly saying Send and plan inspection remained. The judge correctly said
only a draft was visible. The participant's versioned contract permits that
voluntary stop; the host retained it rather than forcing a happy path.

Both accepted interaction records have empty `submittedInputs`. Each session has
only its initial submission. Thus there is no follow-up acceptance receipt and no
later accepted response to bind to participant choices. Ten actor screenshots
match the persisted observation hashes; DOM text is supplemental diagnostic data,
not incorporation proof. Inspecting the final screenshots confirms the draft and
input state, not a resulting plan.

## Observed usage and cost

| Scope | Native standard API-rate proxy | Hybrid standard proxy |
| --- | ---: | ---: |
| Simulator | $0.00924440 | $0.02410570 |
| Initial candidate | $0.01491100 | $0.01747284 |
| Completion judge | not called | $0.04759200 |

The hybrid simulator amount includes $0.00469110 for 46,911 Decisions input
tokens. Text generation dominated its actor inference time: four fills plus the
finish report each invoked Codex. Faster selection alone therefore did not reduce
this actor's total inference time.

Native usage is the last cumulative snapshot per actor/judge session or candidate
provider thread, not a sum of cumulative counters. Candidate trace exports report
complete prompt/model/tool/usage coverage, with native artifacts and child streams
absent by policy/observation. Full trace export descriptors are retained. These
standard API-rate proxies are not native subscription invoices; context, regional
and tier adjustments are unestablished. Unequal failed trajectories cannot support
a successful-conversation cost comparison.

## Preserved setup failures

Three earlier preflights stopped before candidate inference. The first returned
422 at model setup; later configuration-route and explicit-refresh probes exposed
pending custom-harness readiness. The decisive instrumented probe returned:
`No current eligible provider route authorizes readiness.`

The custom `codex-layered-navigation-luna` configuration has neither model rules
nor provider compatibility. The backend requires an eligible route to publish
coordinated readiness. A differential preflight changing only to the supported
`codex-basic` harness passed native refresh. The final pair uses that supported
harness and normal explicit provider refresh; it bypasses no authority check.
The custom-harness product issue remains unchanged.

The red and green diagnostic scripts live under `20261016-readiness-probe` and
`20261016-readiness-compatible-probe`. Earlier preflights are retained under
`20261016-multiturn`, `20261016-multiturn-configured` and
`20261016-multiturn-ready`; final paid inference is under
`20261016-multiturn-compatible`. All are within
`.relayer/live/decision-actor-comparison/`. No failed model trajectory was replayed
to obtain success. Background verification was suspended during paired timing and
resumed afterward.

## Remaining coverage

A successful input → Send → accepted response → inspected incorporation sequence
remains unproved for both unchanged actor revisions. The observed select-control
failure and voluntary pre-Send stopping need investigation before drawing any
multi-turn quality or savings conclusion. The separate frozen navigation experiment
does establish post-response-cap recovery.

Required deterministic results are in
[the recovery verification record](budget-recovery-20261016.md). Outcome review
is recorded separately and remains non-certifying without a PR.
