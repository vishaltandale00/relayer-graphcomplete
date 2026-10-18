# Optional versioned Decisions actor

Product authority: PRD §13.2.3–13.2.4, including the user's 2026-10-15 decision to
try OpenAI Decisions first with the existing Codex text actor. ADR 0003's
production-workspace observation and ADR 0016's live-answer authority remain in
force. This is an optional execution contract on an ordinary immutable actor
revision, not another candidate harness or graph scheduler.

## Executable seams and checkpoints

| Checkpoint | Changed production seams | Smallest deterministic proof |
| --- | --- | --- |
| DEC-001: Explicit, immutable execution identity | `actorConfiguration`, registry normalization, task pinning/reopen/export | `eval-setup-registry.test.mjs`: Decisions revision, switch back, original records/default unchanged, unsupported contract rejection |
| DEC-002: Concrete offered operation | `decision-task-actor.mjs` choice enumeration and reply generation | `eval-decision-task-actor.test.mjs`: observed menu labels, narrowed phase/actions, unknown/refused choices, generated target substitution |
| DEC-003: Chronological experience and bounded requests | Decisions history, working comments, image/choice limits | adapter journey across settled/working views; singleton watch, explicit screenshot omissions, oversized choice rejection |
| DEC-004: Both routes ready before candidate work | Eval production runtime wiring and provider resolver; official endpoint, exact provider/model and host-only credential closure | `eval-provider-setup.test.mjs`: both routes, missing connection/text runtime, safe response projection; registry real service preflight rejects before `tasks.create` |
| DEC-005: Product authority and stopping preserved | Existing browser/session validation, finish correction, separate completion judge, subscription-only task guard | registry Decisions journey preserves rejected contradictory finish and fresh decision; preflight/subscription test; unchanged `eval-task-actor.test.mjs` and `eval-task-actor-errors.test.mjs` authority/recovery coverage |
| DEC-006: Explicit user selection and inference disclosure | Dashboard connected-provider projection; setup editor engine/connection publication; task picker/detail and start notice | Decisions chapter of `npm run test:eval-web`: publish with real fixture feedback, select without promotion, real graph navigation and constrained finish, reopen/export, original run preserved |
| DEC-007: No automatic promotion or lineage bypass | Existing setup publication, promotion and release selection | existing registry/release/calibration tests plus optional revision journey; browser chapter retains explicit promotion of native revision |

Browser controls still expose the established names/roles and opened-menu labels.
The selector offers control operations using those observations; browser checks
remain authoritative for actual executability and freshness. A control's role
does not certify that every offered operation will dispatch successfully.

The adapter records the offered tuple manifest, selected tuple, request digest,
execution identity and sanitized usage with its action or working reaction.
Action completion/failure events remain separate. A request digest is not a full
raw provider response or proof of successful execution. History contains prior
observations and intents, not invented dispatch results. Older screenshots beyond
127 are explicit omissions; their prior textual observations and intents remain.
Observations over 255 choices fail explicitly rather than silently reducing the
candidate set. Model refusals and malformed answers do not trigger fallback or
replay. All these policies belong to execution contract
`openai-decisions-codex-text-v1`; incompatible changes require a new contract.

## Required verification plan

- Warm loop: focused adapter, setup-registry, provider-setup, actor and actor-error
  Vitest tests, with injected inference only.
- Handoff: `npm run check`, `npm run build`,
  `npm run test:eval-compiled-runtime`, and `npm run test:eval-web` (the existing
  browser runner has no chapter-only selector, so run the full entry point).
- Adversarial review of execution identity, product/authority mapping and evidence.
  No tests were deleted or replaced; existing lifecycle tests protect different
  boundaries from the new execution-adapter tests.
- Live model adaptation, cost, latency and realism remain unproved. No paid/API
  inference is part of deterministic verification. External tasks with
  subscription-only authorization reject this API-backed revision.

## Execution record

Dependency preparation used `npm ci --cache /Volumes/2T-SSD/npm-cache
--ignore-scripts`; package compilation completed. The local verified Ladybug
workflow rejected `/Volumes/2T-SSD/relayer-build-cache/model-family-ladybug`
because its Cargo.lock digest differs from this checkout. Its archive was not
adopted. Cargo uses the existing local target cache and its normal source/input
fingerprinting; this is acceleration, not cached test evidence. No compatible
sealed runtime bundle was found locally.

Initial focused verification passed 105 existing actor/registry/provider tests;
the first six adapter tests also passed. During development, a new provider test
incorrectly tried to spy on the frozen provider facade, and an existing error
test detected a changed message prefix. Both were corrected before final
verification. The first compiled-runtime invocation could not collect tests
because root `dist/index.js` had not been built; it is not a scenario pass.

## Observed results

Source snapshot: `dedd1cc66f3d41a06250a6c9274b16f79cace9184a5df83c7b572f79f958d5d2`.
`source-snapshot.json` records the exact 15 executable/test/PRD files, their
individual hashes, the digest method and the base commit. Evidence-result files
are excluded from this digest.

| Entry point | Observed result |
| --- | --- |
| Focused actor/registry/provider/error tests | 125 passed before the final native-dispatch compatibility test; the final adapter file separately passed all 8 tests, including that added check. No changed production source followed these runs. |
| `npm run build` | Passed, including a second build at the final source snapshot. |
| `npm run test:eval-compiled-runtime` | Final run passed all 12 scenarios. An earlier built-source run passed 11 and hit one graph-server startup timeout; the final pass does not erase that failure. |
| Root TypeScript and workspace checks | Passed; includes the visual-assets built-package smoke test. |
| PRD readability | Passed after splitting two overlong new sentences. |
| Python client tests | 99 passed. |
| `npm run test:codex-secret-boundary` | 2 passed. |
| `npm run lint:ladybug-receipt` | Passed, including native and contract receipt checks. |
| `npm run check` | Failed in unchanged Rust environment tests. First run: 395 passed, 3 repository/Git snapshot failures. With `RUST_TEST_THREADS=2`: 397 passed, 1 command-runner output-bound failure. The isolated repository-identity test passed; the isolated output-bound test still failed. The cause of the output-bound failure is unresolved. |
| `npm run test:eval-web` | The new independent Decisions chapter passed every assertion: UI publication and selection without promotion, real graph navigation, constrained stopping, reopened/exported revision, and original revision preserved. The later existing native actor journey still failed while observing after Invoke. The whole runner failed; later chapters were not reached. |
| Full Vitest portfolio | Passed with `--maxWorkers=3`: 328 files passed, 1 skipped; 4,356 tests passed, 3 skipped (4359 total). The new adapter/registry/provider tests passed in this final portfolio. An earlier broad invocation was interrupted to avoid competing with browser proof; it provides no pass claim. |

`verification-observations.txt` retains the compact Rust failures and the browser
chapter results, including the later actor interruption. Native suites or browser
chapters skipped after these failures remain unproved by these commands. The
changed execution seams have focused coverage and the new browser chapter's own
pass; this is not a claim that the full required portfolio passed.

The browser experiment was moved into an independent chapter before the existing
native actor journey after that journey repeatedly stopped before reaching it.
The original journey and its assertions remain intact. No prior test was retired
or weakened, and its failure remains visible.

## Adversarial review

Reviewer `/root/review_versioned_actor` inspected the exact snapshot above, all
changed execution and authority seams, the checkpoint mapping, and the browser
chapter relocation. Verdict: no blocking static findings; no test deletion or
weakened subsumption claim. The acknowledged control-capability limitation remains
nonblocking. This review is non-certifying without a PR and does not certify the
root agent's test runs. Any change to the included source invalidates it. Live
model adaptation, calibration, cost and latency remain unproved.

## Trying the revision

Restart Eval after building. Connect the OpenAI API provider in Eval Settings and
retain the existing connected Codex text runtime. In Setup revisions, choose an
actor predecessor, select OpenAI Decisions and its API connection, select genuine
motivating feedback, and publish. Select the new revision for a new session;
select the prior native revision to switch back. Publication and this code change
promote no default, run no live inference and rewrite no historical record.

## Bounded live follow-up — 2026-10-16

The user authorized a paired live comparison after implementation verification.
[The pilot report](live-comparison-20261016.md) and
[metrics](live-comparison-20261016.json) preserve one native/Decisions pair,
including rejected finish evidence, timings, cumulative native usage accounting,
API pricing estimate, and the initial pre-inference authentication failure.
It exercises traversal and stopping against a deterministic candidate fixture.
It does not establish general realism, adaptive-candidate behavior, working-update
perception, total dollar savings, or a statistically reliable latency difference.
The earlier deterministic verification failures remain unresolved.

A [second pair with a live Codex candidate](adaptive-comparison-20261016.md)
reused those exact actor revisions and observed working comments and navigation.
Its [metrics](adaptive-comparison-20261016.json) separate candidate, simulator,
selector, text and judge usage. No fills or live answers occurred in this pair;
its lower hybrid wall time is confounded by faster candidate execution.

The user then requested a navigation-heavy comparison. Its [report](navigation-comparison-20261016.md)
and [metrics](navigation-comparison-20261016.json) preserve native 12/12 versus
hybrid 8/12 observed-card coverage. Decisions selected the shared ten navigation
operations faster, but had no standard API-rate cost-proxy advantage and did not
finish the full task. The [judge navigation design](judge-navigation-design.md)
separates constrained selection, existing host tool execution and semantic
assessment; it also considers prescribed required-evidence traversal. No judge
implementation, rubric, actor revision or default changed.

The subsequent [response-budget correction and verification record](budget-recovery-20261016.md)
uses a new source receipt. It separates navigation recovery on the frozen graph
from ordinary multi-turn deployment interactions. Historical verification claims
above apply only to their recorded source snapshot.
Its [frozen navigation rerun](navigation-recovery-20261016.md) demonstrates recovery
but preserves an incomplete hybrid stop. The separate
[multi-turn attempt](multiturn-comparison-20261016.md) ended before a follow-up was
sent in both arms; successful multi-turn incorporation remains unproved.

The [input and Send correction](actor-inputs-20261016.md) subsequently established
multi-turn delivery, while preserving an unfinished voluntary hybrid stop.
The separate [judge-gated endpoint benchmark](endpoint-benchmark-20261016.md)
adds an optional v11/v8 revision and its own source receipts. In its
[paired rerun](endpoint-benchmark-comparison-20261016.md), both actors obtained
judge approval and Decisions recovered from an incomplete judgment. That single
pair showed higher hybrid task time and cost proxy; the report preserves the
different paths, categorical rollback conditions, judging limits and capture
qualifications rather than treating approval as deterministic endpoint equality.
