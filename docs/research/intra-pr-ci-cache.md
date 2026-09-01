# Automatic intra-pull-request Rust compilation cache research

Research date: 2026-08-31

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
