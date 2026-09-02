# Pull-request CI

CI keeps one branch-rule context named `check`. The context is an aggregator: it
passes only when planning, quick deterministic checks, and every selected
chapter pass. A selected chapter that is skipped is a failure.

## Integration trains

Reusable integration branches use the `integration/**` namespace. Pushes to an
integration branch run the full portfolio and may save Rust compilation caches.
Component pull requests target that integration branch and receive the
versioned affected-module plan. The integration branch pull request back to
`main` runs the full portfolio. The versioned
`scripts/ci/verification-portfolio.v1.json` manifest assigns every command in
the repository-required `npm run check` and `npm run build` scripts to exactly
one authoritative chapter, and each chapter names the workflow job or jobs
that execute it. A chapter may run in more than one job — the runtime build
also runs inside the Vitest job as a fail-open fallback — without creating a
second authoritative owner. A deterministic test compares the manifest with the current package
scripts and executes every declared chapter against the same machine-readable
authority/prerequisite contract. Adding, removing, reordering, or moving a
required command to an unrelated job therefore fails before the portfolio can
silently diverge. Vitest may repeat package compilation as an explicit
non-authoritative prerequisite; that repetition prepares current runtime
bytes but does not create a second verification owner. CI executes the
authorities in parallel instead of rerunning both complete scripts in a
second serial job. The exact scripts remain the required local pre-commit
gates. Merge remains manual.

Quick deterministic checks no longer gate the parallel chapter and lane
jobs: every chapter starts as soon as the plan is ready, and the quick job
fails the required `check` aggregate on its own. A formatting failure
therefore no longer short-circuits the Rust spend; the accepted trade buys
the quick-job duration back on every run. Cache saves remain gated on their
own success conditions, never on quick.

Tests are always invoked for the current source snapshot. Cache entries contain
dependency and compilation artifacts only; they are untrusted acceleration and
never verification evidence. Rust Clippy, default tests, crash reconciliation,
and runtime builds converge through the existing `Rust checks and fresh tests`
aggregate. Every lane executes on its own fresh runner, so all lanes use one
shared `CARGO_TARGET_DIR` path: identical paths keep sccache cache keys stable
across lanes, which matters for the Ladybug CMake build whose generated-header
paths would otherwise fragment the C/C++ object cache per lane. Their isolated
runners share one toolchain-bound, content-addressed sccache namespace. The Clippy,
default-test, and crash lanes read and write compiler objects; the runtime
lane reads only while the writer lanes run. Its unique outputs are uncachable
binary links, and its shareable units are identical to the default-test
lane's, so reading without writing removes duplicate-write collisions with the
lanes that seed those objects. On runtime-only plans no writer lane exists, so
the runtime lane writes to keep the namespace from going cold. Same-repository pull requests and repository branch pushes may store
compiler objects through the writing lanes. Fork pull
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
Every lane disables Cargo's runner-local incremental mode because sccache cannot
cache incremental Rust invocations. All four lanes preserve the admitted CI-only
`line-tables-only` dev/test debug profile from PR #387 and use a new parallel
cache namespace so incompatible full-debug objects cannot be reused. Each lane
records text and JSON sccache statistics as a non-gating, 14-day workflow
artifact. The separate Cargo registry/git archive excludes `target/` and remains
a trusted-branch-only writer. The platform packaging
archive retains its restore-on-PR, write-on-branch behavior with a
`Cargo.lock`-keyed exact key and a versioned prefix fallback. The prefix
restore already hands a Rust PR the newest available `target/`, and Cargo's
own fingerprinting rebuilds only the drifted crates, so binding the full
Rust input digest would add no warmth: it would only miss more often and
re-save multi-gigabyte entries on every Rust push, churning the shared
10 GB cache budget against the Ladybug, runtime, and dependency entries the
other levers depend on.

The parallel namespace is a staged canary until a real changed-head pull request
and its integrated push demonstrate compiler-cache hits, lower p95 Rust wall
time than the recorded serial baseline, no required-job regression, and no
repository-cache thrashing. Do not manufacture repeated cold runs to reach that
decision. Roll back the lane split if p95 Rust latency worsens by more than 15%,
compiler cache errors become gating, or unexplained differential failures occur.
Compiler objects may be retained when a later compilation unit or test fails;
their presence is not a verification claim. A cache or telemetry failure must
not make the stable required `check` fail when the same source compiles and
tests successfully without acceleration.

The Ladybug native library is built by the `Prebuilt Ladybug native
library` job only when the trusted bundle cache misses. The plan job performs
a lookup-only restore against the bundle key and publishes whether the bundle
exists; warm runs skip the prebuilt job entirely and each Rust lane restores
the bundle straight from the Actions cache, while cold runs build once,
upload a one-day artifact, and the lanes download it. It compiles the pinned
bundled source (`cargo build -p lbug`), strips debug info from the static
archive, and packages the library with the headers the external-link path
needs. The bundle is saved to the Actions cache on trusted pushes and on
same-repository pull requests, matching the sccache trust model, with a key
over the runner platform, rustc release, and `Cargo.lock` digest; a
`Cargo.lock` bump therefore pays the bundle build once per PR instead of on
every push to the PR, and fork pull requests never save. Each Rust lane runs
`scripts/ci/lbug-artifact.mjs verify` on whichever path supplied the bundle,
which re-checks the platform, rustc release, `Cargo.lock` digest, pinned
lbug version, and the library SHA-256 before exporting
`LBUG_LIBRARY_DIR`/`LBUG_INCLUDE_DIR`. A missing or rejected bundle fails
open to the in-lane source build, and the lanes keep running on their own
source builds even if the producing job fails: their gates re-derive from
the plan results, never from the acceleration job. The bundle
records the commit that built it for provenance, but equality keys on the
pinned source, the resolved lbug feature set, and the toolchain, because the
bundled source cannot change without a `Cargo.lock` change. The manifest also
carries a digest over every packaged file plus the library size, so a
truncated include tree or a failed debug strip is rejected before any lane
links. One accepted cost: while the bundle cache keeps hitting, the lanes no
longer repopulate the Ladybug objects in sccache, so a later fallback to the
source build pays a cold CMake compile until it re-stores them. Tests still
compile and run freshly against whichever library they link; the bundle is
acceleration, never evidence.

Vitest worker policy lives in `vitest.config.js`, not in the chapter
runner: the isolated project runs with file-level workers and the
process-bound files run one at a time after it. The chapter must not pin
`--maxWorkers`, and a deterministic test enforces that. The same file sets
the portfolio-wide 15 s per-test timeout: tests that spawn the Rust runtime
or a harness host regularly exceed Vitest's 5 s default once three workers
share the 4-vCPU runner, and a test that needs longer still sets its own. Sharding the
portfolio across two runners was measured against this arrangement and lost
— a single parallel runner finished the full portfolio in 1.9 minutes
against 2.7 for a two-runner serial split, at half the runner cost — so the
portfolio stays on one runner and the parallelism stays in the config.

The selected default-feature `relayer-app-server` and
`relayer-graph-server` binaries are built once in the runtime lane when the
trusted runtime cache misses. The sealed bundle binds the Rust input digest
(over `crates/`, `Cargo.toml`, `Cargo.lock`, and `.cargo/`), runner platform
and architecture, Rust release, `Cargo.lock` digest, Cargo profile, feature
set, binary inventory, and per-binary SHA-256 digest; the commit that built
it is recorded for provenance only, mirroring the Ladybug bundle. The plan
job performs a lookup-only restore against that digest, and on a hit the
runtime lane is skipped and the Vitest jobs restore the sealed bundle
directly from the Actions cache; only trusted `main` pushes save it. On a
miss the lane builds, uploads a one-day workflow artifact, and the Vitest
jobs download it. The cache key binds the package set as well as the
digest. Trusted bundles are seeded only by full-mode main pushes, so the
key carries the full-portfolio package constant for every plan — keying on
a consuming plan's own subset would miss the seeded entry structurally —
and verify additionally asserts the bundle covers the consuming plan's
`runtimeRustPackages`, which is the lock that makes restoring a superset
bundle safe for narrow plans. Both paths verify
every identity field through `scripts/ci/runtime-artifact.mjs verify` and
install only those authenticated bytes into `target/debug`; a failed restore
or verification fails open to an in-lane fresh build so acceleration trouble
never fails the fresh chapters. That fallback rebuilds with the runtime
lane's compilation inputs — the trusted Ladybug bundle (cache first, the
prebuilt artifact second) and the Cargo dependency archive — instead of
paying a cold CMake floor; the build itself is fresh verification, so a
failed fallback build fails the chapter the same way a failed runtime lane
would. This removes independent Vitest Rust compilation without caching any
test result; every mapped Vitest test still runs freshly. Whenever the
trusted cache covers the current Rust inputs — the common case for non-Rust
pull requests — no Rust lane enters the path at all: those runs narrow to
plan, quick, Vitest, any other selected non-Rust chapters, and the check
aggregate. On a miss the runtime lane builds fresh and seeds the cache once,
and Vitest still declares it in `needs` so a failed fresh build stays
visible.

The Clippy, default-test, and runtime lanes append `--timings` to their
direct Cargo invocations when the workflow gives them a
`RELAYER_CARGO_TIMINGS_DIR`, then harvest the report Cargo writes into the
lane's target directory (`cargo-timings/cargo-timing.html`). Each lane
uploads the harvested reports as a non-gating 14-day artifact beside its
sccache statistics; a harvest failure cannot fail the lane. The crash lane executes its command through the
repository npm script, which cannot inject Cargo flags, so it records step
durations but no timing report. Timing reports expose compilation units,
features, critical path, and concurrency; they are measurement evidence, not
verification evidence.

Job summaries record Node setup/npm-cache status and elapsed time, Rust-cache
status and restore time, chapter duration, and the first actionable failure.

The crash-reconciliation lane selects on the checked-in
`rustCrashPackages` list (`relayer-graph-core` and `relayer-graph-server`)
intersected with the affected crates' reverse-dependency closure, plus every
full-portfolio run. Forward build dependencies are excluded: they join the
affected package list because Clippy lints them, but the crash command never
compiles or executes them. `relayer-app-server` is likewise deliberately
excluded: the crash command compiles and executes no app-server code, and
app-server interrupted-execution recovery remains owned by its ordinary Rust
tests. See `docs/research/crash-verification-cadence.md` for the staged
narrowing plan.

The checked-in v1 map is `scripts/ci/affected-modules.v1.json`. Rust selection
includes reverse dependents and their local build dependencies; npm reverse
dependents are derived from manifests. Lockfile, toolchain,
workflow, infrastructure, planner, unknown, and unmapped changes select the
full portfolio. Each affected owner also names its fresh Vitest checkpoints and
their build prerequisites. A selected Vitest chapter with no mapped checkpoint
fails open to the full portfolio rather than silently skipping tests.

Source-module changes conservatively run the complete fresh Vitest portfolio;
the planner narrows their compilation, typecheck, packaging, and non-Vitest
chapters. This keeps product and authority boundaries intact when a new test is
added outside an older component-specific list.

Explicitly owned paths may select no chapter at all. Repository metadata
(`LICENSE`, `.gitignore`, `CONTRIBUTING.md`, `ROADMAP.md`, `CONTEXT.md`),
process documentation (`docs/research/`, `docs/postmortems/`, specification
notes), and manual desktop/evidence driver scripts have no CI consumer, so a
change that touches only those paths still runs planning, the quick
deterministic checks, and the stable `check` aggregator, and nothing else.
Executable seams that cannot run their full flow in CI keep deterministic
substitutes instead: `live-run.example.json` and the paid live-run entry
point resolve through the live-run model checkpoint, the provider-UX evidence
scripts and the ask-profile capture entry point parse through
platform-portable syntax checkpoints, and the ask-profile shell launcher
passes `sh -n`. Two documentation paths are different:
`docs/desktop-release-operations.md` is read by the desktop-shell checkpoint,
and `.gitattributes` is read by the byte-stability and Ladybug receipt-input
checkpoints, so both select their owning Vitest tests. `scripts/clean-dist.mjs` also
selects no extra chapter, but the always-running quick chapter executes it as
the portfolio's `clean-dist` authority, so every plan verifies it. Each such
mapping is an explicit ownership declaration in the v1 map; unknown and
unmapped paths still fail open to the full portfolio. Scripts that Vitest imports or reads keep their
owning test files, and `scripts/prepare-ladybug-source.mjs` additionally
selects packaging because the pinned Ladybug build consumes it and receipts
because the native-receipt authority imports its hashing helpers.
`docs/graph-query-v1.md` is a compile-time input of the graph-core query
contract tests, so it selects the Rust closure of `relayer-graph-core`.
`docs/graph-query-v1-errors.json` is the source of the generated
query-error code and the Python client contract, so it selects the
`@relayer/graph-client` workspace closure and the Python chapter.
