# Pull-request CI

CI keeps its verification aggregator named `check`. The context
passes only when planning, quick deterministic checks, and every selected
chapter pass. A selected chapter that is skipped is a failure.

## Scheduled merge freshness

The approved merge policy permits conflict-free PRs behind main while their
current head has successful CI evidence less than 12 hours old. Age starts at
GitHub's original CI run creation time, not PR creation, author timestamps, job
completion, or a rerun. The plan job records the actual checkout's two parents
and observes `refs/heads/main`; the base parent must equal that observation.
The event's base SHA can lag GitHub's synthetic merge and is not the checkout
authority. The actual merge SHA must match `GITHUB_SHA`, and its second parent
must match the event's exact PR head. A different observed main fails closed.
All ordinary CI checkouts explicitly pin the same immutable event merge SHA.
A newer main commit does not
immediately invalidate otherwise recent evidence. A rerun cannot extend the
original window. Update the branch to create fresh PR CI when it expires.

`Merge freshness guard` refreshes a separate `merge-freshness-status` commit status at minutes
7, 22, 37, and 52, on CI completion, relevant PR changes, and main pushes. Manual
dispatch on main is also available. It never reruns expensive CI or merges PRs.
Only the latest CI run associated with this PR and its exact current head can qualify; its current
attempt must have a successful `check` job. A matching plan artifact from an
earlier attempt of that same immutable run is allowed because re-running only
failed jobs does not repeat a successful plan. This never renews the window.
Missing/expired evidence, conflicts, unknown mergeability, and per-PR API or
artifact errors fail closed when the sweep can publish a status. Older PRs
without the new artifact must run fresh CI after rollout.
Receipt generation and upload are non-blocking plan steps. Their failures remain
visible, but do not skip application tests or affected-module planning. Missing
or invalid evidence still fails the separately required `merge-freshness-status` status.

This is **scheduled, not atomic, expiration**. GitHub can delay or drop cron
jobs. A failed list request or status-write request, disabled workflow, rate
limit, or timeout can leave a previous success visible until a later sweep.
There is no maximum-lateness guarantee. The sweep first publishes a pending commit status before reading evidence,
rechecks the head before completing it, and uses
one non-cancelling concurrency group to prevent overlapping stale writers.
Brief pending checks during refresh are expected.
PR-specific read and publication failures are isolated: the sweep continues with
later PRs and reports unpublished results without including raw API errors.
After processing all PRs, unpublished results fail the workflow for operator attention.

The privileged sweep pins checkout and script actions to immutable commit SHAs.
It checks out protected main with persisted credentials off;
it never checks out or executes PR code, installs PR dependencies, or extracts
artifact paths. Artifact input is size-bounded JSON read through bounded unzip
stdout. GitHub API run/job/commit identities are checked independently. As with
existing CI, reviewed PR workflow code is a trust root for the correctness of
the actual tests and receipt generation; this is not an attestation against a
malicious rewrite of the CI workflow. Its token can read Actions, content and PRs
and write commit statuses and legacy checks, but cannot merge, write source, deploy, or access cloud secrets.

The required result is a commit status, independent of Actions workflow suites.
GitHub can attach API-created checks to the first workflow suite on a head even
when later PR metadata events create a newer suite selected by the merge box.
A green check in the API rollup therefore does not prove merge enforcement.
Both publication APIs are scoped to the head SHA, while receipts belong to a PR.
Before success, the guard re-lists open main-targeting PRs and rejects any shared
head. Use a unique head commit for each open PR. Listing failure fails closed;
PR changes after this check remain subject to the scheduled refresh limitation.
Close and retarget-away events revoke both results for the PR's current head,
before listing open PRs. This prevents indefinite success after closure, including
when the listing fails. Revocation still depends on asynchronous event delivery;
a delayed, dropped, or failed close workflow can leave stale success visible.
PR event triggers therefore allow every base branch; the workflow always checks
out protected `main`, and only open main-targeting PRs can receive success.
[GitHub's current `pull_request_target` behavior](https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/)
uses the default branch workflow and `GITHUB_REF` regardless of the PR base,
so the job's main-ref restriction remains in place for retarget-away events.
Previously successful historical heads are not revoked by this current-head
handler. Reusing those SHAs remains subject to the opening sweep's delay.
The old `merge-freshness` check remains dual-published during migration. Both
revocations are attempted independently before evidence IO; either publication
failure remains an operator-visible failure. The names intentionally differ:
GitHub requires both results when a check and status share a required name.

[GitHub caps commit statuses](https://docs.github.com/en/rest/commits/statuses#create-a-commit-status)
at 1,000 per SHA/context (case-insensitive). After writing pending,
the guard counts this context's history and refuses success at 990 entries.
It publishes failure requiring a new head, retaining capacity for revocation.
Further refreshes can exhaust writes only in a non-success state. History-read
errors fail closed after pending; they cannot preserve an earlier success.

Rollout (requires operator approval for publishing and the live ruleset change):

1. Merge the dual-publishing guard through reviewed CI while the legacy
   `merge-freshness` requirement remains active. Do not remove that requirement
   to get the repair merged.
2. Verify `merge-freshness-status` from the GitHub Actions publisher satisfies a
   required context on a controlled hosted PR targeting `main` (or an isolated
   repository with `main`); other base branches are rejected by the guard. Cover valid and expired or
   missing evidence, and a metadata edit plus scheduled refresh on the same head.
   Inspect the actual merge box/rule evaluation, not only the check/status API.
   Confirm fork metadata separately; no PR code may run in the privileged guard.
3. On main, verify the new status exists on current PR heads. Derive a minimal
   update from the freshly read existing ruleset: replace only the required
   `merge-freshness` context with `merge-freshness-status`, retaining app 15368,
   required `check`, strict freshness disabled, and every unrelated protection.
   The audit rejects the legacy requirement in active rulesets explicitly targeting
   `main` or the default branch. Inspect wildcard rulesets separately.
4. After the approved update, inspect the real merge gate (including PR #477 if
   still open), the read-only authority audit, and a scheduled expiration sweep.
   The checked-in template and deterministic tests alone do not certify activation.

The legacy publisher stays until a separately reviewed cleanup after migration.
Rollback may restore the legacy context only if its actual enforcement is proven;
otherwise restore strict freshness with operator approval before disabling the
guard. Release/tag/environment protections remain unchanged.

Checkpoint mapping (no product runtime behavior changes):

| Boundary | Deterministic checkpoint |
| --- | --- |
| Exact head, actual main merge, run and attempt identity | `test/ci-merge-freshness.test.mjs`: real Git stale-event-base and remote-main mismatch scenarios, plus receipt policy |
| Stale PR base metadata, wrong event merge/head, all-job immutable source | real Git receipt scenario and CI checkout contract |
| Receipt failure does not stop test planning; missing proof still blocks merge | non-blocking receipt-step contract and missing-receipt rejection |
| 12-hour edge, future/invalid time, reruns | policy clock scenarios |
| Failed/missing/latest CI, conflicts, malformed evidence | rejection scenarios |
| Expiration, evidence API failure, changing head | fake GitHub sweep journey |
| PR read/create/update failure isolation and visible partial failure | two-PR sweep scenarios and workflow contract |
| Status publication independent of old check-suite assignment; unchanged-head refresh and expiration | repeated production sweep with commit-status API fixture; hosted merge recognition remains a separate gate |
| Both publications revoked on partial failure; failed final write remains non-success | dual-publication failure journeys |
| Status history unavailable or capacity near 1,000 cannot strand success | status-history failure and capacity boundary scenarios |
| Shared head SHA does not select another PR's run or an older success | PR-specific run selection scenario |
| Shared-head publications cannot lend one PR's evidence to another | both PR orderings, newly shared head after evidence IO, and failed re-list journeys |
| A closed PR's current head does not remain successful after its close handler runs | success/close/reuse journey and closure revocation before failed open-PR listing |
| Retargeting away from main revokes current-head success | retarget/revoke journey with failed listing; all-base event trigger and protected-main checkout assertions |
| Migration cannot retain the obsolete required context | authority audit rejects legacy alongside replacement while allowing unrelated checks |
| Artifact bytes never executed or extracted | real ZIP decoder scenarios |
| Trusted checkout, permissions, schedule and required contexts | workflow/ruleset contract scenario |
| Existing release authority remains configured | desktop-shell release-authority audit scenario |

Focused entry: `npx vitest run test/ci-merge-freshness.test.mjs`.
Workflow/planner changes still select the full existing CI portfolio; required
local gates remain `npm run check` and `npm run build`. Hosted scheduled evidence
is a separate activation gate, not supplied by local fakes.

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

The four Rust lanes, their Rust aggregate, and Vitest use `!cancelled()` so a
superseded workflow stops spending runner time. Their acceleration dependencies
remain fail-open: a failed or skipped Ladybug build does not prevent the Rust
lanes from restoring a trusted bundle or building Ladybug from source, and a
failed runtime-cache build remains visible to Vitest and the stable `check`
aggregate.

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
the plan results, never from the acceleration job. The bundle records the
commit and resolved lbug feature set that built it for provenance. Its cache
key binds platform, rustc release, and `Cargo.lock` digest; verification also
checks the pinned lbug version and packaged bytes. For pinned lbug 0.18.0,
features affect Rust/FFI compilation separately from the cached native CMake
library and headers, so a feature-only change does not invalidate that bundle.
This is the bundle verifier's acceptance rule, not proof of native equivalence:
its feature-metadata fixture only checks that producer feature provenance does
not reject an otherwise intact bundle. The production Cargo-resolved source
path is separately checked against the reviewed lbug version, crates.io
checksum, and canonical full-package tree digest. The source-preparation path
checks the same complete package tree after extracting the checksum-pinned
crate; its resolved-tree exclusions are Cargo's generated root `.cargo-ok`
registry marker, which is absent from the crate archive, and lbug's generated
crate-root `.cache` build directory. A file or symlink at `.cache`, and any
nested source `.cache`, remain reviewed bytes. Re-review this native
source contract before changing the lbug pin or any package source bytes. The manifest also
carries a digest over every packaged file plus the library size, so a
truncated include tree or a failed debug strip is rejected before any lane
links. One accepted cost: while the bundle cache keeps hitting, the lanes no
longer repopulate the Ladybug objects in sccache, so a later fallback to the
source build pays a cold CMake compile until it re-stores them. Tests still
compile and run freshly against whichever library they link; the bundle is
acceleration, never evidence.

Vitest worker policy lives in `vitest.config.js`, not in the chapter
runner: the isolated project runs with file-level workers and the
process-bound files run one at a time after it.
Native Mach-O closure sealing and calibration Git/npm verifier journeys belong
to that process-bound group: their existing test bounds pass when isolated but
can expire under portfolio-wide subprocess contention. Their assertions and
timeout bounds remain unchanged. The chapter must not pin `--maxWorkers`, and a
deterministic test enforces that. The same file sets
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
Native receipt verification also selects packaging and the packaged-lifecycle
checkpoint because the pinned packaging module imports that verifier.
`docs/graph-query-v1.md` is a compile-time input of the graph-core query
contract tests, so it selects the Rust closure of `relayer-graph-core`.
`docs/graph-query-v1-errors.json` is the source of the generated
query-error code and the Python client contract, so it selects the
`@relayer/graph-client` workspace closure and the Python chapter.

Eval-only host and dashboard paths (`desktop/eval-main/` and
`desktop/eval-renderer/`) retain the desktop owner's complete source Vitest and
runtime prerequisites but do not select packaging. These checkout-only paths
are excluded from the public Electron application (PRD §9.1, ADR 0003).
The exclusion applies per changed path: mixed edits to shipped desktop code,
shared renderer, packaging, release, or dependency inputs still select packaging,
and unknown inputs still select the full portfolio. `@relayer/eval-runner`
remains a checkout workspace for Eval and evidence tooling, not a production
desktop dependency; the bundle verifier rejects it in the assembled application.
Desktop explicitly retains `@modelcontextprotocol/sdk@1.30.0`, the optional peer
of Prime's Google SDK previously supplied by Eval-runner, to preserve the pinned
Prime dependency closure.
Planner and bundle-verifier checkpoints live in `test/ci-affected-plan.test.mjs`
and `test/desktop-shell.test.mjs`. This does not narrow the source test portfolio
or the local pre-commit gates.

## Development packaging acceleration

`npm run desktop:pack` still assembles a fresh application and executes its
actual `afterPack` verification. Apple-Silicon development packaging now keeps
two independent, verified build caches under `.relayer/packaging-cache-v1`:
reviewed Ladybug sources/static OpenSSL preparation, and the two release-profile
Rust server binaries. Local runs reuse their private entries; Actions restores
compatible trusted branch entries and saves only on successful branch pushes.
These entries contain build outputs, never test results or an accepted ASAR.
`RELAYER_PACKAGING_CACHE=off` requests the ordinary fresh build path.

Every entry carries its exact file inventory, executable modes, SHA-256 values
and input identity. Reuse verifies all bytes before installing binaries or
exporting native paths. Identity binds repository/cache location (OpenSSL
prefixes are not relocatable), source/native manifests, packaging implementation,
Rust/Clang/Cargo/CMake/Perl/Make/SDK identities, target, default features and
release profile. All crate files, including local untracked files and migrations,
are hashed. Symlinks, external Cargo path packages, custom Cargo configuration,
unsupported compiler overrides and target directories disable reuse. The
reviewed build scripts/configuration in `scripts/ci/packaging-input-contract.json`
name the input-contract boundary: changing or adding one disables reuse until its
external inputs have been reviewed and the contract updated. Never update those
digests mechanically to obtain a hit. Development entries cannot supply signed
release compilation; the separate signed-profile contract below owns that reuse.

A miss or rejected entry builds fresh. Concurrent cache writers fall back; failed
compilation is not retried or published. License readiness and the actual ASAR,
resource, architecture, static linkage and bundled graph-server checks remain
fresh on hits. Stage durations cover identity, native fetch/staging/OpenSSL,
cache verification/build, Cargo, Electron, and afterPack. Telemetry cannot turn
successful verification into failure.

The packaging restore adapter uses the pinned `@actions/cache` SDK in an isolated
process so its otherwise swallowed service diagnostics are observable. It adds
at most one 5–10 second jittered retry for an explicit 429/5xx, honors reported
Retry-After up to 60 seconds, and falls back immediately for longer service waits,
ordinary misses, authorization/unknown errors or a timed-out attempt. Each SDK
attempt has a 120-second process bound; the SDK also has its own internal retries
for some server failures. This policy does not retry build or verification errors.
Cache saves and transport remain optional acceleration. SDK diagnostics and
attempt/hit classifications are logged; no credentials are copied into receipts.

The exact prose-only `docs/evidence/issue-477-recursive-fixture-abort/README.md`
is reviewed as having no CI consumer. Its addition/modification alone runs plan,
quick and `check`; a deletion or non-file replacement remains full coverage.
Mixed fixture edits retain fresh Vitest, and desktop edits retain packaging.
Every other `docs/evidence/` path retains the conservative full-portfolio rule,
including executable probes, qualification receipts and unknown documents.


### Restore only what packaging needs

Packaging computes its input identity before restoring Cargo. The workspace's
locked `cargo metadata --no-deps --offline` query is tested with an empty Cargo
home; it does not fetch registry dependencies. If identity is unavailable, the
lane takes the ordinary fresh-build path.

The lane restores the small release-runtime entry first, then verifies its
receipt, every file digest/mode, and the exact two regular binaries. Only a
verified entry skips the broad Cargo archive, Cargo fetch, and native-prefix
restore. An Actions `cache-hit` value alone cannot skip those steps. The package
builder rechecks the entry and licensing before reuse and always runs Electron
and afterPack. If a verified entry disappears or changes before consumption,
`RELAYER_PACKAGING_FETCH_ON_MISS=1` seeds locked dependencies before falling back
to the offline native/Cargo build. Missing optional output metadata also takes
the fresh path. Trusted saves only publish entries actually prepared by the job.

The bounded retry accepts a reported reset through 60 seconds, including the
observed 36-second response. Longer waits still fall back immediately; each
restore gets at most two SDK attempts. Telemetry records the chosen delay or
budget rejection. Retrying a service failure does not imply an incompatible or
absent cache entry will become a hit.

## Signed Preview native compilation cache

The manual macOS arm64 signed-candidate job opts into a separate
`relayer.signed-native-cache/v1` workflow artifact. It contains only the two
unsigned Rust release binaries (`CARGO_PROFILE_RELEASE_DEBUG=1`, default
features), their dSYMs, and a manifest. Development/CI Ladybug and runtime entries
are never accepted as signed-profile output. A verified runtime hit avoids the
entire Rust/Ladybug/OpenSSL compilation and Cargo fetch; a miss fetches the locked
dependency closure and uses the existing pinned offline native build.

Input identity reuses the reviewed packaging input contract and binds all crate,
native-source and packaging bytes, repository/cache paths, target, toolchains,
SDK, feature/profile settings, symbol tools, signed build/telemetry implementation
and signed workflow. Unsupported ambient build settings disable reuse. Native
content can be reused across commits with identical inputs; the current
candidate still requires its own exact-source main CI and fresh release metadata.

Restore searches at most five pages of 100 recent workflow artifacts and considers up to five
matching identities. Each entry requires GitHub API provenance for this repository,
this manual main signed workflow, a completed successful run and successful
macOS arm64 package job in the named attempt. Artifact name and receipt bind run,
attempt and source commit. Download uses the immutable artifact ID and requires
its API SHA-256 archive digest before extraction. ZIP extraction accepts only the
fixed binary/dSYM/manifest inventory, rejects links, duplicates and extra paths,
and bounds compressed and expanded bytes to 2 GiB. GitHub normalizes ZIP modes;
the extractor reinstates only code-owned binary executable modes before comparing
the sealed inventory. A post-download metadata check rejects a changed attempt.

Sealing generates symbols while Cargo objects exist, rejects dsymutil warning or
error diagnostics, and requires compilation units, valid DWARF and matching
arm64 UUIDs. Restore verifies every file hash and mode. Installation and telemetry
retain and recheck the authenticated inventory, including copied destination
bytes. Telemetry consumes these dSYMs instead of trying to reconstruct them from
bare cached binaries, then still correlates them with the freshly signed package.
This is structural symbol validation, not proof of live Sentry symbolication.

Restoration, rejection, eviction and cache-save failures are logged and fall back
to fresh compilation or already-built output. Compiler failures propagate without
retry. Only fresh native outputs are uploaded (30-day retention); a hit does not
republish its producer's receipt. Set `RELAYER_SIGNED_NATIVE_CACHE=0` to disable
this acceleration. Local builds remain fresh by default. Licensing, Electron
assembly, afterPack, signing, notarization, exact-source verification, current
source maps, telemetry upload and immutable candidate/publication gates remain
fresh and mandatory. No test result or release acceptance is cached.

Checkpoint mappings, local results and the outstanding authorized signed-run
proof gate are recorded in [signed cache evidence](../evidence/signed-native-cache/README.md).

### Command resource profiles

Rust lanes, Vitest and packaging opt into `RELAYER_CI_PROFILE_DIR`. The existing
chapter/timed runners execute each command once through a Python resource
collector and upload JSON profiles as optional 14-day artifacts, including on
failure. Profiles report elapsed time, child user/system CPU, maximum child RSS,
major page faults, block I/O counts and context switches. They preserve the
command's result; unavailable Python or unwritable reports do not retry a
command or change its result. Arguments and environment values are not recorded.

These are process resource summaries, not CPU stack samples. Maximum child RSS
is a wait4 maximum, not simultaneous process-tree memory; block counts are not
bytes. Long-lived daemons outside the waited command are not attributed. Nested
command totals overlap and must not be added together. Compare these summaries
with existing Cargo unit/concurrency reports and Vitest file/case durations to
choose a targeted profiler or integration setup/wait/teardown measurement.

## Windows release native build reuse

The independent manual `Windows Desktop Candidate` workflow has three acceleration layers. Qualification builds the actual release/default-features/debug-1 servers once; fresh unsigned packaging, afterPack PE/static-import/notices checks and graph-server create/lock/shutdown/reopen qualify those bytes. A private artifact seals only two EXEs, two GUID/age-matching PDBs and a manifest. Signing adopts that exact current-run input before login without compiling again. Labeled PRs retain their separate cold qualification recipe and cannot produce reusable release-native artifacts.

Cross-run reuse accepts only repository-owned manual-main artifacts with successful exact-source validation and Windows-2025 native qualification jobs. Later signing failure is permitted; native qualification failure is not. Immutable artifact ID/API archive SHA-256, run/attempt/source, exact archive inventory, per-file hashes, x64 PE/static imports, PDB identities and reviewed native/Rust/toolchain/profile inputs must all match. Producer metadata is rechecked after transfer. Same-run adoption is required and fails closed; optional lookup/rejection falls back to exactly one locked/offline source build. Optional lookup has a 120-second overall transport budget; required handoff has 240 seconds. Actual compiler failure is never retried as a cache failure.

Only a binary miss restores main-scoped Cargo/pinned-source downloads, hash-verified static native preparation at its stable runner prefix, and pinned local sccache 0.18.0 objects. Saves and cache service/setup failures remain optional. No PR writes these namespaces. Native identity binds compiler orchestration, actual resolved tools, MSVC/SDK paths and versions, reviewed build-script/configuration closure and case-insensitive ambient override rejection. Renderer, release version, installer and workflow-only changes do not invalidate native binaries. A compiler-orchestration edit intentionally invalidates native preparation and runtime output.

Every consumer repeats licensing, packaging and lifecycle checks; signed assembly, signatures, telemetry and sealing remain fresh. Receipts name either fresh release compilation or verified artifact reuse, never a cold-build claim on a hit. Non-gating compiler JSON statistics are retained for 14 days. `force_native_rebuild` proves the dependency/compiler fallback without modifying native sources. Main/macOS workflows do not depend on these caches or jobs. Source/fixture proof and hosted cold/hit/fallback proof are recorded separately in the [ledger](../evidence/windows-native-cache/README.md).
