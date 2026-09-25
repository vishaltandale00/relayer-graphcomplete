# Issue #356: imported conversation removal storage boundary

## Scope and decision

This is a behavior-preserving ownership refactor. The product meaning is already
explicit in the [PRD §11.9](../../prd/index.html) and [PRD §15E](../../prd/index.html):
SQLite is the canonical typed write store, while Ladybug is a derived publication
that is acknowledged only after it is searchable. The [runtime package boundary](../../architecture.md#runtime-package-boundaries)
places table queries in SQLite storage modules. [ADR 0008](../../decisions/0008-temporal-current-and-completion-brokers.md)
defines durable revisions and projection acknowledgements. No product decision,
schema change, or query-contract change was needed.

The changed executable seams are `ImportTable` in
`crates/relayer-graph-core/src/storage/sqlite/imports.rs`,
`GraphDatabase::remove_imported_conversation` in
`crates/relayer-graph-core/src/graph/import.rs`, and the import lifecycle
checkpoints in `crates/relayer-graph-core/tests/graph_database.rs`.

`ImportTable` owns optional target lookup, the in-transaction existence and
cross-thread reference preflight, ordered current-completion IDs, and ordered
canonical deletes. Graph orchestration still captures accepted publications
before staging canonical deletion, then applies derived removal while those
SQLite changes remain uncommitted. It retains per-target ordering, the
publication guard, transaction ownership, fail-closed rollback, the no-publication
branch, and indexed versus ordinary commit behavior. Finalization's strict
`target(import_id)` behavior is unchanged. Removal keeps its prior invalid
project-ID fallback and missing-import idempotency.

## Checkpoint map and verification plan

| Promise or boundary | Deterministic production-seam checkpoint |
| --- | --- |
| Accepted imported graph and inert input children are deleted; missing and repeated removal are no-ops | `cargo test -p relayer-graph-core --test graph_database imported_` |
| A staged import with no accepted publications can be removed and its identity reused | `imported_stage_without_publications_can_be_removed` in `graph_database` |
| Derived rejection rolls back canonical deletion and preserves the old revision; retry acknowledges the next revision | `cargo test -p relayer-graph-core --test search_index_ordering imported_conversation_removal_is_acknowledged_only_after_derived_removal` |
| A real Ladybug store refuses cross-thread `REFERENCES` removal without changing either store or their revisions | `cargo test -p relayer-graph-server --features crash-test-support --test ladybug_search_index an_import` |
| The normal deterministic repository portfolio, including crash reconciliation | `npm run check` |
| Required application and workspace package build | `npm run build` |

The refusal and derived-failure tests remain because they observe distinct
boundaries: external graph authority must prevent removal before either store
changes, while a derived-store failure after SQLite deletion is staged must roll
back the canonical transaction. No test was retired.

## Results on the tested source

The focused import lifecycle run passed **11 tests**. The derived-removal ordering
test passed **1 test**. The real Ladybug import run passed **2 tests**, including
searchability and cross-thread reference refusal. The strengthened zero-publication
test passed **1 test** and proved removal by successfully reusing the same staged
import identity and thread.

The 11-test filtered import run happened before the final extra identity-reuse
assertion was added. The exact final snapshot was then exercised by the full
`npm run check` Rust workspace suite, which passed all **74 `graph_database`
tests**, and by the separate strengthened zero-publication test (1/1). The full
suite is the source-exact proof for the import lifecycle after that assertion was
added.

The external-reference checkpoint reads and compares the complete normalized
Ladybug inventories for `Content`, `Layer`, `CONTAINS`, `EXPANDS`, and `REFERENCES`
before and after refusal. They are equal. The imported accepted closure remains
present; the project revision in SQLite and Ladybug both remain at
`FIRST.next`; and the reference remains searchable with count 1.

The derived-failure checkpoint observes `no_accepted_closure == false` after the
failed deletion, SQLite revision still `FIRST`, and one derived commit. On retry,
the closure is gone, SQLite revision is `FIRST.next`, and the derived commit count
is two. The zero-publication path performs no derived commit and still removes
the staged row.

`npm run check` completed with exit code 0 on this source: Cargo format and Clippy
passed; the Rust workspace and crash-reconciliation suites passed; Vitest reported
172 files passed and 1 skipped (2,267 tests passed, 3 skipped); the Codex secret
boundary reported 2 passed; Python reported 29 passed; Ladybug receipt checks and
PRD readability passed. `npm run build` completed with exit code 0. Build output
includes three existing dead-code warnings in the graph-server search-index code;
they did not fail either command. No paid inference, Electron proof, release proof,
or schema migration was run or required.

The first real-Ladybug command omitted its required `crash-test-support` feature
and Cargo rejected the test target before running tests. The corrected command
with that feature passed. This was a command configuration issue, not a test
failure. No unchanged retry was needed.

## Source and log receipts

Tests ran from base commit
`61ce7b0cc50ee819eb54568cb8fc7165bf6c1e01`; `Cargo.lock` SHA-256 was
`00c84a2ea253889974bf75b422a696cae0cbb6f462eb42a1de8747e6000508fc`.
The following exact source hashes identify the code and test inputs for the
successful final `npm run check` and `npm run build`:

| File | Base SHA-256 | Tested SHA-256 |
| --- | --- | --- |
| `crates/relayer-graph-core/src/graph/import.rs` | `8d4bede7a7b5448020379a7a99bcfa6400f5507ff6d80861436340fa7723b116` | `1bf0f3e7a718818b66aa3f21d5e94cfda65c358daff9762aefbc14ff53f7a070` |
| `crates/relayer-graph-core/src/storage/sqlite/imports.rs` | `5b809f171d04aff1f7862678ae4665c94e6fae42529336f853edaff54cf59aa5` | `d13f1d54ac9b83a28080101b450e75f07982d6554a6a7574b3bd2c16808df83c` |
| `crates/relayer-graph-core/tests/graph_database.rs` | `76d42bfe5877a5552e03d0c23be88d322f5a0265abbb1ac83b6cbf319109c0f8` | `fd3a15d390947d921e56548136807b9d2da39f2beb4ee957844a4fa3f331bad6` |
| `crates/relayer-graph-core/tests/search_index_ordering.rs` | unchanged | `317a813bb83fe492ddee69508da334dd89c771e6266673486486bd6a51cf4e4e` |
| `crates/relayer-graph-server/tests/ladybug_search_index.rs` | unchanged | `a0413de61662422d9a287e77a67ca7c08eab7eaa2a050257644e38da945367d9` |

The source-only diff SHA-256 before adding this evidence document was
`7e0c6f54ff7bba1acdc8ade2a0b37a589fbda4ffd3d8ab4e305bebd059ae343b`.
The `remove_imported_conversation` body was also inspected to confirm it contains
no SQL statements or table names.

Full captured command output is retained in
`/Users/vishal/.codex/worker-pilot/evidence/factory-356/`:

- `graph-database-imported.log`
- `graph-database-empty-stage.log`
- `search-index-removal.log`
- `ladybug-import.log`
- `npm-check-final.log`
- `npm-build-final.log`

Code commit `d377bd0abd450d56404e1dbb1bc28f10544f9ca8` passed the [PR #481 CI run](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/36108829010): the stable `check` aggregate, quick deterministic checks, Rust Clippy, fresh Rust tests, crash reconciliation, runtime build, Vitest, TypeScript, Python, receipt integrity, PRD readability, and the macOS arm64 Prime runtime package all passed. The Windows x64 Ladybug qualification was skipped as blocked; the prebuilt Ladybug native library job was skipped because its trusted bundle was available. This refactor does not claim Windows qualification. The later commit `7310dc584311fb400b1565ae170ee97346f2c55e` changed only this evidence document; all executable and test inputs retain the hashes recorded above.

The PR description carries standards and spec review assertions with the exact
reviewed commit, scope, verdict, and findings. Those assertions are refreshed
against the current head before merge. This evidence document is not itself a
merge approval.
