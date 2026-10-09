# Bounded compile-input read-policy diagnostic

Source baseline fb6e9c962eabf6e5f84c12cb0e5d570114a83a68. This successor leaves
#546 and parked #553 unchanged. It changes no product behavior, production cache,
required chapter, test selection, timeout, native ceiling or paid-inference policy.
PRD §15E/16.1 retains the distinction between diagnostic and product proof.

The earlier inventory cannot prove which files dependency build scripts or
procedural macros might read. This diagnostic stages two sources at the same
container path: every tracked file as control, and the declared repository
projection as treatment. Each gets an empty private target. No test output or
compiler-object cache is reused. Required file-read failures identify missing
inputs; successful compilation demonstrates only this recipe/snapshot, not
semantic equivalence or a validated production cache identity.

## Supported diagnostic recipe

`scripts/ci/compile-inputs/launch.py` pins and records the image digest, toolchain, environment,
absolute paths, source manifests, registry extraction receipt and qualified native
inventory. It uses a nonroot container with no network, no host home and a read-only
root/source/registry/native filesystem. Only fresh target, Cargo bookkeeping, tmp
and evidence roots are writable. Control and treatment run sequentially with the
same resource limit (two CPUs, 8 GiB memory/swap ceiling, 512 PIDs). The pinned image is
`sha256:9051430ada55d8edc9751e8e8a61811c7d29a41a502a2d4bedc3d762211cbeb8`.
A Linux alarm bounds preparation and execution to at most 1,200 seconds, plus
up to 30 seconds for owned-container cleanup. The factory grant must include an
independent outer watchdog and cleanup check; a launcher receipt alone does not
prove resource release. The unique owned container name is written before launch
so the outer watchdog can target it even if the launcher is interrupted. No previous target is mounted. Compilation is the complete
default workspace `cargo test --workspace --frozen --no-run --message-format=json`.
The production test chapter is unchanged and remains authoritative.

The launcher rejects differing tracked-source, candidate or policy digests between
control and treatment staging before dependency preparation or compilation. Registry
preparation reads the staged control lockfile, so it remains bound to that snapshot.
The script validates declared inputs before and after execution. It is not a
sandbox by itself; isolation belongs to the recorded launcher. Native preparation
uses the unchanged production verifier and 800 MiB ceiling. One cache-only Actions
job may export a qualified dependency for one day; a miss/rejection stops preparation
without a source-build fallback. The private consumer must reverify the archive
receipt, exact inventory and production native policy. This is dependency preparation,
not evidence that compiled-test cache transport works.

Locked registry archives are checksum-verified and safely extracted to a fresh
source tree. Linked members, non-registry dependencies, corruption and expanded
size overflow reject preparation. Extracted existing Cargo sources are never the
provenance authority. Cargo index/cache bytes, the explicit `CACHEDIR.TAG` bookkeeping file and the
extraction receipt remain
explicit inputs. The entire prepared registry is mounted read-only, including its parent, so Cargo
cannot introduce unrecorded registry bookkeeping. Unknown dependency/configuration
overrides stop the recipe.

## Input meaning and limits

`trackedSourceDigest` identifies tracked bytes/modes/paths only. The narrower
`candidateCompileDigest` includes crates, migrations, build support, Cargo and
configuration files, plus graph-query documents and fixtures embedded by tests.
Runtime permission catalogs and TLA traces remain separate fresh-test inputs.
Graph-query fixtures have mixed compile/runtime ownership. No excluded path is
proved irrelevant by a passing mutation fixture or one successful compilation.

Optional file reads can change generated behavior while compilation succeeds.
Clock, randomness, proc/sys, process metadata and image filesystem behavior remain
explicit assumptions/unqualified dimensions. No claim of universal determinism is
made. `completeDigest` stays null; no caller flag promotes it. Fresh doctest/example
execution equivalence, runtime loader behavior and actual cache benefit are not
established by this compile-only diagnostic.

## Seam/checkpoint map

| Executable seam | Checkpoint |
| --- | --- |
| Source staging and identity | Real included read succeeds; excluded required read fails; optional read remains a limitation; bytes/mode/new/untracked input drift is visible |
| Paired launcher staging | Included or excluded tracked-file mutation between phases stops before dependency preparation or any container execution; unchanged snapshots reach preparation using the staged lockfile despite later original-lock mutation |
| Recipe execution | Wrong source/native/toolchain/image/environment/registry rejects before execution; receipts preserve inner exits independently |
| Owned-container cleanup | Stop/inspect timeouts still attempt forced removal; cleanup errors remain explicit |
| Native consumer extraction | Exact transported archive and extracted inventory match; corruption and links reject before unchanged native qualification |
| Registry extraction | Real locked archive extracts; corruption and linked members reject |
| Historical normalization | Actual checkout overrides workflow head; truncated inventories stay unknown; actual tracked workspace guards include workspace manifests; drift prevents applicability |
| Candidate audit | Successful earlier writer before selected-job start and accessible ref only; cancelled/late/foreign/unqualified writers cannot become complete hits |
| Native dependency workflow | Cache-only, unchanged verifier before export, no compiler/test execution or unrelated artifact upload |

The Python scenarios run through `test/ci-compile-inputs.test.mjs` on Unix; the
workflow is Linux-only. Existing conservative CI ownership remains full coverage.
No test is retired. Required gates are `npm run check` and `npm run build` before
commit, with source-bound adversarial review. Actual read-policy compilation needs
one separately granted bounded Linux window; partial results and failures survive
its deadline. Plan, execution and evidence will be reported separately in the PR.

## Historical audit

`history.py` consumes retained raw checkout logs, job/run metadata, commit/tree API
responses and an explicit captured selection. Candidate Git-blob projection digests
are a separate namespace from filesystem SHA-256 manifests. Current build/discovery
guards must match before candidate compatibility is counted. Historical native,
toolchain, environment, cache version, publication and retention are not inferred.
Successful writers are hypothetical; actual cache hits remain unknown. Unknown
base/default-ref visibility is not fabricated. Same-ref visibility can still be
reported when evidenced by the PR checkout ref. Attempts and selected-job start
cutoffs remain explicit; earlier workflow creation is not the cutoff.

A current controlled recipe cannot retroactively qualify old unconstrained builds.
Do not relabel the previous 0/24 full-tree bound or 12/24 static projection as hits.
Stop this experiment with measured go/no-go and named missing inputs; do not grow
transport machinery or production sandbox policy to force a positive result.

## Exact-pair executable reuse diagnostic

`reuse.py`, `reuse_container.py` and `capture_runner.py` support a separately
bounded experiment, not a production cache. The initial proposed pair is actual
main parent `548de4c3f1bf61e8dd2aa11f4526b44fb043d2be` (A) and merge
`a437a59bddd258fd55753fa63ee4c1326df80a8f` (B). Their 16 changed diagnostic files
are outside the declared projection. This nominates the pair; it does not qualify
compilation identity.

Both full snapshots must compile independently at `/workspace` and `/target`,
with identical pinned image, toolchain, environment, registry and requalified native
inputs. Cargo JSON discovers all emitted test executables and ordinary helper
binaries. Every executable's path, mode, size, hash, package, target, profile and
features must match independently built B output before transported A bytes may run.
The expected B receipt and exact source-pair provenance are trusted experiment
inputs retained outside the archive. This independent B compilation is an
experimental admission oracle, with its full cost disclosed. It is not a cheap
production hit verifier.

A fresh target receives only allowlisted regular executable files. Checksums,
member paths, modes, sizes, duplicates, missing files and extra files fail closed.
No producer or baseline target is mounted in the replay container. Loader inspection
requires resolved libraries from the pinned image and rejects missing dependencies.
It does not prove arbitrary future dynamic loads or subprocess closure.

The baseline runs `cargo test --workspace --frozen --lib --bins --tests -- --test-threads=2` through
Cargo's target-runner hook. The hook records each real command, environment and
package working directory and monotonic invocation order, lists its libtest cases,
and executes it freshly. Replay preserves that observed order and fixed concurrency.
Replay uses those recorded invocations and demands the same complete case inventory,
passing summaries and exit codes. Ordinary helper binaries stay at embedded paths.
Fresh consumer fixtures come from B. Existing Node dependencies are read-only and
inventoried, including package-local `node_modules`; links must resolve within those modules or declared workspace packages.
Package build outputs start fresh in both execution containers. The
reviewed external launcher protects tracked package inputs while permitting generated
`dist` and graph-client `agent-resource` output. Sources and dependency inventories
are checked before and after each phase.

A runtime-only correction may retain existing compilation evidence only when the
source, compile recipe and every executable remain unchanged. Its separate
`execution` record pins the execution diagnostic and complete dependency inventory,
and requires executable temporary storage for real fixture helpers. This record
does not rewrite compiler provenance or qualify the failed runtime attempt. Both
fresh baseline and replay must use the same corrected execution record, with
preparation costs and the original failure retained.

This scope is the default-feature compiled executable tests. It excludes doctests,
crash-feature tests, required example compilation, complete CI equivalence and
release proof. No prior pass substitutes for fresh replay. No test is deleted.
The Cargo behavior used here is documented in the official
[test command](https://doc.rust-lang.org/cargo/commands/cargo-test.html) and
[target runner](https://doc.rust-lang.org/cargo/reference/config.html#targettriplerunner)
references.

| Changed seam | Deterministic checkpoint |
| --- | --- |
| Fresh Cargo inventory and exact-pair admission | Reused compilation, incomplete completion, changed context/provenance, omitted helper, changed bytes or features reject |
| Archive publication and restore | Real executable round-trip succeeds without producer files; corrupt, missing, extra, linked or mode-changed members reject |
| Fresh test execution | Real subprocess reads current runtime data/environment; failure is retained; listed cases must match a complete passing libtest summary |
| Suite replay | Missing executable coverage, wrong package directory, reversed invocation order or extra restored files stop before execution |
| Runtime validation | Tracked source mutation rejects; generated outputs are explicitly scoped; package-local dependency drift and dependency-link escape reject; corrupt restored bytes never reach loader inspection |

Required source gates remain `npm run check` and `npm run build`, plus adversarial
source and evidence review. A factory grant separately bounds Linux execution,
transfer, incremental disk and owned-container cleanup. Record producer compilation,
packing/publication, consumer transfer, verification/install, baseline compile/tests,
and replay tests separately. Actual Tailscale transfer is not hosted-cache latency.
Retain all failed attempts, exact revisions, source/recipe hashes, inner results and
unknowns. Even matching binaries plus passing replay qualify only this pair and
recipe; `completeDigest` stays null and production admission remains unqualified.
