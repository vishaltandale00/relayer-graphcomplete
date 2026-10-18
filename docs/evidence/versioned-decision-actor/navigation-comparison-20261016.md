# Navigation-heavy comparison — 2026-10-16

Decisions selected shared navigation operations much faster, but did not complete
the task and did not show a cost advantage on the shared operations. Preserve
these as separate results.

| Autonomous task result | Existing Codex | Decisions + Codex text |
| --- | ---: | ---: |
| Observed detail cards / required | **12 / 12** | **8 / 12** |
| Navigation clicks | 17 | 10 |
| Finish proposals | 1 | 1 |
| End-to-end wall time, including export | 78.334 s | 20.201 s |
| Total actor inference | 64.573 s | 9.394 s |
| Native Codex actor/text calls | 18 | 1 |
| Decisions selector calls | — | 11 |
| Completion-review time | 8.357 s | 6.609 s |
| Completion-judge verdict | complete | incomplete |
| Final termination | endpoint_reached | budget_exhausted |

This is one synthetic fixed-candidate task through the production renderer.
The graph has Data pipeline, Model training and Deployment branches, with four
detail cards in each. The endpoint explicitly requires inspecting all twelve;
no synthesis or follow-up message is requested. The actor sees current pixels
and control names, never the evaluator's expected node ledger. Both used exact
previous actor revisions and the same settings. The candidate does not perform
inference or adapt its output.

**Behavior and coverage.** Codex visited all three branches. Decisions visited
the data and training branches, then chose finish while all four Deployment
cards remained unobserved. Its text actor incorrectly claimed all twelve were
inspected. The completion judge declined the finish. The host then stopped
because the predeclared candidate-completion limit was one and the initial
response had used it. Neither the 60-action budget nor the 15-minute deadline
was exhausted. Existing host behavior prevented recovery after this rejection;
we did not reopen it, change its budget or rerun it into success. Its short wall
time is not faster successful completion.

Coverage requires an actual stable production observation with the expected
node selected, its exact detail and title visibly rendered, and a screenshot
hash matching the persisted actor-observation artifact. Click intents and node
titles alone do not count. All 29 observations had stable before/after bindings,
visible detail content and matching screenshot hashes. This establishes offered
visual exposure, not comprehension. Equal accepted fixture content/shape and
matching case/harness definitions were checked independently.

**The ten shared navigation operations.** We aligned a common subsequence by
operation, target control, preceding selected title and semantic layer path.
They comprise all four Data details, return to overview, and all four Training
details through their actual open/expand/select operations. Native had one prior
redundant “Open Data pipeline” operation; history, screenshots, context and caching
are not identical. This is descriptive shared work, not a same-model or
identical-context experiment. Native decisions generate the action JSON and a
brief comment; Decisions returns a constrained choice.

| Shared navigation subsequence | Native Codex decisions | Decisions selection |
| --- | ---: | ---: |
| Operations | 10 | 10 |
| Inference time total | 34.108 s | 5.326 s |
| Inference time mean | 3.411 s | 0.533 s |
| Input tokens | 272,371 | 141,790 |
| Cached input subset | 241,024 | 0 |
| Output tokens | 914 | 0 |
| Standard API-equivalent / base-rate estimate | **$0.01218668** | **$0.01417900** |

Selection was about 6.4 times faster for these observed operations. The cost
proxy was about 16% higher for Decisions: native reused cached context heavily.
Different context/history and model selection prevent attributing the entire
latency difference to the endpoint alone. Browser-action execution was similar
across the complete trajectories: about 107 ms per click. It is the inference
selection/generation work that differed; Decisions does not execute the browser
operation itself.

**Cost accounting.** Native subscription usage has no available per-run dollar
invoice. To answer the cost question beyond token counts, the table applies
published standard API rates to native reported usage as an explicitly
counterfactual estimate. GPT-5.6 Luna rates per million tokens are $0.20 uncached
input, $0.02 cached input and $1.20 output. Decisions input is $0.10 per million,
with no output charges. Regional/tier/context qualifications apply; these are not
measured subscription costs or savings. All native actor per-call input
increments were below 272K (maximum 51,310); cache writes were zero.

Native cost = ((input − cached input) × input rate + cached input × cached rate
+ output × output rate) / 1,000,000. Native per-operation usage was obtained by
differencing consecutive cumulative snapshots over the **entire** session before
filtering the common operations, so the unmatched first operation is excluded
correctly. Independent Decisions request usages are summed. Cached input and
reasoning output must not be added again to the totals.

Across the whole unequal trajectories, native actor usage was 601,914 input
(539,520 cached) / 1,625 output. Hybrid Codex text used 17,223 input / 147 output,
and its eleven Decisions requests used 167,294 input / zero output. The Decisions
base-rate estimate for all requests is $0.0167294. Whole-actor API-equivalent
estimates are $0.0252192 native and $0.0203504 hybrid, **for different amounts of
completed work**; they establish no successful-task cost saving.

The unchanged completion reviewers used 12,147 input (6,528 cached) / 274 output
native and 11,506 input (6,528 cached) / 216 output hybrid. At GPT-5.6 Sol standard
rates ($4 input / $0.40 cached / $20 output per million), their counterfactual
estimates are $0.0305672 and $0.0268432. Neither reviewer uses Decisions in this
experiment. Smaller input/output and different verdicts are not a judge backend
optimization.

Sources, checked 2026-10-16: [Decisions pricing](https://developers.openai.com/api/docs/guides/decisions),
[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol).

**What this says about judging.** The completion judge received a bounded packet;
it did not navigate. It correctly rejected the hybrid finish, but its explanation
used a flawed minimum-click argument: the first detail in a branch is selected
automatically, so every exposed detail does not require its own click. The
independent observation ledger establishes the actual 8/12 coverage. A model's
verdict and its rationale remain distinct from deterministic exposure evidence.

The presentation judge is a separate tool-using reviewer. Decisions can choose
its next permitted inspection operation while the existing host executes
`interact`, `history` and `screenshot`, followed by Codex semantic assessment.
For mandatory exhaustive coverage, a prescribed host evidence walk may be simpler
than paying any model to choose the next required inspection. The [judge design
proposal](judge-navigation-design.md) details both options, preserved evidence
and authority rules, and a three-way comparison. It is a proposal, not a new
implemented judge or a scoring/rubric change.

**Pinned experiment and verification.** Existing internal case
`empty-project.hierarchical-overview.single-turn` supplies the training-map prompt.
An isolated experimental `fixture.navigation-heavy` harness authors the frozen
graph; fixture and configuration hashes are in the manifest. Actor policy stays
`task-actor-v9`, GPT-5.6 Luna/low, low exploration/meticulousness, 60 actions and
15 minutes. Completion judge stays GPT-5.6 Sol/high v1. Decisions uses GPT-6 Luna
under `openai-decisions-codex-text-v1`. Candidate completion cap is one in both
arms; native ran first, one repetition each. This exhaustive endpoint intentionally
exercises the unchanged low-exploration policy. No new actor revision, fabricated
feedback or default promotion occurred. There were no control dispatch failures,
invalid-action repairs, working observations or inference retries. The missing
Deployment branch is retained as a failure, not converted into a pass.

Executable experiment seams were frozen fixture authoring, observation audit and
measurement orchestration. Checkpoints were accepted equal fixture shapes,
stable selected-detail/screenshot binding, existing browser/finish authority,
and correct cumulative/per-request accounting. The real accepted graph and live
actor/controller/judge paths exercised those checkpoints. Runner syntax and
post-run equality/hash/accounting checks passed. Original scripted graph checks
are explicitly not run for adaptive task trajectories; no deterministic
comprehension/outcome pass is claimed.

[Machine-readable evidence](navigation-comparison-20261016.json) includes semantic
operation alignment, incremental/cumulative usage, exact actor definitions,
coverage, verdicts, phase timings, raw file hashes and native-rollout audit
references. Full local runner, fixture, task/export/screenshots and observation
audit artifacts are under
`.relayer/live/decision-actor-comparison/20261016-navigation/`.
All 15 implementation hashes still match
`dedd1cc66f3d41a06250a6c9274b16f79cace9184a5df83c7b572f79f958d5d2` on base
`77b1b296022b17c29b06aa0da24522ead3344617`. No production implementation changed.
The existing deterministic suite results and unresolved broader failures in
[README](README.md) are separate; this evidence-only experiment did not rerun them.
