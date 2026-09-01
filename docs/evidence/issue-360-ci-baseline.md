# Issue #360 CI timing and cache baseline

Captured on 2026-08-31 before affected-module selection was added. These are
measurements, not the performance targets from Issue #360.

## Hosted GitHub Actions baseline

The original workflow had one required `check` job containing `npm run check`
and `npm run build`, plus an independent Apple Silicon packaging job. It cached
npm downloads but did not cache Cargo compilation artifacts.

| Run | Snapshot | Observed required check | Observed packaging | Interpretation |
| --- | --- | ---: | ---: | --- |
| [33430203198](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33430203198) | PR `a8ca324e` | `npm run check` 28m42s; job 29m17s | 16m53s build step | Source-heavy/cold representative |
| [33433106942](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33433106942) | `main` `a624fc88` | `npm run check` 29m18s; job 29m47s | 17m31s build step | Source-heavy/cold representative |
| [33427910474](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33427910474) | docs PR `cf125f6d` | `npm run check` 4m23s; job 4m55s | 4m49s build step | Best-available small-change observation; not a proven cache hit |
| [33418071016](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33418071016) | stacked PR `8505fddf` | `npm run check` 4m34s; job 4m58s | 4m14s build step | Best-available small-change observation; not a proven cache hit |

Setup plus `npm ci` took 11–19 seconds in these samples. The live issue's
chapter-level inspection attributed roughly 18.5 minutes to cold Rust
formatting/Clippy compilation, 7.3 minutes to the remaining Rust configurations,
and 2.9 minutes to TypeScript, Vitest, Python, and receipt work. The workflow did
not expose cache-hit evidence, so the short samples cannot be called warm-cache
runs.

## Isolated local compilation-artifact baseline

On the same source snapshot (`a624fc88`) and toolchain (`rustc 1.94.0`), the
existing Rust chapter was run twice against a fresh temporary
`CARGO_TARGET_DIR`. The commands remained fresh invocations of formatting,
Clippy, tests, and server builds.

- Cold target directory: approximately 6m38s.
- Warm target directory: 35.20s.
- Reused target directory size: 11 GiB.

This local comparison isolates the potential value of compilation-artifact
reuse. It does not establish hosted cache transfer time, hosted cold/warm
performance, affected-module performance, or any Issue #360 target.

## Scope justified by the baseline

The implementation therefore caches Rust registry/git inputs and compiler
artifacts before introducing selection. It then keeps affectedness conservative:
all selected tests execute for the current snapshot; integration branches and
PRs run the full portfolio; and lockfiles, toolchains, workflows, infrastructure,
planner changes, unknown paths, and unmapped paths fail open to full verification.

## Automatic intra-PR sccache canary

A follow-up canary replaces the `Rust checks and fresh tests` job's whole
`target/` archive with Mozilla sccache compiler objects while retaining a small
Cargo registry/git download archive. Same-repository pull requests may write
within GitHub's PR-scoped cache; forks receive no compiler-cache credentials and
compile directly. Setup or daemon-start failure falls back to direct
`rustc`; sccache documents rate-limit storage failures as nonfatal, while
its native server-I/O fallback handles later daemon loss. Genuine compiler
failures are never retried or masked. Cache and telemetry cannot substitute for
or invalidate freshly executed checks and tests.

The existing 18.5-minute hosted Rust observation above remains the cold
baseline; no additional synthetic cold runs are required.

The first PR seed run (`33461754406`, head `9d617c9a`) took 22 minutes 10
seconds from Rust-job start to failure. The Cargo dependency archive missed;
sccache setup and daemon start succeeded. After completion, GitHub reported
1,184 entries totaling 546,100,346 bytes in the PR merge ref, proving that
compiler objects were written even though the later gate failed. The failure
was not a cache error: the cold Clippy build exposed an existing integration
test that read `CARGO_BIN_EXE_relayer-graph-server` at compile time, where Cargo
does not provide it for that target. No verification pass or speedup is claimed
from this seed.

The next real changed-head run after correcting that test is the warm
comparison. Record its sccache hits, misses, errors, Rust chapter duration, and
repository cache usage here. Expansion beyond the Rust job requires at least
five minutes of net Rust compilation savings, no required-job regression, and
no trusted-cache eviction or thrashing.
