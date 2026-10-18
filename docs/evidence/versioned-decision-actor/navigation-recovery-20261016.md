# Frozen navigation with response-cap recovery

The host correction worked: after a declined finish at the one-response cap,
the Decisions actor performed five more browser clicks and proposed stopping again.
No additional candidate response or product write occurred. Both actors eventually
received visible detail exposure for all twelve cards. Only the native actor ended
with an accepted endpoint; Decisions voluntarily stopped satisfied but incomplete.

[Metrics and hashes](navigation-recovery-20261016.json) bind the run to source
`96fa71926cb61a62e0d7f397b8ed5db0272147d161ce3385b88681f18d2a4d2b`.
The fixture and harness bytes match the preceding navigation experiment. Exact
actor revisions, behavior contracts, settings apart from Decisions, case plans and
harness digests match across arms. No default was promoted.

## Observed behavior and latency

| Measurement | Native Codex | Decisions with Codex text |
| --- | ---: | ---: |
| Session wall time | 66.916 s | 41.125 s |
| Actor proposals | 17 | 26 |
| Actor decision time, including nested text generation | 54.869 s | 21.827 s |
| Decisions HTTP time, nested above | — | 15.025 s |
| Codex text time, nested above | included above | 6.684 s |
| Completion judge time | 8.290 s | 13.037 s, two assessments |
| Coverage before first finish | 12/12 | 11/12 |
| Final visible-detail exposure | 12/12 | 12/12 |
| Final state | endpoint reached, judge complete | voluntary satisfied / incomplete, judge incomplete |

Decisions first missed Runtime monitoring despite claiming all twelve cards were
inspected. The judge returned uncertain. Recovery included the missing card, but
the final actor text then said earlier branches still needed verification. Its
behavior contract permits voluntary incomplete stopping; the host preserved it.
Neither a completed session nor visual exposure means an accepted endpoint or
comprehension.

All 43 captured observations bind to the actual persisted actor screenshot. One
hybrid observation was unstable across the audit capture; the coverage ledger
uses stable, fully visible detail observations. Every card has such an observation.

Fourteen shared navigation operations match the offered control and preceding
selected title/stage path. Native selection took 44.116 seconds; Decisions took
7.059 seconds. These are different models with different earlier histories,
screenshots, caching and output obligations. This is descriptive evidence of faster
choice selection, not identical-context inference or accepted-task speedup.

## Cost accounting

| Scope | Native standard API-rate proxy | Hybrid proxy / Decisions base estimate |
| --- | ---: | ---: |
| Shared fourteen navigation selections | $0.01670444 | $0.02970030, Decisions only |
| Whole actor trajectory | $0.02114460 | $0.09329540, including text |
| Completion judge | $0.02981920 | $0.07876800 |

The full hybrid selector used 796,532 input tokens: $0.07965320 at the published
Decisions base rate. It made more choices and resent growing history. Native
cached-input counters materially reduce the native API-equivalent proxy. There
is no observed cost advantage in this pair.

Native subscription totals are terminal cumulative session snapshots, independently
matched to native rollout totals. Shared-operation usage is differenced across the
full chronological native call sequence before filtering. Independent Decisions
request usage is summed. Rates and limitations are in the metrics; native proxy
amounts are counterfactual API rates, not subscription invoices or measured dollar
savings. Regional, service-tier and context adjustments are not established.

## Judge evidence limitation

Native click comments name inspected targets. Hybrid click comments are empty,
and the unchanged completion packet omits the observation's control bindings.
The judge could not reconstruct the hybrid's historical card exposure. Its second
verdict also relied on the actor's new incomplete claim. Keep those verdicts
separate from the deterministic exposure ledger.

This strengthens the case for a separately versioned judge evidence contract:
bind executed actions to observed controls and screenshots, and let semantic
assessment inspect that evidence. It does not justify replacing judgment with
click counting. [The judge navigation design](judge-navigation-design.md) remains
unimplemented; this experiment changed only response-budget recovery.

## Scope and evidence

One native-first sequential pair; sixty actions and fifteen minutes per arm.
Background deterministic verification was suspended during inference timing and
resumed afterward. Raw runs, coverage, audits, API metadata and immutable task
exports are under
`.relayer/live/decision-actor-comparison/20261016-navigation-recovery/`.
The experiment establishes recovery and observed trajectories, not a general speed,
quality, realism or cost result. Multi-turn interactions are a separate experiment.

Adversarial review found no material metric mismatch at the initial metrics digest.
The final reporting/hash receipt follows outcome review; without a PR it remains
non-certifying. Required deterministic results are tracked in
[the recovery verification record](budget-recovery-20261016.md).
