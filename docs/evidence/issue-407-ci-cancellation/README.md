# Issue #407: cancel superseded CI lanes

## Checkpoints

| Checkpoint | Production seam | Deterministic observation |
| --- | --- | --- |
| All four Rust lanes, the Rust aggregate, and Vitest stop after workflow cancellation | Job-level `if` expressions in `.github/workflows/ci.yml` | `test/ci-required-check.test.mjs` parses the workflow YAML and pins the four lane expressions plus aggregate and Vitest expressions exactly. |
| Failed or skipped Ladybug acceleration does not skip selected Rust lanes | Rust lane `needs` and job conditions | The same parsed-workflow test pins the lane conditions; `!cancelled()` is the Actions status function that preserves evaluation after a failed or skipped dependency. Hosted execution remains the integration proof. |
| Runtime cache-hit selection remains intact | `rust-runtime` and Vitest job conditions | Exact expression pins retain the cache-miss build condition and cache-hit Vitest path. |
| Stable required check still evaluates selected missing chapters | `check` aggregate job | Existing contract test pins `check.if` to `always()` and its complete `needs` set; existing required-check tests reject failed or unexpectedly skipped selected chapters. |

## Expression changes

| Job | Previous expression | Current expression |
| --- | --- | --- |
| `rust-clippy` | `${{ always() && needs.plan.result == 'success' && needs.plan.outputs.rust == 'true' }}` | `${{ !cancelled() && needs.plan.result == 'success' && needs.plan.outputs.rust == 'true' }}` |
| `rust-tests` | `${{ always() && needs.plan.result == 'success' && needs.plan.outputs.rust == 'true' }}` | `${{ !cancelled() && needs.plan.result == 'success' && needs.plan.outputs.rust == 'true' }}` |
| `rust-crash` | `${{ always() && needs.plan.result == 'success' && needs.plan.outputs.rust_crash == 'true' }}` | `${{ !cancelled() && needs.plan.result == 'success' && needs.plan.outputs.rust_crash == 'true' }}` |
| `rust-runtime` | `${{ always() && needs.plan.result == 'success' && needs.plan.outputs.rust_runtime == 'true' && needs.plan.outputs.runtime_cache_hit != 'true' }}` | `${{ !cancelled() && needs.plan.result == 'success' && needs.plan.outputs.rust_runtime == 'true' && needs.plan.outputs.runtime_cache_hit != 'true' }}` |
| `rust` | `${{ always() && needs.plan.result == 'success' && needs.plan.outputs.rust == 'true' }}` | `${{ !cancelled() && needs.plan.result == 'success' && needs.plan.outputs.rust == 'true' }}` |
| `vitest` | `${{ always() && needs.plan.outputs.vitest == 'true' && (needs.plan.outputs.rust_runtime != 'true' || needs.plan.outputs.runtime_cache_hit == 'true' || needs['rust-runtime'].result == 'success') }}` | `${{ !cancelled() && needs.plan.outputs.vitest == 'true' && (needs.plan.outputs.rust_runtime != 'true' || needs.plan.outputs.runtime_cache_hit == 'true' || needs['rust-runtime'].result == 'success') }}` |

The `check` aggregate remains on `always()`. Workflow concurrency still cancels superseded runs. Step-level telemetry and upload `always()` conditions are unchanged.

## Verification record

- Base: `61ce7b0cc50ee819eb54568cb8fc7165bf6c1e01`.
- Focused command: `npx vitest run test/ci-required-check.test.mjs` with Node `v22.23.2`.
- Focused result: **18 tests passed** in 663 ms on the source snapshot recorded at `/Users/vishal/.codex/worker-pilot/evidence/factory-407/source-focused.json`.
- Heavy verification executable-source SHA-256: `0bc222c77d2c8a5b3838ac6d04e582302be604451f4438522d714602d0741a1a` over the workflow and parsed-workflow contract test. The CI guidance and those executable files match the hashes captured before the heavy gates; the evidence README was finalized afterward.
- `npm run check`: **passed**, exit code 0, Node `v22.23.2`, `CARGO_TARGET_DIR=/Volumes/2T-SSD/cargo/relayer-graphcomplete`, `CARGO_BUILD_JOBS=2`, and `RUST_TEST_THREADS=2`. This included 2,268 Vitest tests passed and 3 skipped, the isolated secret-boundary tests (2 passed), Python tests (29 passed), Ladybug receipt checks, PRD readability, and the Rust workspace and crash-reconciliation suites. Raw output: `/Users/vishal/.codex/worker-pilot/evidence/factory-407/check.log`; the parent-owned session reported exit code 0.
- `npm run build`: **passed**, exit code 0, on the same Node and Cargo environment.
- Raw logs are preserved in the host-local `worker-pilot/evidence/factory-407` bundle. SHA-256: focused Vitest `bafddec6c5a4b61312cd3f2b0256b56a02fbd58386eacc93277889f49e48edef`; check `387f5633710a303c6beff3ad597131de381d84d3e53e9b0c677b7463e1943e59`; build `8fe8b91eff57799a87ecb2037a3e19a5fe3b07704cdce6c56d5824785b5add96`.
- Pull request and CI run: pending; links will be added after creation.
- Hosted cancellation scenario: outstanding. No two-push Rust-touching PR run was naturally available during this focused phase. A local YAML assertion does not prove GitHub-hosted cancellation behavior.
