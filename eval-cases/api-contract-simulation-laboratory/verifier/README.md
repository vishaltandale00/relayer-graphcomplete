# API Contract Simulation Laboratory verifier admission

This ledger records admission evidence for the candidate verifier from GitHub Issue #278. It is evidence about the reviewed source snapshot, not a second verifier or a suite manifest.

## Public seam and snapshot

- Case: `capability.greenfield.api-contract-simulation-laboratory`
- Verifier source identity: `sha256:7f673face611a7b712b5d27a189c1ef6b50b57ef379502fbc6a26a6c7913744e`
- Qualification environment identity: `sha256:555071358361bf0a1019b3d09aa6c587e853c150767d760d647b314276025f0c`
- Frozen fixture and all five autonomous-case artifacts are content-addressed in the immutable case snapshot.
- Candidate behavior is observed only through its declared Node process and loopback HTTP interface. The verifier does not import candidate internals, inspect candidate source text, match a reference patch, or require a privileged implementation structure.
- Qualification applies only the committed candidate diff to a freshly materialized seed. Node permissions confine filesystem reads and writes to that pristine workspace and deny child processes; Seatbelt independently denies outbound network and out-of-workspace writes.

## Checkpoint mapping

| Product promise or boundary | Independent deterministic checks |
| --- | --- |
| Contract import and directional malformed-document rejection | `workspace:contract-import`, `workspace:response-validation` |
| Deterministic routing across compiled and interpreted designs | `workspace:mock-routing`, `workspace:property-contract` |
| Path, header, query, and JSON-body validation | `workspace:request-validation`, `workspace:property-contract` |
| Declared response examples and operation identity | `workspace:response-validation`, `workspace:mock-routing`, successful-route identity assertions |
| Latency and ordered resettable failures | `workspace:latency-injection`, `workspace:failure-injection` |
| Bounded redirect and streaming behavior | `workspace:bounded-redirect`, `workspace:bounded-streaming` |
| Removed, newly required, and additive revision changes | `workspace:revision-comparison`, `workspace:compatibility-report` |
| Request-to-trace causality and replay | `workspace:causal-trace`, `workspace:deterministic-replay` |
| Builtins-only runtime and authority | `workspace:runtime-contract`, `workspace:artifact-scope`, sandbox launch mutants |
| Frozen contracts and scoped delivery | `workspace:protected-contracts`, `workspace:delivery-commit`, `workspace:delivery-clean` |

## Admission portfolio

- Untouched baseline: all 13 public behavior checks are red and the delivery-commit predicate is red.
- Green solution A: a functional interpreter/compiler implementation passes the public verifier and committed pristine-workspace qualification.
- Green solution B: an independently structured class-based implementation passes the same boundaries.
- Boundary/property coverage: evaluator-derived inventory revisions, runtime-random valid/failure/revision path challenges, invalid request and scenario matrices, exact examples and failure bodies, relative latency bounds, redirect and chunked-stream assertions, inclusive/middle/open-ended replay ranges, internal/broken/escaping symlinks, and exact environment preflight.
- Adversarial mutants rejected independently: missing request or response validation, absent latency or failures, shallow compatibility, nondeterministic replay, frozen-contract-only logic, inactive revision selection, fabricated or fixed-probe trace evidence, wrong failure body, redirect, response example, or stream transport, invalid-scenario acceptance, selective operation headers, protected-contract substitution, uncommitted delivery, absolute runtime entries, npm lifecycle hooks, dependency/generated artifacts, shell execution, packages beside the pinned Node runtime, and globally installed packages.
- The default portfolio is deterministic and inference-free; it uses no external service or paid inference.

## Independent review assertion

- Reviewer: adversarial subagent `api_lab_adversary` (non-PR review, non-certifying as durable external attestation).
- Reviewed commit before this ledger-only amendment: `329dee3bf23a1d19ecff80bf9932e623c988a1de`, based on `origin/main` commit `9a6a6c92ad8fd7042241c225a84017368d6d80d0`.
- Reviewed scope: the 11 case source, service integration, focused tests and fixtures, sealed reference, README, architecture, and PRD files in the PR diff. This ledger is excluded from that executable/docs manifest.
- Sorted `sha256  path` manifest digest: `1ea752a918275259af2c916fbfcecca4d2d66f3951aaa2418133bef035872a10`.
- Review command: `npm exec vitest run -- packages/eval-runner/test/api-contract-simulation-laboratory.test.ts test/eval-service-simulated-user.test.mjs`.
- Review result: 2 files and 28 tests passed; both commit-range and working-tree `git diff --check` passed.
- Verdict: certifying for verifier admission, with no unresolved P0, P1, or P2 findings. The reviewer additionally reproduced denial of a post-launch symlink escape under the pinned Node permission model.

Any change to the reviewed 11-file source scope invalidates this assertion and requires a new manifest and review.
