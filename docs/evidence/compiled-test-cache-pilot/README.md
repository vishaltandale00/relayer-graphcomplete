# Controlled hosted compiled-test cache pilot

Status: implementation under evaluation; no speedup or production adoption claim.

The earlier Linux diagnostic compiled only app-server and graph-server lib-test
targets and replayed four selected tests. Its 41.17 s compilation and 6.09 s
local consumer path do not establish Actions cache latency or complete CI
coverage. Its 849 MiB Ladybug archive exceeded the production 800 MiB policy.
This pilot never imports that archive or its external verifier exception.

## Scope and acceptance mapping

PRD sections 15E and 16.1 separate deterministic product proof from package,
live-provider, and release proof. `docs/agents/ci.md` and
`scripts/ci/verification-portfolio.v1.json` retain authority over CI commands.
This experiment changes no product behavior, required CI command, planner,
crash feature selection, test timeout, or release authority. No PRD decision
change is needed. No paid inference or signing runs here.

Changed executable seams and checkpoints:

| Seam | Required boundary | Deterministic checkpoint |
| --- | --- | --- |
| `bundle.py identity` | Consumer owns source, profile/features, toolchain, paths, target contract, native and runner-runtime identity | Python source mutation scenario covers actual fixture/docs bytes, executable mode, untracked input and newly added test target; selected identity-field mutations test whole-object rejection; CLI stale-source scenario covers revalidation before pack and restore; Linux derivation fixture invokes actual identity logic with controlled external probes and native-verifier rejection |
| `bundle.py pack/restore` | Exact inventory; no links, traversal, duplicates, missing/extra files, corruption or partial installed target | Python real roundtrip and rejection scenarios operate on the production transport functions |
| `run.mjs` | Cargo owns all workspace target selection; nonzero compile/test exits remain failures | Vitest executes the real driver against controlled failing commands and checks both receipt and process status |
| Separate hosted workflow | Restore failure reaches the ordinary fresh default test command; telemetry/cache errors cannot certify a test pass | Vitest parses workflow trigger, authority separation, unconditional fresh test steps and explicit Bash pipefail contract; hosted logs establish actual test outcomes |
| Cache transport | Actual Actions save/restore latency, compression, input validation and complete selected lane duration | Named hosted producer and fresh-runner consumer jobs; source receipt and each inner Cargo test summary retained |

`test/ci-compiled-test-pilot.test.mjs` includes the Python transport portfolio in
the ordinary Vitest suite. Existing broad `scripts/ci/` and workflow ownership
selects the full deterministic portfolio; no mapping is narrowed and no test is
retired. Required pre-commit gates remain `npm run check` and `npm run build`.
The independent hosted pilot is additional measurement, not a replacement gate.

## Experiment design

The producer compiles the entire workspace default test inventory with Cargo
`--no-run`, seals the complete target directory **before tests execute**, then
runs the unchanged production `rust-tests` chapter with every workspace package.
The consumer uses a fresh runner and freshly checks out the same source. It
independently derives identity, restores to quarantine, checks an archive SHA
supplied separately by the producer job, validates every file, and atomically
installs compilation bytes. It then invokes that same production chapter. Cargo
still discovers and runs lib, bin, integration and doctests. The crash-feature
lane is untouched and cannot consume this default-feature bundle.

No test output enters the bundle. Cargo source timestamps are not altered to
manufacture freshness. Recompilation after restore counts against the treatment.
Unknown extra, missing, unsafe or corrupt members reject before target install.
An absent/rejected archive leaves an absent target and the normal Cargo build
and test path runs. Genuine compiler/test failures are never retried as misses.

Identity conservatively includes all tracked bytes, paths and actual executable
bits, the workspace target/features metadata, build environment, full rustc and
Cargo versions, compiler/linker reports, fixed absolute paths, and complete
native file inventory. The native bundle must pass the unchanged production
verifier including its 800 MiB ceiling. Failure disables cache experimentation
and leaves source compilation available; it does not promote the earlier
diagnostic exception or relax native policy.

Both jobs use Ubuntu 24.04 hosted runners. Exact `ImageVersion`, installed dpkg
inventory, OS metadata, and OpenSSL library hashes are admission inputs: image
or runtime drift rejects reuse. This is conservative admission for two trusted
hosted runners, **not** a digest-pinned container image or a production-certified
loader closure. Full runtime/compiler binary qualification and a production
cache trust/receipt lifecycle remain prerequisites to adoption.

The key includes run ID and attempt to force one controlled save→restore pair.
This measures hosted transport, not natural hit frequency. The archive ceiling
is 1.5 GiB compressed / 6 GiB expanded; oversize snapshots are recorded rejected
experiments, never reasons to change native qualification. Only this workflow
reads its namespace. The required CI remains separate.

Report producer compile+fresh tests and consumer identity+restore+fresh tests
as selected-lane paths, with common setup, producer identity/packing/upload,
cache download, and job scheduling separately visible. Never compare producer
job duration including packing against consumer job duration as a speedup.

## Evidence ledger

`recent-runs.json` audits the latest 30 completed CI runs captured at 03:24 UTC
on 2026-09-28. Five skipped the Rust test job, 24 passed it, and one cancelled.
Exact checked-out commits came from job logs (including synthetic PR merges),
and their Git trees came from the GitHub Git API. Within this window there were
**zero eligible prior successful writers with an identical source tree** for
the selected lane: two repeated trees flowed from PR to main, which cannot read
the PR cache; the remaining repeated tree followed a cancelled run. Each record
retains its run URL, source/tree, scope, timestamps and candidate writers.

This is a retrospective necessary-condition bound, not an observed cache-hit
rate. It excludes entries before the window, does not assert they were retained,
and does not equate tree equality with complete runtime/build identity. The
full-source pilot intentionally misses even prose-only changed heads. Evidence
for a safely narrower compilation-input closure would be needed before claiming
useful reuse across ordinary edits.

Required: deterministic transport/driver checks, full check/build, source-bound
adversarial review, one hosted save/restore pair, exact inner outcomes, and a
recent-run reuse audit respecting cache ref visibility. Actual results and
unresolved limits will be recorded after execution. A planned test is not proof.
