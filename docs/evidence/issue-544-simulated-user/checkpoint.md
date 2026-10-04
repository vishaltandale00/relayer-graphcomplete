# Interactive evaluation checkpoint — October 4, 2026

This checkpoint delivers evaluation machinery, not a claim that all tasks pass or
that simulated users and judges are calibrated to humans. Product authority stays
in PRD sections 13.2.3–13.2.5 and ADR 0003.

The runner supports interactive AI users in the production graph workspace,
in-graph human grading, immutable setup and feedback lineage, frozen calibration
sets and manually selected comparisons, an independently executing completion
reviewer, isolated external cases, and opt-in local browser diagnostics. The
completion reviewer is currently pinned inside the actor behavior contract;
independent judge configuration chiefly serves graph-presentation grading.
Overall trajectory judging and observers remain separate future work.

## Live evidence at the checkpoint

All ten cases have at least one normal actor completion across separate versions
and follow-ups. This is neither one uniform successful cohort nor ten independently
verified task successes. Historical attempts remain separate and unchanged.

| Saved cohort | Source / catalog | Observed result |
| --- | --- | --- |
| Uniform ten, October 1 | ebc4b3a7 / cb58df13 | 24 submissions, 105 intents; nine normal completions and one workspace actor failure. Independent review supported Redis 20/20; other endpoints incomplete or unsupported. |
| Completion-gated ten | 3da87165 / cb58df13 | 54 submissions, 246 intents; five judge-approved, four budget-exhausted, one Local weekend actor failure. Restaurant/community supported; false approvals included missing deliverables and Redis 19/20. |
| Four budget follow-ups | d0f8299d / 2ae3ff3 | 21 submissions, 89 intents; all judge-approved. Tournament still 27/28, Europe/discussion missing deliverables, workspace conservative fallback supported with a file-coherence caveat. |
| Local weekend click recovery | 31010f12 / 2ae3ff3 | Six submissions, 27 intents; actor failed clicking Open Verified event facts. Original browser exception unavailable; exact cause unknown. |
| Local weekend diagnostics | f76a0a3c / 2ae3ff3 | Six submissions, 26 decisions; all 23 browser actions completed. Judge approved a provisional plan. Music timing, rainy-day budget and missing deliverable remained independent-review limitations. |

The final diagnostic capture contained 1,736 events and 6,464 Playwright records,
with no errors or dropped/write/capture failures. The historical click failure did
not reproduce. It remains unconfirmed; this clean run does not establish its cause
or prove the recovery branch. Frame navigation consumed most of the event budget.
A separate graph-server startup exceeded its ten-second deadline; an 11.05-second
probe and warm retry diagnosed that startup delay separately from actor clicks.

Diagnostic follow-up independent review: `/root/eval_facts`, SHA256
`795fe69e2361edf3463a6a2fdd006ef50dc4e7e5ae3c196b6f42392a27904dc1`.
Local reports, original exports, runtime/workspace audits, diagnostic archives and
hash manifests remain under `.relayer/` in their dated cohort directories.
These can contain private task content and authenticated review links and are not
published in this repository. No model-generated satisfaction is a human grade.

## Proposed next lifecycle: evaluate the evaluators

This is a proposed work sequence, not new implemented behavior or an approved
quality threshold.

1. Freeze the case catalog, candidate harness/model, budgets and evidence format.
   Label real trajectories and candidate stopping points with humans. Separate
   task completion, preference fit, evidence sufficiency and actor realism.
2. Freeze tuning and held-out partitions. Keep failures and disputed labels;
   record disagreement rather than converting it into a fabricated consensus.
3. Give the completion reviewer its own immutable revision and evidence contract.
   Publish each prompt/model/rubric/evidence change with its predecessor and the
   specific motivating human labels. Keep the actor fixed for judge comparisons.
4. Compare judge revisions on identical saved evidence. Measure false approvals,
   false rejections, uncertainty, human agreement and runtime separately. Known
   structural checks establish facts; models assess intent, taste and sufficiency.
5. Validate promising judges in fresh closed-loop sessions: a stopping decision
   changes subsequent behavior, so offline rescoring alone is insufficient.
6. Improve the user actor separately, holding candidate and judge fixed. Judge
   realism, gradual disclosure, natural exploration, consistency with the private
   brief and premature satisfaction against human trajectories. Actor changes
   require fresh interaction, not only replaying saved screenshots.
7. Review held-out results and explicitly promote a revision or retain the prior
   default. Preserve both versions and all prior outcomes. Initial improvement is
   manual; thresholds and automatic promotion are not supplied by this checkpoint.

Immediate judge targets are usable artifact evidence, unresolved constraints,
explicit treatment of uncertainty, and resistance to unsupported completion claims.
Distinguish a user's legitimate preference change from giving up a mandatory case
requirement. Do not force arbitrary turns to manufacture interaction.

## Proposed next lifecycle: improve the candidate harness

Freeze an evaluator release (actor revision, completion judge, final grader and
calibration-set identity) before comparing candidate harnesses. Pin catalog,
profiles, model, provider/runtime, workspace, budgets and source commits too.

For each ablation, state one hypothesis and change one harness dimension where
feasible: prompt, context policy, graph instructions, tools, native delegation,
self-checking or model. Keep GraphComplete's `complete(inputGraph)` boundary and
provider-owned execution; do not add a second scheduler. Provider-inseparable
changes must be named as multi-factor comparisons.

Run paired cases with repeated trials, retaining every error and timeout. Report
objective task checks, human intent/taste fit, graph usefulness, completion-judge
verdict, actor satisfaction, reliability, latency and cost separately. Current
first-graph timing attaches after dispatch and is not a valid responsiveness
comparison until its measurement boundary is fixed.

Inspect disagreements and failure traces, then make a narrow candidate change and
rerun the frozen comparison. Test the selected candidate on held-out tasks and
human sessions before manual promotion. Do not improve a harness and its judge in
the same comparison; if both change, label it a new experiment series. New scores
on old evidence append results and never rewrite the historical run.

## Integrated checkpoint verification

Integrated main7cf98b6d with the checkpoint branch. The generated social-preview
receipt was the only textual conflict; actual Electron light/dark capture regenerated
it and passed cleanup/cancellation. Fullcheck passed3561 JavaScript tests with three
existing skips, two separate secret-boundary tests,68 Python tests and all required
Rust/type/receipt checks. Build, four compiled-runtime tests and every Eval browser
chapter passed. Logs are /tmp/eval-checkpoint-{check,build,compiled,browser}.log and
/tmp/checkpoint-share-preview.log. No paid inference was used.

External catalog2ae3ff3 remained clean: build,125tests(16existing skips), and its
real restaurant browser scenario passed. An initial catalog import attempt overlapped
the runner rebuilding shared SDK files and failed before suite execution; the stable
SDK retry passed. The failed log remains /tmp/checkpoint-catalog-check.log.

Static reviews by /root/checkpoint_spec and /root/checkpoint_integration found no
blocking findings in their explicitly scoped authority and merge-integration reviews;
exact scope/digest assertions are recorded in PR636. They do not certify semantic task
success. Hosted CI and actual merge identity belong to the PR record.
