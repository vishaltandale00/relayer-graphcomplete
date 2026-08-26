# Variance-aware verification-runtime and flake gates

Research for [Research variance-aware verification-runtime and flake regression gates](https://github.com/vishaltandale00/relayer-graphcomplete/issues/181).

## Decision

Relayer should treat verification speed and reliability as versioned assurance policies, not as incidental CI telemetry. Each fidelity tier gets a matched-environment runtime series, a fixed reviewed wall-clock budget, a practical regression threshold, and a first-attempt flake ledger. Runtime regressions block only when they either exceed the fixed budget or show both a material effect and sufficient statistical evidence. Retries classify flakes; they never erase the first failure.

The policy applies to all six fidelity tiers while keeping cadence independent. It gates only time controlled by Relayer. Queue delay, external model/provider latency, and human response time remain separately recorded observations unless a PRD obligation explicitly makes one of them a product SLO.

## What the primary sources establish

- A single timing is not a defensible performance comparison. Google Benchmark supports warm-up, repeated measurements, random interleaving, mean/median/standard-deviation/CV output, and a Mann-Whitney comparison; its comparison documentation warns that the U test needs at least nine repetitions to be meaningful ([user guide](https://google.github.io/benchmark/user_guide.html), [comparison tools](https://google.github.io/benchmark/tools.html)).
- Repetition must occur at the highest level where randomness enters, and repetition allocation should follow observed variance and cost. Performance changes should be expressed with effect-size confidence intervals rather than p-values or point estimates alone ([Kalibera and Jones, *Rigorous Benchmarking in Reasonable Time*](https://kar.kent.ac.uk/33611/45/p63-kaliber.pdf), [DOI](https://doi.org/10.1145/2464157.2464160)).
- Continuous-benchmark thresholds need an explicit testbed, historical window, minimum and maximum sample counts, and retained threshold-model history. Bencher implements those concepts and offers percentage, z-score, t-test, log-normal, and IQR-family models ([Bencher thresholds](https://bencher.dev/docs/explanation/thresholds/)).
- Relative and absolute materiality are separate concerns. pytest-benchmark exposes both percentage and absolute comparison thresholds; Relayer should require both so tiny but statistically visible changes and large percentages on tiny tests do not create noisy failures ([pytest-benchmark comparison](https://pytest-benchmark.readthedocs.io/en/latest/comparing.html)).
- Developer wait is the critical path, not the sum of parallel work. Bazel records total phases and the build DAG's critical path separately, including concurrency and individual critical-path actions ([Bazel JSON trace profile](https://bazel.build/advanced/performance/json-trace-profile)). GitLab likewise excludes queue time from pipeline duration, supporting separate latency and queue metrics ([GitLab pipeline duration](https://docs.gitlab.com/ci/pipelines/#how-pipeline-duration-is-calculated)).
- GitHub-hosted jobs run on newly provisioned machines, runner sizes differ by repository/OS, and runner images are updated regularly. Comparisons therefore need runner and image provenance; a hosted-runner result must not silently share a baseline with a materially different testbed ([GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [runner-images release cadence](https://github.com/actions/runner-images/blob/main/README.md)).
- Google defines flakiness as pass and fail results on the same code and reports that retries reduce false positives while also encouraging teams to tolerate unreliable tests. Flaky alarms are eventually ignored, including legitimate failures ([Google's flake mitigation report](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html), [Google's analysis of flake sources](https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html)).
- A few green retries cannot certify a low flake probability. A large Python study found that achieving 95% confidence that an average passing test was not flaky would require roughly 170 reruns ([Gruber et al., *An Empirical Study of Flaky Tests in Python*](https://arxiv.org/abs/2101.09077)). For a binary flake rate, NIST recommends Wilson or exact binomial confidence intervals rather than the unreliable symmetric normal approximation at small sample sizes or rare failures ([NIST Engineering Statistics Handbook](https://itl.nist.gov/div898/handbook/prc/section2/prc241.htm)).

## Runtime measurement contract

Every execution attestation records these fields, even when its cadence does not gate on them:

| Field | Use |
| --- | --- |
| `criticalPathWallMs` | Primary developer-feedback/runtime gate |
| `setupMs`, `buildMs`, `executionMs`, `teardownMs` | Diagnostic phase ownership |
| `runnerActiveMs` | Compute-cost trend; never substituted for critical-path latency |
| `queueMs` | Capacity signal; excluded from code-regression gates |
| test-point durations | Contributor diagnosis; gated only for explicitly budgeted critical-path owners |
| first-attempt outcome and every retry | Flake classification and reliability evidence |
| monotonic-clock provenance | Prevent wall-clock adjustments from corrupting intervals |
| source revision and graph/test-point identities | Bind timing to the same immutable execution attestation as functional evidence |

The environment fingerprint contains fidelity tier, cadence, OS and version, architecture, runner class and hardware description, exact runner-image release, toolchain/runtime versions, dependency-lock digest, cache mode, shard count, concurrency, and relevant feature/configuration flags. Cold and warm-cache observations are different series.

Relayer must pin explicit OS labels and toolchain versions for blocking series. A materially changed fingerprint starts a candidate baseline. On frequently changing hosted images, blocking change attribution uses a paired base/head confirmation on the same provisioned runner; the new image series runs in shadow until accepted. No implementation may normalize timings by an undocumented machine multiplier.

## Baselines and budgets

Each `(tier, cadence, test point or aggregate, environment fingerprint)` has two distinct controls:

1. **Historical baseline:** the most recent 30–60 successful protected-branch observations from at most the previous 60 days, with a minimum of 30. It models ordinary variance and never includes the candidate observation. Only declared infrastructure incidents may be excluded, with reason and actor retained.
2. **Approved hard budget:** a versioned upper bound on critical-path wall time. It does not roll forward with the measurements. Changing it requires the same review as changing a product or verification contract.

A new series remains `collecting` until it has 30 observations. During collection, the fixed budget still gates, timings remain visible, and relative-regression claims are advisory. Promotion records the observations, median, p95, median absolute deviation (MAD), chosen practical thresholds, and approval.

Do not make hundreds of per-test hypothesis tests. The tier/cadence critical path is the default blocking measure. A particular phase or test point becomes independently blocking only when its verification policy names it as a critical-path owner with its own budget.

## Regression decision rule

There are two independent failure paths:

### 1. Hard-budget failure

One observation above the approved hard budget triggers one fresh-process confirmation. The run fails if the confirmation also exceeds the budget. Release safety timeouts and other explicit product SLOs may be marked `fail-on-first` when waiting for confirmation would itself violate the contract.

The budget protects against a regression being gradually absorbed by a rolling baseline.

### 2. Historical-regression failure

Let `B` be the baseline median and let the proposed tier policy define:

- `R`, the minimum material relative slowdown; and
- `A`, the minimum material absolute slowdown.

An ordinary PR observation crossing `B + max(R * B, A, 3 * 1.4826 * MAD)` is a suspicion, not yet a failure. Confirmation runs merge-base and candidate on the same runner, with clean fresh processes and randomized/interleaved order.

- T0 and T1 measures use at least 9 repetitions per side; 27 is the target for cheap measures.
- T2 through T5 use the maximum predeclared whole-run repetition count their cadence budget permits. When nine repetitions are impractical, the result cannot be called statistically significant; it stays suspect until scheduled runs accumulate enough evidence. The hard budget continues to protect the route meanwhile.

The historical gate fails only when both are true:

1. the one-sided 95% confidence bound for the candidate/base slowdown is greater than `R`; and
2. the corresponding absolute slowdown is greater than `A`.

For at least nine independent observations per side, use a Mann-Whitney comparison plus a confidence interval for the median or ratio effect. Where repeated measurements have nested sources of variation, bootstrap at the highest varying level rather than treating inner iterations as independent samples. Statistical significance without practical materiality never fails CI.

Initial `R` and `A` are calibration outputs, not universal constants. A 30-run pilot must select the smallest values that remain distinguishable from measured noise for each tier. Until then, seed the pilot with `R = 10%` and these deliberately reviewable absolute floors: T0/T1 5 seconds, T2 15 seconds, T3 30 seconds, T4 60 seconds, and controlled T5 orchestration 120 seconds. These seed values are Relayer policy proposals, not values asserted by the cited sources.

## Flake policy

A flake event is a non-passing first attempt followed by a pass for the same source revision, test point, input/variant, and matched environment. The first failure remains in the attestation. At most one automatic retry is allowed, in a fresh process, and only to classify the event; it cannot turn the original run green.

- A newly added or changed test point that flakes blocks the change.
- A required authoritative test point that flakes makes its evidence reliability inadequate and therefore blocks until fixed or until another adequate authoritative owner exists.
- Quarantine is explicit, non-blocking execution with an owner, linked issue, reason, and expiry. A quarantined test continues to run and report but cannot count as authoritative evidence.
- Infrastructure failures are a separate classification. Exclusion from a flake series requires a declared incident and retained diagnostic evidence; an unexplained timeout is not automatically infrastructure.
- Expected stochastic variation in model or human judgments is not a test flake. Only failures of deterministic T5 orchestration are eligible for this flake ledger; evaluation repeatability belongs to the test point's adequacy policy.

Report both per-test-point and whole-tier first-attempt flake rates over a matched-environment rolling window, with 95% Wilson intervals. The point estimate is descriptive. The lower bound exceeding the approved ceiling is a blocking, statistically supported reliability regression. An upper bound above the ceiling means reliability has not yet been demonstrated; it is informational during sample collection, not a noisy CI failure. A current flake event can still block under the rules above even before the historical rate is conclusive.

Seed ceilings for calibration are T0–T2 `0.1%`, T3 `0.5%`, and T4 plus deterministic T5 orchestration `1%`. These are proposed starting risk tolerances, not empirical facts. The pilot must expose how many observations each tier needs to demonstrate its ceiling; budgets must not be loosened merely because the available sample is small.

## Tier application

| Tier | Blocking runtime scope | Sampling approach | Excluded or separately observed time |
| --- | --- | --- | --- |
| T0 pure/model/property | focused and aggregate critical path | repeated/paired cheaply; target 27 | queue |
| T1 in-process component/storage | aggregate plus named critical contributors | repeated/paired cheaply; target 27 where feasible | queue, unrelated build |
| T2 deterministic cross-process | end-to-end critical path and phase split | ordinary run plus suspicious-change paired confirmation; scheduled accumulation | queue |
| T3 Electron desktop | launch-to-terminal-flow critical path, plus launch/action phases | small confirmatory count; scheduled accumulation | queue and unrelated packaging |
| T4 packaged/signed/platform | packaging or updater flow critical path, each separately budgeted | hard budget plus release-history series; paired confirmation only where safe | signing/notary/vendor delay recorded separately unless it is a release SLO |
| T5 metered/human | deterministic orchestration around the evaluation | gate controlled phases; scheduled accumulation | provider inference and human response time unless a PRD SLO says otherwise |

## Budget and baseline governance

Runtime and flake policies are reviewed repository artifacts. Every change records:

- old and new values or environment fingerprints;
- before/after distributions and confidence/effect-size evidence;
- effect on product coverage, authoritative ownership, and cadence;
- rationale, approver, source revision, and effective date;
- any time-bounded waiver, with owner, linked issue, and expiry.

Automation must never raise a budget in response to a regression. A runner, image, sharding, or cache-policy change gets an overlap/shadow period and an explicit baseline promotion. Historical models and attestations remain immutable. Performance improvements may lower a budget only through the same review path; otherwise later regressions could consume the gain unnoticed.

`AGENTS.md` should point agents to this lifecycle: identify affected verification policies, inspect runtime and flake deltas, preserve first-attempt results, resolve or explicitly govern suspect evidence, and obtain review before changing any baseline, budget, quarantine, or waiver.

## Follow-on decisions surfaced

The research makes these implementation decisions precise enough to ask, but does not answer them from external evidence:

1. After the 30-run pilot, what practical relative threshold, absolute floor, hard wall-clock budget, and flake ceiling does the product owner approve for each tier/cadence?
2. Which T0/T1 test points are important enough to receive independent performance hypotheses instead of remaining diagnostics under the aggregate critical-path gate?
3. Which runner classes can support same-runner paired base/head confirmation, and which tiers require pinned or self-hosted hardware before their historical gate may block?
4. Which T4 vendor waits and T5 provider latencies are actual PRD SLOs rather than non-code observations?

