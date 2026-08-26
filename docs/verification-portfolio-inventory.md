# Current verification portfolio inventory

Snapshot: commit `13484ea5706578e60c46757a6de78f7a0f306228` on 2026-08-26, macOS arm64, Node 22.23.2, npm 10.9.8. This is a planning artifact for [Inventory the current verification portfolio and its product responsibilities](https://github.com/vishaltandale00/relayer-graphcomplete/issues/180). It records what the checkout proves today; it does not propose test deletion or consolidation.

## How this inventory was produced

- Read `AGENTS.md`, `README.md`, `docs/architecture.md`, all accepted ADRs, `docs/agents/issue-tracker.md`, and the PRD. `AGENTS.md` names `CONTEXT-MAP.md`, but that file is absent at this commit.
- Used the repository's own discovery boundaries: `cargo test --workspace -- --list`, `vitest list --json`, Python `unittest discover`, root and workspace package scripts, GitHub Actions workflows, Electron scripts, release scripts, and committed PRD evidence.
- Ran only deterministic, local commands. No live inference, signing, publishing, promotion, or hosted canary was attempted.
- Treated a test's implementation and dependencies as authoritative. Names such as “UI,” “integration,” and “end to end” are not fidelity claims by themselves.

For this snapshot, the map's fidelity vocabulary is useful:

- T0: pure/model/static checks.
- T1: in-process component or storage tests.
- T2: deterministic cross-process tests using real local services.
- T3: Electron desktop flows.
- T4: packaged, signed, or platform acceptance.
- T5: metered model or human evaluation.

Cadence is separate from fidelity. “PR” below means the required `CI` workflow; “manual” means an available command or `workflow_dispatch`; “historical” means committed evidence with no automatic freshness gate.

## Discovery and measured execution

| Surface | Discovered | Measured result on this snapshot | What the measurement means |
|---|---:|---|---|
| Rust workspace | 215 tests across app server, graph core/server, and six integration-test binaries | Passed. Cold `cargo test --workspace`: 37.94 s wall, including 25.38 s compilation. Test bodies then reported about 8.8 s in aggregate. | The cold number is setup-sensitive. It is not a stable regression baseline without matched environment and cache state. |
| Vitest | 593 tests in 71 files: 390 root, 142 harness-host, 49 eval-runner, 12 graph-client | Passed after required package and Rust binary builds. Warm run: 5.26 s wall. | Raw `vitest run` is not clean-checkout self-contained. Before package builds, discovery failed on workspace exports; before Rust builds, seven tests failed because server binaries were absent. |
| Python client | 16 tests in one file | Passed in 0.69 s wall. | In-process mocked transport/object tests only; they do not provide the PRD's requested shared real-server cross-language conformance. |
| PRD readability | One custom static checker | Passed in 0.18 s wall. | Proves only the 25-word sentence rule implemented by `docs/prd/check-readability.mjs`, not PRD completeness, identity integrity, or evidence freshness. |
| Canonical default gate | `npm run check` | Passed in 40.27 s wall after dependencies were installed; the first clippy pass compiled for 12.24 s. | Includes format, clippy, all Rust tests, required Rust/package builds, TypeScript checks, Vitest, Python, and PRD readability. It does not run Electron smokes, deterministic eval CLI, packaging, live evals, or release canaries. |
| Deterministic runtime eval | One two-turn case × one fixture harness | Passed in 4.07 s wall including a warm build; emitted a passing immutable runtime artifact under `.relayer/evals/runtime/`. | Proves two accepted interactions, distinct capabilities, one reused harness object, fixture facts, saved result, and viewer through a real graph server/Node host. It does not use the app server, Electron, a provider, project grounding, or human judgment. |
| Electron first-message smoke | One broad fixture-driven script | Internally failed at Back restoring the selected root node after 21.24 s, but the command returned status 0. | It exercised substantial T3 setup before failure and wrote screenshots, but this run is not passing evidence. Exit status currently cannot gate the asserted flow reliably. |
| Electron approval smoke | One fixture-driven script | Internally failed because the waiting presentation text was incomplete after 7.20 s, but the command returned status 0. | It reached the real Electron approval surface with zero inference, but this run is not passing evidence. Exit status currently cannot gate the asserted flow reliably. |

`npm ci` took 5.36 s and installed 448 packages. That setup time is reported separately from verification. The measurements are one-off observations, not statistically defensible budgets; [Research variance-aware verification-runtime and flake regression gates](https://github.com/vishaltandale00/relayer-graphcomplete/issues/181) owns the baseline and regression policy.

## Automated portfolio by responsibility

| Verification owner and examples | Actual proof | Tier | Current cadence | Important non-proof |
|---|---|---|---|---|
| Graph core: `crates/relayer-graph-core` (60 unit/integration tests) | SQLite-backed graph identity, visibility, layouts, typed navigation, draft/accepted/stopped states, stable-key replay, atomic submission, leases, migrations, concurrency, and restart reads. | T1 | PR via `npm run check` | No renderer, product lifecycle, provider execution, or cross-language equivalence. No property-test framework was discovered despite the PRD using “property” language. |
| Graph server: `crates/relayer-graph-server` (15 tests) | Loopback API authority, control/capability tokens, context preparation, staged import, action/layer request behavior, and parent-control-pipe lifecycle. | T1/T2 | PR | Does not prove packaged sandbox reachability or every wrong-scope/expired-session HTTP combination named by the PRD. |
| App server: `crates/relayer-app-server` (140 tests) | Product persistence, projects and Git environment inspection, catalogs/model selection, permissions, approvals, imports/exports, interaction context, invoke lifecycle, restart reconciliation, and runtime authority boundaries. Several integration binaries start real local processes/storage. | T1/T2 | PR | Does not prove the visible desktop choices, platform keychain, live provider, or signed artifact. Names describing “flow” generally prove HTTP/storage contracts, not a user flow. |
| TypeScript graph client: `packages/graph-client/test` (12 tests) | Object composition, IDs, layouts, actions, aliases, and error propagation around a stubbed transport. | T0/T1 | PR | The real Rust path is exercised elsewhere, not as an exhaustive shared conformance suite. |
| Python graph client: `python/relayer-graph/tests` (16 tests) | Object composition, current Prime host scope, request shapes, validation/error mapping, and icon vocabulary with mocked HTTP. | T0/T1 | PR | No real-server or TypeScript-equivalence run. This is a direct gap against PRD section 11.7 and section 16. |
| Harness host: `packages/harness-host/test` (142 tests) | Configuration, host/session lifecycle, approval coordination, Codex app-server translation, Codex graph-tool prompts/contracts, Prime run-context adapter, resume state, cancellation, redaction, and serialization. | T0/T1 | PR | Fake SDKs/providers and adapters do not prove provider authentication, live model behavior, clean-install Prime packaging, or recursive output quality. |
| Eval runner: `packages/eval-runner/test` (49 tests) | Case expansion, deterministic checks, H3 fixture/materialization/grading contracts, simulated-user rubric/evidence/review state, MCP tool surface, and portions of real-server runtime execution. | T0-T2 | PR | Most tests prove the evaluator's rules, not that a candidate actually satisfies them. H3 workspace graders are stubbed in the product-service integration test. |
| Root Vitest suite: `test/` (390 tests in 52 files) | A mixed portfolio: pure renderer/state/release models, source/markup assertions, real Rust-process product/Eval flows, import/export persistence, and deterministic graph-authoring replay. | T0-T2 | PR | `vitest.config.js` uses Node, not a browser. Many “UI” and “navigation integration” tests use strings, fake DOM objects, mocked requests, or source inspection; they do not prove pixels, browser accessibility, pointer behavior, or Electron wiring. |
| Deterministic eval CLI: `npm run eval:basic` | Real graph server + Node host + TypeScript client, two interactions, fixture harness, deterministic fact/topology checks, capability revocation, harness reuse, and saved JSON/HTML. | T2 | Manual | Not in `npm run check` or CI. It bypasses the product app server and production renderer. |
| Electron scripts: `test-desktop-first-message.mjs`, `test-desktop-approval.mjs` | Real Electron plus isolated product/graph services and fixture harness; assertions cover composer, acceptance/rendering, navigation/history/Eval, invoke, and approval presentation. | T3 | Manual | Both observed assertion failures returned status 0. They are broad scripts with no per-obligation result record and currently cannot be authoritative gates. They are not packaged or signed runs. |
| Opt-in capture scripts | Real Electron fixture flows for model selection, environment rail, graph repair, interaction context, conversation import/export, annotations, and tutorial. They can save screenshots/video/manifests. | T3 | Manual/historical | A capture proves only its scripted fixture and recorded requirements. Most use `fixture-task-system` or register that fixture under another implementation key; they do not prove live provider/model behavior. Committed media has no common freshness enforcement. |
| Live eval commands | `eval:basic:live` and `eval:graph-repair:live` can exercise named supported configurations and optional structured judging. Historical PRD evidence records prior Codex/Prime runs. | T5 | Opt-in/manual | Excluded from defaults; current provider availability, cost, variance, and reproducibility were not re-run. Historical “passed” is not current attestation. |
| Release scripts and workflows | Deterministic unit tests validate artifact names, receipts, hashes, IAM plans, pointer monotonicity, canary evidence grammar, and target contracts. Signed workflows build/notarize macOS candidates; native canaries install and update them; promotion reuses exact bytes. | T0/T4 | PR for model tests; tag/manual for real release | Release-model tests do not sign, notarize, install, update, or contact storage. Windows job is explicitly disabled. Manual signed candidates do not publish unless tag-authorized. |
| Human evidence | PRD embeds screenshots, videos, JSON receipts, JSONL traces, and explanatory checkpoints; Eval supports screenshot-grounded human/simulated review. | T3-T5 | Historical/manual | Repository has 123 evidence files (21 MB): 78 PNG, 26 JSON, 6 JSONL, 5 MP4, 5 Markdown, 3 JPG. There is no single machine-readable inventory linking every asset to PRD identity, source commit, environment, expiry, and authoritative obligation. |

## CI and cadence inventory

| Workflow | Trigger | What it gates | What it does not gate |
|---|---|---|---|
| `CI` | Pull request and push to `main` on Ubuntu | `npm ci`, `npm run check`, then `npm run build` | Electron T3, deterministic eval CLI as a named case, packaging, macOS/Windows behavior, live providers/judges, evidence freshness, runtime/flake budgets, or coverage thresholds. |
| `Desktop Signed Preview Candidates` | Manual or `desktop-v*` tag | Source authority, default checks, macOS arm64/x64 signing/notarization/package evidence. Tag runs may publish exact artifacts and Preview pointer. | Windows job is disabled. A manual run never updates the feed. It does not prove installation/update; canaries are separate. |
| Apple Silicon and Intel Preview canaries | Manual | Downloads exact seed/target/receipt, performs native DMG first install and Preview update, captures screenshots/logs, emits sealed canary evidence. | Not required on ordinary changes. Evidence retention is 90 days in Actions; long-lived truth depends on committed artifacts. |
| Stable promotion | Manual, protected environment | Validates committed canary evidence and exact Preview bytes, then conditionally moves the target Stable pointer and saves a receipt. | Does not rebuild/re-sign or itself interactively use the product. Windows remains blocked. |

There is no scheduled verification workflow. No discovered gate measures code coverage, mutation/fault score, flaky-test rate, per-test duration, portfolio critical path, or PRD-to-test completeness.

## PRD capability responsibility matrix

The PRD's status tracker says zero of ten capabilities has complete end-to-end proof. That summary is consistent with the inventory, even where lower sections label individual components “Verified.”

| Product capability | Strongest current proof in this checkout | Gap before complete product proof |
|---|---|---|
| Connect an agent | Provider/catalog and credential-adapter models plus committed setup/restart screenshots. | Rejection, expiry, revocation, OS-secret boundary, current live connection, and signed authentication smoke. |
| Configure execution | Catalog/family/settings/picker model tests; one T2 first-message service flow; committed model-picker capture. | Most picker “UI” tests are markup/model checks. Need incompatible-selection presentation and a second packaged provider/harness. |
| Choose work context and permissions | Extensive Git/environment hardening, product persistence, permission profiles, request assembly, and historical no-folder evidence. | Full visible folder/project/local-checkout/new-worktree/fork/cleanup flows; actual OS dialogs and platform behavior. |
| Run a task | T2 fixture eval and service tests prove accepted graph creation/persistence; T3 scripts are intended to prove Electron first message. | Current T3 first-message run failed internally; no trustworthy exit gate, signed live-provider product flow, or provider-quality claim. |
| Control a run | Host cancellation, approval, interrupted-state, retry identity, and state models. | PRD correctly lists visible Stop/Retry product proof as open. No passing Electron stop/retry journey. |
| Inspect the result | Dense T0 renderer/camera/layout/history tests, T2 read-only Eval flows, and historical screenshots. | Current T3 history assertion failed; no restart visual replay or accessibility technology/browser proof. |
| Act on the result | Graph/API/client invoke, navigation, context, and one-shot lease contracts; T2 import/export and replay. | Current T3 invoke/history script did not finish. Human-visible context effect, full invoke lifecycle, and live harness behavior remain incomplete. |
| Return to saved work | Rust restart persistence/reconciliation and T2 service restart tests. | Visible accepted-graph restart replay, thread management, unsent draft recovery, and destructive-entry flows. |
| Evaluate a harness | Eval contracts, T2 case × harness product-service execution, read-only imports, candidate trace and simulated-user machinery, historical review evidence. | Complete content-addressed promotion/retention bundle, calibrated live comparisons, and current end-to-end human audit. |
| Manage/update desktop | Strong deterministic release model plus committed signed macOS canaries and promotion receipts. | Remaining settings/support cases, corrupt-download/deferral paths, Windows signing/install/update, and continuously fresh platform evidence. |

## Gaps, overlaps, and orphans

### Gaps

1. **No stable product-identity link.** Tests, eval checks, capture manifests, PRD rows, and release evidence use local names or prose. There is no enforced PRD scenario/obligation identity or authoritative-owner record.
2. **No cross-language conformance.** TypeScript reaches the Rust server in T2 flows; Python remains mocked. The same fixtures/errors are not compared across both clients.
3. **Desktop gates are untrustworthy today.** Both named Electron smokes printed assertion failures while returning status 0. CI does not run them, and their broad result is not decomposed into durable per-obligation attestations.
4. **Product-flow claims outrun executable evidence.** PRD section 16.1 says the default suite covers every visible event including stop, retry, context attachment, and worktrees, while section 17.4 says those product proofs are unproven. The tests support the narrower section 17.4 reading.
5. **Accessibility proof is mostly structural.** Keyboard-intent, labels, markup, and focus rules are tested, but there is no real-browser accessibility tree, assistive-technology, contrast, or packaged keyboard journey gate.
6. **No portfolio health telemetry.** CI does not retain structured per-test timing, attempts, flakes, coverage, mutation evidence, or environment fingerprints.
7. **No current live-provider/signed-product coupling.** Historical live evals and signed canaries are valuable but are not automatically connected to the exact code/harness configuration being promoted today.
8. **Missing context map.** Repository instructions require `CONTEXT-MAP.md`; its absence makes ownership/context discovery depend on inference.

### Overlaps

1. Graph semantics are asserted in Rust storage tests, graph-server tests, TypeScript object tests, Python object tests, host tests, T2 runtime eval, graph-authoring replay, and Electron captures. These are different failure boundaries, but the portfolio does not label which is authoritative and which is corroborating.
2. Renderer navigation/history/layout behavior is repeated across many T0 model/controller tests, T2 service/import tests, the broad first-message T3 script, and committed captures. A failure does not identify the authoritative obligation owner.
3. Release authority, artifact grammar, and promotion rules appear in root Vitest, shell/PowerShell scripts, workflows, ADR/runbook prose, and committed receipts. The real T4 canary is uniquely strong, but lower-tier duplicates are not marked as prerequisites versus corroboration.
4. The two-turn task-system fixture recurs in eval-runner tests, root T2 tests, the eval CLI, Electron smokes, and captures. It is a useful vertical spine but weak portfolio breadth: repeated execution of one synthetic scenario can look like broader product coverage.

### Orphans and ambiguous evidence

1. The PRD asks for property tests, shared cross-language fixtures, and complete visible-event coverage that discovery did not find as such.
2. `npm test` is narrower than the required gate: it omits Python, clippy/format, TypeScript checks, PRD readability, and workspace checks. Only `npm run check` represents the default portfolio.
3. The deterministic eval CLI is documented as a major proof but is not a CI step; its saved local artifact is ignored and ephemeral unless deliberately retained.
4. Opt-in capture scripts and committed media have heterogeneous manifests. Some assets have strong hashes/requirements; others are screenshots with only nearby PRD prose. No common reader can determine freshness or supersession.
5. Human annotation tooling proves that reviews can be recorded. It does not prove that a qualified human reviewed every promoted candidate or that reviewer agreement is calibrated.

## Inputs this inventory gives the remaining map

- [Define fidelity-tier and execution-cadence assignment rules](https://github.com/vishaltandale00/relayer-graphcomplete/issues/182) should separate clean-checkout prerequisites, T0-T2 default gates, unreliable/manual T3 scripts, T4 target workflows, and historical/opt-in T5 evidence.
- [Define evidence adequacy, ownership, freshness, and suspect-link policy](https://github.com/vishaltandale00/relayer-graphcomplete/issues/184) needs an explicit authoritative owner for graph semantics, renderer journeys, client conformance, eval quality, and release acceptance.
- [Prototype portable bindings, test points, and attestations across every runner](https://github.com/vishaltandale00/relayer-graphcomplete/issues/185) must represent internal assertion failure independently from wrapper exit status and preserve setup/build/execution timing separately.
- [Turn timing research into enforceable tier budgets](https://github.com/vishaltandale00/relayer-graphcomplete/issues/186) should not use the one-off numbers above as baselines. The clean/warm distinction and current lack of structured timing are the relevant facts.
- [Define the safe compression and migration sequence](https://github.com/vishaltandale00/relayer-graphcomplete/issues/189) should retain each distinct failure boundary until authoritative ownership and substitution evidence exist. Repetition of the task-system fixture alone is not subsumption.
