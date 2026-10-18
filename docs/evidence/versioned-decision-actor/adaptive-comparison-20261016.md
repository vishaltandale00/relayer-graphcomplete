# Live-candidate comparison — 2026-10-16

The same two pinned actor revisions ran once each against a real Codex candidate
on the task-system case. Both reacted to working updates. Decisions selected
navigation while Codex generated its experience comments and final stopping
report. No candidate follow-up, text-field fill, annotation, or live answer was
produced in this pair. Candidate adaptation to new input remains unproved here;
the earlier fixture pilot separately recorded a generated follow-up.

| Observed measure | Existing Codex actor | Decisions + Codex text |
| --- | ---: | ---: |
| End-to-end wall time, including exports | 71.836 s | 57.670 s |
| Candidate trace run span | 59.018 s | 40.164 s |
| Simulator inference time, working + settled | 11.778 s | 11.588 s |
| Working observations / reactions | 2 / 2 | 2 / 2 |
| Recorded working-revision gaps | 0 | 0 |
| Working navigation actions | 0 | 2 |
| Settled actions, including finish | 1 | 2 |
| Codex simulator/text calls | 3 | 3 |
| Decisions selector calls / mean | — | 4 / 0.344 s |
| Completion-review calls / time | 1 / 6.285 s | 1 / 9.394 s |
| Candidate completions | 1 | 1 |
| Actor final stop / endpoint claim | endpoint_reached / reached | satisfied / incomplete |
| Actor self-rating, not human feedback | 4/4 | 3/4 |
| Completion-judge verdict | complete | complete |

**Interpretation.** The hybrid's lower wall time does not establish a selector
speedup: its candidate finished about 19 seconds sooner, and candidate outputs
were different. The simulator inference times were almost equal. Working
observation and candidate execution overlap; do not add those times. Hybrid
selector time (1.374 s) and Codex text time (10.198 s) are nested inside its
11.588 s actor time. Each candidate trace has one provider turn/model-call span,
containing multiple model-response/token-usage updates; it is not one underlying
inference request. The model-call spans were 58.502 s native and 39.508 s hybrid.
One sequential pair, native first, cannot characterize variability or order effects.

**Behavior.** Codex watched current revisions 1 and 2, then proposed finishing
without navigation. Decisions watched those same revision numbers in its own
candidate response, selected “Incoming queue” and “Two workers” while execution
was working, opened “If both are busy” after settlement, then stopped satisfied.
It still described worker tie-breaking as unresolved. The judge regarded that
extra detail as unnecessary for the original request. Preserve both judgments:
a completed session and a model reviewer verdict are not an independently proven
endpoint, and the hybrid actor did not claim its endpoint was reached.

Neither arm dispatched a failed control or produced a rejected finish. Recorded
gaps were zero; this is not a claim that all possible working content was seen.
Browser opening took 0.717 s native and 0.739 s hybrid, after initial submission.
The task's first observed-presentation latencies were 50.474 s and 33.588 s;
both records explicitly say the observer was absent before submission and their
usefulness was not assessed. The live candidate published two observed revisions
in each arm. Original scripted graph checks were **not run**: the task service
records that they do not certify an adaptive human trajectory. No human grades
or annotations were created. Human grading annotations remain outside the
simulated actor's authority.

**Usage.** Native values below are terminal cumulative totals for each separate
session, verified against native rollouts. Candidate values use the last
`thread/tokenUsage/updated.total` per unique provider thread across the trace
exports. There is one candidate provider thread per arm and no recursive-child
aggregate to add. Never sum successive cumulative snapshots. Cached input and
reasoning output are already included in the input/output totals.

| Native subscription route | Input | Cached input subset | Output |
| --- | ---: | ---: | ---: |
| Codex actor, including working comments | 40,144 | 0 | 358 |
| Hybrid Codex text, including working comments | 38,709 | 9,984 | 281 |
| Native-arm completion reviewer | 10,779 | 6,528 | 165 |
| Hybrid-arm completion reviewer | 11,073 | 0 | 317 |
| Native-arm candidate | 326,224 | 294,912 | 8,008 |
| Hybrid-arm candidate | 192,145 | 167,168 | 4,071 |

Four successful Decisions requests used 27,032 input tokens and no cached or
output tokens: **$0.0027032 (0.27 cents)** at the published base input rate of
$0.10 per million tokens. Regional and long-context qualifications remain;
this is not an invoice. [OpenAI Decisions pricing](https://developers.openai.com/api/docs/guides/decisions),
checked 2026-10-16. Native subscription usage provides no per-run dollar amount,
so total dollar cost or savings cannot be calculated. Token differences also
reflect differing candidate output, context, navigation, and caching.

**Pinned controls and execution.** Same internal case
`empty-project.task-system.two-turn`, original task prompt, endpoint, maximum
three candidate completions, 60-action/15-minute actor budget, `task-actor-v9`
prompt, GPT-5.6 Luna/low text model, low exploration/meticulousness, and
GPT-5.6 Sol/high completion judge v1. The candidate was `codex-basic` revision18,
GPT-5.6 Luna/medium, Auto permission profile, with the production recursive
temporal features and required candidate tracing. The Decisions selector was
GPT-6 Luna. This is an execution-version comparison with different selector
models and context handling, not a same-model API experiment.

Exact actor records from the fixture pilot were copied into isolated registries
and reused unchanged: native `setup-f3228801-d355-4e27-b7ea-edb25764840b`, hybrid
`setup-232cbab6-49ed-4c07-9f42-30f182af0726`. The machine metrics carry authoritative
full records/digests. No new revision, fabricated feedback, promotion, or edit to
an existing registry was needed. The isolated product resolved and validated one
explicit native candidate route; no API-backed candidate or external
subscription-only case was admitted. Native runtime integrity was verified with
the production resolver; no build, installation, or inference retry occurred.
All owned services closed. Host-held API credentials stayed in memory and were
not passed to the native candidate or simulator processes.

**Evidence and verification.** [Machine-readable results](adaptive-comparison-20261016.json)
include raw measurement hashes, exact actor records, phase timings, observations,
actions, judge explanations, candidate usage events, trace boundaries, and native
usage audit references. Full local artifacts are under
`.relayer/live/decision-actor-comparison/20261016-adaptive/`: runner, manifest,
validated candidate route, timings/API metadata/results, per-arm task logs,
screenshots, immutable exports, candidate details, and complete candidate trace
and graph-operation exports.

All 15 implementation file hashes still match snapshot
`dedd1cc66f3d41a06250a6c9274b16f79cace9184a5df83c7b572f79f958d5d2` on base
`77b1b296022b17c29b06aa0da24522ead3344617`. Matched-control checks passed: same
case-plan digest, same harness digest, equal behavior contracts/settings except
the decision field, and exact reuse of both actor revisions. Both live task
lifecycles and immutable exports completed; this certifies only those observations.
No production implementation changed. The [existing verification record](README.md)
and unresolved broader check failures remain separate; no deterministic suite was
rerun for this evidence-only follow-up.
