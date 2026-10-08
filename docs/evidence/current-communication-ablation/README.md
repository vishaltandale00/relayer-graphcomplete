# Current communication prompt ablation

The user approved four nested prompt versions on 2026-10-08. The experiment
holds the shipped #693 source base (`fcfacdb0a235451f04d97d760d39948ad406972f`)
fixed across cells, excluding unrelated subsequent main changes. It tests current
layers as communication while work proceeds, then early publication, then material
updates. It does not change acceptance, authority, or native recursion.

## Required plan and mapping

PRD §4.3 authorizes useful visible working state through immutable current
advancement. ADR 0008 owns Advance/Return and prior-current accessibility; ADR 0009
owns the unchanged personal presentation pin. The named configs are Eval-only and
require `RELAYER_EVAL_CURRENT_COMMUNICATION_ABLATION=1`. No product config changes.

| Changed executable seam / promise | Smallest deterministic checkpoint |
| --- | --- |
| Optional Codex setting parsing and actual basic/layered prompt composition | `packages/harness-host/test/codex-basic.test.ts`: actual native turns differ from baseline only by the exact cumulative factors; existing ordinary/profile prompt cases remain |
| Four named settings preserve model, permission, recursion and presentation inputs | `test/eval-configuration-paths.test.mjs`: configurations normalize to shipped codex-basic except name/factor |
| Opt-in Eval configuration discovery, unchanged default and packaged catalogs | same configuration test; existing desktop configuration tests; full `npm run check` fallback for startup env gate |
| Source and compiled-runtime delivery | `npm run check`, `npm run build`, `npm run test:eval-compiled-runtime` |
| Read-only production review and catalog/startup composition | `npm run test:eval-web` |

No tests are deleted. Native-child treatment compliance remains observational;
root prompt delivery does not prove that helpers follow its instructions.

## Frozen pilot protocol

Two existing built-in H3 tasks, three repetitions per cell (24 original root
candidate attempts), fresh case workspaces and product threads, serial execution.
Candidate: codex.basic / gpt-6-luna / codex-subscription / medium. Presentation:
personal-presentation-v4. Final judge: simulated-user v11 / gpt-5.6-sol / high.

A adds nothing. B adds the communication framing. C adds early publication to B.
D adds material updates to C. Full additions are saved in `protocol.json` before
inference. No silent repairs, replacement attempts, injected errors, or manual
judge termination. Preserve failed and unavailable measurements.

Rotate cell order by task and repetition. Hold the source, cases, candidate,
judge, SDK, native executables and renderer inputs fixed; record actual routes,
source/configuration hashes and pre/post artifact hashes. Profile is an isolated
SQLite backup from the prior owned run; no native candidate sessions are copied.
All cells use that same profile/history. Report this as a descriptive pilot,
not a population-wide or causal performance conclusion.

Record backend Send-to-first-publication and final acceptance separately, observed
partial authoring incidents, mandatory task gates, available qualitative task
scores, and final graph scores/coverage. A completed provider turn is not acceptance.

During execution, a passive read-only review may capture painted current layers.
The review opens after dispatch, so rendered latency is unsuitable for Send-to-paint
comparisons. Capture is first observed rendering, potentially missing earlier
revisions. Bind interaction/layer, paint observation, viewport and PNG digest. Do
not invent a renderer timestamp from backend evidence or select the first useful
snapshot retrospectively as the first snapshot. Compare observed layer identity
against the actual first backend publication and record gaps.

First-view assessment uses frozen `current-communication-first-view-v1`, a blinded
gpt-5.6-sol/high subscription rater, criterion yes/no/unknown and independently
judged overall 1–4 experience/useful-insight ratings. Anchors, missing-data rules
and D update materiality are frozen in protocol.json. Cropped graph-stage PNGs exclude the review roster, grades and history. Inspector
images are omitted because node-detail readiness is unqualified. This first-view
rubric assesses visible graph overview insight only, not the full interactive
experience. It consumes only the original request and that published
snapshot's rendered evidence. It never sees final code, later findings or final
grades. Use four separate criteria: task-specific finding/evidence, honest
uncertainty, actionable implication/next step, readable/navigation-useful
presentation. A status such as "working" supplies no finding credit. Usefulness
and update materiality remain separate from the final graph judge. Publication
count is diagnostic, not an objective. Missing and terminal-only capture stay
explicit. Strict first useful after-paint TTFG remains indeterminate until a
pre-Send renderer observation and first-view judgment contract is qualified.

## Actual execution and evidence

The reviewed source digest is recorded in `source.json`. Warm tests passed 78/78;
`npm run check`, `npm run build`, compiled-runtime proof (4/4), and all declared
browser proof chapters passed. `verification.json` preserves log hashes and the
initial unchanged Windows cleanup failure (cause unproven), its isolated 10/10
pass, and the repeated full pass. The newer-main native-cache lock mismatch was
rejected; the shipped #693 base passed trusted Ladybug identity verification.

All 24 original candidates ran on `85c72aa5104a790389ed4a64ebdb5e09522107f2`.
No replacements or manual judge termination. Production ledger/timing and grade
recomputation, gate references, screenshot hashes, 220 pre/post artifact identities,
and exact root routes passed. Native runtime messages verify A/B/C/D delivery and
Luna/medium on all 24 roots. `measurement-receipt.json` preserves evidence hashes.

| Case | Version | First publication median (s) | Range (s) | Observed errors | Task gates | Graph scores /8 (available N) |
| --- | --- | ---: | --- | ---: | --- | --- |
| Repair | A | 53.3 | 38.9–57.9 | 1 | 3/3 | 4 (N=1) |
| Repair | B | 52.1 | 46.9–88.8 | 0 | 3/3 | 2, 3 (N=2) |
| Repair | C | 49.6 | 38–98.8 | 4 | 2/3 | 3, 2, 2 (N=3) |
| Repair | D | 44.4 | 37.3–64.8 | 1 | 3/3 | 4 (N=1) |
| Investigation | A | 49.7 | 27.4–55.5 | 2 | 3/3 | 4, 4 (N=2) |
| Investigation | B | 53 | 37–58.5 | 3 | 3/3 | 4, 3 (N=2) |
| Investigation | C | 44.9 | 40.9–51.4 | 5 | 3/3 | unavailable (N=0) |
| Investigation | D | 43.1 | 43–54.8 | 3 | 3/3 | unavailable (N=0) |

Each timing cell has three original attempts. These are backend Send-to-publication
measurements, not renderer TTFG. Every first publication was a terminal Return:
24 Return-first, zero Advance transitions. All 24 roots reached acceptance.
The framing did not produce communication while work proceeded in these tasks.
D has lower nominal medians (16.7% repair, 13.3% investigation versus A); within-cell
variation and the small rotated pilot do not establish causal improvement or a winner.

Task gates passed 23/24: C repair repetition 1 omitted a regression-test change from
its commit; functionality/build/typecheck/focused tests passed. Qualitative task
scores remain unavailable for all 24. Observed authoring incidents totaled 19:
A=3, B=3, C=9, D=4; capture remains partial and exact totals unknown.

Final graph review completed 11/24. The other 13 ended without complete submitReview
coverage; scores remain unavailable, never zero. Raw scores and per-sample ceilings
are retained in results.json. Missingness differs by cell, so graph non-regression
is indeterminate. Judge failures are separate from candidate authoring counts.

First-view overview ratings completed 24/24 under the frozen rubric: all 2/4,
with 15/24 judged to contain meaningful task insight. Every view was terminal-first;
there were zero early meaningful snapshots and zero D update pairs to assess.
This crop excludes the inspector and cannot assess full interaction or establish
Send-to-first-useful-paint latency. First-view scores do not replace final graph scores.

The initial rater qualification failed because native JSON output omitted its
startup model header. That failure is retained. A separate operational qualification
passed after binding the unique native thread to its runtime model/effort contexts;
no rubric, candidate, observer, or scoring factor changed. Retained native sessions
are private evidence and are not supplied to the fresh-thread raters.

Keep the ordinary baseline. A next experiment can give an explicit first-finding
trigger for `graph.advance`, after repairing/qualifying final-judge stop feedback
and richer first-view capture. No treatment is promoted by this change.

Required verification, actual commands and initial failure receipts are recorded in
verification.json. Live inference was authorized for this pilot, never the default suite.
