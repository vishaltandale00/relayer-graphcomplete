# DeepSWE verifier design and implications for Relayer Eval

Research snapshot: 2026-08-27. DeepSWE source inspected at commit [`0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea`](https://github.com/datacurve-ai/deep-swe/tree/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea).

## Executive conclusion

The useful DeepSWE pattern is not a clever textual verifier. It is a disciplined behavioral-test pipeline:

1. collect the candidate's committed diff;
2. apply it in a pristine, isolated verifier checkout;
3. apply held-out tests only after the candidate has finished;
4. exercise public APIs and observable outputs;
5. distinguish new behavior from regression safety;
6. retain exact per-test evidence even though leaderboard qualification is binary; and
7. backtest the verifier against the empty implementation, a known-good reference, repeated runs, and diverse agent attempts.

That directly exposes the bug in the current H3 verifier. Requiring the literal test expression `sanitizeStatusCode("200.5")` tests whether the candidate guessed our chosen example, not whether decimal numeric strings correctly fall back. DeepSWE's design says to replace that check with held-out behavioral cases and preserve the source/file/commit checks only where the visible task explicitly requires them.

## Which “DeepSWE” this refers to

DeepSWE is a 2026 benchmark from Datacurve: 113 newly authored, long-horizon coding tasks over 91 open-source repositories and five languages. It is not the earlier DeepSWE-Preview coding model/training system evaluated on SWE-bench Verified. The benchmark evaluates model configurations through a fixed `mini-swe-agent` harness; its authors explicitly caution that this does not rank the quality of products such as Codex CLI, Claude Code, Cursor, or Gemini CLI. See the [official paper](https://arxiv.org/html/2607.07946) and [official repository](https://github.com/datacurve-ai/deep-swe).

This distinction matters for Relayer Eval: DeepSWE's task and verifier design is relevant to our substance grade, but its fixed harness and coding-only scope do not measure our graph UI or interactive product behavior.

## How a DeepSWE task is packaged

Each task includes:

- `instruction.md`: the candidate-visible request;
- `task.toml`: pinned repository/base commit, environment, timeouts, and artifact collection;
- `tests/test.patch`: held-out behavioral and regression tests;
- `tests/test.sh`: the task-specific test runner;
- `tests/config.json`: exact feature and regression test IDs;
- `tests/grader.py`: a shared report parser and scorer; and
- `solution/`: a reference solution for author/reviewer validation, not grading.

The [repository README](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/README.md#L5-L33) describes this layout and states that the reference patch is never used at grading time.

### Candidate patch isolation

The agent works in an isolated, no-network checkout and commits its work. A `[[verifier.collect]]` hook captures `git diff --binary <base> HEAD` as `model.patch`; see the concrete [ofetch task configuration](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/ofetch-per-origin-circuit-breaker/task.toml#L18-L36).

Grading occurs in a separate pristine verifier environment. The shared grader:

1. resets only paths touched by `model.patch` to the pinned base;
2. applies `model.patch`;
3. resets paths touched by `test.patch` to their verifier preimage; and
4. applies the held-out `test.patch`.

This order prevents the candidate from reading or modifying acceptance tests during execution and avoids trusting a candidate-controlled test runner. A candidate patch that cannot be applied becomes a scored failure with `apply_failed=1`; a failure to apply the verifier's own patch is treated as infrastructure failure. The exact mechanics are in the shared [grader preparation code](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/ofetch-per-origin-circuit-breaker/tests/grader.py#L110-L165). Harbor's [separate verifier documentation](https://www.harborframework.com/docs/tasks#verifier-environment-shared-vs-separate) specifies the isolation and artifact-transfer boundary.

## What the verifiers actually assert

The paper's stated rule is: test through public APIs and observable outputs, not private helpers or internal implementation state. The goal is to accept any reasonable implementation that satisfies the prompt, rather than the reference solution's names or structure. See [Sections 3.4 and 4.2–4.3](https://arxiv.org/html/2607.07946) of the paper.

The official ofetch task is a useful concrete example. Its prompt specifies a per-origin circuit breaker in terms of public configuration, state transitions, hooks, retries, URL forms, and observable fast-fail behavior. Its held-out Vitest patch drives the public fetch clients with mocked fetch behavior and fake time, then checks returned values, errors, call counts, concurrency, and state transitions. It does not search implementation text for a prescribed circuit-breaker shape. See the [ofetch instruction](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/ofetch-per-origin-circuit-breaker/instruction.md) and [behavioral test patch](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/ofetch-per-origin-circuit-breaker/tests/test.patch#L26-L90).

“No implementation-shape checks” is a preference, not an absolute ban. A structural assertion can be legitimate when structure is itself part of the visible deliverable. For example, the `textual-kitty-key-phases` prompt explicitly requests an example with a guarded entrypoint, and its verifier parses the example's AST to confirm that requirement. The important rule is prompt-verifier bijection: no hidden structural preference should become a grading requirement.

## Scoring and evidence

Each task's `config.json` names two buckets:

- `f2p_node_ids`: fail-to-pass tests proving the requested behavior now works;
- `p2p_node_ids`: pass-to-pass tests proving existing behavior still works.

The task runner emits JUnit or CTRF reports. The shared grader normalizes those reports, treats a missing or skipped whitelisted test as failed, and resolves duplicate IDs with the worst observed status. A binary reward of 1 requires a non-empty F2P set, every F2P test to pass, and every P2P test to pass. See the [shared scoring implementation](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/ofetch-per-origin-circuit-breaker/tests/grader.py#L255-L343) and [ofetch's explicit test buckets](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/ofetch-per-origin-circuit-breaker/tests/config.json).

Although qualification is binary, the verifier preserves:

- F2P and P2P totals and pass counts;
- per-bucket fractions and an overall partial fraction;
- a machine-readable CTRF report;
- per-test failure messages;
- raw suite output; and
- whether the candidate patch failed to apply.

This is a good match for our earlier decision: substance qualification may remain strict while the run explorer exposes why and how far a candidate missed.

## How DeepSWE validates a verifier

The authors report the following construction checks:

- a known-good reference implementation is reviewed against the prompt and verifier but is not used to grade candidates;
- each verifier is run three times during authoring, with variable outcomes sent back for revision;
- every trial runs both feature tests and selected existing regressions;
- LLM-assisted analysis is followed by independent human review;
- reviewers evaluate prompt-verifier bijection, acceptance breadth, task realism, and environment cleanliness; and
- several frontier configurations attempt each task, with passing and near-correct failing trajectories reviewed to find verifier gaps.

These procedures are described in [Sections 4.2 and 4.3](https://arxiv.org/html/2607.07946).

DeepSWE also uses an LLM judge as an auditor, not the authoritative grader. GPT-5.5 at xhigh reasoning reviews the task, trajectory, patch, reference solution, and verifier output. On the paper's sampled audit it disagreed with the DeepSWE verifier on 10 of 735 rollouts (1.4%), versus 256 of 789 (32.4%) for SWE-Bench Pro's inherited-test scheme. The authors correctly describe these as disagreement rates, not ground-truth verifier error rates; the DeepSWE count is small, and the judge itself is fallible.

## Limitations we should not copy blindly

DeepSWE explicitly acknowledges several limitations in [Section 8](https://arxiv.org/html/2607.07946):

- Binary reward erases the difference between a near-complete solution and code that does not compile.
- Functional verification does not grade readability, maintainability, idiomatic style, documentation, defensive coding, or performance unless directly specified and tested.
- The prompts are still more detailed than many everyday developer requests.
- Ambiguous requests, clarification behavior, debugging dialogue, planning, review, and other non-coding work are excluded.
- A fixed mini-swe-agent/bash harness measures model capability under that scaffold, not native product quality.
- The LLM audit is sampled, uses a withheld prompt, and has single-digit DeepSWE disagreement counts.
- Tests are hidden from the agent during execution but public after release, so future training contamination remains possible.

## Proposed H3 verifier v2

### 1. Remove lexical implementation and test matching

Delete the combined check that requires:

- `Number.isInteger(statusCode)` to appear in source;
- `Number.isFinite(statusCode)` not to appear; and
- five exact `sanitizeStatusCode(...)` strings to appear in the candidate's test file.

The source-string checks prescribe one correct implementation. The test-string checks require the candidate to guess our examples. Neither establishes behavior.

### 2. Add evaluator-owned behavioral tests

Run a hidden evaluator-owned test module against the public sanitizer boundary. Derive its cases from the visible prompt, with multiple representatives per equivalence class rather than one magic literal:

| Requirement | Representative hidden cases | Expected observation |
| --- | --- | --- |
| Lower integer boundary | `99`, `100`, `101` | fallback, accept, accept |
| Upper integer boundary | `598`, `599`, `600` | accept, accept, fallback |
| Decimal numbers | `100.1`, `200.5`, `599.5` | fallback |
| Integer numeric strings | `"100"`, `"301"`, `"599"` | normalized integer |
| Decimal numeric strings | `"100.1"`, `"404.1"`, `"599.5"` | fallback |
| Custom fallback | repeat invalid cases with a non-default fallback | supplied fallback returned |

Use deterministic table-driven assertions and emit one result per requirement/case. Values should be evaluator-owned and may change without changing the contract; candidates pass by implementing the category, not memorizing an example.

### 3. Split feature behavior from regression safety

Mirror DeepSWE's F2P/P2P distinction:

- Feature checks: evaluator-owned decimal and boundary cases.
- Regression checks: the upstream focused sanitizer unit tests, build, and typecheck.

Qualification should require all essential feature requirements plus the selected regressions. The UI should show each bucket separately so “feature incomplete” is not confused with “regression introduced” or “environment failed.”

### 4. Keep explicit delivery constraints separate

The H3 prompt visibly requires focused files, meaningful commits, a clean tree, and no unrelated/dependency/generated changes. Those are legitimate deterministic delivery checks because they are part of the task contract. Keep them, but do not mix them into the behavioral assertion:

- `behavior.*`: public observable semantics;
- `regression.*`: build/typecheck/upstream focused tests;
- `delivery.*`: allowed changed-file scope, requested commit count, clean tree; and
- `infrastructure.*`: fixture integrity, patch application, test execution, timeout.

This separation also fixes misleading details: every failed check should name its exact failed predicate and include the observed value or command receipt.

### 5. Grade a candidate artifact in a pristine verifier workspace

For the first revision, collect the diff from the candidate's seeded base and apply it to a newly materialized pinned checkout before injecting evaluator tests. This removes trust in candidate-modified test infrastructure and makes regrading deterministic. Candidate patch failure should be a candidate result; failure to apply evaluator tests or prepare the pinned environment should be an infrastructure error eligible for rerun.

### 6. Add verifier contract tests and backtests

Before promoting the revised case:

1. **Base/negative:** the seeded checkout must fail the feature suite.
2. **Reference/positive:** a minimal known-good fix must pass every essential feature and regression check.
3. **Alternative valid patches:** at least three behaviorally equivalent solutions should pass, including different decimal test literals and a reasonable implementation shape that does not contain our preferred source string.
4. **Near misses:** integer-range-only, numeric-number-only, numeric-string-only, and regression-breaking patches must fail the appropriate named requirement.
5. **Anti-gaming:** candidate edits to tests, package scripts, or runner configuration must not suppress evaluator-owned tests.
6. **Determinism:** repeat reference, base, and representative near-miss grading three times.
7. **Agent backtest:** replay existing H3 attempts plus several fresh frontier attempts; review every verifier/judge disagreement and revise the case before promotion.

### 7. Preserve two independent grades

DeepSWE informs only the verifiable-substance side. Relayer Eval should continue to score graph presentation separately with the recursive screenshot-grounded judge. A behaviorally correct patch can still produce a useless graph, and an excellent graph can accurately explain a failed implementation. Neither grade should overwrite the other.

## Suggested implementation sequence

1. Introduce structured `behavior`, `regression`, `delivery`, and `infrastructure` check results without changing the run UI contract.
2. Replace H3 lexical checks with an evaluator-owned table-driven behavioral test.
3. Add base/reference/alternative/near-miss verifier contract tests.
4. Move grading into a pristine patch-applied workspace.
5. Surface exact per-check receipts and separate infrastructure errors in the run explorer.
6. Backtest old and new verifier verdicts against completed H3 artifacts and human review.
7. Only then update the case's qualification result and use the pattern as the template for the remaining coding cases.

This order fixes the demonstrated false negative first, then hardens isolation and observability without blocking the immediate correction.
