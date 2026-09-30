# Turn-specific harness authoring guidance

This change keeps query flow, graph structure, delegation, questions, and current
publication under agent judgment. Claude/Codex receive JavaScript references;
Prime receives Python references. Recursive instructions remain conditional on
an actual runtime completion binding. Existing authority, acceptance, lifecycle,
and immutable presentation pins are unchanged.

Claude Basic now selects V4 for newly created conversations, matching production
Codex and Prime. Existing selections are not migrated. Shared prompt improvements
can reach later executions of existing conversations after an application update.

## Changed seams and required verification

| Seam / promise | Smallest deterministic checkpoint |
| --- | --- |
| PPG-003: delivered language and agent-owned flow | Existing captured Codex/Claude/Prime prompt tests and shared presentation assertions |
| Recursion authority and observation semantics | Broker-present/absent prompt cases; fixed watch membership and structured child failures remain explicit |
| Accurate authoring and control binding | New executable JS/Python examples compiled through the real client compiler and Prime bridge; source-node/layer provenance asserted |
| Python API drift | Existing introspection test validates reference methods, async declarations, and keyword names against the real Python client |
| Questions do not imply live answer delivery | Delivered guidance names finalized presenting response, next Send, fixed input snapshot, and no new authority |
| PPG-002: new-thread presentation selection | Existing configuration test includes Claude V4; unchanged generic pinning/recovery suites run in aggregate |
| PPG-007: publication integrity | Existing temporal-current tests run in aggregate; no current or acceptance implementation changes |

Required assembled checks: `npm run check` and `npm run build`. No tests are
removed. Existing phrase assertions changed only where they prescribed the old
watch-loop workflow; new assertions cover agent choice and fixed watch membership.

## Verification of initial reference revision (ca13cb3f)

- Focused provider/configuration/reference suite: 5 files, 186 tests passed.
- Both new executable examples initially failed the canonical accessibility check;
  the textarea hosts now carry an authored accessible name and both tests pass.
- PRD readability: passed.
- First full check: Rust/type/build stages passed; Vitest reported 237 files
  passed, one skipped, two failed (3,171 tests passed, three skipped, three failed).
  The failures were the packaged-module inventory and two Prime integration cases
  that assumed the first prompt example was a whole response. Both seams were
  repaired; the focused two-file integration/inventory run passed all three tests.
  The fixture continues to exercise current advancement before final submission.
- Final `npm run check`: passed in one invocation. Vitest: 239 files passed,
  one skipped; 3,174 tests passed, three skipped. Codex secret-boundary tests:
  two passed. Python: all 60 passed. Rust formatting, Clippy, workspace/crash
  tests, TypeScript checks, package builds, receipt lints, and PRD readability
  all passed.
- Final `npm run build`: passed after the aggregate check.
- Final reviewed executable digest matches the reviewed source below. Log digests
  and command outcomes are recorded in `validation.json`.

The existing trusted native build outputs from this worktree are reused. No cold
build or worker provisioning was needed for this prompt-only revision. Earlier
initial setup rejected an incompatible Ladybug cache (Cargo.lock mismatch) and
built from source; no mismatched artifact was admitted.

## Adversarial review of initial reference revision

Reviewer `/root/reference_review` reviewed the thirteen changed executable/config/test/inventory
files: Claude configuration; Codex, Prime, shared presentation and authoring
reference implementations; Codex, Prime, configuration, authoring-reference and
shared presentation-assertion tests; sealed telemetry module inventory; and the
Prime product integration test and its fixture. SHA-256 over sorted path + NUL + bytes + NUL:
`5617c52da0286f9f108f463c849f09bd24a5c5bebbd046b0cf9c31bf9338340a`.

Verdict: no unresolved executable blockers. Review found that a watch snapshots
its child set, so later appended children would not be observed by the original
watch. Guidance now explains separate watches for newly launched children, and
captured-prompt tests assert that boundary. The second review retained the
fixture-owned nonterminal advance before final submission while removing the
full-response recipe from model guidance. Review was read-only and did not
independently execute tests. It certifies neither live adoption nor latency and
must be invalidated if the reviewed executable state changes.

## Historical investigation and live evidence

`investigation-plan.md` and `authoring-design.md` capture the earlier design
investigation; their no-implementation statements describe that stage, not this PR.
`live-gate-2026-09-29.json` preserves the earlier authorized live gate's sanitized
source/runtime identities and observations. That gate predates this reference
revision and is baseline evidence only:

| Harness / model | First graph | Nonterminal current | Outcome |
| --- | --- | --- | --- |
| Codex / GPT-6 Sol | None | None | Account rejected model at 3.163 s |
| Codex / GPT-5.6 Sol | 404.956 s | None | Accepted at 407.795 s |
| Prime / Qwen3.8 Max Prime | None within 600 s | None | Stopped at 600.502 s |

These timings observe the root current projection with a 250 ms poll, not renderer
latency. Neither model created semantic children. Codex's model trace is complete;
Prime's is truncated at 10 MiB. Both independent graph-operation records are
complete. Draft authoring and compiler repairs occurred before publication.

The initial reference revision did not establish visual acceptance, significant
speedup, or a fix for the reported single-node symptom. Matched natural-query live
trials and actual one-node examples remain necessary. Question-source response
linkage and same-completion answer delivery are separate work, not implemented here.


## Follow-up: precise controls and small authoring increments

The candidate Codex live run at `ca13cb3f` published its first current graph at
597.510 seconds, compared with the historical 404.956-second baseline. This is
one trial, not a general regression estimate. The graph-operation record was
complete; the native trace export was partial when the ten-minute timeout raced
with accepted product state. Four bulk authoring attempts failed before the fifth
succeeded: nested templates, nonexistent `detailCapability.navigate`, nonexistent
`detailCapability.text`, and a missing binding-key argument to `expand`.

The follow-up changes only the per-turn authoring reference and its tests. Exact
control signatures and independent navigation snippets accompany the existing
visual/question examples. Both language references instruct small checkpoints
and targeted repairs. Query flow, delegation, publication timing, accepted-record
immutability, compiler behavior, and execution transport remain unchanged.

Changed executable seams/checkpoints:

- PPG-003 API delivery: captured-provider assertions observe JS control signatures
  for Codex/Claude and Python signatures for Prime, alongside small-increment
  advice that explicitly preserves query-flow and publication choices.
- PPG-003 navigation binding: the delivered JS and Python snippets compile through
  the owning canonical compiler/Prime bridge; tests assert the control kind and
  source-node/source-layer provenance in addition to the existing input boundary.
- Existing integration, temporal, and pinning checks remain required through the
  full `npm run check`, followed by `npm run build`. No test was removed.

The original revision's test counts and review digest above remain historical.
This follow-up requires its own exact-source validation and review. It has not
been live-tested and makes no latency-improvement claim.


Follow-up adversarial reviewer `/root/guidance_repair_review`: PASS with no
unresolved blockers. Reviewed exact JS/Python APIs, navigation examples,
checkpoint/repair advice, and authority boundaries; independently ran both
compiler-example tests (2 passed). Sorted path + NUL + bytes + NUL SHA-256 for
`graph-authoring-reference.ts`, `graph-authoring-reference.test.ts`, and
`graph-presentation-guidance-assertions.ts` under `packages/harness-host`:
`d9dd1e76c33f7cd667d5e2cb0adeac65d42f894f536775dfe6e9fa28d3df0e4b`.
This reviews compilation and guidance only, not accepted navigation or live
performance. Invalidate after any change to those files.


Follow-up verification passed: focused provider/reference suite 132 tests;
`npm run check` completed with 239 Vitest files passed and one skipped (3,174
passed, three skipped), two Codex secret-boundary tests, all 60 Python tests,
Rust/type/build chapters, receipt lints, and PRD readability. `npm run build`
passed afterward. Log hashes are in `guidance-repair-validation.json`.
