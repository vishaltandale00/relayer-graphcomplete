# TLA+ models

These models find bugs in the parts of Relayer with the most concurrent
state. The method is model, counterexample, reproduce, fix:

1. Model one race-prone state machine, citing the code each action abstracts.
2. Let TLC search every interleaving for a trace that breaks a stated promise.
3. Reproduce the trace as a scenario the real code replays, and watch it fail.
4. Fix the code, mirror the fix in the model, and flip the check.

A model is a search tool, not proof. The evidence for a bug or a fix is the
regression test on the real code. A passing check means only that no
counterexample exists within the model's abstraction and bounds.

## Running

```bash
npm run check:models
```

Pass check ids to run a subset. The runner needs Java 11 or newer and the
pinned `tla2tools.jar` (version and sha256 in `checks.json`). It never
downloads the jar; place it at `~/.cache/tlaplus/tla2tools-1.8.0.jar` or set
`TLA2TOOLS_JAR`. All checks and scenarios together take a few minutes on an idle machine.
`--render` rewrites the scenario traces (see below).

`check:models` is not part of `npm run check` yet. Adding it there requires a
Java runtime in CI and an entry in `scripts/ci/verification-portfolio.v1.json`.

## How expectations work

Each check in `checks.json` expects either `pass` or a named violation. A
known bug is recorded as an expected violation, so the runner stays green
while the bug is open. The runner reads only the models, never the code, so
the models must be kept in step with the code by hand.

`CompletionCurrent` and `ExecutionLeases` have one constant for each
candidate fix:

- `completion-today` and `leases-today` mirror the code as it is.
- `completion-fixed` enables every fix. Every `ExecutionLeases` fix has
  landed, so `leases-today` is also its fixed preset.

Each bug check starts from `completion-today`, switches every other bug's
fix on, and leaves its own constant as the code has it. A violation of that
check can therefore come only from its own mechanism.

`CatalogRefresh` follows the same rule with `catalog-today`, which mirrors
the code. It has one constant per landed fix, and each open bug check keeps
every landed fix on. `ProviderLeaseLifecycle` does the same with
`lifecycle-today`.

A fix PR flips its constant in `completion-today` or `catalog-today`. That
check then passes, so the PR must also flip its expectation to `pass`;
otherwise the runner fails.
A provider fix edits `ProviderSettings.tla` directly and flips its check the
same way. Violated checks run on one TLC worker, so a violated invariant's trace is
the same from run to run. A liveness counterexample may still differ between
runs.

## Scenarios and trace replay

A scenario in `scenarios.json` is a list of named spec actions with their
arguments, such as `["Handoff", "N", "ok"]`. The runner runs each scenario
through its model with TLC. It writes the full expected state after every
step to `traces/<id>.json`. The spec's `Act` operator maps each name to its
action.

The traces are committed, so replaying them needs no Java. Outside
`--render`, the runner fails if a committed trace no longer matches the
model. A step the model does not allow is also an error.

An adapter replays each trace against the real code, one step at a time. For
`ProviderSettings`, [`test/support/provider-settings-trace-adapter.mjs`](../../test/support/provider-settings-trace-adapter.mjs)
drives the real `ProviderDefinitionService` and IPC handlers:

- **Actions:** each spec action becomes the real call it abstracts.
- **Awaits:** the spec splits an operation at certain awaits (`prepareRuntime`,
  `login()`, `openExternal`, `account()`, `onRuntimeReady`). Each of those is
  held on a deferred, so each step resumes exactly one of them.
- **State:** `observe()` is the refinement mapping. It reads the real objects
  back as the spec's variables.

[`test/provider-settings-traces.test.mjs`](../../test/provider-settings-traces.test.mjs)
checks two things after every step:

- The real state must equal the model's state. A mismatch means the code and
  the model disagree.
- The scenario's promises must hold. A broken promise is a bug in both.

For `CompletionCurrent`, [`crates/relayer-app-server/tests/support/completion_traces.rs`](../../crates/relayer-app-server/tests/support/completion_traces.rs)
replays against the real app-server code:

- **Graph:** a real in-memory graph server holding a real recursive child.
- **Product:** the real SQLite product store.
- **Harness:** a fake whose start is refused, or runs while acknowledging
  another identity (a lost acknowledgement).
- **Graph faults:** a layer in front of the graph server can fail the next
  capability activation with a 503, or garble control preparations, so a
  replay or a direct test reaches those failures on the real server.
- **Launch steps:** each step calls the function `complete_prepared_child`
  calls for it (reserve, claim, activate, start).
- **Cleanup:** the start-failure cleanup is the real background task. The fake
  harness holds its first call (cancel) until the replay reaches
  `CleanCancel`, so the task cannot run ahead of the trace. Its later loops
  cannot be paused, so the replay compares state once it has run.
- **Child Return:** the child's model returns through its own graph writer.
- **Projection:** the product's settlement reason (`execWhy`) is compared, so
  a wrongly projected reason is caught.
- **`finalPromises`:** these must hold at the end of the scenario.
- **The deadlock the model missed:** the model has no harness session lock. The real-process `recursive-complete-e2e` test found the gap: child admission first asked the host to set up the thread's session, which the running root turn holds while it awaits the child. Children now skip that step (`admit_invoked_execution`). The adapter's fake harness rejects session setup as busy, so the fast tier guards against it too.
- **Selected children:** a scenario whose initial state has `selected = TRUE` seeds a catalog and gives the root a model selection. The child inherits it and is admitted: the fake harness signs the admission with the app server's own digest helpers. The replay compares the child's attempt and lease, read from the product database, with the model.
- **Unheld background work:** the semantic and exit observers run on their own. A step that sets them off (`ChildReturn`, `ProviderExit`) is compared together with the background steps that follow it, once they have run. Comparing it at once raced the observer.
- **Beyond the traces:** direct adapter tests cover what the model abstracts:
  - a host that stays unreachable while a child runs (`provider_end_waits_through_an_unreachable_harness`);
  - leases granted for an attempt the product then refuses to record (`a_child_whose_attempt_cannot_be_recorded_releases_its_leases`).

  The handler test `a_launch_whose_caller_disconnects_still_attaches_and_observes_the_child` covers a broker request dropped during the start.
- **Restarts:** `Crash` restarts the app with its harness, so the provider run ends. `AppRestart` restarts only the product server: the harness and the provider run survive, and so do the child's attempt and lease. After either, the resumed provider-end wait (`AttemptEnd`) ends the attempt only once the provider has stopped, and `CancelTerminal` keeps cancelling a stopped or failed child that still runs. Start-failure cleanup fails and settles the child before it cancels (`CleanFail`, `CleanFinalize`, then `CleanCancel`), so an unreachable harness cannot hold the child's result open.
- **Known model gaps:** `AttemptEnd` is a free action guarded by the provider having ended, rather than a step of the observers. The model has no observation error while the provider runs, and the timeout re-poll is modeled only by turning the timeout off. The adapter drives each launch step itself rather than through `complete_prepared_child`, so a wiring slip in the handler is caught only by the handler tests.

The first replay found a model error. The IPC layer releases a renderer
binding once its connection settles, and the model did not.

For `TurnComposer` and `NodeInspector`, the adapters render the real
Product workspace (`createProductWorkspace`) in happy-dom:

- [`test/support/turn-composer-trace-adapter.mjs`](../../test/support/turn-composer-trace-adapter.mjs)
  types into `#threadPrompt`, clicks Send, and switches threads by calling
  `render()`, as `renderThread()` does. A fake `threads.submitInteraction`
  holds the POST, the refresh that loads the new turn, and the await before
  settlement on deferreds. `observe()` reads the prompt's value and disabled
  state and the drafts persisted in `composer-drafts`.
- [`test/support/node-inspector-trace-adapter.mjs`](../../test/support/node-inspector-trace-adapter.mjs)
  clicks graph nodes, `+`, `×`, and Close, and types in the annotation
  editor, with the real node context draft controller. Every draft save and
  discard request and every Node Detail asset is held on a deferred, and the
  controller's 350 ms autosave runs on fake timers. `observe()` reads the
  selection, the inspector, its header, the Node Detail host and whether its
  page is shown, and the annotation dock.

- [`test/support/authored-input-send-trace-adapter.mjs`](../../test/support/authored-input-send-trace-adapter.mjs)
  types into an authored Node Detail input, commits it with `change`, and
  clicks Send, with the real input draft controller. A fake app server
  applies the commit and reservation rules of the SQLite storage it cites;
  the replay checks what the renderer decides: whether Send is enabled and
  which draft revision each request carries.

A scenario may list `violatedAtEnd`: promises of an open bug. The replay must
match the model at every step, and those promises must hold until the final
step and break at it. This records the bug on the real code while the suite
stays green. A fix removes them from `violatedAtEnd`, and the replay then
requires them to hold. Deleting the guard a scenario depends on makes its
replay diverge at the step the guard governs.

A bug fix follows these steps:

1. Add the counterexample's steps as a scenario, render it, and watch the
   replay break the promise at the final step.
2. Fix the code and mirror the fix in the model.
3. Re-render the trace. The replay now matches the model's new state, and the
   promise holds.

With the code fix reverted, the replay fails at exactly the step the fix
changes.

`ExecutionLeases` has no scenarios or adapter yet.

## Verdicts

The Verdict column is an independent read of the code for each
counterexample:

- **Confirmed:** the product can reach the trace.
- **Plausible:** reaching it depends on the assumption named in the row.
- **Latent:** the mechanism is real, but the current UI cannot reach it.

## Models

### `ProviderSettings.tla`

This model covers provider connections, execution leases, and default model
settings:

- **Desktop main:** the `#serialized` provider queue, connect, reconnect,
  complete, cancel, logout, remove, the execution lease broker and `close()`.
- **IPC:** the browser handoff and renderer ownership.
- **UI:** when Reconnect and Remove are offered.
- **SQLite catalog:** the default family and provider removal guards.

There is one existing managed provider `P`, one new connection `N`, and one
renderer.

| Check | Verdict | Finding |
| --- | --- | --- |
| `provider-leased-runtime` | Fixed; now passes | Before the fix (plausible: narrow window): Rust admitted a turn while `P` still read connected in SQLite, and the user then signed out and reconnected. When the harness took its lease, `acquireExecution` handed out the runtime the pending reconnect registered, because it never checked `pendingConnections`. A failed handoff, a cancel or a terminal check then ran `#cancelPendingConnection`, which closed that runtime and wiped its home under the turn (PROV-004). Now `acquireExecution` refuses while a reconnect is pending, and a settling reconnect never closes or wipes a runtime a lease holds. When the sign-out's publish failed, Rust kept admitting turns through the whole reconnect, so the window was wide. `ProviderLeaseLifecycle` checks each fix and its reverted form. Regression tests: `refuses a turn's provider access while a reconnect is pending`, `refuses access during a reconnect after a sign-out the app server never recorded` and `never closes or wipes a leased runtime when a reconnect settles` in `provider-connection-generation.test.mjs`. |
| `provider-remove-during-reconnect` | Fixed; now passes | Before the fix: after sign out, Reconnect, then Remove, the pending reconnect outlived the removal and could still complete. Now `remove()` drops it as the provider enters `removal_pending`, which "immediately blocks new attempts through it" (docs/architecture.md). The runtime stays in `this.runtimes` for turns still draining, and it closes with the tombstone. The PRD is silent here, so this is an architecture-backed decision. Scenario: `provider-remove-during-reconnect`. |
| `provider-attempt-ownership` | Fixed; now passes | Before the fix: `bindConnection` ran only after `connect()`/`reconnect()` (including `login()`) and `openExternal` resolved. It added a `destroyed` listener to contents already destroyed, and that listener never fired. It now cancels the attempt instead. This restores PRD BRW-005. Scenario: `provider-destroyed-before-bind`. |
| `provider-close` | Fixed; now passes | Before the fix (plausible: depends on shutdown order): `close()` waited for lifecycle tasks but not for the queue, and `acquireExecution` ignored `closing`. A turn admitted before shutdown could create and register a runtime after the maps were cleared, and nothing closed it. Now `acquireExecution` refuses once `close()` begins, and `#runtimeFor` closes a runtime that finishes starting after it. `close()` still does not wait for the queue. Regression test: `refuses access once shutdown begins, and closes a runtime that finished starting after it`. |
| `provider-default-family` | Decided; now passes | A catalog refresh that reports `provider_no_eligible_execution_models` tombstones the provider's managed family even when it is the default family. PRD PROV-008 (decision Q15) makes this a recovery state. The family stays the default and Send is refused with that code. Settings and both composers show "Needs model setup" with an exact-provider **Refresh models** action. If the provider then disconnects, the family stays selected and shows the disconnected state with a reconnect through Settings. A managed family the user disabled is not in recovery and restores still disabled. A later eligible refresh restores the family, or after a policy upgrade its successor. The invariant was `DefaultFamilyIsLive`; it is now `DefaultFamilyIsLiveOrManagedByActiveProvider`, named for what it checks. It allows a non-live default only for `P`'s managed family while `P` is active, including after `P` disconnects. It does not model the user's enabled choice, the tombstone cause, or which family is kept for recovery; the Rust flow, storage and migration tests check those. Regression tests: `a_default_family_without_eligible_models_needs_model_setup_until_a_refresh_restores_it` and `test/default-family-recovery.test.mjs`. |

### `CatalogRefresh.tla`

This model covers the model catalog and the default provider and family:

- **Desktop main:** the per-provider catalog refresh queue
  (`model-catalog-service.mjs`). Before PR 4 a refresh captured its adapter
  when it was requested; now it resolves the adapter and the connection
  generation when it runs. The model also covers the pre-inference join,
  `close()`, the unavailable stub's explicit recovery, and logout, reconnect,
  remove and connect at the points where they meet that queue.
- **SQLite catalog:** a publish reactivates or tombstones the provider's
  managed family and reconciles an unset or managed default. With the
  generation, it first refuses a result from an older connection generation.
  It also covers the user's default provider and family choices and the
  removal guard.

There are two providers: the existing managed provider `P`, and `Q`, which
starts absent and may connect. The families are their managed families `mP`
and `mQ`, and one custom family `C` with members from both. Each check
shrinks the bounds in `catalog-today`. On an idle machine the two slowest,
the default-provider checks, take about 10 and 20 seconds.

`catalog-today` has six fix constants, all landed:

- `DefaultProviderPairsFamily`: choosing a default provider also selects that
  provider's enabled managed family, in the same transaction. A provider
  without one is refused, and the defaults stay unchanged (PROV-008).
- `ConnectionGeneration`: each provider row carries a connection generation.
  Logout, reconnect completion and removal advance it in their own
  transaction. A refresh resolves its adapter and generation when it starts.
  Rust refuses a publish from an older generation inside its write
  transaction. Logout commits its signed-out state itself and no longer waits
  for its refresh inside the provider queue (PROV-002).
- `ReconnectKeepsAdapter`: a cancelled or failed reconnect leaves the active
  provider a catalog adapter. Recovery refuses while a reconnect is pending,
  so it never discovers through that reconnect's runtime (F4, L1).
- `AdapterAfterCommit`: connect registers the catalog adapter only after the
  definition commits (PROV-007).
- `RefreshSkipsPendingReconnect`: while a reconnect is pending, a refresh
  resolves no generation. It neither runs nor publishes until the reconnect
  settles, and `DefaultRestores` counts a provider as healthy only then. This
  model has no provider home, so `ProviderLeaseLifecycle` checks what the fix
  prevents.
- `CancelSignsOut`: a cancelled or failed reconnect commits signed-out with
  the next generation, as logout does, and its wipe signs the account out.
  Every result in flight is superseded.

Each `-reverted` check turns one constant off and keeps the others on, so its
violation comes only from its own mechanism.

| Check | Verdict | Finding |
| --- | --- | --- |
| `catalog-refresh-keeps-chosen-default` | Fixed; now passes | Before the fix, the Settings default-provider selector saved only `providerId`. Rust stored that provider with the old provider's managed family. The next catalog publish for the old provider matched "the default family is my managed family" and moved the default provider back. The pairing leaves nothing for a refresh to revert. The check also proves `DefaultIsPaired` and `RefreshKeepsOtherDefault`. Regression test: `catalog_refresh_keeps_the_chosen_default_provider_and_its_managed_family` in `model_catalog_flow.rs`. |
| `catalog-refresh-keeps-default-chosen-from-unset` | passes | Starts with no default family. A refresh may fill it, with its provider, which PROV-008 allows. Once the user chooses a provider and family, no refresh changes them. With the fix off, the same bounds violate `RefreshKeepsUserDefault` through the same trace as `catalog-chosen-default-reverted`. |
| `catalog-chosen-default-reverted` | violated: shows why the fix is needed | With `DefaultProviderPairsFamily` off, `Q` connects, the user chooses `Q`, and a refresh of `P` moves the default provider back to `P`. |
| `catalog-stale-refresh-after-reconnect` | Fixed; now passes | Before the fix, a refresh discovered "disconnected" after sign-out, then stalled. The user reconnected, which published connected directly. The stalled refresh then published its disconnected result, and nothing queued behind it corrected that (CR-V1, plausible: needs a stall). Now that result carries the older generation and has no effect. The check also proves `NoStaleEffect`. Regression tests: `drops a refresh that discovered before a reconnect completed` in `provider-connection-generation.test.mjs`, and `a_catalog_result_from_a_superseded_connection_generation_has_no_effect` in `model_catalog_flow.rs`. |
| `catalog-stale-refresh-after-reconnect-reverted` | violated: shows why the fix is needed | With `ConnectionGeneration` off, the stalled result publishes over the reconnect. |
| `catalog-old-account-repopulates` | Fixed; now passes | Before the fix, a refresh discovered eligible models. A reconnect to an account with zero eligible models then tombstoned the managed family. The older eligible result published afterwards and reactivated it (CR-V3, plausible: an old `model/list` outlasts a full login). Now it carries the older generation. Regression test: the same Rust flow test. |
| `catalog-old-account-repopulates-reverted` | violated: shows why the fix is needed | With `ConnectionGeneration` off, the older eligible result reactivates the family. |
| `catalog-stale-adapter-capture` | Fixed; now passes | Before the fix, a refresh captured the unavailable stub when it was requested, and the stub answered "could not be activated". A reconnect or recovery then registered the real runtime and published connected. The stub's result then published over it (F3/V2, confirmed). A refresh now resolves its adapter when it runs. Regression test: `keeps a recovered provider connected when a refresh requested during recovery runs after it`. |
| `catalog-stale-adapter-capture-reverted` | violated: shows why the fix is needed | With `ConnectionGeneration` off, the captured stub contradicts the reconnect. |
| `catalog-stub-recovery-logout-deadlock` | Fixed; now passes | Before the fix, an explicit refresh through the stub waited for the provider queue. Logout held that queue while it waited for its own refresh, queued behind the explicit one. Neither returned (CR-V7, latent: the UI hides Sign out while the stub is registered). Logout now commits its signed-out state with the next generation and does not wait for the refresh. Regression test: `signs out while an explicit recovery is queued behind another refresh`. |
| `catalog-stub-recovery-logout-deadlock-reverted` | violated: shows why the fix is needed | With `ConnectionGeneration` off, logout never returns. |
| `catalog-no-restore-after-cancelled-reconnect` | Fixed; now passes | Before the fix, a cancelled reconnect unregistered the catalog adapter while the provider stayed active. A tombstoned default family then never restored, because no refresh could run (V8, F4, confirmed). Recovery could also discover through the pending reconnect's runtime (L1). The check proves `ActiveProviderHasAdapter`, including when the fresh runtime cannot start and the recovery adapter stands in, and `DefaultRestores`. Regression tests: `keeps a catalog adapter for an active provider whose reconnect is cancelled`, `falls back to the recovery adapter when a cancelled reconnect cannot restart the runtime`, and `does not recover through the runtime of a pending reconnect`. |
| `catalog-no-restore-after-cancelled-reconnect-reverted` | violated: shows why the fix is needed | With `ReconnectKeepsAdapter` off, a cancelled reconnect leaves the active provider with no adapter. |
| `catalog-connect-adapter-after-commit` | Fixed; now passes | Checks `AdapterOnlyForDefinition`. Before the fix, connect registered the catalog adapter before the definition committed, so a refresh could run for a provider that did not exist (F1). Regression test: `publishes nothing and registers no adapter before the definition exists, and a refused create leaves nothing`. |
| `catalog-connect-adapter-after-commit-reverted` | violated: shows why the fix is needed | With `AdapterAfterCommit` off, the adapter exists before the definition. |
| `catalog-own-family` | passes | A catalog publish changes only its own provider's managed family and never the custom family. |
| `catalog-tombstoned-default-blocks-send` | passes | A default family tombstoned by a zero-eligible publish stays the default and blocks Send. |
| `catalog-default-restores` | passes | With the real adapter registered, a tombstoned default family restores once its provider is healthy again. |

### `CompletionCurrent.tla`

This model covers one recursive child from `complete()` to settlement:

- the graph current's compare-and-swap and receipts;
- the product execution phases and status;
- broker retries of `complete()`;
- the child model;
- the harness run, including a start whose acknowledgement was lost;
- the semantic and provider-exit observers;
- start-failure cleanup;
- the parent's stop, which may come before launch;
- an application restart.

| Check | Verdict | Finding |
| --- | --- | --- |
| `completion-safety-holds` | passes | There is at most one launch per reservation. Stop reports what the graph holds. Terminal states are absorbing. |
| `completion-observe-timeout` | Fixed; now passes | Before the fix: `observe_invoked_completion` had a 5 s control timeout, but the harness answers only when the run ends. A child still running after 5 s was failed with `provider_exited_without_return`, and its capability was revoked while the provider kept running. A live Prime delegation run hit this at about 5.1 s. The observation is now a long poll that the exit observer repeats on a timeout. `provider_end_waits_through_observation_timeouts` proves the repeat with a 100 ms poll against a run that is still going. |
| `completion-activation-failure` | Fixed; now passes | Before the fix: a failed activation settled the execution row only and restored the child to `submitted`. The graph current stayed active, a broker retry got 200 with no launch, and restart skipped the settled row. Now the launch owns the child from its claim on: any activation failure, retryable or not, starts the launch-failure cleanup (`LaunchFailure::ActivationFailed`). It fails the current with `capability_activation_failed`, a canonical reason, and settles both product rows with it, without cancelling. A retry reports the failed child. Scenario: `completion-activation-failure`. Regression test: `a_failed_activation_fails_the_child_in_both_stores_and_an_exact_retry_reports_it`. |
| `completion-activation-failure-reverted` | violated: shows why the fix is needed | Without the fix, a failed activation settles the execution row while the current stays active. |
| `completion-clean-exit` | Fixed; now passes | Before the fix: for an invoked child, the harness resolves a clean native end without checking for Return (`host.ts`). The exit observer failed only on an error, so the child stayed active until its parent stopped it or the app restarted. With child admission, its attempt and leases were then held that whole time. The exit observer now fails an active child once its provider run ends, however it ended: a run that ends without Return is a failure. Scenario: `completion-admitted-exits-without-return`. |
| `completion-clean-exit-reverted` | violated: shows why the fix is needed | Without the clean-exit check, a child whose provider exits cleanly without Return never settles. |
| `completion-start-failure-reason` | Fixed; now passes | Before the fix: start-failure cleanup retried `fail_graph_completion("provider_start_failed")` every 250 ms, and the graph rejected that reason forever. `provider_start_failed`, `provider_attachment_persist_failed` and `graph_observation_failed` are now canonical failure reasons in `validate_terminal_reason`, so the graph and product rows share one reason. Scenario: `completion-start-failure`. `app_server_failure_reasons_are_canonical` in graph-core covers all three reasons. |
| `completion-start-failure-terminal` | Fixed; now passes | Before the fix: if a stop before launch, or a Return after a lost start acknowledgement, terminated the current first, cleanup retried forever. Cleanup now stops at any terminal current and settles the product with that current's own outcome. It uses the same settlement as the semantic observer (`settle_terminal_recursive_child`). Scenarios: `completion-stop-before-failed-start`, `completion-return-after-lost-start`. |
| `completion-child-admission-reverted` | violated: shows why the fix is needed | Before child admission, a selected child's provider ran with no admitted plan, attempt or held lease. Prime refused to run such a child. This check turns admission off and shows `ProviderRunsUnderLease` breaking. With admission on (`completion-today`), the safety checks include `ProviderRunsUnderLease`, `LeaseReleasedOnlyAfterSettlement`, `AccessReleasedOnlyAfterProviderRun` and `AttemptEndsOnlyAfterProvider`. A child's graph current can settle while its provider still runs, so its attempt ends only after both. The model separates the attempt's durable lease record (`lease`, which the adapter reads) from the host's provider access (`access`). The host releases the access as soon as the provider run ends (`HostAccessRelease`), without waiting for the attempt. The record is released only after the attempt ends, when Rust's release finds nothing left to free. `ClaimedChildSettles` requires both to be released. A refused admission fails the child with the host's reported category; the fake refuses with `model_unavailable`. Its cleanup skips the cancel, since no run was started: an unreachable host cannot hold a refused child active. Scenarios: `completion-admitted-start-failure`, `completion-admitted-return-after-lost-start`, `completion-admitted-returns-while-provider-runs`. |
| `completion-restart` | passes | Restart reconciliation does not abort on a state the product produced. |
| `completion-fixed-safety` | passes | With every candidate fix, every safety invariant holds. |
| `completion-fixed-liveness` | passes | With every candidate fix, every claimed child settles. |

The candidate fixes are:

1. Long-poll or re-poll the observation instead of timing out.
2. Fail the child when a clean exit leaves its current active.
3. Fail both stores when activation fails. Landed.
4. Use valid failure reasons. Landed.
5. Let cleanup settle a current another actor already terminated, with that
   current's own outcome. Landed.

A landed fix is on in `completion-today` as well.

The committed scenarios do not step `HostAccessRelease`, since the adapter
has no such step. In their traces the access stays held until
`LeaseReconcile`, which the model also allows.

### `CompletionLaunchWindows.tla`

This model covers the launch windows `CompletionCurrent` abstracts, for one
child from the parent's `prepareComplete` to settlement:

- the broker's product preparation and binding, and a preparation that ends
  ambiguously;
- the execution row before `launching`, and capability activation;
- the thread's one active message turn: the user's next message
  (`UserSends`), which the gate admits only while no message turn runs;
- a run the user starts from another invoke action (`UserInvokes`), which
  starts a fresh native session and runs beside the message turns;
- the product's Stop of the child, and a user's re-invoke of the delegate
  action, which resumed the child on the product path before the decision;
- a crash, and startup reconciliation of each window.

There is one parent, one child, two broker calls and at most two restarts.
Admission, start, attach and the observers are one step each. Each cleanup
is one atomic step: the activation cleanup fails the graph current first, and
the refused-launch cleanup fails the product row first. Startup graph and
store errors, the background retry after them, and a crash inside a cleanup
are not modeled; Rust tests cover them. `launch-today` mirrors the
code, with every fix on; each `-reverted` check turns one fix off.

| Check | Verdict | Finding |
| --- | --- | --- |
| `launch-safety` | passes | A settled execution row has a terminal current and product row. Startup leaves no interrupted child active. Whenever no message turn runs, the user's next message is admitted (`SendNeverWaitsOnChild`, which reads `ENABLED UserSends`, so the child's and the invoked run's states are checked against the gate itself). Two message turns never run at once (`OneHumanTurn`). A run the user invokes never waits (`InvokeNeverWaits`). The product neither stops nor runs an agent's child (`ProductLeavesChildAlone`). |
| `launch-liveness` | passes | Without a restart, every child the parent launched ends in the graph, and its product row ends once its parent is done. |
| `launch-restart-liveness` | passes | Across two restarts, every child the product recorded ends in both stores. |
| `launch-activation-reverted`, `launch-activation-liveness-reverted` | Fixed; the reverted checks show the old traces | A failed or lost activation restored the child to `submitted` and settled only the execution row. An exact retry got 200 and launched nothing, product Stop answered 500, and the next human turn got 422. Now the activation failure fails both stores (`ActivationFailsGraph`). Regression test: `a_failed_activation_fails_the_child_in_both_stores_and_an_exact_retry_reports_it`. |
| `launch-restart-reverted` | Fixed; the reverted check shows the old trace | A restart after the child row existed but before `launching` re-bound the child and left its current active. A second restart then quarantined it as a provenance mismatch, because the expected occurrence was read only while the parent was accepted or running. Startup now reads the child's own occurrence whatever its parent's status, and fails the child in both stores with `application_restart`; a reserved row settles (`StartupFailsUnlaunched`). Startup also marks results an older build left unmarked when only an agent could have created them, and retries a child it kept after a transient graph failure in the background. A deterministic startup failure still fails the child's graph current when its node carries the child's own occurrence, and an unbound child is located without revalidating its model. None of this is modeled: the model has no startup errors or schema versions. Regression tests: `a_restart_before_launch_fails_the_bound_child_in_both_stores`, `a_restart_fails_a_bound_child_whose_parent_already_failed`, `a_restart_fails_an_unbound_child_whose_parent_already_failed`, `a_restart_fails_a_stuck_child_an_older_build_left_unmarked`, `a_restart_that_cannot_reach_the_graph_fails_the_child_once_it_can`, `a_deterministic_startup_failure_fails_the_child_in_both_stores`, `a_restart_fails_an_unbound_child_whose_model_no_longer_validates`, `a_restart_finishes_the_graph_half_of_a_refused_child`. |
| `launch-refused-prepare-reverted`, `launch-child-row-reverted` | Fixed; the reverted checks show the old traces | An ambiguous preparation left the claimed child `submitted` and unbound, and the broker answered 422 "already in progress". Once the parent stopped, nothing recovered it, even across restarts. The refused-launch cleanup now fails it in both stores with `preparation_failed` and binds it to the parent's graph interaction (`RefusedLaunchFailsChild`). It fails the product row first, so a later launch cannot reserve or claim the child; `RefusedCleanup` is one atomic step, so the model does not show that ordering. Only the launch that claimed the child's preparation starts the cleanup, so a concurrent duplicate's refusal cannot end a child the claiming launch still runs. Regression tests: `an_ambiguous_preparation_fails_the_claimed_child_in_both_stores`, `a_duplicate_launchs_refusal_leaves_the_claiming_launch_its_child`. |
| `launch-child-gate-reverted` | Decision; the reverted check shows the old trace | A child still running after its parent was accepted refused the thread's next human turn with 422. By product decision, only human root turns hold the thread (`ChildrenOutsideRootGate`, the gate's guard on `UserSends`). With it off, `SendNeverWaitsOnChild` fails as soon as the parent is accepted while the child is still pending; `OneHumanTurn` holds either way. Regression tests: `only_message_turns_hold_the_thread`, `a_running_child_does_not_hold_the_next_human_turn_and_product_stop_refuses_it`, the renderer tests that feed agent children to `composerStatusForThread` and `productStopTarget`, and the recursive end-to-end test "lets the next human turn run while a launched child still runs". |
| `launch-invoke-gate-reverted` | Decision (#717); the reverted check shows the old trace | The gate counted a user's invoked run as the thread's one active turn, so an invoke waited for the running message turn and the next message waited for the invoke. By product decision, an invoked run starts a fresh native session and holds nothing (`InvokesOutsideRootGate`, the gate's guard on `UserInvokes` and its term in `HumanTurnInProgress`). With it off, `InvokeNeverWaits` fails in the initial state, where the parent's message turn runs; `OneHumanTurn` holds either way. Regression tests: `invoked_runs_start_beside_an_active_turn`, `only_message_turns_hold_the_thread`, and the renderer tests that feed a user's invoked run to `composerStatusForThread` and `productStopTarget`. |
| `launch-product-child-reverted` | Decision; the reverted check shows the old trace | The product's Stop of a child answered 500 or recorded a Stop nothing acted on, and a user's invoke of the delegate action ran the child on the product path, where neither the user nor the parent could stop it. Now the product refuses both (`ProductLeavesChildren`, the guard on `UserStopsChild` and `UserReinvokes`). Regression tests: `only_message_turns_hold_the_thread` (Stop with and without an execution row) and `a_users_invoke_does_not_run_an_agents_child`. |
| `launch-graph-orphan` | Known open | A crash after the parent's `prepareComplete` but before the broker's first product write leaves a graph-only child. No product row names it, so startup cannot fail it, and its current stays active. |

### `ExecutionLeases.tla`

This model covers provider execution leases from admission to release:

- **Rust:** the interaction execution task, from admission through the
  attempt, `/complete`, terminal persistence and the inline release; the one
  lease-debt reconciler; startup reconciliation after a restart.
- **Harness host:** the pending access entry (admitted, claimed, settled,
  released), its release timers, the owner's release and acknowledgement,
  and close.
- **Desktop main:** the provider lease count, the lease's acknowledgement,
  removal and its finalize, the runtime, and `close()`.
- **User:** Stop, removal, reading a quarantined interaction, quit and
  restart.

There is one provider `P`. Each turn has one attempt, one lease and its own
thread. Most checks use one turn and at most one restart; `leases-safety`
and `leases-ideal` use two turns.

Fault constants turn on the conditions the findings need:
`AdmissionTimeout`, `RustCanAbandon`, `PersistCanFail`, `StartupQuarantine`,
`StartupCleanupCanFail` and `HarnessCanHang`. `UserCanStop` lets the user
Stop a turn while Rust still waits on it (`Cancel`); unlike `GiveUp`, Rust
then waits for the turn's end. Each fix has its own constant; finding G's is
`ForceStopsCancelledTurn`.

An attempt has four states: `none`, `running`, `ended` and `terminal`.
`ended` is an undecided attempt that Relayer no longer waits on
(`native_wait_ended_at`). It keeps its outcome open for reconciliation, but
the removal drain skips it and its lease is debt. Live native work is still
guarded by the held lease (`jsHeld`), which the host releases only when the
turn settles, or when a cancelled turn is force-stopped (`ForceStop`).

| Check | Verdict | Finding |
| --- | --- | --- |
| `leases-safety` | passes | With every fault on, a leased runtime stays open, a turn runs only under held access, access is never released while its turn runs (`AccessKeptWhileTurnRuns`), only a cancelled turn is ever force-stopped (`OnlyCancelledTurnsForceStopped`), and the app always starts. |
| `leases-ideal` | passes | With no faults, every lease is released, every lease debt is reconciled, every attempt whose turn ended stops holding the provider, and a removal completes without a restart. |
| `leases-abandon` | Fixed; now passes | Finding B. Before the fix: after Rust gave up on a running turn, its lease release freed the access while the native turn still ran. Removal could then close the runtime and delete its home under it. Now access lives as long as the native turn. An owner's release of a running turn cancels the turn and returns at once. The host releases the access as soon as the native turn ends, and keeps the entry until the owner's release (`HostReleasesOnSettle`). `leases-abandon-reverted` shows the old trace. |
| `leases-timer-claim` | Fixed; now passes | Finding A, plausible: needs a 30 s stall. Before the fix: the admission timer's release could be in flight when the claim ran, and it then freed the access under the running turn. Once any release is decided for an admission, the claim refuses it, even if that release failed (`ClaimRejectsReleasing`). `leases-timer-claim-reverted` shows the old trace. `leases-claim-after-failed-release` covers a failed release. It turns A2's fix off, because a refused finalize is the only way the model has for a release to fail. |
| `leases-removal-finalize` | Fixed; now passes | Finding A2. The host releases the last lease when the native turn ends, before Rust ends the attempt, so the store refuses the removal finalize. The refusal now leaves `P` `removal_pending` instead of throwing. The owner's release, which Rust sends only once the attempt is terminal, acknowledges the lease, and the acknowledgement retries the finalize (`AckRetriesFinalize`). `leases-removal-finalize-reverted` shows removal waiting for a restart without it. |
| `leases-view-debt` | Fixed; now passes | Finding D. Before the fix: settling a quarantined attempt (from the thread view or an invoke action's destination) made lease debt but did not wake the reconciler. The debt then waited for a restart. The settle now wakes it (`QuarantineSettleWakesReconciler`). `leases-view-debt-reverted` shows the old trace with C's fix off, because C now releases the lease before the settle. |
| `leases-persist-lease` | Fixed; now passes | Finding C, lease half. Before the fix: when a turn's terminal state could not be persisted, nothing released its lease. The host now releases it when the native turn ends. `leases-persist-lease-reverted` shows the old trace with C's attempt fix off, because that fix also releases the lease. |
| `leases-restart-quarantine`, `leases-restart-persist` | Fixed; now pass | Finding E, startup half. A removal waited on a running attempt, and the user quit. At the next start, an interrupted submitted input was quarantined, or a failed persist had left it quarantined, so its attempt stayed `running`. `reconcileStartup`'s refused finalize then failed every start. A refused finalize now leaves `P` `removal_pending`, and the app starts. `leases-restart-quarantine-reverted` shows the old trace with E's removal fix off, because that fix stops the refusal. |
| `leases-restart-drained-removal` | Fixed; now passes | Finding E, retry half. After that restart, once the quarantined attempt becomes terminal, the reconciler's release finds no host entry, because host memory is fresh. A release for a lease the host no longer tracks retries every drained removal (`UnknownReleaseRetriesFinalize`), so the removal finishes without another restart. The same path covers access the host forgot ten minutes after releasing it. The check turns E's restart fix off, because with it startup's own finalize succeeds and the retry is never needed. `leases-forgotten-release-reverted` shows removal waiting for a restart without the retry. |
| `leases-restart-removal` | Fixed; now passes | Finding E, removal half. Before the fix: after that restart, the quarantined attempt stayed `running` until its thread was opened or the app restarted again. Opening the thread is a user action, so the removal could stay pending meanwhile. Startup now records the end of the wait on the attempts it leaves open for reconciliation, since their process exited with the app (`RestartEndsWaits`). The drain skips them, so startup's finalize succeeds. `leases-restart-removal-reverted` shows the old trace. |
| `leases-persist-attempt`, `leases-persist-removal` | Fixed; now pass | Finding C, attempt half. Before the fix: when a turn's terminal state could not be persisted, its attempt stayed `running`, which blocked the provider tombstone until a restart. A harness approval that is aborted, expired or cancelled reached this with no fault (`Persist` with `q = "decided"`). The execution task now ends its wait on any attempt it leaves running and releases its lease (`PersistFailureEndsWait`). An attempt whose interaction already failed or stopped ends with that outcome; a quarantined one stays undecided. The owner's release acknowledges the access, which retries the finalize. `leases-persist-attempt-reverted` and `leases-persist-removal-reverted` show the old traces. |
| `leases-persist-attempt-forced` | passes | `AttemptEndsAfterTurn` also holds for a force-stopped turn. Rust gives up on the turn, or the user stops it, and it ignores the cancellation, so `ForceStop` ends it. The attempt then ends even when its terminal state cannot be persisted. The other `AttemptEndsAfterTurn` checks never cancel a turn. The check is not vacuous: a force-stopped turn with a running attempt and the app up is reachable, through both `GiveUp` and `Cancel`. `leases-persist-attempt-forced-reverted` turns `PersistFailureEndsWait` off, and the property fails through `Cancel`, `ForceStop` and a failed persist. |
| `leases-startup-isolation` | Fixed; now passes | Finding L6. Before the fix: a removal or cleanup failure other than a drain refusal rejected `reconcileStartup`, so Relayer could not start. Startup now records each provider's failure and continues (`StartupIsolatesProviders`). `leases-startup-isolation-reverted` shows the old trace. The model has one provider, so "other providers still activate" is covered by the composition test, not the model. |
| `leases-hang` | Fixed for Codex and Prime; now passes | Finding G. Before the fix: a cancelled native turn that ignored the cancellation kept its provider access forever, so removal waited forever. Now a cancelled turn still running after two minutes is force-stopped, and its access is then released (`ForceStopsCancelledTurn`, action `ForceStop`). The turn is cancelled by Rust giving up (`GiveUp`) or by the user's Stop (`Cancel`). After a Stop, Rust still waits, so the force-stop is what hands Rust its result. The force-stop ends only that turn. The model assumes every harness supports it and that it always ends the native work. In the code the kill or disposal is best effort, and the host releases the access at most ten seconds later, so `AccessKeptWhileTurnRuns` holds only under that assumption. `claude.basic` has no force-stop, so its turn that never settles still keeps its access. `OnlyCancelledTurnsForceStopped` follows from the action's guard; it documents the promise rather than testing the sibling case. `leases-hang-reverted` shows the old trace. |

The fixes are:

1. The host releases access when the native turn ends, and an owner's
   release of a running turn cancels it (`HostReleasesOnSettle`). Landed.
2. The claim refuses an admission once a release was decided
   (`ClaimRejectsReleasing`). Landed.
3. A refused finalize leaves the provider `removal_pending`, and the owner's
   acknowledgement retries it (`AckRetriesFinalize`). Landed.
4. Settling a quarantined attempt wakes the reconciler
   (`QuarantineSettleWakesReconciler`). Landed.
5. A release for a lease the host no longer tracks retries every drained
   removal (`UnknownReleaseRetriesFinalize`). Landed.
6. An execution task that stops waiting on a native run without persisting
   its outcome ends the attempt with a decided interaction outcome, or records
   the end of the wait, and releases the lease (`PersistFailureEndsWait`).
   Landed.
7. Startup records the end of the wait on attempts it leaves open for
   reconciliation (`RestartEndsWaits`). Landed.
8. Startup isolates each provider's removal and cleanup failure
   (`StartupIsolatesProviders`). Landed.
9. A cancelled turn still running after two minutes is force-stopped, and
   its access is released (`ForceStopsCancelledTurn`). Landed.

The `*-reverted` checks turn one landed fix off and show its old trace. In
them the acknowledgement call is attributed to `AckRetriesFinalize`, so a
reverted `HostReleasesOnSettle` still acknowledges. A reverted check turns
off any other fix that would hide its trace, and says so in its finding.
Recursive children unwinding across a restart are modeled in
`CompletionCurrent`, not here. Neither model orders startup's one observation
of those children before Desktop's startup removal; the product persistence
and completion trace tests cover that ordering.
A release and its acknowledgement are one step, and acknowledgements do not
fail in the model, so the host's retry of a failed acknowledgement is not
modeled. The ten-minute forget of access released without an owner is
modeled (`ForgetReleased`).

### `TurnComposer.tla`

This model covers the follow-up composer across two threads:

- typing, which persists the draft under the active scope `thread:latest turn`;
- Send, the follow-up POST, the server recording the turn before it answers,
  and its `interaction_in_progress` rule;
- the refresh that loads the new turn, or skips it when the navigation entry
  `[thread, turn, layer path]` changed or the refresh failed;
- settlement of the submitted draft and its revision comparison;
- thread switches, which load the thread's state, and `renderThread()` for
  unrelated reasons (the environment refresh every 5 s and on window focus,
  which does not fetch `/api/state`);
- the new turn arriving by polling, and finishing;
- a Send that waits for an authored input commit before it posts, and ends
  there without posting when the answer does not save or the thread changes;
- a turn created elsewhere in the thread, such as by an authored invoke;
- a POST that fails with a network or server error, before or after the
  server recorded the turn.

Context annotations, restored retry drafts, the model picker, and the
unconfirmed-draft warning are not modeled. `composer-today` leaves out turns
created elsewhere to keep the per-promise checks fast; `composer-fixed` and
`composer-invoked-turns` include them.

| Check | Verdict | Finding |
| --- | --- | --- |
| `composer-typing-during-send` | Fixed; now passes | Before the fix (#512): `submitInteraction` disables the prompt, but any `renderThread()` during the POST re-enables it through `renderInteractionState`, because the loaded latest turn still reads as settled; the environment refresh renders every 5 s on project threads and on window focus. Text typed then stayed in the old turn's draft scope, and when the new turn loaded the composer moved to that turn's empty scope, so the text was never shown again. Entering a newer turn's empty scope now moves the thread's unsent text written this session into it (settlement deletes a sent draft, so what remains is unsent; after a restart, persisted text is moved only if no later turn shows it was sent), and a send definitely rejected after its turn arrived restores its text. The prompt now stays editable for the whole send (SCP-019, a decision made in review of this PR), so typing during a send no longer depends on a re-render. A user's persisted draft also wins over a restored retry that arrives in its scope, so the prompt no longer flips between them. Scenarios: `composer-typing-during-send`, `composer-failed-send-restores-draft`. |
| `composer-typing-during-send-without-renders` | Fixed; now passes | The same loss, reached by leaving the thread and returning during the POST before the server records the turn. Scenario: `composer-return-during-send`. |
| `composer-without-carry` | Records the bug | With `CarryUnsentDraft` off, text typed during a send is stranded. |
| `composer-settlement-erases-edit` | Fixed; now passes | Before the fix (#513): re-entering a scope with persisted text assigned `currentPromptRevision + 1`, which could repeat a revision the scope already had. An edit after Send could then reach the submitted revision, and settlement cleared the prompt and deleted the persisted draft. A scope's revision now only moves forward. Scenario: `composer-settlement-erases-edit`. |
| `composer-sent-text-lingers` | Fixed; now passes | Before the fix (#513): re-entering a scope during a send bumped its revision though the text was unchanged, so settlement no longer recognized the sent text and left it in an enabled composer. Unchanged text now keeps its revision. Scenario: `composer-sent-text-lingers`. |
| `composer-one-send-per-thread` | passes | Every send releases its thread's Send button. The model has one send slot per thread, so it cannot attempt a second Send; a test in `test/turn-composer-traces.test.mjs` forces one while the first is in flight, after leaving and returning to the thread, and checks it does not post. |
| `composer-invoked-turns` | Fixed; now passes | Before the fix (review of #512): the submission was held only once `submitInteraction` began, after Send had waited for authored input commits. A turn created elsewhere that arrived during the wait carried the text into its scope, and the Send then posted it and cleared only the older scope, so the sent text stayed. The submission is now held from the click. A Send that ends without posting hands back text a newer turn left in its scope into the empty prompt, as a rejected POST does; text typed since wins. One thread, three turns. Regression tests: the "newer turn arriving while Send waits" cases in `test/authored-input-send-traces.test.mjs`, since only that world holds a Send on an authored commit. The draft-send warning, which the model leaves out, also holds the text while open and hands it back when cancelled; a test in the same file covers it. |
| `composer-without-click-hold` | Records the bug | With `HoldFromClick` off, the text is carried away while Send waits. |
| `composer-without-uncertain-hold` | Records the bug | With `HoldUncertain` off, the text of a POST that failed after the server recorded it is carried into the turn it created, and could be sent again (SCP-019). The renderer recognizes that turn by the text: any draft whose text a later turn of the thread carries was sent, which also holds after a restart. A turn an invoke action created does not count, so a definitely rejected send still comes back. An unrelated turn, or a POST that never reached the server, still carries the text forward. A retry refused after the turn arrived does not hand the text back. Scenarios: `composer-uncertain-send-stays-put`, `composer-retry-of-landed-send`. |
| `composer-without-uncertain-hand-back` | Records the bug | With `HandBackUncertain` off, the text of a send lost to a network or server error stays stranded in its scope when an unrelated turn arrived while it was pending. It is now handed back as for a rejection, unless the send's own turn already arrived; the renderer and the model recognize that turn by the text. Until its own turn arrives, such text may be shown, and `SentTextIsNotShownAgain` allows it. Scenario: `composer-lost-send-after-unrelated-turn`. |
| `composer-without-retire` | Records the bug | With `RetireSuperseded` off, stranded text that newer typing kept out of the prompt stays in its scope, and is carried forward once the prompt empties (`SupersededStaysGone`, SCP-021). It is now retired from its scope and storage, also when the send settles while another thread is shown and that thread's newest scope holds newer text. Scenarios: `composer-superseded-text-retired`, `composer-superseded-text-retired-off-thread`. |
| `composer-fixed` | passes | With every candidate fix, every composer promise holds. |

The candidate fixes are:

1. `CarryUnsentDraft`: moving a turn's unsent text into the newest turn's
   empty scope, and restoring it into the prompt when a send fails after the
   new turn arrived. Text still owned by an in-flight send is not moved.
   Landed (#512).
2. `StableScopeRevision`: re-entering a scope keeps its revision when its
   text is unchanged, and otherwise takes a revision above any it had.
   Landed (#513).
3. `HoldFromClick`: holding the submission from the click on Send, and
   handing back stranded text when that Send ends without posting. Landed
   in review of #512.
4. `HoldUncertain`: after a network or server error, holding the
   submission once a turn with its text arrives, so its text is neither
   carried into that turn nor handed back. Landed in review of #512.

A restored retry that the user's non-empty draft keeps out stays pending,
and returns once the user empties the composer; an empty value persisted
after the user cleared restored text is a tombstone, and wins (SCP-020).
A restoration is identified by its interaction and retry attempt, so a
later failed attempt of the same interaction restores again.
Clearing a draft that kept a restoration out brings the retry text back at
once, and persists nothing, so it also returns after a restart; tests cover
both. The
model leaves restored retry drafts out; unit tests in
`test/workspace-keyboard.test.mjs` cover these rules.

`SentTextIsNotShownAgain` allows the text of a send that may have been sent
to stay in the prompt of the scope it was sent from, where the user sees it
until its turn arrives. `UnsentDraftSurvives` drops its promise for such text
only when a newer turn already arrived before the error; SCP-019 then does
not restore it. Text the user cleared while a Send waited stays cleared when that Send
stops (SCP-021). A restoration the user already saw, persisted before a
restart, counts as applied, so clearing it leaves the composer empty. While
a Send is in flight, its scope is judged by revision, so an edit after Send
that retypes the same text is kept (SCP-018).

Stranded text is restored only into an empty prompt: text the user typed
since wins, and the stranded text is retired (a decision recorded in the
PRD).

The model does not restart the app. After a restart, text an earlier session
left in an older turn's scope, such as one closed while a send was in
flight, is carried into the newest turn unless a later turn with that text
shows it was sent or a newer turn's persisted draft superseded it (which
retires it, SCP-021), and text restored after a restart is not carried into
a turn with that text that arrives later. Text a later turn shows was sent
is also deleted from storage (SCP-016); the model deletes an uncertain
send's draft once its turn lands, and leaves a send in flight to its
settlement. Tests in
`test/turn-composer-traces.test.mjs` cover these cases.

`CarryUnsentDraft` recognizes the in-flight submission by its revision, so
it is sound only together with `StableScopeRevision`.

Every fix has landed, so `composer-today` and `composer-fixed` now agree.
Keeping per-turn draft scopes and carrying unsent text forward is the recorded
product decision (PRD SCP-018 to SCP-020).

### `NodeInspector.tla`

This model covers node selection on the graph canvas and the Node Details
inspector with a durable annotation draft:

- `selectNode`, including the draft flush before switching nodes and the
  asynchronous Node Detail mount;
- `prepareNodeContextSelectionChange` before Close and before a turn change;
- `+`, typing, autosave, and `×` on an annotation draft;
- `render()` with newer state, which re-selects the node or, on entering a
  new view, may clear the selection;
- the dock reconciliation in `renderNodeContextDock`;
- reuse or disposal of the mounted Node Detail runtime.

A draft's target includes the layer it was made in, so drafts and editors
belong to a view: entering a new view drops the editor, and a draft is
reopened only in its own view. `nodeSelectionSequence` is compared only for equality, so each request in
flight carries whether it is still the latest. Historical context
selections, node inputs, annotation comments, and confirm are not modeled;
confirm resolves like discard.

| Check | Verdict | Finding |
| --- | --- | --- |
| `inspector-promises` | Fixed; now passes | Before the fixes: (#514) while a draft save, confirm, or discard was in flight, `selectNode` returned at once and `prepareNodeContextSelectionChange` returned false, so a node click, Close, or turn change did nothing; a dropped Close or turn change also incremented `nodeSelectionSequence`, cancelling a pending click or the first Close, so a double-clicked Close closed nothing. (#515) A switch refused by a failed flush returned without re-rendering the kept node; if the switch had superseded that node's own Node Detail mount, the inspector showed its header over a disposed, empty page. A render during the flush was dropped, so the inspector kept older state or, on entering a new view, stayed hidden. Now such a request waits for the draft to resolve and the latest one proceeds; a click made in a view the user has since left is void; a prepare whose editor was replaced prepares again. A switch continues from the latest state, and a resolved draft re-renders the selection unless a waiting request or the switch will. Selecting a node with an unconfirmed draft still reopens its editor (PRD L2203). Scenarios: `inspector-click-during-discard`, `inspector-close-during-flush`, `inspector-double-close`, `inspector-refused-switch-rerenders`, `inspector-view-change-during-discard`. |
| `inspector-without-supersede` | Records the bug | With `LatestRequestSupersedes` off, a switch waiting on a draft save commits its node, reporting it through `onSelectionChange` and recording it in history, before a click queued meanwhile replaces it. Before the fix (review of #514), a queued click did not advance `nodeSelectionSequence`, and a request that proceeded at once did not void one still waiting, so a waiting Close could run after a newer click. `OnlyLatestRequestSelects` is checked on the real workspace through the nodes it reports. Scenarios: `inspector-click-during-switch`, `inspector-click-voids-waiting-close`. The same rule for a Close or turn change that proceeds at once has no replay, because the adapter does not change turns. |
| `inspector-without-queue` | Records the bug | With `QueueWhileResolving` off, input made while a draft resolves is dropped. |
| `inspector-without-refresh` | Records the bug | With `RefreshAfterResolve` off, a refused switch can leave the kept node's detail disposed. |

The candidate fixes are:

1. `QueueWhileResolving`: a click, Close, or turn change that arrives while
   a draft resolves waits for it, and the latest one then proceeds against
   the state it finds; a click whose node is gone does nothing. A prepare
   whose editor was replaced prepares again. Landed (#514).
2. `RefreshAfterResolve`: continuing a switch from the latest state, and
   re-rendering the selection once a draft resolves unless a waiting request
   or the switch will. Landed (#515).
3. `LatestRequestSupersedes`: a user's newest request supersedes every
   earlier one, whether it waits for a resolving draft or proceeds at once.
   Landed in review of #514.

The replay reads which state revision the inspector shows: each refresh
delivers a new state object whose node kinds name the revision, and the
header's kind is compared with the model's `title.rev` at every step, so
`InspectorIsCurrent` is checked on the real inspector. The desktop host
mutates one `appState` in place, so a stale state would not show there
today; the replay would still catch code that continues from a stale state.
Scenario: `inspector-switch-sees-refresh`.

✓ (confirm) resolves like × in the model. The replay drives the real
confirm button and holds its request, so a request queued behind a
confirmation is checked on the real workspace. Scenario:
`inspector-click-during-confirm`.

Entering a view selects a node unless the user closed Node Details
(#542): the model keeps a node still in the view and otherwise selects the
layer's first node, and tracks the host's `nodeDetailsClosed` as `closed`.
The replay starts with Node Details closed, as the spec's initial state is,
and its host marks them closed when the workspace reports no selection.
Scenario: `inspector-new-view-selects-first-node`.

A request waiting for a draft is void once the workspace enters another
view (a view-entry epoch, so a round trip back to a view with the same key
does not revive it), whether it is a click, Close, turn change, Back or Forward, or a layer
change. The model clears any remembered request on entering a view.
Scenario: `inspector-view-change-voids-waiting-close`.

While a draft resolves, an editor the dock shows must be locked
(`ResolvingEditorLocked`, checked at every step on the real dock). When a
switch's destination disappears during its save, the kept node is shown
again from the latest state; a test covers it.

An editor remounted while its draft's confirm or discard is in flight, after
the user left the thread and returned, resolves until that operation
settles, so requests still wait for it. It waits for the workspace's own
confirm or discard promise, which settles only after any revision-conflict
reload and retry, not for the draft's momentary operation kind. Tests cover
the plain remount and the conflict retry.

The model has one thread. Switching threads voids a request still waiting
for a draft, so a turn change queued in one thread cannot act on the next;
a test in `test/node-inspector-traces.test.mjs` covers it. After each step
the replay waits for in-flight `crypto.subtle` digests and a steady
inspector, since a Node Detail mount verifies its package off the event
loop.

The replay also showed the dock keeps the previous node's locked editor
until the new node's Node Detail mount finishes. The replay compares the
dock only once the renderer is quiet.

The model reuses the mounted runtime when the node matches; the code also
requires the same interaction, layer, and package, which differs only on
entering a new view. Discard is modeled only for a saved draft with no newer
text. Other callers of `prepareNodeContextSelectionChange` (sidebar thread
switch, Back and Forward, breadcrumbs, navigate actions) are dropped the same
way but are not modeled.

### `AuthoredInputSend.tla`

This model covers one input action in an authored Node Detail and the
follow-up Send:

- typing, and the commit on `change` at the controller's draft revision;
- Send's gates and the draft revision it captures;
- the server's commit rule and its reservation of committed attachments;
- the turn ending, with the failure restore;
- a commit that fails in transport or on the server;
- draft reloads, which the controller queues behind a commit in flight;
- the lock on authored inputs while a Send is in flight;
- the renderer's reloads after each response.

| Check | Verdict | Finding |
| --- | --- | --- |
| `input-send-carries-answer` | Fixed; now passes | Before the fix (#521): legacy input controls registered each commit with `inputPending`, which kept Send disabled; an authored input's commit did not. Mousedown on Send blurs the input, whose `change` commits it, so the commit and the Send went out together at the same revision. A Send served first went without the answer, which then landed in the next turn's draft; a commit served first got the Send refused with `input_draft_revision_conflict`. Send now waits for the thread's authored commits before it captures the draft revision, and stops if one fails, since the answer did not save; a commit still in flight counts toward Send being ready. Authored inputs are locked while a Send is in flight; a commit during a run still goes to the next turn's draft (ADR 0008). Scenarios: `input-send-waits-for-commit`, `input-failed-answer-stops-send`. |
| `input-send-without-waiting` | Records the bug | With `SendAwaitsAuthoredCommits` off, a Send served before the commit goes without the answer. |
| `input-send-forgets-early-failure` | Records the bug | With `KeepFailedCommit` off, a commit that fails before the click is forgotten, and the Send goes without the answer. Before the fix (review of #521), a failed commit left the set Send waits on as soon as it settled. Now an input's latest failed commit is kept until a Send it stops, a newer commit of that input, or detaching it accounts for it. It stops the next Send once, whether or not its Node Detail is still open; clicking Send again sends without it. Its error is shown again when a new Node Detail mounts the input, until a later commit or detaching it clears it. Scenario: `input-early-failure-stops-send`; the closed-inspector case is a test in `test/authored-input-send-traces.test.mjs`. |

Send waits rather than being disabled during the commit, because disabling it
would swallow the click that caused the blur. The composer's committed-input
pills lock from the click, so an answer the Send will reserve cannot be
detached while it waits; a test covers it. The replay observes whether the
authored input is locked (its own commit busy, or a Send in flight), and
reads whether a Send stopped by a failed commit released the Send button
from the real button.

The ghost `intended` is the answer in the field when Send is clicked. The
model first recorded the committed value when no commit was in flight, which
hid the early failure. A Send stopped for an answer that did not save is
told so; if the user clicks Send again without editing it, the message goes
without that answer.

### `CanvasGesture.tla`

This model covers pointer gestures on the graph canvas while the workspace
re-renders underneath:

- pressing, moving, and releasing on a node, with the pointer capture that
  routes the node's events;
- panning the stage;
- renders that keep the layout, change it, or switch to another view and
  back, with the view cache that restores pinned positions and the camera.

Positions are locations on a ring of `L` points; a node's screen location is
its world location plus the camera offset. There is one draggable node, and
the other view does not contain it. Pinch and wheel zoom, keyboard
navigation, the inspector's camera fit, and the click that selects a node
are not checked. A gesture never spans a return to the home view. The canvas
has no force simulation: layouts are authored and normalized, and the camera
is the only transform (`docs/architecture.md`).

| Check | Verdict | Finding |
| --- | --- | --- |
| `canvas-promises` | Fixed; now passes | Before the fix (#531): `renderGraph` replaced `graphNodes` and the node elements on every render, but `dragging` kept the replaced object and the capture on the removed element. After a render mid-drag, moves went to the old object and the node stopped following the pointer (`DragFollowsPointer`, Press → Move → RenderLayout). The next render rebuilt positions from the new objects, so the drop was lost (`DropStays`, Press → RenderSame → Move → Release). A render now re-binds the drag to the node's new object and captures the pointer on its new element. A node that has moved stays under the pointer, pinned, and the camera is not refit while it is dragged. Entering another view, the node disappearing, a failed re-capture, or a move with no button pressed ends the drag. `CameraMovesOnlyByPanOrFit` is a property of steps: in the home view, only a pan, a new layout, or the fit after a drop moves the camera. Scenarios: `canvas-drag-across-render`, `canvas-drag-across-layout`, `canvas-drop-round-trip`, `canvas-pan-across-render`, `canvas-drag-into-view-change`. |
| `canvas-without-rebind` | Records the bug | With `KeepDragAcrossRender` off, a render during a drag leaves the drag on the replaced node. |
| `canvas-without-fit-before-leaving` | Records the bug | With `FitBeforeLeaving` off, leaving the view mid-drag after a layout change caches the unfitted camera, and returning restores it. The view is now fitted before it is cached. Scenario: `canvas-leave-after-layout-change`. |
| `canvas-without-fit-after-drop` | Records the bug | With `FitLayoutAfterDrop` off, a layout that changed mid-drag is never fitted, and new nodes can stay off-screen (`DropFitsNewLayout`). Now the view fits the new layout once the node is dropped, and the node stays where it was dropped. Scenario: `canvas-drag-across-layout`. |

The replay dispatches pointer events the way a browser routes them. An event
goes to the element holding capture while that element is still in the
document, and otherwise to the element under the pointer. Each refresh
delivers a new state object. `RenderLayout` is replayed only while a moved
drag holds the node, because a new placement does not otherwise map onto
evenly spaced locations. Tests outside the model cover a graph that
empties mid-drag (the node elements are removed with the graph, so the
release cannot click a node that is gone) and each way a drag ends: a move
with no button pressed, a failed re-capture, and entering another view that
also shows the node. The camera and layout functions
have their own tests (`test/graph-camera.test.mjs`,
`test/graph-layout.test.mjs`).

Since #477, returning to a view restores its camera only if the user moved
it (camera revision above 0). An automatic camera is refitted, and so are
the fits after a drop and before leaving, which the model tracks as
`manualCam`. The fit before leaving therefore matters only for a camera the
user panned. `Hover` moves the pointer with no button pressed, so a pan can
be followed by a node drag. Scenario `canvas-leave-after-pan-and-layout-change`
replays that path, and fails without the fit before leaving.

A fit centers the graph, which the model writes as `Fit`: the one node at
location 0. The replay reads locations and camera offsets modulo `L`, and
`FitCentersNode` checks, unreduced, that whenever the camera is a fit of the
node (the ghost `fitted`) the real node is exactly where the first fit put
it. The replay also observes the selection, so a moved drag must not select
the node on release. Scenario: `canvas-click-selects`.

### `HarnessReadiness.tla`

This model covers harness readiness from evaluation to admission:

- **Desktop main:** the readiness coordinator's generations, its
  publication chain, and startup's file-only runtime validation.
- **Stores:** the app server's `product_harnesses` row and, before the fix,
  the readiness copy in `harness-configurations.json`.
- **Restart:** a crash at any point, then the whole next startup.
- **Admission:** Send admits only a route the app server holds ready.

There is one harness configuration, three evaluations, two configuration
digests and one restart.

`readiness-today` mirrors the code, and each `-reverted` check turns one fix
off. Two constants hold the fixes:

- `RustIsReadinessRecord`: Electron publishes readiness only to the app
  server. Startup restores ready only from the app server's own row.
- `RustRejectsOlderGeneration`: the app server rejects a generation lower
  than one it accepted for that harness in the same process.

`RequestCanOutliveClient` lets a readiness request reach the app server after
its client saw an error. Without it, the publication chain alone keeps
results in order.

| Check | Verdict | Finding |
| --- | --- | --- |
| `readiness-restart-restore` | Fixed; now passes | Before the fix (R1): readiness was written to Rust first, then to the JSON catalog. At startup Electron restored ready from the JSON, and Rust rebuilt its row from that JSON without reading its own. A crash or failed write between the two writes restored a ready that Rust had withdrawn, and Send was admitted. Now the JSON carries only whether the runtime files validate. `initialize_model_catalog` restores ready only from its own previous row for the same digest (PROV-006). Regressions: the desktop-shell test "hands startup readiness to the app server record instead of the previous catalog file" fails on the old code; `restart_keeps_the_app_server_record_of_an_unavailable_route` guards the new rule. |
| `readiness-restart-restore-reverted` | violated: shows why the fix is needed | With the JSON catalog as a second record, a crash between the two writes restores the withdrawn ready, and Send is admitted on it. |
| `readiness-single-record` | Fixed; now passes | Before the fix (R2): a failed JSON write left the two records split, with nothing to reconcile them. The JSON readiness write is gone, so there is one record. |
| `readiness-single-record-reverted` | violated: shows why the fix is needed | With two records, a JSON write that fails after the Rust commit splits them. |
| `readiness-never-backwards` | Fixed; now passes | Before the fix (R3): Rust checked only that a generation was positive. The app server now rejects an older generation than one it accepted in the process (PROV-005). Regression: `readiness_rejects_an_older_generation_within_a_process`. A superseded result can still publish until the newer one does. PROV-005 allows that, because it never replaces a newer result. |
| `readiness-never-backwards-reverted` | Plausible: needs a request that outlives its client | Without the guard, a request that reaches Rust after its client gave up replaces a newer result. |
| `readiness-liveness` | passes | The latest evaluation always reaches the app server. |

With the fix on, `PROV006_RestoreOnlyFromRecord` restates the `Restart`
action and `ReadinessRecordsAgree` compares Rust with itself. They guard
against a regression in the model, not in the code. With the fixes on,
`PROV006_AdmitOnlyLatestReady` and `PROV005_NeverOverNewer` also hold almost by
construction; their discriminating power is in the `-reverted` checks. The
model starts with no ready row, so it does not cover the JSON field that
marks a coordinated harness. A row made ready before this fix is cleared once
by migration 0034, which `first_launch_after_upgrade_reverifies_a_route_an_older_build_left_ready`
covers.

The generation guard lives in app-server memory. Electron restarts its
counter with each process, and the desktop quits when the app server stops.
If the app server alone restarted, its restored row would stay the record.
It would accept the coordinator's next generation, and the coordinator's
counter only grows.

### `ReadinessRepair.tla`

This model covers readiness across Repair, restart and upgrade for two
providers that share one harness. ChatGPT and OpenRouter both run through
`codex-basic`. It adds three things to `HarnessReadiness`:

- **Two runtime predicates:** `files` is what startup's cheap validation
  checks, and `execs` is what the version probe checks. External damage
  can break either one.
- **Upgrades:** a restart may change the configuration digest, or require
  the other runtime recipe. Its staged runtime then either activated or not.
- **The automatic evaluation:** the app server's upgrade mark, Desktop's one
  background evaluation, and the commit that clears the mark.

`readiness-repair-today` mirrors the code, and each `-reverted` check turns
one fix off. Three constants hold the fixes:

- `RepairRevalidates` (R1): Repair, app-update staging and post-update
  activation reuse an installation only when it passes startup's full
  validation, then the probe. Otherwise they reinstall.
- `UpgradeEvaluates` (#556): an upgrade that changes the digest marks the
  route due in the app server. After startup, Desktop runs one background
  evaluation through the `recipe-update` trigger. The next committed result
  clears the mark.
- `RecipeChangeMarksDue` (PR #576 review): the app server records the recipe
  each route last loaded. An upgrade that changes only the recipe does not
  restore the old ready and marks the route due, whether the staged runtime
  activated or not.

| Check | Verdict | Finding |
| --- | --- | --- |
| `repair-validated` | Fixed; now passes | Before the fix (R1): reuse checked only that the entrypoints were regular files and that the probe passed, and `stat` follows symlinks. Startup also checks the ownership marker, the owned private state and entrypoint confinement. So Repair published ready for an installation the next start rejected. Regressions: the installer tests "repairs an installation startup rejects because …", "stages a fresh app-update generation when the active one is unusable because …" and "does not activate a pending generation startup would reject because …" fail on the old code. |
| `repair-validated-reverted` | Confirmed | With the probe alone, a Repair after the layout broke publishes ready for an installation startup rejects. |
| `repair-survives-restart` | Fixed; now passes | A route an evaluation made ready survives a restart that changes nothing. |
| `repair-survives-restart-reverted` | Confirmed | Before the fix, the next unchanged restart withdrew the ready that Repair had published, so Repair never stuck. |
| `repair-records` | passes | With both fixes, startup restores only from the app server's record (PROV-006), and the latest evaluation wins (PROV-005). A route marked due is never ready, across two restarts. Leaving the mark set after a publish breaks this check. |
| `repair-records-prerule` | passes | The same holds from a row an older build left ready. |
| `upgrade-evaluated` | Fixed; now passes | Before the fix (#556): a changed digest left both providers pending until someone pressed Repair. Now each changed digest gets one committed evaluation without a Repair, even across a restart before the commit. The model assumes a connected provider publishes a route; without one, the mark waits. Regressions: `an_upgraded_digest_is_due_one_automatic_evaluation`, `one_post_upgrade_evaluation_restores_both_providers_sharing_a_route`, the migration test `the_update_migration_marks_routes_an_earlier_upgrade_left_pending`, and the provider-composition test "evaluates an upgraded shared route once after startup". |
| `upgrade-evaluated-reverted` | Confirmed | Without the automatic evaluation, the upgraded route stays pending while nobody presses Repair. |
| `recipe-change-evaluated` | Fixed; now passes | A route restores ready only when an evaluation measured it on the recipe the release requires. Regressions: `a_changed_runtime_recipe_starts_pending_and_is_due_once` and the desktop-shell test "hands startup readiness to the app server record instead of the previous catalog file" fail on the old code. |
| `recipe-change-evaluated-reverted` | Confirmed | Before the fix, an upgrade whose staged runtime activated, with the same digest, restored the ready measured on the old recipe. |
| `recipe-change-due-reverted` | Confirmed | Before the fix, an upgrade that changed only the recipe was never marked due. When its activation failed, the route waited for Repair. |
| `repair-liveness` | passes | Every started evaluation, automatic or not, settles. |
| `shared-route-witness` | Witness, expected violation | Readiness is per harness, so an evaluation not started for a provider makes that provider's shared route ready too. This is why one Repair restored both providers in #556. |

Desktop also passes the recipes this start activated; the recorded recipe
covers that trigger, so the model leaves it out. The model starts with a
recorded recipe. In the code, a row migration 0039 left without one counts a
change only when this start's own update activated a new recipe or failed
to, or when the route was ready and its files no longer validate;
`the_first_recorded_recipe_marks_only_a_runtime_this_update_changed`
covers that. Migration 0039 also marks every loaded route startup left pending.
The model starts after that migration, so it does not cover the backfill.
The automatic evaluation skips a harness whose runtime was never
installed; the model has one harness whose runtime starts installed.
The model's providers always have a route. In the code, a managed provider
whose activation failed on a broken runtime has none, so the step first
recovers it as Repair does, then evaluates each due harness once;
composition tests cover that.
In the code it runs once per process with the models published so far. A mark stays set
when its evaluation found no provider with a route. The next start looks
again, but it prepares nothing until a provider has a route.

### `ProviderLeaseLifecycle.tla`

This model covers one managed provider `P` where its lifecycle meets a turn's
execution lease, the catalog refresh and the connection generation:

- **Desktop main:** sign-out, reconnect, its cancel and completion, removal,
  `close()`, and `acquireExecution` with the runtime it may start. The provider
  queue is a lock, and a lease that starts a runtime holds it across
  `#runtimeFor`'s awaits, which `close()` does not wait for.
- **Provider home:** one boolean, whether it holds a login. Wiping the runtime
  state removes it.
- **App server:** the connection generation and whether `P` reads ready. Rust
  admits the turn only while it does (PROV-006).

There is one turn and at most three runtimes. Two faults are constants. The
sign-out's publish can fail, which is only logged. A reconnect's publish can
get no answer, whether or not it committed. Reading the generation, at the
reconnect's start or back after that publish, can fail too. Sign-out is also
accepted while a reconnect is pending: Settings does not offer it then, but
the service does not refuse it. A sign-out's publish can fail before it
commits, commit and lose its answer, or lose its answer and commit later
(`LateCommit`), when the app server applies it only at the generation it
carried. A settling reconnect's signed-out publish can fail too
(`CancelPublishCanFail`).

`lifecycle-today` mirrors the code. It has every fault on and eleven fix
constants, all landed. The refresh runs in three steps: it resolves its
generation, reads the account, then publishes.

- `LeaseWaitsForReconnect`: `acquireExecution` refuses while a reconnect is
  pending (PROV-004).
- `CancelSparesLease`: a settling reconnect never closes or wipes a runtime a
  lease holds. With the first fix this is unreachable; it guards the
  invariant.
- `ShutdownRefusesLeases`: `acquireExecution` refuses once `close()` begins,
  and a runtime that finishes starting after it is closed again.
- `RefreshSkipsPendingReconnect`: no refresh runs or publishes while a
  reconnect is pending (PROV-002: user actions supersede automatic ones).
- `LostReconnectAdopted`: a reconnect whose publish got no answer reads the
  generation back. Unmoved, the publish never committed, and the reconnect
  settles as before. Otherwise the login may be committed, so it is kept.
- `AdoptChecksBaseline`: the reconnect is adopted as connected only when the
  generation reads exactly one past a baseline it read at its start, and no
  sign-out ran meanwhile. A sign-out the app server answered makes the
  refusal certain, so the reconnect settles as failed. An unanswered
  sign-out, any other advance, or a failed read keeps the reconnect's runtime
  and login without adopting it. This unknown outcome is a PRD decision: the
  reconnect reports a failure, and the next refresh settles the state.
- `CancelSignsOut`: a cancelled or failed reconnect commits signed-out with
  the next generation before it wipes the home, as sign-out does. Its publish
  can fail like sign-out's, and `close()` skips it.
- `CancelKeepsUnrecordedLogin`: when that publish fails, or during shutdown,
  the cancel keeps the login and the reconnect's runtime instead of wiping
  them, as an unknown reconnect outcome does. The app server may still read
  `P` connected, so a wipe would leave it admitting turns with no login.
- `SupersededCancelWipes`: a reconnect that a sign-out the app server
  answered superseded is settled by wiping, even when its own signed-out
  publish fails. That sign-out already recorded signed out, and no refresh
  ran since, so nothing is unknown.
- `SignOutBlocksAdmission`: a sign-out the app server has not recorded, from
  a failed sign-out publish or a cancel with no login to keep, refuses new
  provider access. The block ends when a signed-out state is recorded, a
  refresh publishes a catalog that is not connected, or the service confirms
  a sign-in: a completed reconnect, including one whose outcome is unknown,
  or a cancel whose account check reads connected. A connected catalog does
  not end it: its discovery may predate the sign-out. The cancel keeps a
  login only when the account does not read signed out. Its account check is
  bounded, and one that errs or times out (`AccountCheckCanFail`) leaves the
  outcome unknown. The block is process-local and not modeled across a
  restart; the startup refresh reads the account and records its state.
- `AdoptTracksLostWrites`: a lifecycle write whose answer was lost, even one
  sent before the reconnect started, may still commit. While one is
  outstanding, an advance in the generation proves nothing, so the reconnect
  is not adopted. A later answered write that advances the generation ends
  the doubt, because the app server refuses every older write.

| Check | Verdict | Finding |
| --- | --- | --- |
| `lifecycle-lease-during-reconnect` | Fixed; now passes | Checks `PROV004_NoCloseUnderLease` with every fault on. This is `provider-leased-runtime`, with the provider home added. |
| `lifecycle-lease-acquire-guard-alone` | passes | With `CancelSparesLease` off, the acquire guard alone keeps PROV-004: no lease exists while a reconnect is pending. |
| `lifecycle-lease-cancel-guard-alone` | passes | With `LeaseWaitsForReconnect` off, the cancel guard alone also keeps PROV-004. |
| `lifecycle-lease-during-reconnect-reverted` | violated: shows why the fix is needed | With both lease fixes off, a turn leases the runtime a pending reconnect is signing in, and cancelling the reconnect closes it and wipes its home. Either fix alone passes, so this check turns both off. |
| `lifecycle-close` | Fixed; now passes | Checks `CloseLeavesNoOpenRuntime`. This is `provider-close`. |
| `lifecycle-close-reverted` | violated: shows why the fix is needed | With `ShutdownRefusesLeases` off, a lease queued before shutdown registers a runtime after `close()` cleared the maps. |
| `lifecycle-refresh-during-reconnect` | Fixed; now passes | Before the fix (plausible: Settings reopened while a reconnect is pending): the refresh discovered through the runtime the reconnect reuses and published ready. Cancelling the reconnect wiped the login but superseded nothing, so Rust admitted turns that Settings showed signed out, and they failed. Checks `ReadyMeansSignedIn` and `PendingReconnectNotReady` with the sign-out fault off. Since `CancelSignsOut`, the cancel alone restores `ReadyMeansSignedIn`, so the skip's own promise is `PendingReconnectNotReady`: no automatic result stands for the user's sign-in. Regression test: `runs no refresh while a reconnect is pending, so a cancelled reconnect leaves the app server signed out`. |
| `lifecycle-refresh-during-reconnect-reverted` | violated: shows why the fix is needed | With `RefreshSkipsPendingReconnect` off: sign out, reconnect, sign in, and a refresh publishes ready while the reconnect is pending. |
| `lifecycle-lost-reconnect-answer` | Fixed; now passes | Before the fix (plausible: needs a lost answer): only a superseded refusal relearned the generation. Any other error settled the reconnect and wiped the login the app server had just committed. Rust then read connected with no login. This was the reconnect counterpart of F2. Regression tests: `adopts a reconnect the app server committed before its answer was lost`, `keeps the login of a reconnect whose outcome is unknown` and `registers the runtime a reconnect created when its outcome is unknown`. Keeping the login of an unknown outcome is a PRD decision. If the publish never committed, the next refresh publishes the signed-in account at the old generation, with no reconnect event. |
| `lifecycle-lost-reconnect-answer-reverted` | violated: shows why the fix is needed | With `LostReconnectAdopted` and `CancelSignsOut` off, as before these fixes, the committed reconnect's cancel wipes its login while Rust reads connected. With `CancelSignsOut` on, that cancel would record signed out instead, so `lifecycle-committed-reconnect-keeps-login-reverted` shows the login lost. |
| `lifecycle-lost-answer-adopts-only-commit` | Fixed; now passes | Checks `AdoptsOnlyCommittedReconnect`: an unanswered reconnect is adopted only when the app server committed it. An independent review found that an earlier draft of this fix adopted any advance past the baseline. Regression tests: `settles a reconnect whose unanswered publish did not commit`, which also covers a publish or discovery that failed before any commit; `neither adopts nor wipes a reconnect whose unanswered publish cannot be proven`; and `settles a reconnect the app server refused with a code it could not have committed`. |
| `lifecycle-lost-answer-adopts-only-commit-reverted` | violated: shows why the fix is needed | With `AdoptChecksBaseline` off: a sign-out commits but loses its answer, and the reconnect cannot read its baseline. Its publish at the older generation never commits, yet the read shows an advance, and the reconnect is adopted. Before the baseline and sign-out checks, a sign-out during the reconnect led to the same adoption. |
| `lifecycle-late-sign-out-reverted` | violated: shows why the fix is needed | Found by a Codex review of #572. With `AdoptTracksLostWrites` off: a sign-out's answer is lost while its request is still in flight, a reconnect reads its baseline, the sign-out commits, and the reconnect's refused publish loses its answer too. The read shows one step past the baseline, and the refused reconnect is adopted. Regression tests: `does not adopt a reconnect when an earlier unanswered sign-out may have moved the generation`, and `adopts a reconnect again once an answered sign-out supersedes an unanswered one` for the doubt's end. |
| `lifecycle-committed-reconnect-keeps-login` | Fixed; now passes | Checks `CommittedReconnectKeepsLogin` with every fault on: a reconnect the app server committed is never settled and wiped. The review found that marking every sign-out as superseding, answered or not, broke this through a failed sign-out publish during the reconnect; this check catches that version. Regression test: `neither adopts nor wipes a reconnect whose unanswered publish cannot be proven`. |
| `lifecycle-committed-reconnect-keeps-login-reverted` | violated: shows why the fix is needed | With `LostReconnectAdopted` off, the committed reconnect whose answer was lost is settled and its login wiped. |
| `lifecycle-cancel-records-signed-out` | Fixed; now passes | Checks `CancelRecordsSignedOut` with every fault on: no settled reconnect wipes the login while Rust reads ready. Before the fix (the known limit): a sign-out whose publish failed left Rust reading ready. A reconnect started and was cancelled; the cancel wiped the login and recorded nothing, so Rust kept admitting turns until some later refresh. Regression test: `records signed out in the app server when a reconnect is cancelled after a failed sign-out`. |
| `lifecycle-cancel-records-signed-out-reverted` | violated: shows why the fix is needed | With `CancelSignsOut` off: a sign-out whose publish fails, a reconnect, a cancel. |
| `lifecycle-cancel-keeps-unrecorded-login-reverted` | violated: shows why the fix is needed | Found by a Codex review of #572. With `CancelKeepsUnrecordedLogin` off: a sign-out whose publish fails, a reconnect, and a cancel whose own publish fails and still wipes the login. Regression test: `keeps the login when a cancelled reconnect cannot record signed out`. |
| `lifecycle-confirmed-sign-out-stands` | Fixed; now passes | Checks `ConfirmedSignOutStands` with every fault on. Found by a Codex review of #572: a sign-out answered during a pending reconnect was followed by the browser sign-in. The refused reconnect's settle could not publish, so it kept the new login as an unknown outcome, and the next refresh published connected over the confirmed sign-out. Shutdown is excluded, because `close()` drops a pending reconnect without settling it. Regression test: `keeps a confirmed sign-out when a superseded reconnect cannot record signed out again`. |
| `lifecycle-confirmed-sign-out-stands-reverted` | violated: shows why the fix is needed | With `SupersededCancelWipes` off: sign out, reconnect, sign out (answered), sign in, and a cancel whose publish fails keeps the login. |
| `lifecycle-no-stale-admission` | Fixed; now passes | Checks `NoStaleAdmission` with every fault on: no provider access is granted while `P` has no login and the app server reads it ready. Found by a Codex review of #572: a cancel after a sign-out whose publish failed kept a login that did not exist and let turns take access against the stale connected catalog. The model then found that a refresh that read the account before such a sign-out could end the block by publishing connected. Regression tests: `refuses provider access after a sign-out the app server did not record`, `keeps admission blocked when a cancel after an unrecorded sign-out has no login to keep`, and `keeps admission blocked when a refresh from before an unrecorded sign-out publishes connected`. |
| `lifecycle-no-stale-admission-reverted` | violated: shows why the fix is needed | With `SignOutBlocksAdmission` off: Rust admits a turn, a sign-out's publish fails, and the turn takes provider access with no login. |
| `lifecycle-straddling-refresh` | Fixed; now passes | Checks `ReadyMeansSignedIn` with the sign-out fault off. Before the fix: a refresh resolved its generation before a reconnect, read the account after the browser sign-in, and reached its publish after the cancel. The cancel had not moved the generation, so both checks passed and Rust read ready over the wiped login. The cancel now advances it, so the result is stale. Regression test: `drops a refresh that straddles a cancelled reconnect`. |
| `lifecycle-straddling-refresh-reverted` | violated: shows why the fix is needed | With `CancelSignsOut` off: sign out, refresh starts, reconnect, sign in, refresh reads, cancel, refresh publishes. |
| `lifecycle-overlapping-refresh` | passes | Checks `OverlappingRefreshNeverReadiesWipedLogin`, with every fault but the sign-out's on. A Codex review of #572 asked for a refresh epoch across the reconnect, since `refreshGeneration` is only a level check. This check shows the epoch is not needed: every path that ends a reconnect and wipes the login first advances the generation, and a cancel that cannot keeps the login, so a straddling refresh is either stale or truthful. A refresh straddling a failed sign-out is the sign-out's known limit and is excluded. |
| `lifecycle-overlapping-refresh-reverted` | violated: shows why the fix is needed | With `CancelKeepsUnrecordedLogin` off, a cancel whose publish fails wipes the login without advancing the generation, and the straddling refresh publishes ready over it. |
| `lifecycle-removal-completes` | passes | PROV-003: a removal that waited on the turn finishes once the turn releases, with every fault on. |

`ReadyMeansSignedIn` is checked with the sign-out fault off. A failed
sign-out publish leaves Rust ready with no login by itself; the next refresh
corrects it. While a reconnect is pending, no refresh runs, and the lease
guard keeps turns off the reconnect's runtime. Settling the reconnect commits
signed-out, which ends that state. If that publish fails too, the login is
kept, so Rust stays ready with a login until the next refresh.

A reconnect starts with `ReconnectBegin`: from its first check it prepares the
runtime and starts the sign-in (`prepareRuntime`, `login()`) before it is
pending, and it may fail there (`ReconnectAbort`). No refresh starts or
publishes in that interval either. A Codex review of #572 found the code
guarded only the pending entry; `refreshGeneration` now also returns null
while a reconnect prepares. The browser sign-in cannot finish before
`login()` returns, so no invariant tells the interval apart: a refresh there
reads the signed-out account. The regression test is `runs no refresh while
a reconnect prepares its runtime or starts its sign-in`.

Two code seams sit inside single model steps, and the code now matches the
model's assumption at each. `RefreshPublish` checks for a pending reconnect
at the write. An explicit refresh awaits a readiness evaluation after the
catalog service's check, so the composition rechecks the refresh generation
just before it publishes. The regression test is `publishes no explicit
refresh whose readiness evaluation outlasted the start of a reconnect`.
`Close` is the moment admission closes. Desktop shutdown awaits the app
server before it closes the providers, so it now calls `beginShutdown()`
first; leases requested meanwhile are refused. The regression tests are
`refuses provider access from the moment shutdown begins` and a source-text
check of `shutdownServices` in `desktop-shell.test.mjs`. Both were found by a
Codex review of #572.

### `HarnessCodexThread.tla`

This model covers `codex.basic`'s persistent root thread across serialized
root turns. Prompts carry only the current turn, so the native thread is the
only holder of prior conversation ([#584](https://github.com/vishaltandale00/relayer-graphcomplete/issues/584)).
It must be kept whenever it can be resumed, and a reset must be visible.

- **Harness:** the saved thread, the Codex home it is bound to, the step that
  saves it, and the pending reset notice.
- **App server:** `thread/start`, `thread/resume` and `turn/start`. A thread
  has a rollout only in the `CODEX_HOME` whose `turn/start` was accepted on it.
  `thread/resume` without one fails with "no rollout found", as the pinned
  Codex 0.147.0 binary does.
- **Providers and homes:** the subscription `s` has its own home `S`. Two
  API-key providers, `k1` and `k2`, share Codex's default home `D`, as they do
  in production today.
- **Interruptions:** Stop, the per-turn force-stop and force shutdown, and a
  thread saved by an earlier release, whose home is unknown and whose rollout
  may be missing. A force marks the turn, and the kill lands later (`Kill`), so
  a `turn/start` answer already in flight can still arrive. A Stop while
  `turn/start` is pending kills the app-server.

The model decides only resumption for the provider each turn uses. Which
providers an existing conversation may select belongs to the legacy
compatibility policy, so the model lets every turn pick any provider.

`codex-thread-today` mirrors the code, and each `-reverted` check turns one fix
off. Nine constants hold the fixes:

- `CommitAtTurnStart`: the thread is saved when `turn/start` is accepted
  (`onTurnId`), not when `thread/start` answers.
- `ThreadRecordsHome`: the saved thread records a binding, and a turn that
  does not match it starts a fresh thread.
- `BindToHome`: that binding is the Codex home, not the provider definition, so
  providers that share a home keep resuming the thread.
- `RecoverMissingRollout`: a `thread/resume` that finds no rollout forgets the
  saved thread and starts a fresh one in the same turn.
- `ForceForgets`: a force-stop or force shutdown of a root turn that sent
  `turn/start` forgets the saved thread.
- `CommitChecksForce`: a `turn/start` answer that arrives after the force is not
  saved (`onTurnId` checks the force signal).
- `ForgetOnlyAfterTurnStart`: a turn forced before it sent `turn/start` wrote
  nothing, so the saved thread is kept.
- `StopForgetsPendingStart`: a Stop that kills the app-server while
  `turn/start` is pending forgets the thread, as a force does.
- `ResetsVisible`: every forget leaves a reset notice, which the next fresh
  root thread reports.

The properties are:

- `NoDeadResume`: a root turn never fails on a thread Codex cannot resume.
- `ResumeOnlyMaterialized`: only a thread with a rollout in the turn's home is
  offered for resume, except one saved by an earlier release.
- `NoKilledResume`: a conversation killed mid-write, by a force or by a Stop
  while `turn/start` was pending, is never resumed (PRD, Provider execution
  access).
- `NoNeedlessForget`: after a root turn in a home finishes, or is stopped once
  running, the next root turn in that home resumes its thread, whichever
  provider it uses. Only a later killed conversation lifts this.
- `NoSilentReset`: a root turn that starts a fresh thread after a root
  conversation was lost reports it. Each loss is reported once.
- `NeverResumes`: a witness, expected to be violated, that a real resume is
  reachable.

| Check | Verdict | Finding |
| --- | --- | --- |
| `codex-thread-resumable` | Fixed; now passes | Before the fix (H1): the thread was saved as soon as `thread/start` answered, and reset only when the presentation version changed. A follow-up in another Codex home resumed it without its rollout, and a Stop between `thread/start` and `turn/start` pinned a thread that never got one. Every later root turn failed with "no rollout found", also after a restart. Regressions: `codex-root-thread.test.ts` drives the real app-server transport against an emulated app-server with Codex's rollout rules. |
| `codex-thread-home-reverted` | violated: shows why the fix is needed | Without a recorded binding, a follow-up in another home resumes a thread with no rollout there. |
| `codex-thread-commit-reverted` | violated: shows why the fix is needed | A Stop before `turn/start` leaves a saved thread with no rollout. |
| `codex-thread-recovery-reverted` | violated: shows why the fix is needed | A thread saved by an earlier release, with no rollout in the turn's home, fails the turn. It is still offered for resume, so that existing conversations keep their thread. |
| `codex-thread-force-reverted` | violated: shows why the fix is needed | A force that keeps the saved thread lets the next root turn resume the killed conversation. |
| `codex-thread-late-commit-reverted` | violated: shows why the fix is needed | A `turn/start` answer that arrives after the force saves the forced thread again. |
| `codex-thread-forget-unwritten-reverted` | violated: shows why the fix is needed | Found in review: a force during `thread/resume`, before `turn/start`, forgot a thread nothing wrote. Now kept. Regressions: the two "before its turn/start" cases in `codex-root-thread.test.ts`. |
| `codex-thread-home-binding-reverted` | violated: shows why the fix is needed | #584: binding the thread to its provider definition dropped native history when a follow-up moved between API-key providers sharing Codex's default home. Regression: "keeps resuming across providers that share a Codex home". |
| `codex-thread-stop-kill-reverted` | violated: shows why the fix is needed | Found in review: a Stop while `turn/start` was pending killed the app-server but kept the thread. Regression: "forgets, visibly, a root thread whose turn a Stop killed while turn/start was pending". |
| `codex-thread-silent-reset-reverted` | violated: shows why the fix is needed | #584: without the notice, a root turn silently starts over after its native conversation was lost. Regressions: the reset assertions in `codex-root-thread.test.ts`. |
| `codex-thread-resume-witness` | violated: witness | A real resume is reachable. |

In review, three mutants of this model and `HarnessPrimeRoot` passed every
property then shipped: `Commit` always clearing the saved thread, `Force`
keeping it, and force close forgetting an idle Prime session. They now violate
`NoNeedlessForget`, `NoKilledResume` and Prime's `NoNeedlessForget`.

`ResumeOnlyMaterialized` exempts the earlier release's thread by design: its
home is unknown, so the harness tries it once and binds it on success.
`NoNeedlessForget` gives up continuity only when a turn runs in another home,
where the thread cannot be resumed.

### `HarnessPrimeRoot.tla`

This model covers the harness host and Prime Agent's persistent root session:

- **Host:** the per-thread session lock, capture and persist after a run,
  graceful close, force close, a crash and one restart.
- **Prime:** pinning, rotation, reload, the force-stop generation, and the
  presentation instructions each session was built with.
- **Turns:** two root turns and one invoked child, which only captures state.

`prime-root-today` mirrors the code, and each `-reverted` check turns one fix
off. Five constants hold the fixes:

- `ForcePersists`: the host records the harness state as soon as a per-turn
  force-stop fires, not when the host run ends up to ten seconds later.
- `ForceShutdownForgets`: force shutdown forgets the root session while a root
  conversation runs on it, as a per-turn force-stop does.
- `ForgetOnlyRunning`: only when an unforced root turn is bound to that
  session. A turn still acquiring its session wrote nothing, and a turn
  already force-stopped dropped its session then.
- `ForceClosePersists`: force close captures and persists that state, although
  it skips close's final persist.
- `SessionScopedInstructions`: each session reads its own presentation
  instructions. Before, every session read the shared resource loader's cache,
  which only a session's `reload()` refreshed.

| Check | Verdict | Finding |
| --- | --- | --- |
| `prime-root-serialized` | passes | Root turns stay serialized, and two root natives never share a session. |
| `prime-root-memory` | passes | While the harness is live, it never pins a force-stopped root conversation. |
| `prime-root-capture` | Fixed; now passes | Before the fix: a graceful close captured the state, a force-stop then fired, and the close persisted the stale capture. |
| `prime-root-capture-reverted` | violated: shows why the fix is needed | Without recording at the force-stop, the close persists the stopped session. |
| `prime-root-restart-close` | Fixed; now passes | Before the fix: a turn force-stopped after close had persisted was restored after the restart. |
| `prime-root-restart-close-reverted` | violated: shows why the fix is needed | Same trace with the force-stop recorded only at the end of the host run. |
| `prime-root-force-close` | Fixed; now passes | Before the fix (H2): quitting while a root turn ran ended in force close. Force shutdown kept the root session (Codex kept its thread), and nothing persisted, so the restart resumed the killed conversation. The check also holds `NoNeedlessForget`: an idle session, or one a turn is still acquiring, is kept. Regressions: `host-root-session-force.test.ts` (Codex through the real host, restarted) and the Prime force-shutdown test in `prime-agent.test.ts`. |
| `prime-root-force-close-forget-reverted` | violated: shows why the fix is needed | Force close persists the killed conversation it did not forget. |
| `prime-root-force-close-persist-reverted` | violated: shows why the fix is needed | The previously saved killed conversation survives. |
| `prime-root-forget-running-reverted` | violated: shows why the fix is needed | Found in review: forgetting whenever a root turn is in flight forgets a session a turn was still acquiring. `NoNeedlessForget` now also covers an idle session. Regression: "keeps the root session when force shutdown ends a root turn still acquiring it". |
| `prime-root-keep-witness` | violated: witness | An idle session survives a force close and the restart. |
| `prime-root-crash` | Open, narrowed | A crash after a per-turn force-stop but before its state write lands restores the stopped conversation. The write now starts when the force fires. Before, it waited for the host run to end. Regression for the new timing: "records a force-stopped root turn's forgotten session before its host run ends". |
| `prime-root-instructions` | Fixed; now passes | Before the fix (H3): a rotated root session was built from the loader's cache, which held the previous version's instructions, because `createAgentSessionFromServices` does not reload it (PPG-003). Regression: `prime-agent-native-instructions.test.ts` with the real Prime SDK 0.8.1 and no inference; it also covers invoked children, which the model leaves out. |
| `prime-root-instructions-reverted` | violated: shows why the fix is needed | With the shared cache, a rotated root session runs with stale instructions. |
| `prime-root-liveness` | passes | A force-stopped turn's host run always ends and frees the lock. |

`Restart` after a close or force close waits for the writes they await. A
crash may restart at any point.

### `HarnessCodexAuth.tla`

This model covers the per-`CODEX_HOME` `auth.json` refcount and its serialized
write and remove queue in `codex-basic.ts`. It has three concurrent turns,
roots and children, on one provider home. It includes the per-turn
force-stop and a host that stops waiting before a turn's cleanup ends. It found
no bug, and its checks guard the queue against regressions.

| Check | Verdict | Finding |
| --- | --- | --- |
| `codex-auth-safety` | passes | A running turn always finds its key file, the user count is exact, and no key file remains once every turn ends. |
| `codex-auth-liveness` | passes | The key file is eventually removed for good. |

## Limits

- **Bounds:** one provider plus one new connection, one renderer, one lease,
  and a single child at depth 1 with head revision at most 3. The lease model
  has one provider, at most two turns and two restarts, and one turn per
  thread, so it cannot show that a force-stop spares a sibling turn on the
  same thread; the harness-host, Codex and Prime tests cover that. The
  composer has two threads, two turns each, and two typed values; the
  inspector has two nodes, three state revisions, and three editors; the
  canvas has three locations, one draggable node, and six renders.
  `CatalogRefresh` has two providers, two queued refreshes per provider, and
  at most two lifecycle events. A bug that needs more actors is out of reach.
- **Connection generation:** removing the generation check from `Publish`
  makes `catalog-stale-refresh-after-reconnect`, `catalog-old-account-repopulates`
  and `catalog-stale-adapter-capture` fail, so their passes are not vacuous.
  A logout whose signed-out publish fails advances nothing and supersedes
  nothing; a later reconnect's cancel records the signed-out state. A cancelled reconnect whose fresh runtime fails to start swaps the
  adapter for the stub within one generation; a real result already in
  flight may still publish, which PROV-002 allows because the account and
  generation are unchanged. No check covers restoring through the recovery
  adapter: that needs an explicit refresh, a user action the model does not
  make fair. `CatalogRefresh` checks the generation once, at publish. The code checks twice: the catalog service before it publishes,
  and Rust inside the write transaction. The model's single check stands for
  both. `CatalogRefresh` does not model a lifecycle write whose response is lost; a JS test
  covers the refresh that relearns the generation. The ad hoc
  `ProviderConnect` model, which covers a crash between the create's commit
  and its reply (F2), is not promoted; a JS test covers F2.
  `ProviderLeaseLifecycle` models a reconnect whose answer is lost. It makes
  each publish atomic, so a request whose answer was lost has already
  committed or never will. A sign-out request sent before a reconnect that
  reaches the app server only after the reconnect read its baseline breaks
  that assumption: the reconnect's refused publish can then read one step
  past its baseline and be adopted. That needs three faults and is not
  modeled.
- **Catalog abstractions:** `CatalogRefresh` has no harness. A family is
  resolvable when it is enabled and has a connected member with available
  models. That stands for "some harness can run it": the model leaves out
  the default harness that a provider choice moves along with the family.
  `RefreshKeepsUserDefault` counts only a provider and family chosen
  together. A default with no family is not one: a harness-only save also
  sets `defaults_modified`, and every provider or family save now sets a
  family. `RefreshKeepsOtherDefault` is checked only from a set default
  family, because filling an unset family may also set its provider. Legacy
  system families without a managed provider are not modeled; a service test
  covers them.
- **Queue order:** the provider queue is FIFO for queued cancels, but requests
  that queue behind an interior await may start in either order.
- **Not modeled:**
  - the parent retrying a failed stop;
  - label uniqueness and ids;
  - thread permission pinning;
  - Ladybug index crash recovery;
  - remint races in the graph server;
  - the parent's `/result` long poll;
  - grandchildren;
  - several turns on one harness session or thread;
  - in the lease model, a user's Stop before the native turn starts;
  - store errors other than a refused drain in the provider service, and
    acknowledgement failures.
- **Composer assumptions:** `threads.submitInteraction` reads the thread from
  `viewState` behind a dynamic `import()`, assumed to resolve in the same
  task; if it took a task, a thread switch could send one thread's text on
  another's POST. The model always views the latest turn, so the `finally`
  that reads the viewed turn's status is modeled for that case only.
- **Candidate fixes are modeled, not designed.** A fix still needs a product
  decision wherever the PRD is silent. One example is what the default family
  should become when its managed family is tombstoned.
- **Adapter:** `bound` is attributed to the step that registered the
  listener, not read from the listener itself. `lock`, the program counters,
  and the families are not compared.
- **Review:** an independent adversarial review of model fidelity is not
  certifying. Record its commit, scope and verdict in the PR.
