# Pull-request CI

CI keeps one branch-rule context named `check`. The context is an aggregator: it
passes only when planning, quick deterministic checks, and every selected
chapter pass. A selected chapter that is skipped is a failure.

## Integration trains

Reusable integration branches use the `integration/**` namespace. Pushes to an
integration branch run the full portfolio and may save Rust compilation caches.
Component pull requests target that integration branch and receive the
versioned affected-module plan. The integration branch pull request back to
`main` runs the full portfolio, including the exact repository-required
`npm run check` and `npm run build` gates. Merge remains manual.

Tests are always invoked for the current source snapshot. Cache entries contain
dependency and compilation artifacts only; they are untrusted acceleration and
never verification evidence. Pull-request jobs restore eligible caches but do
not save them. Repository branch pushes are the only cache writers.
Job summaries record Node setup/npm-cache status and elapsed time, Rust-cache
status and restore time, chapter duration, and the first actionable failure.

The checked-in v1 map is `scripts/ci/affected-modules.v1.json`. Rust and npm
reverse dependents are derived from their manifests. Lockfile, toolchain,
workflow, infrastructure, planner, unknown, and unmapped changes select the
full portfolio. Each affected owner also names its fresh Vitest checkpoints and
their build prerequisites. A selected Vitest chapter with no mapped checkpoint
fails open to the full portfolio rather than silently skipping tests.

Source-module changes conservatively run the complete fresh Vitest portfolio;
the planner narrows their compilation, typecheck, packaging, and non-Vitest
chapters. This keeps product and authority boundaries intact when a new test is
added outside an older component-specific list.
