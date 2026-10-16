# Merge CI follow-up — October 14, 2026

Hosted CI at `83c636cf7b3ef63b4c80aa5c61bd5ac4dbe7f123` found an invalid JSON test setting and two correctly rejected stale visual receipts. The fallback test now omits `promptProfile` from a cloned settings object, preserving the fallback path and all terminal assertions. Actual Electron captures replace the stale annotation and social-preview images/receipts together. No product behavior, configured baseline, provider pin, paid-inference setting or runtime deadline changed.

The annotation capture's first attempt exposed two proof lifecycle problems: automatic Electron exit returned zero for a failed receipt, and Chromium could recreate an in-process profile during shutdown. The capture now waits for cleanup before publishing a parent result; the shared `runElectronProof` owns its profile until process exit. An explicit 60-second capture-only service startup allowance carries no standard startup/TTFG claim. The original 10-second timeout cause remains unconfirmed.

## Required checkpoints

| Changed seam / promise | Deterministic checkpoint | Required assembled proof |
| --- | --- | --- |
| JSON-valid settings; delivered fallback permits both terminal paths | Existing `delivered fallback prompt` test and workspace TypeScript checks | Fresh exact-head hosted TypeScript chapter |
| Annotation capture exit/result/profile ownership | Shared `electron-proof-process.test.mjs`; unchanged receipt integrity test binds actual capture script, source, images and canonical occurrence | README's shared-parent command; positive result after cleanup, exit without signal, no new fixture/profile directories or owned children |
| PRD7.1 accepted follow-up `+`, editable annotation during later generation, exact durable occurrence and reload | Existing unchanged annotation receipt/production tests | Actual baseline-renderer A/current-renderer B/editor/confirmation/reload capture |
| SOC-003 exact renderer, both 1200×630 themes, cancellation and cleanup | Existing unchanged social receipt test | `npm run evidence:share-preview`; complete served-renderer identity before/after, isolated-session residue and cancellation probes |
| Changed capture script selects its CI receipt checkpoint | Real planner row in `ci-affected-plan.test.mjs`; explicit owner in versioned CI map | Full-portfolio selection retained; unknown-path fallback not used as a mapping substitute |

The production authority/UX and other heavy checkpoints remain in the [83 source/evidence record](merge-review-20261014.md) and [checkpoint map](README.md#merge-review-follow-up-2026-10-14). The [overlay](merge-typecheck-source.json) reconstructs 79 paths from the immutable 83 source manifest: `383056b9891f8082836b66222e8041c0d46bf81848d18e5ae7646f456958e617`. Only one test fixture, one capture driver and two CI map/test files changed. Prior proof is reused only for unchanged production and relevant test closures; original 83 records stay historical.

## Actual outcomes

- Workspace checks passed in 57.037s after reproducing TS2322 locally. The fallback test passed 1/1 (67 filtered). Four receipt/CI/parent files passed 98/98. No assertions were removed or loosened.
- Actual annotation capture through the shared parent passed in 16.657s: five checkpoints, zero paid calls, positive final cleanup result, process exit 0 and zero newly remaining fixture/profile directories. Separate post-exit process inspection found no owned Electron/graph/app child. The fixture compares a historical renderer overlay on the same backend; it is not a whole historical application comparison.
- Actual social capture passed in 9.141s with both themes, cancellation, session isolation, closed server and zero remaining windows. All six PNGs were visually inspected: A lacks `+`; B enables it; C shows the editable text; D retains one confirmed composer annotation; both social themes show the expected graph without Node Details. Historical startup-repair evidence is untouched.
- Final `npm run build` passed in 36.561s on the final executable snapshot. Earlier build in 27.269s is retained separately.
- **`npm run check` failed** in 249.3s: Clippy passed; app-server 385 passed/eight failed; downstream gates were not reached. A concurrent workspace check rebuilt visual-assets during that attempt, so native host startup is confounded. All eight cases passed in 26.723s serial isolation after builds settled, with unchanged bounds/assertions. No cause for every failure, whole-command pass or clean local suite is claimed. The later capture/planner edits are outside that command's reached native/Clippy closure and have their explicit fresh checks above.
- Hosted CI at83c CI remains failed: TypeScript fixture and Vitest 4,244 passed/two failed/34 skipped. Fresh Rust/crash/runtime/Clippy, Python, packaging and other selected chapters passed. The new head still requires fresh hosted full-portfolio CI and merge freshness. No merge performed.

## Preserved failures and limits

The execution record preserves the hosted failure logs, local TypeScript red, two stale-receipt failures, the first annotation timeout (`passed:false` despite exit 0), and the intermediate visually successful capture with recreated profile. Only the final shared-parent capture qualifies cleanup. Native startup/performance, paid-model quality/endpoint, hosted social crawler acceptance and signed release proof are outside this follow-up. Prior incomplete live quality verdicts remain unchanged.

[Execution record](merge-typecheck-verification.json) and [review assertion](merge-typecheck-review.json) bind actual results and reviewed state separately.
