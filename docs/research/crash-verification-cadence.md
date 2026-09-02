# Crash-support and crash-reconciliation verification cadence

Research date: 2026-09-01

Repository snapshot: [`d861a49d`](https://github.com/vishaltandale00/relayer-graphcomplete/commit/d861a49daeda4d87f818650a3a6e467a48d6dad9), the fetched `origin/main` tip at the start of this investigation.

Issue: [#360, Make CI fail fast with integration-train caching and affected-module checks](https://github.com/vishaltandale00/relayer-graphcomplete/issues/360)

Status: research and staged implementation. This note does not change tests,
branch rules, product behavior, release behavior, or remote state.

Implementation progress:

- Stage 2, first narrowing step, landed after #392: the affected planner no
  longer selects the crash-reconciliation lane for `relayer-app-server`-only
  changes. Selection is the checked-in `rustCrashPackages` list
  (`relayer-graph-core`, `relayer-graph-server`) intersected with the Rust
  reverse-dependency closure; telemetry-capability changes still select the
  lane because the closure contains `relayer-graph-server`. Full-portfolio
  runs, unknown/unmapped fail-open, and the exact crash command are unchanged.
  The crash command contains no app-server test, so no checkpoint lost an
  owner; app-server interrupted-execution recovery remains owned by its
  ordinary tests in the default-test lane.
- Stage 0 evidence collection landed as `--timings` artifacts on the
  Clippy, default-test, and runtime lanes (the crash lane runs through its npm
  script and records step durations only).
- Stages 1–4 (checkpoint manifest, purpose-split smoke binaries, smoke
  cadence, nightly depth, release binding) remain unimplemented and still
  require their deterministic planner tests and hosted observations first.

## Decision

The entire current `check:graph-crash-reconciliation` command should **not** run on every ordinary component pull request.

The safe fast cadence is:

| Context                                                                                                                 | Required crash evidence                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary non-Rust or unrelated Rust component PR                                                                        | No separate crash runtime. Keep the selected crate's normal tests and Clippy. Feature-gated crash code remains compile-fresh whenever its owning graph crate is selected.                                                           |
| Ordinary crash-relevant graph PR                                                                                        | Run a narrow deterministic injected-fault smoke on Ubuntu after all crash-feature test targets compile. Select it by a checked-in checkpoint manifest, not by a broad app-server/server predicate.                                  |
| Unknown, unmapped, planner, workflow, toolchain, lockfile, feature, Ladybug pin, build-script, or crash-manifest change | Fail open to the full deterministic crash/reconciliation portfolio.                                                                                                                                                                 |
| `integration/**` push and integration PR to `main`                                                                      | Run the complete deterministic portfolio on the exact integrated commit and the real-process `SIGKILL` proof on Apple Silicon. Keep it inside the stable required `check` aggregation.                                              |
| Default-branch push                                                                                                     | Retain the full portfolio as post-merge detection while the staged change is being evaluated.                                                                                                                                       |
| Scheduled/nightly                                                                                                       | Run repeated, replayable Apple Silicon kill/reopen and corruption/rebuild campaigns. Publish source SHA, seed, checkpoint, platform, and logs. A stale or missing nightly is visible but never substitutes for a required PR gate.  |
| Preview or Stable release candidate                                                                                     | Run the full deterministic suite, the real-process kill proof, and packaged lifecycle/reopen verification against the exact candidate SHA/artifact before manual promotion. Never reuse an old nightly result as release authority. |

This preserves Issue #360's explicit constraints: fresh selected tests, fail-open unknown changes, full integration-state verification, one stable required context, manual merge, and compilation/dependency caching without cached test results.

## Why the current every-PR command is the wrong unit

The root command was two invocations when this note was written:

```sh
cargo test -p relayer-graph-core --features crash-test-support --test search_index_ordering
cargo test -p relayer-graph-server --features crash-test-support
```

It has since been folded into one invocation with the same feature
configuration, `cargo test -p relayer-graph-core -p relayer-graph-server
--features crash-test-support`, which compiles both crates once and also runs
graph-core's other test targets under the feature. The analysis below is
unchanged by that fold. The second invocation is not a crash-only suite. Enabling `crash-test-support` makes six integration-test binaries eligible, but `cargo test -p relayer-graph-server` also executes ordinary crate unit and integration tests. On the observed hosted run it executed:

- 21 graph-core ordering tests, of which four use injected crash points;
- 25 graph-server library tests;
- 22 graph-query conformance tests;
- 14 public graph-search route tests;
- 14 Ladybug index tests;
- 18 Ladybug lifecycle/reconciliation tests;
- three corpus tests; and
- several small/default test binaries.

The real process-kill file is restricted to `target_os = "macos"` and `target_arch = "aarch64"`. The required Ubuntu Rust job therefore reported **zero executed tests** for `ladybug_crash_reconciliation`. The current every-PR chapter is expensive feature-enabled deterministic coverage, but it is not real Apple Silicon crash proof.

The current planner also invokes that whole command whenever the Rust plan contains either `relayer-graph-server` **or `relayer-app-server`**. An app-server-only component change can therefore pay to build and run graph-core/Ladybug crash configurations even though the command contains no app-server crash test. App-server interrupted-execution and cross-database recovery remain important, but their owners are the ordinary app-server Rust tests, not this Ladybug feature command.

## Product and architecture checkpoints that cannot be weakened

The PRD is authoritative for product meaning:

1. [PRD section 8.2, Local persistence and restart recovery](../prd/index.html#8-return-to-saved-work) requires atomic persistence, no corruption of the last accepted graph, immediate rendering of accepted turns after reopen, and explicit stopped/failed handling for interrupted work.
2. [PRD section 11.9, Graph search v1](../prd/index.html) makes SQLite canonical and Ladybug derived, forbids a SQLite search fallback, requires acknowledgement only after the complete Ladybug projection is searchable, explicitly declines cross-database physical ACID, and requires incompatible stores to rebuild from SQLite before atomic validated swap.
3. The first enabled graph-search lane is macOS Apple Silicon. Intel and Windows evidence cannot satisfy that lane.
4. Drafts and unresolved invokes must not enter searchable topology. Query selectors are intersected with completion-bound read authority.

The architecture adds the exact authority boundaries:

- accepted completion revisions, current head, idempotency receipt, and projection event commit in one `synchronous=FULL` SQLite transaction;
- SQLite and Ladybug cannot use a cross-store two-phase commit, so Ladybug commits first and SQLite records the derived revision before its own commit;
- SQLite is the canonical recovery authority; an ahead, damaged, missing, or incompatible derived store must not become product truth;
- exact invocation occurrence is the idempotency authority for recursive result recovery; and
- app-server product/graph handoff recovery is separate from Ladybug projection recovery and must not be hidden inside a generic “crash” label.

`AGENTS.md` and [`docs/agents/ci.md`](../agents/ci.md) further require explicit checkpoint mapping, the smallest realistic deterministic test for each checkpoint, full fallback for unmapped changes, fresh tests for the selected source snapshot, and a stable aggregate `check` result. The live main ruleset currently enforces strict required status `check`, pull requests, resolved review conversations, linear history, and squash/rebase only. It does not enable auto-merge; that manual authority must remain unchanged.

## Current crash and reconciliation checkpoint inventory

The inventory below maps tests rather than command names. “Authority” is the state allowed to decide the post-failure result. “Failure checkpoint” is what the test actually interrupts, corrupts, races, or rejects.

### Graph-core dual-store ordering and crash hooks

File: [`crates/relayer-graph-core/tests/search_index_ordering.rs`](../../crates/relayer-graph-core/tests/search_index_ordering.rs)

| Test                                                                            | Product checkpoint                                                                          | Authority                                                          | Failure checkpoint                                                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advance_failure_rolls_back_current_acceptance_and_retry_receipt`               | Failed current advance exposes no accepted progress or replay receipt.                      | Canonical SQLite current state.                                    | Derived-index apply failure during Advance.                                                                                                           |
| `exact_advance_retry_does_not_reindex_and_stop_or_fail_publish_nothing`         | Exact retries are idempotent; stop/fail do not publish graph topology.                      | SQLite transition receipt and lifecycle.                           | Replay and non-publishing terminal transitions.                                                                                                       |
| `legacy_submit_replay_clears_only_a_matching_ambiguous_canonical_commit`        | Only the exact publication identity can confirm an ambiguous derived commit.                | Canonical publication identity plus SQLite receipt.                | Lost acknowledgement/ambiguous derived commit.                                                                                                        |
| `return_after_advance_adds_the_terminal_root_action_once`                       | Return after accepted progress publishes the terminal root action exactly once.             | Accepted completion closure and operation receipt.                 | Advance-to-Return retry boundary.                                                                                                                     |
| `leased_return_index_failure_rolls_back_child_completion_and_parent_resolution` | A child is not succeeded and its invoke target is not resolved when projection fails.       | Child SQLite completion plus source invoke lease.                  | Derived-index rejection during leased Return.                                                                                                         |
| `leased_return_retry_converges_after_search_commit_crash_boundaries`            | A leased child retry converges without premature parent resolution or duplicate success.    | Child completion receipt and exact source/action lease.            | `AfterSearchCommit`, `AfterSqliteRevisionRecord`.                                                                                                     |
| `advance_retry_converges_after_search_commit_crash_boundaries`                  | Current Advance retry converges to one accepted revision.                                   | SQLite current head/CAS receipt.                                   | `AfterSearchCommit`, `AfterSqliteRevisionRecord`.                                                                                                     |
| `exact_retry_converges_after_every_completion_crash_boundary`                   | Concurrent exact retries converge to one correct accepted output/revision.                  | SQLite accepted completion and idempotency receipt.                | `AfterSqliteClosureWrite`, `AfterSearchClosureWrite`, `AfterSearchCommit`, `AfterSqliteRevisionRecord`, `AfterSqliteCommit`, `AfterResponsePrepared`. |
| `a_save_commits_to_both_stores_and_records_the_exact_revision`                  | A successful acknowledgement binds searchable projection to its canonical revision.         | SQLite revision receipt.                                           | Normal dual-store commit boundary.                                                                                                                    |
| `a_store_that_cannot_begin_fails_the_write_with_nothing_saved`                  | An unwritable derived store cannot produce accepted output.                                 | SQLite absence of accepted closure/revision.                       | Ladybug transaction begin failure.                                                                                                                    |
| `a_store_that_rejects_the_closure_rolls_back_both_stores`                       | Rejected projection leaves neither accepted canonical state nor a live derived transaction. | SQLite rollback plus Ladybug rollback.                             | Ladybug apply failure.                                                                                                                                |
| `a_write_that_outlives_its_budget_fails_with_no_partial_state`                  | Timed-out projection cannot be acknowledged or partially accepted.                          | SQLite absence plus bounded rollback.                              | Ladybug apply stall past deadline.                                                                                                                    |
| `revisions_advance_per_target_and_targets_do_not_share_a_sequence`              | Project/thread readiness is independent per target.                                         | SQLite per-target revision record.                                 | Cross-target ordering.                                                                                                                                |
| `a_stuck_target_does_not_stall_an_unrelated_target_indefinitely`                | One target cannot hold global write progress forever.                                       | Bounded SQLite transaction deadline.                               | Stalled derived write while another target waits.                                                                                                     |
| `a_store_left_ahead_of_sqlite_never_has_its_revision_reused`                    | An orphan derived revision is never mistaken for canonical acknowledgement.                 | Maximum of stored and recorded revision; SQLite remains canonical. | Ladybug ahead of rolled-back SQLite.                                                                                                                  |
| `an_imported_conversation_is_indexed_with_the_rest_of_the_import`               | Imported accepted history is searchable when import is acknowledged.                        | Canonical imported SQLite rows.                                    | Normal import publication.                                                                                                                            |
| `an_import_the_store_rejects_leaves_nothing_imported`                           | Failed derived import publishes no canonical partial import.                                | SQLite import transaction.                                         | Ladybug import apply failure.                                                                                                                         |
| `imported_conversation_removal_is_acknowledged_only_after_derived_removal`      | Canonical removal is not acknowledged before derived removal succeeds.                      | SQLite import record and revision.                                 | Derived removal rejection.                                                                                                                            |
| `import_retry_with_reallocated_ids_remains_quarantined_until_rebuild`           | A retry with different internal IDs cannot confirm an orphaned portable publication.        | Stable portable publication identity and canonical rebuild.        | Crash after derived commit before imported SQLite rows.                                                                                               |
| `a_closure_in_a_project_is_published_to_its_project_and_its_thread`             | Project and thread selectors see the same accepted publication without widening authority.  | Canonical project/thread membership.                               | Multi-target publication.                                                                                                                             |
| `a_standalone_thread_publishes_to_its_thread_alone`                             | Standalone history does not leak to another target.                                         | Canonical thread membership.                                       | Target-selection boundary.                                                                                                                            |

The four explicitly crash-hooked tests are the smallest existing injected-fault core smoke. The other 17 tests remain full-portfolio owners of rollback, timeout, target isolation, import, and publication semantics; several are cheap enough that keeping the whole 21-test binary in the smoke is reasonable after it has compiled (0.94 seconds in the observed hosted run).

### Public-route orphan and authority checks

File: [`crates/relayer-graph-server/tests/graph_search_route.rs`](../../crates/relayer-graph-server/tests/graph_search_route.rs)

| Test                                                               | Product checkpoint                                                      | Authority                               | Failure checkpoint                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------- |
| `store_ahead_of_rolled_back_sqlite_is_not_searchable_before_retry` | Derived-orphan data is unavailable until canonical retry.               | SQLite acceptance and target readiness. | Ladybug ahead of rolled-back SQLite.            |
| `ladybug_commit_is_not_searchable_before_sqlite_acknowledgement`   | No public read may observe the irreducible cross-store window.          | SQLite acknowledgement.                 | Query between Ladybug commit and SQLite commit. |
| `a_different_retry_cannot_confirm_an_orphaned_publication`         | A different closure cannot launder an orphan into accepted search data. | Exact publication identity.             | Mismatched retry after lost acknowledgement.    |

Other tests in this binary own capability denial, remint identity, selector intersection, immediate freshness, reopen, cancellation, and non-oracular errors. They are important graph-search tests but are not crash injections. They belong to the full feature portfolio and to separately mapped query/authority smoke groups, not automatically to every crash smoke.

### Ladybug store durability primitives

File: [`crates/relayer-graph-server/tests/ladybug_search_index.rs`](../../crates/relayer-graph-server/tests/ladybug_search_index.rs)

| Test                                                                       | Product checkpoint                                         | Authority                                                              | Failure checkpoint           |
| -------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------- |
| `a_rolled_back_write_leaves_the_store_untouched`                           | Rollback exposes no derived publication.                   | Ladybug transaction outcome.                                           | Explicit rollback.           |
| `dropping_an_unpolled_commit_releases_the_transaction`                     | Cancellation before polling cannot poison the next writer. | Store worker ordering and rollback-on-drop.                            | Abandoned commit future.     |
| `a_committed_closure_survives_closing_and_reopening_the_store`             | Acknowledged projection is durable across clean reopen.    | Ladybug persisted revision/topology, checked against expected closure. | Close/reopen.                |
| `a_saved_graph_is_searchable_the_moment_the_author_is_told_it_saved`       | Acknowledgement-level freshness holds.                     | Returned completion acknowledgement.                                   | Immediate read after save.   |
| `an_abandoned_write_releases_its_transaction_so_the_next_save_still_works` | Timed-out/cancelled writes cannot deadlock later saves.    | Store worker plus rollback-on-drop.                                    | Abandoned in-flight write.   |
| `the_store_reports_the_revision_it_holds_for_reconciliation`               | Startup can compare derived and canonical revisions.       | Persisted Ladybug revision.                                            | Reopen/reconciliation probe. |

The remaining index tests own schema/value round-trip, identity, replay, publication-target union, read-only parsing, and import reference behavior. They support rebuild correctness but are not themselves crash tests.

### Startup reconciliation and atomic-generation lifecycle

File: [`crates/relayer-graph-server/tests/ladybug_search_lifecycle.rs`](../../crates/relayer-graph-server/tests/ladybug_search_lifecycle.rs)

| Test                                                                               | Product checkpoint                                                                                | Authority                                                    | Failure checkpoint                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `rebuild_restores_active_stopped_and_failed_accepted_currents`                     | Rebuild preserves all accepted lifecycle projections, not only succeeded finals.                  | Canonical SQLite accepted revisions.                         | Derived store reconstruction.                |
| `missing_store_rebuilds_every_accepted_closure_from_sqlite`                        | Deleted derived state does not lose accepted history.                                             | Canonical SQLite closure inventory.                          | Missing Ladybug store.                       |
| `accepted_history_without_search_receipts_is_rebuilt_and_receipted`                | Legacy accepted history becomes searchable with canonical receipts.                               | SQLite accepted history.                                     | Missing derived revision receipts.           |
| `missing_store_rebuilds_a_graph_carrying_a_connected_edge`                         | A canonical rebuild reproduces relationship topology, not only nodes and layers.                  | Canonical CONNECTED inventory multiplicity.                  | Missing store for an edge-bearing graph.     |
| `same_revision_missing_and_extra_topology_is_never_accepted_as_ready`              | Revision equality cannot hide missing or injected topology.                                       | Full canonical topology comparison.                          | Same-revision logical corruption.            |
| `same_revision_property_mutation_and_identical_relationship_duplicate_are_rebuilt` | Property mutation and duplicate relationships are detected.                                       | Canonical property/relationship inventory.                   | Same-revision semantic corruption.           |
| `malformed_openable_inventory_is_globally_rebuilt_before_startup_returns`          | Structurally openable but impossible shared metadata cannot serve reads.                          | Canonical global inventory.                                  | Malformed `published_targets`.               |
| `logical_damage_blocks_only_its_target_while_unaffected_target_stays_usable`       | Target-local damage does not unnecessarily block healthy targets.                                 | Per-target canonical readiness.                              | Held logical rebuild for one target.         |
| `unopenable_active_generation_is_quarantined_and_rebuilt_from_sqlite`              | Unopenable active bytes cannot become truth and remain inspectable.                               | SQLite rebuild plus quarantine evidence.                     | Physically unopenable generation.            |
| `pointer_to_missing_generation_recovers_globally_from_sqlite`                      | A dangling active pointer cannot make startup trust absence.                                      | SQLite rebuild and new validated generation.                 | Pointer to missing generation.               |
| `incompatible_derived_version_rebuilds_side_by_side_under_the_same_engine_pin`     | Version mismatch rebuilds without mutating canonical data.                                        | SQLite plus version receipt.                                 | Incompatible derived schema/version.         |
| `orphan_revision_absent_from_sqlite_is_removed_by_canonical_rebuild`               | Derived-only accepted-looking data is removed.                                                    | SQLite closure inventory.                                    | Orphan revision/topology.                    |
| `pre_generation_active_bytes_are_quarantined_and_rebuilt`                          | Legacy layout bytes are not trusted in place.                                                     | SQLite rebuild plus quarantine.                              | Pre-generation store layout.                 |
| `forced_validation_failure_leaves_the_prior_active_generation_intact`              | A failed candidate rebuild cannot destroy the prior recoverable generation.                       | Existing active pointer until candidate validation succeeds. | `BeforePublish` injected validation failure. |
| `one_rebuild_deadline_includes_receipt_and_final_active_open`                      | Timeout covers receipt and final open; a timed-out published pointer remains restart-recoverable. | Next startup validation against SQLite.                      | `DelayBeforeFinalOpen`.                      |
| `active_pointer_replacement_after_open_is_detected_and_rebuilt`                    | A raced pointer cannot silently switch the opened generation.                                     | Revalidated pointer plus SQLite rebuild.                     | `ReplacePointerAfterOpen`.                   |
| `active_pointer_replacement_before_publish_fails_closed_without_overwriting_it`    | Rebuild does not overwrite a concurrently changed active pointer.                                 | Pointer CAS-like identity and next-startup SQLite rebuild.   | `ReplacePointerBeforePublish`.               |
| `symlink_pointer_and_generation_are_rejected_without_following_them`               | Filesystem indirection cannot redirect the trusted store boundary.                                | Validated regular-file layout.                               | Symlink pointer/generation.                  |
| `quarantined_rollback_is_an_independent_durable_copy`                              | Quarantine evidence is not an alias to mutable active bytes.                                      | Independent durable quarantine copy.                         | Post-quarantine active mutation.             |

All 19 are reconciliation tests and should stay in the full integration portfolio. A narrow PR smoke should select one representative from each non-subsumed failure class rather than running every corruption variant:

- missing/canonical rebuild: `missing_store_rebuilds_every_accepted_closure_from_sqlite`;
- same-revision semantic mismatch: `same_revision_missing_and_extra_topology_is_never_accepted_as_ready`;
- physically unopenable generation: `unopenable_active_generation_is_quarantined_and_rebuilt_from_sqlite`;
- failed candidate preservation: `forced_validation_failure_leaves_the_prior_active_generation_intact`; and
- pointer race fail-closed: `active_pointer_replacement_before_publish_fails_closed_without_overwriting_it`.

That five-test set is a proposed smoke, not an achieved replacement. It must pass replacement-before-deletion review; no full test should be removed.

### Real-process kill proof

File: [`crates/relayer-graph-server/tests/ladybug_crash_reconciliation.rs`](../../crates/relayer-graph-server/tests/ladybug_crash_reconciliation.rs)

| Scenario                                                                                          | Product checkpoint                                                                                                                                                                       | Authority                                                                     | Failure checkpoint                                                                |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `real_kill_child` + `sigkill_after_ladybug_commit_leaves_a_detectable_orphan_and_retry_converges` | A process killed in the irreducible Ladybug-first window leaves a detectable orphan; reopen/retry converges to complete searchable topology without treating the orphan as acknowledged. | Canonical SQLite acceptance plus exact derived revision/publication identity. | Real `SIGKILL` immediately after Ladybug `COMMIT`, before SQLite acknowledgement. |

`real_kill_child` is a child-mode test entrypoint used by the parent scenario; it is not independent product coverage. The parent scenario is the sole current OS-process crash proof. It must report one executed parent test on an Apple Silicon runner. A compile-only or zero-test result is not evidence.

### Feature-enabled tests that are not crash tests

The current command also enables/runs:

- all 22 `graph_query_v1_conformance` tests;
- all 14 `graph_search_route` tests, including the three orphan/authority tests above;
- all 14 `ladybug_search_index` tests, including the six durability primitives above;
- all three `search_index_corpus` tests; and
- ordinary graph-server unit/default integration tests.

These tests must retain owners and cadences. They should not be silently dropped when the crash cadence changes. The affected-module planner should select query contract, route authority, index schema, corpus, and crash/reconciliation groups independently. Integration PRs still run them all.

## Recent hosted timing and failure evidence

The repository baseline records cold source-heavy `npm run check` runs around 29 minutes and attributes roughly 18.5 minutes to cold Rust formatting/Clippy compilation plus 7.3 minutes to the remaining Rust configurations. See [`docs/evidence/issue-360-ci-baseline.md`](../evidence/issue-360-ci-baseline.md).

The latest successful full PR run at this snapshot was [Actions run 33463966913](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33463966913), head `f411b2a4`:

| Rust phase                                             |                      Observed hosted time |
| ------------------------------------------------------ | ----------------------------------------: |
| Clippy, all selected packages/all targets/all features |                         4m34s compilation |
| Fresh default Rust tests                               | about 3m12s through compile and execution |
| `check:graph-crash-reconciliation`                     |                         3m58.5s wall time |
| └ graph-core crash-feature compile                     |                                     38.5s |
| └ graph-core 21-test execution                         |                                     0.94s |
| └ graph-server crash-feature compile                   |                                     2m39s |
| └ graph-server eligible test execution                 |                         about 38.5s total |
| Final affected server build                            |                                     48.3s |
| Whole selected Rust command                            |                              about 12m35s |

The crash command was about 32% of that Rust command's wall time. Most of its cost was a second feature-specific compile/link configuration, not test execution.

The next main run, [33465911128](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33465911128), had a 31m39s successful Rust job, but the overall required check failed because the duplicate full-gate Vitest run observed `SIGTERM` instead of expected `SIGKILL` in `desktop-shell.test.mjs`. That was not a Ladybug crash-suite failure. The immediately preceding Rust-job failure in [33461754406](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/33461754406) was a compile-time `CARGO_BIN_EXE_relayer-graph-server` lookup exposed by cold all-target Clippy; it also failed before the graph crash command. Recent failures therefore do not show a flaky Ladybug crash test, but they do show that compile freshness and independent aggregate failures are valuable.

The accompanying CI build change removes that duplicate serial full gate. A
versioned verification-portfolio manifest mechanically matches every command in
`npm run check` and `npm run build` to one authoritative job; Rust Clippy,
default tests, crash reconciliation, and runtime builds run in isolated lanes
behind the existing Rust aggregate. The runtime lane passes commit- and
toolchain-bound server binaries to Vitest, which still executes every selected
test freshly. This orchestration change does not itself narrow crash cadence or
establish a hosted speedup; the projections below remain subject to real PR and
integrated-push measurements.

### Expected timing impact

These are projections to validate, not achieved results:

- An ordinary app-server-only PR currently eligible for the broad predicate can avoid up to the observed 3m58.5s crash command on the Rust critical path, while retaining its app-server tests.
- A crash-relevant PR that runs the existing 21-test core binary plus a purpose-split Ladybug smoke will save the unselected route/query/corpus/reconciliation runtime and test-binary link work. The existing logs show only about 38.5 seconds of server test execution, so substantial additional savings require avoiding unrelated test-binary linking and reusing compiler objects; merely filtering test names after compiling every binary will not deliver the four-minute saving.
- Full integration PR time will not decrease from this change and may increase by the Apple Silicon real-kill job. That is intentional: the optimization moves complete proof to the exact integrated state instead of deleting it.
- Nightly and release time is outside ordinary PR latency. It must be separately budgeted and cannot be used to claim Issue #360's under-ten-minute warm component target until hosted measurements exist.

Stage 2 should be accepted only after at least five real component PRs report cold/warm, compile/link, test, and total crash-chapter time. Do not manufacture repeated cold runs.

## Proposed planner and workflow contract

### Versioned checkpoint manifest

Add a checked-in `scripts/ci/crash-checkpoints.v1.json` (name illustrative) with one entry per test scenario:

```json
{
  "version": 1,
  "tests": [
    {
      "id": "core.complete.exact-retry",
      "package": "relayer-graph-core",
      "binary": "search_index_ordering",
      "test": "exact_retry_converges_after_every_completion_crash_boundary",
      "group": "ordering-smoke",
      "productPromise": "acknowledged accepted graph is durable and exactly retryable",
      "authority": "canonical SQLite completion and operation receipt",
      "failureCheckpoints": [
        "AfterSqliteClosureWrite",
        "AfterSearchClosureWrite",
        "AfterSearchCommit",
        "AfterSqliteRevisionRecord",
        "AfterSqliteCommit",
        "AfterResponsePrepared"
      ],
      "platform": "any",
      "cadences": ["affected-pr", "integration", "nightly", "release"]
    }
  ]
}
```

The manifest is the routing authority, not verification evidence. Tests still execute freshly. Every entry must map to one or more source owner patterns, and every discovered crash/fault/reconciliation test must appear exactly once.

### Planner output

Extend the existing plan with explicit fields:

```json
{
  "crashMode": "none | compile | smoke | full",
  "crashGroups": ["ordering-smoke", "reconciliation-smoke"],
  "realKill": false,
  "reasons": [
    "crates/relayer-graph-server/src/search_index/lifecycle.rs: reconciliation owner"
  ]
}
```

Selection rules:

1. `integration/**` pushes, integration PRs to `main`, and default-branch pushes select `full`; integration selects `realKill: true`.
2. Changes to graph completion publication, search-index revision/receipt storage, Ladybug store/schema/lifecycle, public search readiness/authority, or their tests select the mapped smoke groups.
3. App-server-only changes do not select Ladybug crash runtime. Their interrupted-execution and product/graph handoff tests remain app-server owners.
4. `Cargo.toml`, `Cargo.lock`, graph crate feature declarations, `build.rs`, Ladybug source/pin/packaging inputs, the CI workflow, runner scripts, planner, checkpoint manifest, test discovery code, unknown paths, unmapped paths, and any deleted/renamed mapped test select `full`.
5. A source change inside a mapped crash-owning crate that the finer map cannot classify selects `full`, not `none`.
6. Do not use top-level Actions `paths` filters. The existing always-present workflow and stable aggregate `check` remain the branch-rule surface.

### Ordinary affected-PR smoke

Run on Ubuntu:

1. selected Clippy with `--all-targets --all-features`, which compile-checks crash-feature code for selected graph crates;
2. fresh core `search_index_ordering` (keeping all 21 tests is cheap after compile);
3. the proposed five-test lifecycle smoke in a purpose-split test binary; and
4. the three public-route orphan/authority tests when publication/readiness/route code changes.

Purpose-split existing tests rather than copying their setup/assertions. The split must be behavior-neutral and preserve full-suite invocation. A test filter inside the existing monolithic server command is insufficient if Cargo still builds every integration binary.

A maintainer label or manual dispatch may escalate an exact PR SHA from smoke to named groups/full, but labels are not the primary selector and cannot override fail-open `full`.

### Full integration-state verification

On `integration/**` and the integration PR to `main`:

- run every authority in the versioned verification portfolio on Ubuntu, with
  deterministic equivalence to the current `npm run check` and `npm run build`
  command sequences;
- run `ladybug_crash_reconciliation` on the existing `macos-15` Apple Silicon runner and assert the parent test count is one;
- keep tests fresh even when Cargo/sccache artifacts restore;
- aggregate both results into required `check` and fail if either selected job is skipped, cancelled, reports zero tests, or fails; and
- keep merge manual.

The current Apple Silicon packaging job already runs on a `macos-15-arm64` image. The real-kill proof may share setup/compiler artifacts with that job, but its result must remain a separately named chapter so packaging success cannot masquerade as crash success.

### Scheduled/nightly stress

Add a separate scheduled workflow at a non-zero minute, plus manual dispatch. It should run from the default branch and:

- repeat kill/reopen/retry with a bounded count and wall-clock limit;
- cycle declared crash checkpoints and lifecycle fault classes;
- add ASAN/TSAN only where Ladybug/native dependencies and runner support make the result meaningful;
- record deterministic seeds and exact scenario configuration;
- upload logs/receipts even on failure; and
- alert on failure or a stale/missing run.

GitHub documents that scheduled workflows can be delayed or dropped under load, especially at the top of the hour. Nightly evidence is therefore diagnostic depth, never sole pre-merge or release authority.

### Release gate

For each Preview and Stable candidate:

1. bind evidence to the exact candidate SHA and packaged graph-server bytes;
2. run the full deterministic feature portfolio;
3. run the Apple Silicon real-kill/reopen proof;
4. run the existing packaged Ladybug lock/shutdown/reopen lifecycle capture;
5. run a bounded replayable crash campaign; and
6. require zero unexplained failures or skipped selected scenarios before manual publication/promotion.

Stable promotion may reuse immutable Preview artifacts, but it may not reuse an older source snapshot or merely cite a prior nightly. Existing release authority and no-automatic-downgrade rules remain unchanged.

## Deterministic planner and workflow tests required before rollout

Add tests to the existing CI test portfolio for:

1. **Mode selection:** representative unrelated, mapped smoke, full, integration, and unknown path sets produce exact `crashMode`, groups, platform, and reasons.
2. **Fail-open drift:** an unknown file inside either graph crate, a changed/deleted mapped test, a new `#[cfg(feature = "crash-test-support")]` test, or an unreadable/truncated diff selects full.
3. **Manifest completeness:** source/Cargo test discovery and the manifest have a one-to-one mapping for every crash hook, lifecycle fault, real-kill parent, and required-feature crash/reconciliation test.
4. **Checkpoint completeness:** every `CompletionCrashPoint` and `SearchIndexLifecycleFault` enum variant is owned by at least one mapped scenario or explicitly documented as helper-only.
5. **No test-result caching:** workflow assertions permit registry/compiler caches but reject restored JUnit/pass receipts as a successful chapter.
6. **Fresh invocation:** selected commands contain the exact current SHA context and actually invoke Cargo tests after cache restore.
7. **Stable aggregation:** `check` fails when a selected smoke, full, or Apple Silicon job fails, is cancelled, is absent, or is unexpectedly skipped; an unselected conditional job is accepted only when the plan says it is unselected.
8. **Platform truth:** the real-kill job asserts `runner.arch == ARM64`, target cfg is macOS/aarch64, and the parent scenario executed once rather than compiling to zero tests.
9. **Integration override:** any affected-path result is overridden to full plus real kill for integration state.
10. **Manual merge:** workflow and ruleset fixtures continue to exclude auto-merge and merge-queue mutation.

## Staged rollout

### Stage 0 — improve evidence without changing cadence

- Record per-binary compile/link and execution time in the Rust summary.
- Report exact test counts and explicitly flag the Ubuntu real-kill zero-test result.
- Record crash mode/groups/reasons as `full-current` for comparison.

Exit: two real hosted runs distinguish compile/link from execution and show the Apple Silicon runner can execute the parent real-kill scenario.

### Stage 1 — land the manifest and deterministic planner tests

- Add the complete checkpoint manifest and completeness tests.
- Purpose-split the smoke tests without changing which tests run in the full command.
- Keep the current every-eligible-PR full command while validating plan output in shadow mode.

Exit: no unmapped crash/fault test, all planner adversarial fixtures pass, and full command results are unchanged.

### Stage 2 — narrow ordinary component PRs

- Remove the broad `app-server || graph-server` crash predicate.
- Enable manifest-selected smoke for crash-relevant graph paths.
- Keep unknown/full fallbacks, full integration/default-branch runs, and manual escalation.

Exit: at least five real component PR observations; no selected job skip; measured improvement without test-result reuse; no integration failure attributable to a scenario omitted from the component smoke.

### Stage 3 — add nightly depth

- Add bounded Apple Silicon kill/corruption campaigns with replay artifacts and stale-run alerting.
- Tune count/time from measurements, not an arbitrary multi-hour copy of another project.

Exit: three consecutive scheduled runs execute all declared groups and one intentionally injected failure proves alerts/artifacts work.

### Stage 4 — bind release proof

- Require the exact-candidate full, real-kill, packaged lifecycle, and bounded campaign results in Preview/Stable release operations.
- Keep publication and promotion manual.

Exit: one Preview candidate produces a complete immutable receipt before the rule is allowed to gate Stable.

## Residual escape analysis

| Residual escape after narrowing                                                   | Owning countermeasure                                                                                                                                        | Remaining limitation                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| An unrelated-looking path affects crash behavior through an unmodeled dependency. | Unknown/unmapped and changes inside ambiguous graph-crate areas select full; manifest completeness test.                                                     | A semantically wrong owner declaration can still escape until integration.         |
| A corruption variant omitted from smoke fails.                                    | Full exact integration state, default-branch full run, nightly all groups.                                                                                   | Component feedback arrives later than smoke.                                       |
| Linux injected panic differs from OS process death/WAL behavior.                  | Required Apple Silicon real `SIGKILL` on integration and release; repeated nightly kill/reopen.                                                              | One kill point does not cover arbitrary filesystem/power-loss behavior.            |
| All-features compilation hides an isolated feature edge.                          | Add explicit default/no-default/crash-feature compile matrix at integration; use targeted feature compilation where additive-feature assumptions are unsafe. | Compile freshness is not runtime correctness.                                      |
| A passing derived revision hides topology corruption.                             | Full topology/inventory reconciliation tests, not revision-only checks.                                                                                      | The test corpus cannot enumerate every possible malformed store.                   |
| Nightly is delayed/dropped or an old green result is reused.                      | Stale-run alert; nightly never authorizes merge/release; candidate reruns required proof.                                                                    | Diagnostics may be delayed.                                                        |
| Integration branch differs from final merge base.                                 | Strict required check and exact integrated PR commit; rerun after base changes.                                                                              | Manual operator can still choose not to merge; that is intended authority.         |
| Compiler cache is poisoned/stale.                                                 | Tests execute fresh; cache failure falls back; source-snapshot assertions; no result cache.                                                                  | A compiler defect is outside this test portfolio.                                  |
| Crash test flakes and is retried until green.                                     | Preserve first failure, no automatic unchanged retry in required gates, zero unexplained failures for release.                                               | Infrastructure failures still require diagnosis and an explicitly justified rerun. |
| App-server recovery is mistaken for Ladybug recovery or vice versa.               | Separate checkpoint groups and owners; ordinary app-server persistence/recovery tests remain mandatory.                                                      | Cross-layer defects require the full repository integration portfolio.             |

## Rollback criteria

Immediately restore the affected owner/group to full per-PR execution if any of the following occurs:

1. an integration, main, nightly, or release failure would have been caught by an existing test omitted from that component PR's selected smoke;
2. a crash/fault test or enum variant is unmapped, duplicated, renamed without manifest update, or reports zero execution unexpectedly;
3. a planner/workflow change can make selected evidence skip while aggregate `check` passes;
4. the Apple Silicon job is unavailable often enough that integration proof cannot complete, with no equivalent authorized runner;
5. test results, pass receipts, or prior-SHA evidence are used as substitutes for fresh execution; or
6. a release candidate lacks exact-SHA packaged crash/reopen evidence.

Pause further narrowing and reassess if, after five representative runs, smoke consumes at least 80% of the full crash chapter's warm critical-path time. That would mean the complexity is not buying meaningful latency; prefer a simpler full gate or deeper test-binary restructuring rather than weakening checkpoints.

Any rollback should be a planner/manifest routing change, not deletion of tests. Keep the full portfolio runnable throughout.

## Primary-source practice review

| Project/source                                                                                                                                                                                                                                                                                                                                                    | Observed practice                                                                                                                                                                                              | Transfer to Relayer                                                                                                                                                        | Do not copy blindly                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Tokio Loom workflow at `8b13642a`](https://github.com/tokio-rs/tokio/blob/8b13642a1f7346814f189937b2d6e1e80b210db1/.github/workflows/loom.yml) and [ordinary CI](https://github.com/tokio-rs/tokio/blob/master/.github/workflows/ci.yml)                                                                                                                         | Costly Loom scopes run on labeled PRs and fully on maintained-branch pushes; ordinary CI compile-checks Loom code. Work is partitioned and bounded by preemption/branch limits.                                | Compile all gated code, select named affected fault groups on PRs, run full groups on integrated/default state, and bound exploration.                                     | Loom explores concurrency schedules, not disk/process crash semantics; labels alone are not a fail-open planner. |
| [RocksDB stress-test documentation](https://github.com/facebook/rocksdb/wiki/Stress-test) and [current crash targets at `bbdcd282`](https://github.com/facebook/rocksdb/blob/bbdcd2825fd907c8014ba0995dca58880cb476fe/crash_test.mk)                                                                                                                              | Deterministic unit tests coexist with continuous multi-hour randomized black-box `kill -9` and white-box filesystem fault injection, multiple validation authorities, and scenario-specific targets.           | Keep small deterministic PR smoke; move repeated kills, option combinations, and sanitizers to nightly/release; record seed/checkpoint and validate independent authority. | Multi-hour DB stress is disproportionate for every component PR.                                                 |
| [redb CI at `553cacdf`](https://github.com/cberner/redb/blob/553cacdffb38d8dc8cb9d61cb11a23352ef49fd2/.github/workflows/ci.yml) and [recovery design](https://github.com/cberner/redb/blob/master/docs/design.md)                                                                                                                                                 | Fresh cross-platform tests, fuzz smoke, and default/all/no-default compile surfaces run while build artifacts are cached. Recovery claims name checksums, transaction IDs, roots, and rollback authority.      | Cache compilation only, run selected tests fresh, keep feature surfaces explicit, and tie each test to its recovery authority.                                             | Its public workflow does not itself establish the desired nightly split.                                         |
| [Rust bors](https://github.com/rust-lang/bors)                                                                                                                                                                                                                                                                                                                    | The tested state is a constructed merge commit on a special branch before integration.                                                                                                                         | Full crash proof should bind the exact integration commit/base combination.                                                                                                | Do not add automatic merge or a scheduler; this repository's integration PR and manual merge are sufficient.     |
| [Cargo feature semantics](https://doc.rust-lang.org/cargo/reference/features.html) and [cargo-hack](https://github.com/taiki-e/cargo-hack)                                                                                                                                                                                                                        | Default, no-default, all-features, and individual feature configurations are distinct; feature unification can hide isolated edges.                                                                            | Separate compile surfaces and partition combinatorial matrices where useful.                                                                                               | `--all-features` alone is not proof of feature isolation.                                                        |
| [GitHub required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), [workflow troubleshooting](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows), and [runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) | Top-level skipped workflows can leave required checks pending; path diff filters are limited; schedules can delay/drop; macOS standard runners are Apple Silicon; stable required checks should always report. | Keep one always-triggered workflow, plan internally, fail open, aggregate selected jobs, schedule off the hour, and assert ARM64 real-test execution.                      | A scheduled green or a skipped conditional is not release evidence.                                              |
| [Cargo packaging/publishing](https://doc.rust-lang.org/cargo/reference/publishing.html)                                                                                                                                                                                                                                                                           | Packaging builds/extracts/verifies the actual artifact without publishing during dry run.                                                                                                                      | Verify exact candidate/package bytes before publication.                                                                                                                   | Source-tree tests alone do not certify packaged native behavior.                                                 |

The shared pattern is separation by evidence cost and authority: cheap deterministic and compile checks close to edits, complete integrated-state proof before merge, stochastic/repeated fault work off the PR critical path, and exact-artifact proof before release. No reviewed mature project supports caching a prior test result as evidence for a new source snapshot.

## Final recommendation

Proceed only through the staged plan. The immediate safe change is not “delete crash tests from PR CI”; it is to establish the checkpoint manifest, make the real-kill zero-test gap visible, purpose-split the smoke binaries, and shadow-test affectedness. Once that mapping is proven, ordinary component PRs can stop paying the broad four-minute command while the exact integrated and release states receive stronger crash evidence than they do today.
