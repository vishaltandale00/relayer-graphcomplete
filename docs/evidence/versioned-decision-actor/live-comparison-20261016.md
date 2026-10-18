# Live Decisions / Codex simulated-user pilot — 2026-10-16

One live run of each version used the same task-system case and production
renderer. The Decisions selector worked, but its trajectory took **38.4 seconds**
versus **13.9 seconds** for the existing Codex actor. This pair shows a cheap,
fast selector alongside more interaction and review work; it does not establish
a general quality, speed, or total-cost advantage.

| Observed measure | Existing Codex | Decisions + Codex text |
| --- | ---: | ---: |
| End-to-end time, including admission and export | 13.938 s | 38.407 s |
| Actor decisions/proposals | 3 | 8 |
| Recorded actions, including proposed finishes | 3 | 7, plus 1 rejected finish |
| Candidate completions, including initial response | 1 | 2 |
| Actor inference time | 9.238 s | 19.046 s |
| Decisions selector calls/time | — | 8 / 4.171 s total; 0.521 s mean |
| Codex text-generation calls/time | Included in 3 decisions above | 4 / 14.850 s |
| Completion-judge calls/time | 1 / 3.446 s | 2 / 16.028 s |
| Browser open, observation, and action time | 0.951 s | 2.158 s |
| Actor's final stop | endpoint_reached / reached | satisfied / uncertain |
| Actor self-rated satisfaction (not human feedback) | 4/4 | 3/4 |
| Final completion-judge verdict | complete | complete, after initial incomplete |

Selector and text time are components of hybrid actor time; do not add all three.
Shared server, provider-connection, and Chromium startup precede these wall times.
Per-arm admission/preflight is included: 0.077 s native, 0.644 s hybrid. The
remaining time covers persistence, orchestration, finishing, and export. These
are local wall-clock measurements including network/native process overhead.

**Behavior.** Codex opened “Two-worker pool,” opened “Results store,” and proposed
finishing. Decisions opened “See queue behavior,” selected “Next claim” twice,
and proposed finishing. Its first generated finish inferred FIFO scheduling;
the judge declined that stop. It then filled and sent a follow-up that explained
the flow and asked whether “next” meant FIFO. A subsequent generated finish
contradicted itself (`endpoint_reached` with `endpointStatus: uncertain` and
remaining work). The host rejected it before dispatch, preserving the rejection
and usage. The repaired finish stopped satisfied while explicitly leaving FIFO
uncertain. No control dispatch failed. Both sessions closed and exported.

The unchanged judge is an important limitation: the native verdict describes
the actor's finish explanation as delivered; the hybrid's first verdict rejects
its explanation for inadequate visible evidence, and the second accepts the
actor's own submitted follow-up. These model assessments do not independently
prove equivalent candidate delivery or task success. The hybrid's final actor
claim remains uncertain despite its judge's complete verdict. Its long follow-up
also did not resemble the prompt's desired low-effort, short ordinary-user reply.

**Usage and cost.** Native SDK usage is cumulative within a session. We checked
its snapshots against the exact native rollout `total_token_usage`; the table
uses the terminal snapshot, not a sum of successive snapshots. Cached input and
reasoning output are subsets of input and output respectively.

| Native subscription usage | Input | Cached input subset | Output |
| --- | ---: | ---: | ---: |
| Codex actor | 37,434 | 22,272 | 371 |
| Hybrid Codex text actor | 85,156 | 36,096 | 654 |
| Codex-arm completion judge | 11,023 | 0 | 90 |
| Hybrid-arm completion judge | 25,706 | 11,008 | 619 |

The 8 independent Decisions HTTP requests used **95,684 input tokens**, zero
cached tokens, and zero output tokens. At the published **$0.10 per million input
tokens**, their base-rate estimate is **$0.0095684 (0.96 cents)**. Regional and
long-context pricing qualifications apply; this is not an invoice. Source:
[OpenAI Decisions pricing](https://developers.openai.com/api/docs/guides/decisions),
checked 2026-10-16. Native subscription runs expose usage but no per-run dollar
charge, so total dollar cost and dollar savings cannot be calculated from this
evidence. The hybrid consumed more native text and judge tokens in this pair.

**Controls and scope.** The case was `empty-project.task-system.two-turn`: explain
an incoming queue, two workers, a results store, and waiting while workers are
busy. Candidate responses came from deterministic `fixture.task-system`; both
simulators and the common completion judge ran live. This isolates traversal
against a repeatable graph but does not measure an adaptive candidate. There
were zero working-update reactions in either run.

Both used the existing `task-actor-v9` prompt, GPT-5.6 Luna/low text actor, low
exploration/meticulousness, 60-action/15-minute actor budgets, three candidate
completions maximum, and the same GPT-5.6 Sol/high completion judge v1. Decisions
used GPT-6 Luna via `openai-decisions-codex-text-v1`. Thus this compares execution
versions with different selector models and protocols, not the Decisions API
versus a generative API on the same model. Case-plan and harness digests, actor
behavior contracts, and all settings except `decision` matched. The native arm
ran first. One pair cannot characterize variability, order effects, or realism.

The existing v9 revision `setup-98dee801-7d74-4071-81b5-3b4190d3cf4c` was cloned
into two new, isolated experimental registries as initial revisions. No human
feedback was fabricated, no existing revision was edited, and no default was
promoted. The initial attempt in `20261016-pilot` stopped both arms before
inference because that profile's native account was disconnected. A read-only
account check found the existing Eval profile connected; the pair then ran once
using that profile and fresh product/task stores. No inference run was retried
into success. Managed Codex 0.159.3 passed the production resolver's byte-integrity
validation; no build or runtime installation was needed. API credentials stayed
in the host's in-memory credential store and were not written to the report,
tasks, prompts, exports, or native environment.

**Evidence.** [Machine-readable metrics](live-comparison-20261016.json) include
pinned revisions, action traces, judge explanations, exact timings, token usage,
export hashes/paths, matching-control checks, and raw measurement hashes. Full
local artifacts are under `.relayer/live/decision-actor-comparison/20261016-paired/`:
`manifest.json`, `run.mjs`, `timings.json`, `api-metadata.json`, `results.json`,
per-arm registries/task records, screenshots, and immutable task exports.

The tested 15-file implementation snapshot remains
`dedd1cc66f3d41a06250a6c9274b16f79cace9184a5df83c7b572f79f958d5d2` on base
`77b1b296022b17c29b06aa0da24522ead3344617`; all recorded file hashes were rechecked.
The runner hash is recorded in the manifest and metrics. No implementation changed
for this experiment. Required implementation verification and its unresolved
failures remain separately recorded in [README](README.md); this live pilot does
not replace deterministic tests or repair those failures.
