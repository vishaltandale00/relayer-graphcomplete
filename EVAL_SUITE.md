# Running the external capability eval suite

GraphComplete owns the eval runner, dashboard, product execution, and saved results. The ten cases introduced by PR #533 live in [relayer-capability-evals](https://github.com/vishaltandale00/relayer-capability-evals): tasks, fixture materializers, verifiers, reference solutions, mutants, admission scripts, evidence, and ordered suite membership. Older H3, frontier, calibration, and standalone benchmarks remain here.

## Setup and launch

The host SDK requires Node 22.8 or newer; the current ten-case catalog targets macOS and includes an exact Node 22.23.2 verifier pin. Use Node 22.23.2 and follow the external repository’s runtime instructions for the full suite. Build this GraphComplete checkout first with `npm ci` and `npm run build`. Clone the external catalog using the exact origin recorded in `eval-catalog.lock.json`, then check out its pinned commit:

```sh
# Run from this GraphComplete repository root.
GRAPHCOMPLETE_ROOT="$PWD"
CATALOG_ROOT="$(dirname "$PWD")/relayer-capability-evals"
git clone "$(node -p 'JSON.parse(require("fs").readFileSync("eval-catalog.lock.json", "utf8")).repositoryUrl')" "$CATALOG_ROOT"
git -C "$CATALOG_ROOT" checkout --detach "$(node -p 'JSON.parse(require("fs").readFileSync("eval-catalog.lock.json", "utf8")).commit')"
npm --prefix "$CATALOG_ROOT" ci
npm --prefix "$CATALOG_ROOT" run setup -- --runner "$GRAPHCOMPLETE_ROOT"
RELAYER_EVAL_CATALOG_ROOT="$CATALOG_ROOT" npm run eval-app:dev
```

For an existing clone, fetch the pinned commit explicitly and use the same detached checkout and setup steps. Setup links the built public `@relayer/eval-runner` SDK; compiled case modules are versioned in the catalog repository. Follow that repository's README for case-specific platform and runtime prerequisites. GraphComplete does not fetch, install, or build external cases during startup.

Select the external suite in the Eval dashboard, then choose the harness/model and judge. Suite selection fixes the case order and contract pins; individual member overrides are rejected. Normal execution uses the real product and may invoke the configured model. Deterministic verification below uses fixture harnesses and does not establish live model quality.

Without `RELAYER_EVAL_CATALOG_ROOT`, only the existing built-in catalog is loaded. A configured checkout with a mismatched origin, commit, modified tracked bytes, or invalid catalog fails closed. An unavailable case makes its suite unavailable; consult its external runtime instructions.

## Ownership and identity

The external package exports `createEvalCatalog()` using the versioned public SDK. Each registration supplies its public definition, bound snapshot, materialize/grade callbacks, and mandatory-gate mapping. GraphComplete validates registrations and suite pins, executes callbacks through the generic project runner, and keeps outcome and presentation grades independent.

The lock pins repository, commit, and entrypoint. The loader verifies tracked file contents, records the Git tree and entrypoint digest, and rechecks before queuing and executing a run. Individual external runs and suite runs persist this catalog identity. Historical results remain readable when the external checkout is absent. A catalog is trusted developer-selected executable code, with the same trust as the evaluator checkout; repository separation is not a plugin sandbox. The linked SDK belongs to the running GraphComplete build.

## Verification and updates

- Host contracts: `npx vitest run desktop/eval-main/external-catalog.test.mjs packages/eval-runner/test/eval-catalog.test.ts packages/eval-runner/test/capability-suite-contract.test.ts packages/eval-runner/test/run-plan.test.ts test/eval-service-simulated-user.test.mjs test/eval-suite-selection.test.mjs`.
- Repository gates before committing: `npm run check` and `npm run build`.
- Compiled runtime: `npm run test:eval-compiled-runtime`.
- Dashboard fixture proof with a prepared external checkout: `RELAYER_EVAL_CATALOG_ROOT="$CATALOG_ROOT" RELAYER_EVAL_REQUIRE_EXTERNAL_CATALOG=1 npm run test:eval-web`.
- Case tests and admission portfolios: run the declared commands in the external repository. Admission evidence applies only to its captured source/runtime inputs; older receipts do not certify moved or edited cases.

To update cases, change and verify the external repository, commit its source and compiled modules, then update this repository's lock to that immutable commit and rerun host integration checks. Restart the Eval host after changing a catalog pin: Node caches imported modules for the process lifetime. Never edit the pinned checkout in place and treat its previous receipts as current evidence.

The [host checkpoint map](docs/evidence/external-eval-catalog/README.md) separates required proof from recorded results. Live model baselines require their declared credential and cost controls; no paid inference is part of the default test suite.

## Live external runs

Selecting a real harness or model judge for external cases requires an explicit confirmation and a positive declared USD cost cap. Authorization binds the resolved cases, harness configurations, and judge; changing that selection requires new authorization. The host checks the connected provider credential before queueing work and stores only its opaque reference with the authorization. The declared cap is recorded, not a provider billing cutoff. Deterministic fixture runs with the deterministic judge do not require live authorization.

The loader copies verified tracked catalog files into a private, read-only snapshot before importing code. Its installed dependencies, including the linked host SDK, remain trusted developer tooling rather than part of the catalog Git pin. Git replacements, grafts, filesystem-monitor hooks, and clean filters cannot redirect catalog verification.

External judge-only reruns also require fresh authorization for their case, harness identity, and selected judge. Their authorization is recorded separately from the original run.

## Opt-in actor diagnostics

To collect local browser diagnostics for new simulated-user sessions, start Eval with:

```sh
RELAYER_EVAL_ACTOR_DIAGNOSTICS=1 npm run eval-app:dev
```

Keep your existing profile, catalog and runtime environment settings. The flag is
off by default and does not launch a session or authorize inference. Diagnostics
are stored separately under the Eval profile's `eval-data/actor-diagnostics` directory,
organized by session and capture attempt. Existing runs are not backfilled.

Action records correlate with recorded observation and action-event IDs. They
capture sanitized browser errors and stages, structural target state, recovery
decisions and browser lifecycle events. A failure screenshot is best-effort;
page closure or a capture error can make it unavailable. Missing dispatch evidence
means unknown, never proof that no input reached the page.

The Playwright trace retains operation timing and sanitized failures. Network
payloads, source files and DOM snapshots are excluded; credentials and unsafe
trace fields are removed before retaining the archive. Private temporary capture
files are removed after processing; abrupt process termination can leave private
scratch files. A missing or unfinished manifest means capture is incomplete. Diagnostic files stay local and do not enter
actor observations, completion-judge input, human grades or ordinary exports.
Screenshots can contain visible task content; treat these local bundles as private.
Inspect `manifest.json` and the event log for capture omissions before drawing
an RCA conclusion. Capture is observational: it does not replay actions or relax
recovery rules. Turn the flag off on the next host launch to stop new captures.

Each attempt contains `events.jsonl`, `manifest.json`, and, when capture succeeds,
`trace.zip` plus failure PNGs. Open a saved archive with
`npx playwright show-trace /absolute/path/to/trace.zip`. Join `action_started`
records to the task trajectory using `actionEventId` and `observationEventId`;
use their `actionId` for corresponding error and recovery records. A sanitized
trace has no DOM replay; inspect the separate screenshots and target-state events.
