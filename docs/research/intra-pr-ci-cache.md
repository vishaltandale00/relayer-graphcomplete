# Automatic intra-pull-request Rust compilation cache research

Research date: 2026-08-31

Post-merge optimization review: 2026-09-01 UTC, after PR
[#381](https://github.com/vishaltandale00/relayer-graphcomplete/pull/381)

## Decision

Canary Mozilla sccache in the `Rust checks and fresh tests` job. Ordinary
same-repository pull-request runs automatically reuse and publish
content-addressed compiler objects. Fork pull requests receive no sccache
binary integration or compiler-cache credentials and compile directly. Tests
remain fresh, cache availability is never evidence, and sccache failure falls
back to direct compilation when setup or its daemon start is
unavailable. A later nonzero wrapped compiler result propagates without retry
so genuine compiler failures are not masked.

Do not add a manual workflow, checkbox, label, or whole-`target/` rolling
archive. The existing local Rust target measured 11 GiB before compression,
larger than GitHub's default 10 GB repository cache allowance. See the
[Issue #360 timing baseline](../evidence/issue-360-ci-baseline.md).

## Why sccache instead of a target archive

GitHub cache entries are immutable archives. A rolling `target/` design would
need a new archive per generation, transfer large overlapping trees, and manage
eviction. GitHub removes entries that are not accessed for more than seven days
and evicts least-recently-used entries when a repository exceeds its allowance.
([GitHub usage and eviction policy](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy))

sccache instead keys compiler outputs by the compilation inputs and stores
individual reusable results. Its GitHub Actions backend supports an explicit
`READ_ONLY` mode, defaults to `READ_WRITE`, and documents that a service rate
limit may prevent storage without stopping the build.
([sccache GitHub Actions backend](https://github.com/mozilla/sccache/blob/main/docs/GHA.md))
This better matches a pull request where most dependencies and compilation
units remain unchanged between heads.

`Swatinem/rust-cache` remains a good dependency-oriented alternative, but its
default cleanup removes workspace crates and incremental artifacts before
saving. That controls archive size while reducing the state retained from the
repository code being edited.
([rust-cache inputs and cleanup](https://github.com/Swatinem/rust-cache#cache-details))

## Scope and trust boundary

GitHub scopes caches by key, cache version, and ref. A pull-request run may read
compatible entries from its current ref and base/default branch. Entries
created for `refs/pull/<number>/merge` are available only to that pull request,
not to `main` or sibling pull requests.
([GitHub cache access restrictions](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache))

The canary therefore uses these rules:

1. `main` and `integration/**` runs may read and write within their trusted ref
   scope.
2. Same-repository pull requests may inherit compatible trusted compiler
   objects and write new objects within their pull-request scope.
3. Fork pull requests skip the sccache action, receive no Actions cache service
   credentials through it, and compile directly with `rustc`.
4. Trusted branches and sibling pull requests never restore objects that exist
   only in another pull request's scope.
5. The compiler-cache namespace includes a schema version, runner OS and
   architecture, Rust release, and host. sccache's content key additionally
   covers the compiler invocation and source inputs.

Caches are not signed or verified and must never contain credentials. A cache
hit cannot satisfy a test, product, release, or authority gate.
([GitHub cache security](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#best-practices-for-using-caches-securely))

## Fail-open boundary

The Mozilla setup action is pinned by commit and installs a pinned sccache
release. Setup and an explicit daemon start are `continue-on-error`;
when either is unavailable, the checked-in compiler wrapper invokes `rustc`
directly. The GitHub backend documents that rate-limit storage failures do not
stop compilation. Any later nonzero sccache result propagates without rerunning
the compiler because sccache also propagates real compiler failures and the
wrapper cannot safely distinguish them. The Rust step enables sccache's native
server-I/O fallback so loss of daemon communication invokes the local compiler
without masking a compiler result. The telemetry step is non-blocking.

This means the required job can fail for compilation or test behavior, but not
solely because acceleration was unavailable. Valid objects written before a
later compile or test failure may remain cached because they are acceleration,
not proof.

The Rust canary removes `target/` from its Actions archive and retains only the
smaller Cargo registry and git download paths there. Vitest, full-gate, and
packaging jobs keep their existing compilation archives during the canary so
the experiment changes only one job. It sets `CARGO_INCREMENTAL=0` because
sccache cannot cache incrementally compiled Rust crates; that setting is scoped
to the canary job.

## Evidence and expansion rule

Reuse the existing hosted Issue #360 cold baseline. Do not create multiple
synthetic cold runs. Observe:

1. one real pull-request run that seeds sccache; and
2. the next real changed-head run that can reuse those objects.

Expand sccache to another job only if the changed-head run shows real compiler
cache hits, saves at least five minutes of Rust compilation time, introduces no
required-job failure, and does not evict or thrash trusted main, packaging, or
npm caches. Record setup outcome, hit/miss/error counts, write/read durations,
and the Rust chapter duration in the job summary and evidence ledger.

## Post-#381 measured bottlenecks

The table below uses GitHub's recorded job and step timestamps. It distinguishes
successful observations from targets. #381's final run is a genuine same-PR
changed-head warm comparison, but because the workflow/cache implementation
itself forced full mode, it is not yet a representative affected-component PR.

| Successful run | Full gate | Rust job | Vitest job | Other selected work |
| --- | --- | --- | --- | --- |
| [`main` after #359](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33462685754) before the sccache canary | 31m23s job; 29m05s required check/build; 1m51s target-cache save | 11m59s job: 4m01s target restore plus 7m35s compile/check/test | 6m42s job: 2m49s target restore, 30s prerequisites, 2m50s fresh tests | TypeScript job 31s with 10s actual build; packaging 4m37s with 3m46s actual package build |
| [#381's successful warm changed-head PR run](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33463966913) | 30m24s job; 29m49s required check/build; no usable target restore | 13m04s job: sccache setup/start about 1s, then 12m35s compile/check/test; 5m26s faster than the recorded 18m30s baseline | 8m06s job: 4m14s target restore, 40s prerequisites, 2m44s fresh tests | TypeScript job 24s with 7s actual build; packaging 5m14s with 4m18s actual package build |

Three conclusions follow from the successful evidence:

1. The full repository gate remains the critical path whenever the planner
   selects `full`; the first sccache seed did not change that job.
2. Rust and Rust-backed Vitest prerequisites dominate. TypeScript, Python,
   receipts, PRD, and Node setup are currently too small to justify invasive
   caching work.
3. A large target archive can save compilation but costs minutes to restore.
   The relevant comparison is end-to-end wall time, not a nominal cache hit.

The first post-merge `main` run is **not** successful workflow evidence, though
its individual Rust job did finish successfully. Its full-gate target restore
took 3m20s and reached the full Vitest phase about 6m18s after the gate began,
but a fresh Vitest assertion failed at 9m06s. Its separate Vitest job missed the
target cache, spent 17m58s rebuilding prerequisites, ran fresh tests in 2m49s,
and saved the new archive in 47s. The sccache Rust step took 31m39s, versus
12m35s for #381's PR seed and 7m35s of compilation/check/test after a 4m01s
target restore in the pre-canary run. This `main` execution is another branch
seed, not the required warm changed-head comparison: GitHub cache entries made
on a pull-request merge ref cannot be restored by the default branch.
([GitHub cache matching and scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#cache-key-matching))

During that Rust writer, the repository cache API reported 3.69 GB across
1,314 active entries and the newest entries were `sccache/*` objects. A later
completed-run snapshot reported 3.89 GB across 1,449 entries, including 1,445
main-scoped sccache objects totaling 793,942,004 bytes. These are
early transfer/rate-limit warnings, not a claim that sccache caused the failed
workflow or that a warm run will be slow. The sccache statistics were written
only to the job summary, not the downloadable log, so this review could not
independently recover the hit/miss/error breakdown from the completed job.
([post-merge run](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33465911128),
[GitHub cache usage and rate limits](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy))

## Post-#392 parallel-lane observations

PR #392 replaced the serial Rust chapter with four isolated lanes
(`rust-clippy`, `rust-tests`, `rust-crash`, `rust-runtime`) sharing one
toolchain-bound sccache namespace (`relayer-rust-parallel-line-tables-v1`),
removed the duplicate serial full gate in favor of the versioned verification
portfolio, and passes runtime binaries to Vitest through a verified workflow
artifact.

Measured hosted runs (job start to completion, GitHub timestamps):

| Run | Context | Clippy | Tests | Crash | Runtime | Vitest | Whole workflow |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [PR #392 final](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33483636709) (new namespace, effectively cold) | full-mode PR | 12m29s | 13m19s | 14m30s | 12m07s | 3m29s | about 16m46s |
| [first `main` push after merge](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33485024514) (trusted cold seed) | full portfolio | 18m40s | 20m11s | 21m44s | 20m13s | 3m14s | about 24m26s |

The PR run is the first consumption of the parallel namespace, so its lanes
seeded and cross-read each other instead of reusing trusted objects; the
`main` push is the first trusted writer. Both are cold comparisons for the new
namespace, not the steady-state warm target. The next real changed-head PR
after the trusted seed is the admission comparison required by
`docs/agents/ci.md`.

The PR run's lane artifacts recorded the expected cold-namespace consequence:
47–59% cache-hit rates dominated by C/C++ objects, Rust hit rates of 16–25%,
and 457–567 cache write errors per lane. The write errors are four lanes
compiling and storing the same compiler objects concurrently; the losing write
for an identical key is harmless because the winning lane stored the same
content-addressed object. Steady-state warm runs only recompile changed units,
so duplicate writes collapse to the lanes that share each changed unit.
Average cache write latency was 0.18–0.71s and read hits 0.07–0.23s. No read
errors were observed. Write errors remain nonfatal by backend contract; they
are recorded per lane in the 14-day sccache statistics artifacts.

Vitest no longer compiles Rust. Its job downloaded the 255 MB runtime artifact
(both server binaries with the `line-tables-only` profile), verified its
identity fields, installed the binaries into `target/debug`, and ran every
selected test freshly in about 3m15s.

`--timings` reports now upload from the Clippy, default-test, and runtime
lanes (harvested from each lane's target directory; the crash lane executes
through the repository npm script, which cannot inject Cargo flags, so it
records step durations only). Use the reports to identify repeated compilation
units before any further feature/profile consolidation.

The first warm PR run after the trusted seed ([33493873593](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33493873593),
full mode, about 15m36s end to end; Clippy 9m27s, tests 12m44s, crash 12m17s,
runtime 10m58s) still recorded 50–60% hit rates and 437–535 write errors per
lane. The trusted seed itself ([33485024514](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33485024514))
had 0% Rust hits and 856–1029 write errors per lane, so it stored only a
fraction of the compiled objects (2,359 main-scoped sccache entries after the
seed). The self-perpetuating pattern: four lanes cold-miss the same units,
each stores the winning write for an identical key and fails the other three,
and every unit that never stored is re-missed and re-raced on the next run.
One mitigation is now in place: the runtime lane is read-only. Its unique
outputs are uncachable binary links and its shareable units are identical to
the default-test lane's, so it no longer races the seeding lanes; the
default-test, Clippy (rmeta graph), and crash (crash-feature graph) lanes
remain the writers.

The first run with the read-only runtime lane ([33495979365](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33495979365),
about 12m20s end to end) shows convergence beginning:

| Lane | Hit rate before / after | Write errors before / after |
| --- | --- | --- |
| rust-clippy | 55.0% / 64.0% | 493 / 384 |
| rust-tests | 50.6% / 69.8% | 535 / 293 |
| rust-crash | 59.9% / 73.6% | 437 / 258 |
| rust-runtime | 58.3% / 64.7% | 466 / 451 (stores refused, 0.000s write time) |

The runtime lane's "write errors" are its rejected stores counted by sccache
in read-only mode; its average cache write is 0.000s, so it performs no cache
I/O and creates no entries. Lane durations fell to Clippy 7m31s, runtime
7m55s, tests 9m22s, and crash 10m19s.

The next two runs confirmed the convergence ([33497316910](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33497316910)
failed one pre-existing timing flake in `product_persistence_flow.rs` that was
fixed separately; [33498832402](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33498832402)
passed end to end in about 11 minutes): hit rates reached 83.0% clippy, 83.5%
tests, 80.3% crash, and 78.7% runtime (Rust-only hits 60–65%), while writer
write errors fell to 167–236. The read-only runtime lane reports its refused
stores with 0.000s average write time throughout. Remaining misses are
dominated by the per-run changed units and the Ladybug build-script graph
identified by the timing reports.

### What the first hosted timing reports show

The `--timings` artifacts from the warm PR run (33493873593) identify the
critical unit in every lane: the `lbug` build-script execution (the bundled
Ladybug source build forced by `LBUG_BUILD_FROM_SOURCE = "1"`).

| Lane | Wall | lbug build-script unit | Share of wall |
| --- | --- | --- | --- |
| rust-clippy | 555.6s | 479.6s | 86% |
| rust-tests | 709.4s | 513.2s | 72% |
| rust-runtime | 612.2s | 475.7s | 78% |

The next largest units are the workspace crates themselves (about 100–114s
each for the app-server and graph-server test builds) and their test-binary
links. Two consequences follow: further feature/profile consolidation of the
workspace crate invocations can save at most a few minutes per lane, while
anything that shortens or cache-shares the Ladybug source build attacks the
majority of every lane's wall time. Investigation of the lbug unit found that the bundled CMake build already
auto-detects sccache on `PATH` and uses it as the C/C++ compiler launcher,
but the lanes' per-lane `CARGO_TARGET_DIR` values put generated build headers
at different absolute paths per lane. C/C++ cache keys hash preprocessed
source, including those absolute line-marker paths, so every lane maintained
its own fragment of the Ladybug object cache while sccache's Rust keys (which
omit `--out-dir`) were unaffected. Because every lane runs on its own fresh
runner, the lanes now share one `CARGO_TARGET_DIR` path; the identical path
makes the generated-header paths match across lanes and runs, letting the
Ladybug objects compile once and be read by all lanes. Candidate directions
that remain unvalidated: `SCCACHE_BASEDIRS` normalization if other volatile
paths appear, and whether the reviewed prebuilt-library path from the Issue
#261 qualification can be reused without weakening its provenance guarantees.

One premise to monitor: the Ladybug CMakeLists prefers `ccache` and only falls
back to `sccache`. GitHub's Ubuntu images currently ship neither, so CMake
finds the sccache binary installed by the pinned action. If a future runner
image adds ccache, the launcher silently switches to a runner-local cache and
the cross-run Ladybug benefit disappears without changing correctness.

### Warm result after the unified target directory

The first warm run on the unified path ([33517115657](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33517115657),
about 11m20s end to end; Clippy 7m04s, runtime 6m24s, tests 8m35s, crash
10m49s) reached 88–91% C/C++ hit rates in every lane with the object cache
genuinely shared across lanes. The lbug unit nonetheless held at 244–328s per
lane. The honest accounting: the unification removed the per-lane key
fragmentation (per-lane C/C++ misses fell from 281–480 to a stable 116–150),
which protects every future cache reseed from paying four full Ladybug C++
compiles, but the remaining lbug wall is bounded by a per-run miss tail and
CMake configure/archive overhead rather than by cache sharing. The prime
suspect for the stable miss tail is CMake's configure-time feature probes,
whose scratch-directory sources carry volatile absolute paths; confirming that
would need `SCCACHE_LOG`-level debugging on a hosted run. The next material
levers are therefore the crash-lane cadence staging and any reduction of the
configure/probe cost, not further cache-key work.

### Local sccache experiment on the Ladybug build

To test whether the per-lane Ladybug floor was compile cost or cache overhead,
the pinned sccache 0.17.0 was run locally against `cargo build -p lbug` with
CI-parity settings (`CARGO_INCREMENTAL=0`, `line-tables-only` dev profile,
`RUSTC_WRAPPER=sccache`):

| Run | Wall | Requests | C/C++ hits | C/C++ misses |
| --- | --- | --- | --- | --- |
| 1, cold cache | 249s | 1125 | 0 | 1062 |
| 2, fresh target dir, same cache | 43s | 1125 | 1054 (99.25%) | 8 |

Two conclusions follow. First, the Ladybug CMake build is effectively fully
cacheable through sccache when paths are stable; the cold 249s matches the
hosted per-lane Ladybug unit (244–328s), so the hosted lanes are paying close
to the cold compile cost shape despite their 88–91% C/C++ hit rates. Second,
the hosted floor is therefore dominated by cache overhead rather than
compilation: roughly 1,000 cache reads at the observed 0.07–0.23s each, CMake
reconfiguration and its configure-time probes, the residual miss tail, and the
final archive step, all on four cores. Cache-key work cannot reduce that floor
further. The remaining candidate with material headroom is building the pinned
Ladybug source once in a trusted job and restoring the resulting static
library through a source-hash-keyed cache entry (`LBUG_LIBRARY_DIR` +
`LBUG_INCLUDE_DIR` are supported by the crate build script); that keeps the
reviewed bundled source as the build input and every test fresh, but it
changes the "compile from source in every lane" property and needs an explicit
decision before implementation.

Decision (approved 2026-09-01): implemented as the `Prebuilt Ladybug native
library` job. It builds `cargo build -p lbug` once per run, strips debug info
(1.8 GB to ~440 MB in local measurement), and serves the bundle to every Rust
lane through an identity-verified workflow artifact plus a trusted-push cache
keyed on platform, rustc release, and `Cargo.lock` digest. Lanes verify the
bundle before linking and fail open to the source build when it is missing or
rejected, so the change cannot weaken verification. Local equivalence proof:
the default, crash-feature, and query-conformance suites all pass against the
externally linked bundle (one load-induced wall-time-budget flake reproduced
green in isolation).

## Ranked next options

### 1. Keep sccache admitted in Rust, then verify the trusted-main consumer

**Expected impact:** high if a real changed-head run reuses most library
compilations; negative if per-object service I/O outweighs the saved compile.
**Correctness risk:** low for verification, medium for reliability and cache
storage. Tests still run, but service latency and eviction can extend the
required job.

sccache is not a complete replacement for Cargo's warm target directory. Its
Rust support requires incremental compilation to be disabled and cannot cache
crates that invoke the system linker, including binaries, `dylib`, `cdylib`,
and procedural macros. Its hash includes rustc, sysroot, compiler arguments,
source, and dependency inputs; absolute-path normalization is available through
`SCCACHE_BASEDIRS` if equivalent hosted checkouts fail to match.
([sccache Rust limitations](https://github.com/mozilla/sccache/blob/036fc5c8b6b6f807a70eaf58fd3fe6025454fddb/docs/Rust.md),
[sccache Rust keys](https://github.com/mozilla/sccache/blob/036fc5c8b6b6f807a70eaf58fd3fe6025454fddb/docs/Caching.md#rust),
[path normalization](https://github.com/mozilla/sccache/blob/036fc5c8b6b6f807a70eaf58fd3fe6025454fddb/README.md#normalizing-paths-with-sccache_basedirs))

The #381 warm changed-head run cleared the predefined five-minute admission
threshold, so retaining the Rust canary is justified. The next representative
affected-component PR after the trusted `main` seed should record:

- total Rust job and compile/check/test step time, excluding queue time;
- cacheable requests, hits, misses, non-cacheable reasons, read/write errors,
  timeouts, and backend location from `sccache --show-stats`;
- repository cache count and bytes before and after;
- the exact toolchain, runner image, profile, features, flags, and effective
  `CARGO_INCREMENTAL=0` setting; and
- a no-cache fallback result proving a service failure does not change source
  verification.

Emit the statistics to durable logs or an artifact as well as the job summary;
a green job is not proof that a fail-open backend stored or restored anything.
The GitHub backend documents read-only/read-write modes, separate read/write
keys, and nonfatal storage rate limits.
([sccache GitHub backend](https://github.com/mozilla/sccache/blob/036fc5c8b6b6f807a70eaf58fd3fe6025454fddb/docs/GHA.md),
[sccache configuration](https://github.com/mozilla/sccache/blob/036fc5c8b6b6f807a70eaf58fd3fe6025454fddb/docs/Configuration.md#cache-configs))

Keep monitoring whether the already-observed five-minute end-to-end saving
persists without cache growth or reliability regression. Before expanding
sccache to another job, compare that job's current whole-target transfer plus
compile time with a mutually exclusive sccache canary on the same commands and
realistic changed-head delta; do not combine sccache with Cargo incremental
compilation.

### 2. Mature the existing full-gate and Vitest target-cache baseline

**Expected impact:** high for full-mode PRs and Rust-backed Vitest setup.
**Correctness risk:** low for verification, medium for transfer time and quota.

The post-merge run suggests the full-gate archive can move the workflow from a
roughly 29-minute cold gate toward the Issue #360 target, but that run failed
and therefore cannot establish a warm success. The newly seeded Vitest archive
also needs one successful consumer. Preserve the current trusted-branch writer,
fresh tests, and separate cache keys while collecting two successful consumers
with archive bytes, restore time, prerequisite time, and eviction data.

Cargo documents `target/` as an internal build cache containing dependency
artifacts, fingerprints, and incremental state; it explicitly names sccache as
the shared-cache alternative. Target state is sensitive to paths, toolchain,
profile, features, and flags, so it remains rebuildable acceleration rather
than an artifact contract.
([Cargo build cache](https://doc.rust-lang.org/cargo/reference/build-cache.html),
[GitHub cache versus artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/dependency-caching#artifacts-versus-dependency-caching))

Do not promote final executables or a whole `target/` tree through workflow
artifacts as a shortcut. Artifacts are for explicit outputs and provenance;
they do not make an untested compilation reusable evidence for a later source
snapshot.

### 3. Use Cargo timings, then canary reduced debug information

**Expected impact:** medium, especially for linking and target/cache size.
**Correctness risk:** low to medium because CI backtraces become less detailed.

Add `--timings` to the actual Clippy/test/build experiments and retain the HTML
report. Cargo's report exposes each compilation unit, features, critical path,
active/waiting/inactive concurrency, and maximum concurrency; it does not show
rustc-internal concurrency.
([Cargo timings](https://doc.rust-lang.org/cargo/reference/timings.html))

Then compare the current profile with CI-only
`CARGO_PROFILE_DEV_DEBUG=line-tables-only` and
`CARGO_PROFILE_TEST_DEBUG=line-tables-only`, keeping debug assertions,
overflow checks, features, and tests unchanged. Cargo says `line-tables-only`
retains filename/line information for backtraces with much less debug data.
The test profile inherits dev; non-incremental builds default to 16 codegen
units, while incremental builds default to 256. Codegen-unit changes trade
compile parallelism against generated-code quality, so tune them only after the
timing graph shows idle CPU or codegen pressure.
([Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html#debug),
[Cargo default profiles](https://doc.rust-lang.org/cargo/reference/profiles.html#default-profiles))

Measure cold and warm wall time, linker time, cache bytes, and failure
backtrace usefulness. The profile change must have its own cache namespace.

### 4. Reduce false full-mode selection only through explicit ownership

**Expected impact:** potentially very high because it can omit the 30-minute
full gate on a component PR. **Correctness risk:** high.

Replay the planner against a representative recent PR set and count the exact
reasons that selected `full`. For example, #359 correctly failed open because
it changed `package.json`, the PRD, evidence paths, and unmapped executable
scripts. A path may leave `full` only after its product, authority, test, build,
and release consumers have explicit owners and deterministic checkpoints.
Unknown and unmapped changes must continue to select the complete portfolio.

Measure the percentage of recent PRs whose only full-mode reasons become
explicitly mapped, plus their resulting critical-path reduction. Review every
mapping adversarially; never infer that documentation, evidence, or scripts are
non-executable from their extension or directory alone.

### 5. Audit duplicate Rust feature/profile configurations

**Expected impact:** high on cold/full runs. **Correctness risk:** high because
different invocations protect different feature and authority boundaries.

The current gate compiles Clippy with all targets/all features, tests default
features, separately tests crash-support configurations, and builds the
servers. Use Cargo timings to identify the repeated units and then map each
configuration to its unique checkpoint before removing anything. Cargo features
are additive and feature unification can enable a different union than a
default-feature test, so an all-features pass is not automatically a substitute
for the default and crash-support cases.
([Cargo feature unification](https://doc.rust-lang.org/cargo/reference/features.html#feature-unification))

Require replacement-before-deletion, exact command comparisons, mutation or
subsumption evidence, and the unchanged repository-required full gate at the
integration boundary until equivalence is established.

### 6. Partition only isolation-safe Vitest files

**Expected impact:** bounded at roughly three minutes in the measured full
suite, but more valuable after Rust falls below ten minutes. **Correctness
risk:** medium because this suite intentionally runs with one worker and
contains processes, timers, files, ports, and shared application state.

Vitest supports file-level workers and deterministic shards, and blob reports
can be merged after shards complete. It also warns that file parallelism is
unsafe when tests share an external resource. Keep every test fresh, identify
explicit isolation-safe groups, and run the unsafe group serially; do not simply
raise `maxWorkers` globally.
([Vitest parallelism](https://vitest.dev/guide/parallelism),
[Vitest sharding CLI](https://vitest.dev/guide/cli#shard),
[Vitest blob reports](https://vitest.dev/guide/reporters#blob-reporter))

Compare at least ten repeated hosted runs for runtime and flake rate, including
process-shutdown and timeout-heavy tests. The current post-merge full-gate
failure is a reason to harden isolation first, not evidence that sharding is
safe.

### 7. Trial a larger Linux runner only if the account boundary permits it

**Expected impact:** medium to high for cold parallel compilation, low for
cache-service latency or a single serial linker. **Correctness risk:** low;
cost and availability risk are high.

GitHub larger runners offer 8- and 16-core Linux shapes, but require an
organization or enterprise on Team or Enterprise Cloud and are billed even for
public repositories. The current standard public Linux runner has four CPUs
and 16 GB RAM. If the repository becomes eligible, compare 4-core and 8-core
runs on the same source, command, image family, and cache condition; record
queue time, Cargo concurrency, job time, billed minutes, and dollars per
successful required run.
([larger-runner billing](https://docs.github.com/en/actions/concepts/runners/larger-runners#billing),
[larger-runner sizes](https://docs.github.com/en/actions/reference/runners/larger-runners#machine-sizes-for-larger-runners),
[standard hosted-runner hardware](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#supported-runners-and-hardware-resources))

### 8. Defer TypeScript incremental/project-reference work

**Expected impact:** low today; measured TypeScript work is 7–10 seconds.
**Correctness risk:** medium because it changes the build graph and persisted
state.

TypeScript project references and `tsc --build` can build out-of-date projects
in dependency order, and `.tsbuildinfo` persists the program graph. Those are
appropriate when TypeScript becomes material, but cache transfer and migration
work cannot repay meaningful CI time at the current scale.
([TypeScript project references](https://www.typescriptlang.org/docs/handbook/project-references),
[TypeScript incremental state](https://www.typescriptlang.org/tsconfig/incremental.html))

When revisited, preserve fresh compiler invocation, `noEmitOnError` or
`--stopOnBuildErrors`, exact config/lockfile keys, and declaration ownership.

## Recommended sequence

1. Capture sccache statistics and cache bytes in durable evidence. The staged
   reduced-debug profile intentionally starts a new compiler-cache generation,
   so use one seed followed by the next real changed-head run rather than
   manufacturing a separate consumer of the retired full-debug generation.
2. Compare the staged same-repository Vitest read-only sccache path against its
   measured 4m54s target-restore-plus-build floor. Keep fork and trusted-push
   target-cache paths until the candidate is admitted.
3. Retain reduced debug information only if the hosted seed/warm pair improves
   net Rust wall time and cache size without degrading actionable backtraces.
4. Replay full-mode planner reasons and audit Rust configuration duplication;
   implement only mappings or removals with explicit checkpoint ownership.
5. Partition Vitest only after the Rust critical path is below ten minutes.
6. Defer runner, TypeScript, Electron, and npm work unless new measurements
   make them material.

Throughout, the stable `check` aggregator, fresh selected tests, fail-open
unknown mappings, full integration boundary, manual merge, and all product,
authority, release, and PRD gates remain unchanged. Cache hits and compiler
objects remain acceleration, never verification evidence.

## Open-source precedent

No reviewed mature project implemented a separate manual cache-publication UX;
the common approach is automatic compilation caching with trust conditions:

| Project | Observed mechanism | Relevance |
| --- | --- | --- |
| Mozilla sccache | GitHub Actions backend with read/write and read-only modes. ([documentation](https://github.com/mozilla/sccache/blob/main/docs/GHA.md)) | Direct compiler-object mechanism used by the canary. |
| Mozilla sccache action | Installs a selected release, exports GitHub cache credentials, and reports compiler statistics. ([action](https://github.com/Mozilla-Actions/sccache-action)) | Setup and telemetry integration, pinned in the workflow. |
| Trust Wallet wallet-core | Uses both `mozilla-actions/sccache-action` and `Swatinem/rust-cache` in Rust CI. ([workflow](https://github.com/trustwallet/wallet-core/blob/master/.github/workflows/rust.yml)) | Demonstrates sccache in ordinary Rust pull-request CI. |
| Bytecode Alliance cargo-component | Uses the Mozilla action across Linux, macOS, and Windows. ([workflow](https://github.com/bytecodealliance/cargo-component/blob/main/.github/workflows/main.yml)) | Demonstrates multi-platform compiler caching; this repository intentionally starts with Linux only. |
| pnpm | Excludes oversized Rust targets when restore cost is not worthwhile and uses immutable keys for smaller outputs. ([workflow](https://github.com/pnpm/pnpm/blob/main/.github/workflows/pacquet-integrated-benchmark.yml)) | Supports measuring transfer/storage cost instead of assuming a large target archive helps. |

## Documentation consequence

The root `AGENTS.md` already points to `docs/agents/ci.md` and needs no new
mechanics. The CI guide owns the durable automatic-write, fork, fail-open,
fresh-test, evidence, and expansion rules.
