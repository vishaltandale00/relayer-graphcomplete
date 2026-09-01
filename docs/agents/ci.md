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
never verification evidence. The `Rust checks and fresh tests` job canaries a
content-addressed sccache compiler cache: same-repository pull requests and
repository branch pushes may read and write compiler objects. Fork pull
requests do not run sccache and receive no compiler-cache credentials; they
compile directly with `rustc`. GitHub's ref scoping lets pull requests inherit a
compatible trusted branch baseline without allowing `main`, integration
branches, or sibling pull requests to consume objects written by that pull
request. The canary falls back to direct `rustc` when sccache setup or its
daemon start is unavailable. The upstream GitHub backend keeps
rate-limit storage failures nonfatal, and its native server-I/O fallback invokes
the local compiler if daemon communication is lost. Any genuine nonzero compiler
result propagates without a second compiler invocation, so compiler failures
cannot be delayed or masked.
It disables Cargo's runner-local incremental mode because sccache cannot cache
incremental Rust invocations. Its separate Cargo registry/git archive excludes
`target/` and remains a trusted-branch-only writer. Other Rust
compilation archives retain their
existing restore-on-PR, write-on-branch behavior until hosted canary evidence
justifies expansion.

The sccache canary is admitted beyond the Rust job only after one seed run and
the next real changed-head pull-request run demonstrate compiler-cache hits, at
least five minutes of net Rust compilation savings against the recorded hosted
baseline, no required-job regression, and no repository-cache thrashing. Do not
manufacture repeated cold runs to reach that decision. Compiler objects may be
retained when a later compilation unit or test fails; their presence is not a
verification claim. A cache or telemetry failure must not make the stable
required `check` fail when the same source compiles and tests successfully
without acceleration.

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
