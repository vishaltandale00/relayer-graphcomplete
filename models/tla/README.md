# TLA+ models

These models find bugs in the two parts of Relayer with the most concurrent
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
`TLA2TOOLS_JAR`. All checks and scenarios together take about 40 seconds.
`--render` rewrites the scenario traces (see below).

`check:models` is not part of `npm run check` yet. Adding it there requires a
Java runtime in CI and an entry in `scripts/ci/verification-portfolio.v1.json`.

## How expectations work

Each check in `checks.json` expects either `pass` or a named violation. A
known bug is recorded as an expected violation, so the runner stays green
while the bug is open. The runner reads only the models, never the code, so
the models must be kept in step with the code by hand.

`CompletionCurrent` has one constant for each candidate fix:

- `completion-today` mirrors the code as it is.
- `completion-fixed` enables every fix.

Each bug check starts from `completion-today`, switches every other bug's
fix on, and leaves its own constant as the code has it. A violation of that
check can therefore come only from its own mechanism.

A fix PR flips its constant in `completion-today`. That check then passes, so
the PR must also flip its expectation to `pass`; otherwise the runner fails.
A provider fix edits `ProviderSettings.tla` directly and flips its check the
same way. Violated checks run on one TLC worker, so their traces are the same
from run to run.

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

The first replay found a model error. The IPC layer releases a renderer
binding once its connection settles, and the model did not.

A bug fix follows these steps:

1. Add the counterexample's steps as a scenario, render it, and watch the
   replay break the promise at the final step.
2. Fix the code and mirror the fix in the model.
3. Re-render the trace. The replay now matches the model's new state, and the
   promise holds.

With the code fix reverted, the replay fails at exactly the step the fix
changes.

## Verdicts

The Verdict column is an independent read of the code for each
counterexample:

- **Confirmed:** the product can reach the trace.
- **Plausible:** reaching it depends on the assumption named in the row.

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
| `provider-leased-runtime` | Plausible: narrow window | Rust admits a turn while `P` still reads connected in SQLite, and the user then signs out and reconnects. When the harness takes its lease, `acquireExecution` hands out the runtime the pending reconnect registered, because it never checks `pendingConnections`. A failed handoff, a cancel or a terminal check then runs `#cancelPendingConnection`, which closes that runtime under the turn. |
| `provider-remove-during-reconnect` | Fixed; now passes | Before the fix: after sign out, Reconnect, then Remove, the pending reconnect outlived the removal and could still complete. Now `remove()` drops it as the provider enters `removal_pending`, which "immediately blocks new attempts through it" (docs/architecture.md). The runtime stays in `this.runtimes` for turns still draining, and it closes with the tombstone. The PRD is silent here, so this is an architecture-backed decision. Scenario: `provider-remove-during-reconnect`. |
| `provider-attempt-ownership` | Fixed; now passes | Before the fix: `bindConnection` ran only after `connect()`/`reconnect()` (including `login()`) and `openExternal` resolved. It added a `destroyed` listener to contents already destroyed, and that listener never fired. It now cancels the attempt instead. This restores PRD BRW-005. Scenario: `provider-destroyed-before-bind`. |
| `provider-close` | Plausible: depends on shutdown order | `close()` waits for lifecycle tasks but not for the queue, and `acquireExecution` ignores `closing`. A turn admitted before shutdown can create and register a runtime after the maps are cleared. |
| `provider-default-family` | Needs a product decision | A catalog refresh that reports `provider_no_eligible_execution_models` tombstones the provider's managed family even when it is the default family. A later refresh with eligible models reactivates the same family. Disable, delete and removal all refuse to break the default family, but the PRD makes no promise here. |

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
| `completion-observe-timeout` | Confirmed | `observe_invoked_completion` has a 5 s control timeout, but the harness answers only when the run ends. A child still running after 5 s is failed with `provider_exited_without_return`, and its capability is revoked while the provider keeps running. Shipped configurations enable recursion. |
| `completion-activation-failure` | Confirmed | A lost or failed activation settles the execution row only. The graph current stays active, the product status is never finalized, and a broker retry gets 200 with no launch. Restart skips settled rows. |
| `completion-clean-exit` | Confirmed | For an invoked child, the harness resolves a clean native end without checking for Return (`host.ts`). The exit observer fails only on an error, so the child stays active until its parent stops it or the app restarts. |
| `completion-start-failure-reason` | Confirmed | Start-failure cleanup retries `fail_graph_completion("provider_start_failed")` every 250 ms, and the graph rejects that reason forever. `graph_observation_failed` is also missing from `validate_terminal_reason`. `provider_attachment_persist_failed` is missing too, but it is sent once and the exit observer then fails the child with a valid reason. |
| `completion-start-failure-terminal` | Confirmed | If the current was already terminated by a stop before launch, or by a Return after a lost start acknowledgement, `terminate_graph_completion` reports "already terminal without the expected failure receipt". Cleanup then retries forever. Adding reasons alone does not fix this. |
| `completion-restart` | passes | Restart reconciliation does not abort on a state the product produced. |
| `completion-fixed-safety` | passes | With every candidate fix, every safety invariant holds. |
| `completion-fixed-liveness` | passes | With every candidate fix, every claimed child settles. |

The candidate fixes are:

1. Long-poll or re-poll the observation instead of timing out.
2. Fail the child when a clean exit leaves its current active.
3. Fail both stores when activation fails.
4. Use valid failure reasons.
5. Let cleanup settle a current another actor already terminated, with that
   current's own outcome.

Fix 3 conflicts with the retryable activation path. That path restores the
interaction to `submitted` for a retry, and resetting the execution to
`reserved` is the alternative. Choosing between them is a product decision.

## Limits

- **Bounds:** one provider plus one new connection, one renderer, one lease,
  and a single child at depth 1 with head revision at most 3. A bug that needs
  more actors is out of reach.
- **Queue order:** the provider queue is FIFO for queued cancels, but requests
  that queue behind an interior await may start in either order.
- **Not modeled:**
  - the parent retrying a failed stop;
  - label uniqueness and ids;
  - the model catalog refresh queue's own ordering;
  - harness readiness generations;
  - thread permission pinning;
  - Ladybug index crash recovery;
  - remint races in the graph server;
  - the parent's `/result` long poll;
  - grandchildren.
- **Candidate fixes are modeled, not designed.** A fix still needs a product
  decision wherever the PRD is silent. One example is what the default family
  should become when its managed family is tombstoned.
- **Adapter:** `bound` is attributed to the step that registered the
  listener, not read from the listener itself. `lock`, the program counters,
  and the families are not compared.
- **Review:** an independent adversarial review of model fidelity is not
  certifying. Record its commit, scope and verdict in the PR.
