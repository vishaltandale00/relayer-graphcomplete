# Issue #453: stopped child diagnostics

The Eval visual-comparison contract inspects authored visual Node Details on accepted nodes. Every observed semantic child still has to settle as an accepted result. A stopped child therefore fails `agent-authored-complete:child-terminal`, while it does not receive a per-child authored-output check. This keeps V3's empty accepted-node set from being reported as a misleading package failure.

| Child status | Presentation | Terminal check | Child authored-output checks | Overall result |
| --- | --- | --- | ---: | --- |
| stopped | V2 | fail | 0 | fail |
| stopped | V3 | fail | 0 | fail |
| accepted | V3, plain output | unchanged V3 validation | 1, fail | fail |

The regression exercises exported production `recursiveCompleteChecks` with a stopped child carrying source/action/interaction/completion identities, stopped projection settlement, settled execution metadata, and a complete nested-authority trace. Existing accepted-child fixtures now explicitly declare `status: "accepted"`; their terminal/execution failure and V3 plain-output failure assertions remain in place.

## Verification

- Required warm-loop checkpoint: `npx vitest run test/eval-app-integration.test.mjs -t 'semantic child|visual-comparison|authored visual'`
- Result on the implementation snapshot: 1 file passed; 4 tests passed, 14 skipped; 0.943 s. The stopped-child fixture observed V2 and V3 terminal failure, zero authored-output checks, and overall failure.
- The first Vitest attempt could not resolve the unbuilt `@relayer/eval-runner` workspace package. After `npm run build:packages`, the focused command passed.
- The initial full-file attempt ran before runtime binaries were built: 14 tests passed and 4 composed Eval tests failed because `target/debug/relayer-graph-server` was absent (ENOENT). This setup failure is preserved in `worker-pilot/evidence/factory-453/full-eval-integration.log`.
- After linking the trusted shared Cargo target, the full file passed: 18/18 tests in 50.13 s. See `worker-pilot/evidence/factory-453/full-eval-integration-heavy.log`.
- `npm run check` passed on the same source snapshot. Inner outcomes: 172 Vitest files passed, 1 skipped; 2,268 tests passed, 3 skipped; Codex secret-boundary 2/2; Python 29/29; Ladybug receipts and PRD readability checks passed. Full output: `worker-pilot/evidence/factory-453/npm-check.log`.
- `npm run build` passed on that same source snapshot. Full output: `worker-pilot/evidence/factory-453/npm-build.log`.
- Heavy commands used Node 22.23.2, `CARGO_TARGET_DIR=/Volumes/2T-SSD/cargo/relayer-graphcomplete`, `CARGO_BUILD_JOBS=2`, and `RUST_TEST_THREADS=2`. The source hashes before and after all heavy commands match: `desktop/eval-main/eval-service.mjs` `61a48f2b717a9b5699ad37c7877717120778de948bd75a1f2e55dca43b68cbeb`; `test/eval-app-integration.test.mjs` `7cbc19896ebe9aa6f645138014309d24bc37d11c1e7ec7042d9010bfd163d3d8`. Detailed logs and pre/post receipts are retained under `worker-pilot/evidence/factory-453/`.
- No paid inference or visual renderer changes are involved.

Executable seams changed: `recursiveCompleteChecks` in `desktop/eval-main/eval-service.mjs` now gates only the child authored-output loop on accepted status; `test/eval-app-integration.test.mjs` exercises stopped V2/V3 behavior and makes existing accepted-child fixtures explicit. Product meaning is mapped to PRD §12's visual Node Details comparison contract and ADR 0003's production Eval workspace boundary. The versioned CI map `scripts/ci/affected-modules.v1.json` assigns `test/eval-app-integration.test.mjs` to the `relayer-app-server` and `relayer-graph-server` Vitest runtime prerequisites; source changes select the full fresh Vitest portfolio. The deterministic production seam is covered by the focused and full Eval integration tests above; repository check and build gates passed for the exact source snapshot recorded here.
