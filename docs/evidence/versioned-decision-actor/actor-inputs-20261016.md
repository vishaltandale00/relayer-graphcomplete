# Versioned input selection and delivery correction

The user explicitly requested fixing selection failures and pre-Send stopping,
then rerunning both actors on the same multi-turn case. PRD §13.2.3 records that
direction. Historical actor definitions and results remain immutable.

## Changed executable seams and checkpoints

| Checkpoint | Production seams | Smallest deterministic proof |
| --- | --- | --- |
| INP-001: Opt-in identity and historical isolation | Actor prompt v10, behavior v7, observation v4, Decisions v2; registry normalization/catalog and editor publication | `eval-actor-inputs.test.mjs` publishes/reopens a new revision with injected fixture feedback and verifies the prior/default revision; existing registry tests retain historical contracts; `test:eval-web` input revision chapter observes editor staging, feedback publication and old/default isolation |
| INP-002: Only observable list choices | Browser observation and exact option authority | Warm geometry fixture tests exercise filtering/signature state; `test:eval-actor-inputs` uses actual Chromium native lists in the production workspace for painting, partial overlays, ancestor clipping, disabled/group/duplicate names and legacy isolation |
| INP-003: Selecting two choices preserves both; correction preserves others | Browser select/deselect dispatch, pinned action validation, Decisions enumeration | Warm action-schema and tuple tests; real browser additive selection/deselection with normal input/change events |
| INP-004: Stale selections grant no write | Browser element, presentation, selected-state and multiple/size mode signature checks | Real browser mutation of selected state, presentation, same-element single/multiple mode and exact element replacement rejects before dispatch |
| INP-005: Drafting and delivery stay distinct | Explicit Send accessible name, prompt guidance, Decisions v2 instructions, existing task admission | Browser fills the real composer, clicks named Send, verifies one follow-up receipt and a second accepted response; live rerun must independently establish incorporation |
| INP-006: Working perception, receipt evidence and stopping authority persist | Current-observation routing, working action schema/admission, completion evidence and participant-stop allowlists | Existing actor tests; v3/v4 live-answer evidence scenario; v7 participant-stop test; new action restricted to its pinned schema |
| INP-008: A minimum-two refusal retains the first choice as a draft | Shared compiled Node Detail change handling and existing draft/authority reset | Production runtime test uses real minimum-selection validation: A refused/no commit, ordinary refresh retains A, adding B commits once, changed boundary clears; actual browser drives the authored control with the actor controller |
| INP-007: Same provider authority, no credential expansion | Decisions configuration validation and provider resolution | v1/v2 parametrized production-provider preflight test, native route and host-only API credential transport |

The editor's explicit staging button requires ordinary motivating feedback to
publish a successor. The local comparison uses isolated experimental roots,
declared as such; it does not invent feedback or promote a product default.
The new list observation includes only enabled, unique, fully painted labels.
It preserves hidden existing selections without exposing them or granting new
selection authority. A stale observed state is rejected before dispatch.

The native and hybrid revisions share the new prompt, action schema and stopping
contract. Honest incomplete stopping remains possible. The host neither sends a
draft automatically nor hard-codes the participant's choices. Guidance is a model
behavior change, not proof that every future model will comply.

## Diagnosis and required verification

The initial inference-free Chromium probe reproduced `list:null` for a visible
multi-select and an arrow-only name in the initial Send markup. Runtime workspace
code also sets Send's accessible name later; adding the static name does not alone
explain or establish resolution of the earlier model's stopping behavior.
The versioned prompt and selector guidance explicitly separate stages from delivery.

The first three warm regression assertions failed against the old implementation.
After implementation, the focused actor/registry/provider/input files passed 184
tests in 4.95 seconds before the final registry compatibility guard. A final run
is recorded below. The original minimal browser probe then passed.

Development of the larger browser fixture exposed preparation mistakes: missing
provider admission, an omitted presentation timestamp and an unavailable default
model. A concurrent build also temporarily removed compiled packages. Those setup
failures do not prove a production input regression or a passing browser scenario.
Final browser evidence uses explicit fixture provider admission and a validated
model route, with no model inference.

Required handoff: focused warm tests, `npm run build`, `npm run check`,
`npm run test:eval-compiled-runtime`, `npm run test:eval-actor-inputs`, and the full
`npm run test:eval-web` entry point. The dedicated input proof is also included
before the existing native actor journey in the browser runner. Existing tests
and their historical failures remain intact. No test was retired.

Live proof is separate: one native-first pair on the earlier fictional deployment
case, the same candidate harness/model/effort, four-response cap, sixty actions,
fifteen-minute deadline, and temporal features explicitly disabled for both arms.
It must bind an actual follow-up submission and consumed input to a later accepted
rendered response. Neither typed choices nor a judge claim establishes that result.
Every model failure or incomplete stop remains an outcome; no failed trajectory
is silently retried.

The first new-revision live pair (`20261016-multiturn-input-v10`) exposed a second production boundary. The actor could dispatch selection, but the authored form reapplied its old committed value after a minimum-two validation refusal. Native recovered via a click, sent a follow-up and received a second accepted response; Decisions repeated single selections and stopped incomplete before Send. That pair is preserved with pilot source receipt `actor-inputs-pilot-source-20261016.json`. A red production-runtime regression reproduced the reset. The correction registers selection changes as local drafts using the existing text-draft refresh and input-boundary rules. It does not admit an invalid attachment or alter Send validation. No historical actor contract was rewritten.

## Results

Final source: `c119733bcec08022dd403a773bd894f75d81087d7df9aa88bb9f4e403257bb47`, 26 files, recorded in `actor-inputs-source-20261016.json`. No default was promoted. Source hashes remained unchanged after the paired rerun.

### Executed verification and evidence

- Build passed in `build-recovery-final.log`; production source was final. Subsequent changes only extended two regression-test/proof files to reset an uncommitted draft on an authority change.
- Focused actor, registry, provider, human-task and compiled-input runtime portfolio: 257 passed in `warm-recovery-verified.log`. The final runtime file separately passed all 73 tests after the boundary assertion was added (`runtime-boundary-final.log`). A preceding 77-test run also passed. Shared-host load increased these warm commands beyond the ten-second goal; the edit loop did not invoke paid inference.
- Dedicated actual-browser proof passed with final boundary assertions (`browser-boundary-final.log`). It exercised observation, additive selection/deselection, occlusion/clipping, refusal/refresh/correction, stale scope/mode/element rejection, historical isolation, explicit Send and a second accepted response.
- Full `test:eval-web` final isolated invocation passed the new editor publication/picker chapter and all new input proof, then failed in the existing native actor journey at `proveTaskActor`: actor timeout in phase `observe`; expected completed, got interrupted. Subsequent chapters were not reached. `web-isolated-final.log` preserves the failure. Earlier attempts retain a fixture error selecting a collapsed task picker and native startup timeouts; a separate startup diagnostic observed the waiting child normally. The final isolated entry point still failed, so the browser suite is not green.
- Compiled-runtime first run passed all 12 tests before the shared-form correction. The later run failed 5 with 7 passing (`compiled-recovery-final.log`): graph/app-server readiness and fifteen-second scenario timeouts. This failure remains separate from the earlier pass and does not establish the final source passing.
- Final lower-concurrency compiled-runtime retry passed all 12 tests in 35.48 seconds (`compiled-bounded-final.log`); the earlier 5-failure run remains preserved. No source changed between those runs.
- The final root check passed Rust formatting and Clippy, then failed in the app-server unit suite: 397 passed and one failed, `environment::tests::command_runner_enforces_start_timeout_and_output_bounds`. Its one-second output-bound assertion failed again in isolation. The cause is not established; no unrelated production code or timeout was changed. Remaining Rust workspace suites, graph-crash reconciliation, root build steps and the full default Vitest portfolio were not reached. There is no whole-repository pass.
- Type checking, workspace checks, secret-boundary tests (2), Python tests (99), Ladybug receipt lint and PRD readability were run separately and passed. Exact logs and hashes are in `actor-inputs-verification-20261016.json`.
- Two earlier root attempts were interrupted during Clippy after observed host memory pressure (8.6 GB swap on a 16 GB host), first to bound Rust jobs, then to also bound Vitest workers. Their incomplete runs establish no test verdict. The final command used `CARGO_BUILD_JOBS=2 VITEST_MAX_WORKERS=2 RUST_TEST_THREADS=2` with the same check portfolio.

Development failures are retained in `.relayer/verification/actor-inputs-20261016`. One focused command was mistakenly started concurrently with the package-cleaning build and failed to resolve removed compiled package entries; after the build completed, the focused portfolio passed. This was a preparation error, not scenario evidence. The new regression initially reproduced the lost selection; a Happy DOM stale `selectedOptions` cache required a fixture-only live getter. The browser fixture required an outer fixed wrapper because production compiled-detail host CSS enforces relative positioning. No test was retired. The existing mixed runtime test now distinguishes a busy refresh that preserves a draft from an acknowledged commit that applies a value; its other authority/focus/scroll assertions remain.

### Paid live evidence

[The final paired report](multiturn-input-comparison-20261016.md) separates behavior, actor inference, candidate execution, judging, usage and price proxies. Native delivered three follow-ups and received four accepted responses; Decisions delivered two and received three. Both later plans visibly incorporate the exact window, Canary and both selected signals. Native resolved the rollback-threshold concern; Decisions stopped satisfied/incomplete with that requirement explicitly unresolved. Neither typed fields nor actor/judge claims alone establish those results: accepted submission/consumption receipts and stable hash-bound final screenshots were checked.

The shorter and cheaper observed hybrid trajectory did less work and did not reach the same endpoint. One sequential pair on a shared host does not establish a causal matched-completion latency/cost win. Native dollar estimates remain API-rate proxies, not subscription invoices. Final reports preserve the failed first pilot and do not retry a stochastic outcome into success.

### Adversarial review

Reviewer `/root/review_versioned_actor` verified the exact final source digest, selection/draft/authority mapping, tests and runner; no static blocker remained. It independently audited raw metrics, cumulative native usage, per-request Decisions usage, consumed input records and both final screenshots, finding no material measurement mismatch. This review is non-certifying without a PR. The durable review receipt binds its source and report hashes; it does not turn failed heavy checks into passes.
