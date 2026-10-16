# Living plan graph Slice 1 verification

Product authority: [PRD §4.5](../../prd/index.html#living-plan-graph), [#745](https://github.com/vishaltandale00/relayer-graphcomplete/issues/745), [Slice 1 #746](https://github.com/vishaltandale00/relayer-graphcomplete/issues/746). Slice 2 presentation is deferred to #747.

## Changed seams and required verification

| Product checkpoints | Executable seam | Smallest deterministic observation |
| --- | --- | --- |
| LP-001, LP-010 | App `prepare_bound`, capability profile, immutable prepared graph contract | `test/living-plan-product-e2e.test.mjs`: real app/host/graph processes, two accepted messages, legacy supported configuration without planning field, own contributions and retained previous pointer; app runtime adoption matrix covers Codex/Claude/Prime defaults, custom opt-in and explicit opt-outs; configuration suite rejects invalid or search-disabled planning profiles |
| LP-002, LP-003, LP-006 | SQLite checkpoints, normal Ladybug query-v1 Content indexing, typed search observation and exact plan read; ordinary get_node now records applicable plan reads in a write transaction | `crates/relayer-graph-server/tests/living_plans.rs::running_plans_are_searchable_by_real_children_and_survive_return_and_reopen`: search while parent active; new pointers, exact reads, retry conflict, reopen and subsequent call. Core graph_database scoped-read and terminal broker tests protect ordinary get_node behavior |
| LP-003, LP-004 | Codex and Claude JS prompt builders, both Prime Python profiles, typed/Python authoring clients | Harness `codex-basic`, `prime-agent`, `configuration` suites; Prime visual integration performs real Python publish/read roundtrips (the remaining Python suite is regression coverage); sealed requirement activates guidance, legacy input stays neutral. These observe contract delivery, not model judgment |
| LP-005, LP-006 | Real child preparation, interaction-scoped append-only contribution, active-authority validation | Same server scenario: independent child/sibling owners, child after parent Return, successful enclosing integration, foreign thread rejection. Retained trusted writers cannot publish after Return or Stop |
| LP-007, LP-008 | Required final pointer in the same Return transaction as response acceptance | Server `return_is_atomic_checkpoints_survive_failure_and_legacy_preparations_stay_legacy`: missing contribution refuses Return, injected association failure rolls back response acceptance, earlier checkpoint retained, repaired Return, legacy preparation and Stop |
| LP-009 | Reserved internal Content type, ordinary topology validation plus SQL guards, import registration, response closure | Server scenario refuses plan layer/action participation and verifies conversation snapshot excludes plans; core `graph_database` reserved-type import fixture rejects spoofed kind and key. Existing export/share suites exercise the same accepted response closures |
| LP-002 integrity | Encoded publication bound versus frozen query-v1 response bound | Oversized and escape-heavy refusal plus `bounded_plan_text_remains_discoverable_in_encoded_query_v1_results`: accepted near-bound text remains a typed searchable pointer |
| Prime asset admission | Managed recipe identity, vendor manifest, runtime pinned digests and fake-inference visual fixture | `test/prime-managed-runtime.test.mjs` and `test/prime-agent-packaging.test.mjs` rederive real Python/harness asset hashes; `test/prime-visual-integration.test.mjs` exercises actual Prime/Python graph paths while fake inference explicitly satisfies the intrinsic plan requirement. This is separate from model planning proof |
| Off-target Eval admission | Target capability adaptation and pre-inference case admission | `test/eval-configuration-paths.test.mjs` adapts actual shipped planned configs and reparses them; `test/eval-app-integration.test.mjs` rejects the plan case off the qualified macOS ARM64 search target before model execution |
| Packaged module inventory | Sealed telemetry module registration | `test/desktop-telemetry-module-inventory.test.mjs` compares exact packaged module inventory, including the new guidance module |
| Inherited planning in fake inference | Task-system and Stop fixtures replace native inference under shipped configurations | Existing composer compatibility and Stop integration scenarios retain real prepared contracts and acceptance; the fake publishes a contribution when required. These are contract fixtures, not model-quality evidence |
| Portable trace reuse | Eval consumes an exported host spool once, then revalidates complete evidence for a child seen again after a follow-up | Real-process living-plan product fixture runs two human turns and one first-turn semantic child through Eval; each of the three traces exports exactly once. Existing trace integrity tests cover corrupted bytes/scope; cached failure paths also received source review. The initial live run exposed repeated consuming export and is retained as a failed evidence attempt |
| Eval evidence authority | Sanitized graph-operation recorder, registered two-turn case and deterministic grader | Recorder suite plus `test/eval-living-plan.test.mjs`: wrong owner, wrong prior pointer, post-Return publication, failed child, disconnected child read/connected unrelated read cannot pass |

No tests were retired. The distinct negative scenario protects acceptance rollback and terminal authority; the running/reopen scenario protects live discovery and continuity. The size scenario protects serialization expansion at the search boundary.

Required entry points: `npm run test:living-plans` (after build), `npm run check`, `npm run build`, `npm run test:desktop:first-message`, `npm run test:eval-compiled-runtime`, and `npm run test:eval-web`. None requires paid inference. Live model evidence is separate and was explicitly requested by the user.

## Build prerequisites

Native Ladybug cache `/Users/vishal/.relayer/structure-example-comparison-20261015/ladybug-cache` was verified with the repository `lbug-artifact.mjs verify` workflow for macOS ARM64 / Rust 1.98.0. Identity, lock/source, and file hashes passed. It contains pinned Ladybug 0.18.0 from producer `5156d906579625f1eda41bbcf0de7cc71827458d`.

No compatible sealed app/runtime artifact was available for this source. A shared local compiler output was subsequently found to be replaceable by concurrent worktree builds, so its runtime binaries were excluded from final proof. A private Cargo target was created; a dependency-cache clone was stopped after discovering 541,440 unrelated files in the shared deps directory, all workspace crate artifacts were invalidated, and missing dependencies and workspace code were rebuilt from source. Final proof uses `/Volumes/2T-SSD/cargo/relayer-living-plan-0f84`, with explicit runtime binary paths and recorded hashes. Rust was rebuilt from source against that verified native bundle using `LBUG_LIBRARY_DIR` and `LBUG_INCLUDE_DIR`. Build acceleration does not replace the tests above.

## Actual executions

The final executable/configuration/test workspace is identified by the 59-entry [`source-manifest.sha256`](source-manifest.sha256), SHA256 `aff5e6108d0d007faa99083c6a9910dd87256c61d320d623975d8338cd5b5aa2`. The exact live-run source is retained as [`live-source-manifest.sha256`](live-source-manifest.sha256), SHA256 `50fbf77024754f91bc766f4a439f0e7898c02e8d137b98341986a4363ded846a`. Three later deltas make the shared zero-inference task-system and Stop fixtures publish required contributions and register the new guidance module in the sealed telemetry inventory. Native/provider implementation is unchanged; no live proof is claimed for those fixture or inventory changes. This is an uncommitted workspace receipt, not a commit or release certificate. Documentation-only receipt edits do not change that digest.

Passed on the isolated native build at the 56-file live source:

- `npm run test:living-plans`: app adoption matrix (1 Rust test), reserved import identity (1), real graph-server scenarios (3), and 10 JavaScript files / 250 tests.
- Real-process product fixture: two root interactions and one semantic child accepted, all 15 deterministic Eval checks passed, three traces exported once each, ordinary conversation and share output excluded internal plan details.
- `npm run test:codex-secret-boundary`: 1 file / 2 tests.
- Python unittest discovery: 99 tests.
- `npm run lint:ladybug-receipt`: qualification, native receipt and contract-probe lints passed.

Final-source executions at manifest `aff5e6108d0d007faa99083c6a9910dd87256c61d320d623975d8338cd5b5aa2`:

| Execution | Observed result |
| --- | --- |
| `npm run test:living-plans` | Passed again: 5 Rust checks and 10 JavaScript files / 250 tests |
| `npm run build`, nested in `test:desktop:first-message` | Native servers, root TypeScript and all workspace packages built successfully |
| `npm run test:desktop:first-message` | Passed inner smoke receipt: typed permissions, accepted graph, four turns, required-response rejection and repaired/reopened navigation, product/Eval layout parity, read-only review; zero inference |
| `npm run test:eval-compiled-runtime` | 1 file / 12 tests passed against compiled entry |
| Focused composer/share/Prime/invoke rerun, one worker | 4 files / 229 tests passed |
| Stop integration rerun, one worker | 1 file / 12 tests passed |
| Exact sealed module inventory | 1 test passed |
| Sealed private Homebrew Node closure timeout scenario | 1 test passed, remaining 129 intentionally deselected |
| `npm run prd:check-readability`, `git diff --check` | Passed |

`npm run check` did **not** pass. Format, Clippy, Rust workspace tests, crash reconciliation, package builds and type checks passed before Vitest reported 320 passing files, 9 failing files, 1 skipped file; 4,334 passing tests, 21 failing tests, 3 skipped tests. The run began before the final fixture/inventory repairs; no pass is claimed for an interleaved source snapshot. Failures were six composer fixture acceptances, two Stop fixture acceptances, one module inventory mismatch, plus timeouts/readiness/bounded-process failures in share, Prime, recursion, invoke, Stop and sealed Node scenarios. The respective focused files/scenarios subsequently passed in the contexts above (Prime visual tests are also included in the final living-plan gate). The entire check command was not rerun after those repairs. Separate secret-boundary, Python and receipt lint commands above cover the stages skipped after Vitest failed; their source files are unchanged.

`npm run test:eval-web` passed interrupted startup, persisted host/restart, settings, human lifecycle, dispatch-race and native-select checkpoints, then failed during the actor startup preflight: task was `interrupted`, expected `completed`. Later checkpoints were not reached. Its overall result remains failed. A corrected private-target, logging-only diagnostic passed startup and redraw preflight, executed three completions, then failed with an actor timeout in `observe`. The observation failure remains unresolved; no further unchanged retry was run. A diagnostic attempt inherited a shared Cargo path and was excluded after it rejected the new planning config; subsequent diagnostics explicitly use the private target. Neither an earlier outer pass nor the passing live demonstration substitutes for this assembled gate.

The machine-readable execution summary is [`verification-results.json`](verification-results.json). Failed broad gates remain explicit; the original full-check result is not rewritten by successful focused follow-ups.

## Requested live demonstration

[`live-run-receipt.json`](live-run-receipt.json) records run `run-2026-10-16T06-48-29-861Z-ef3d4c66`, execution `848aefc5-b7ce-4246-b90a-17a847930dc4`, using Codex Basic revision 19, `planning: interaction-v1`, query-v1 search, and product-selected `gpt-6.1-sol`. The user explicitly requested this live model execution. Both human turns and the single semantic child accepted; all 16 checks passed. Complete portable traces and graph-operation ledgers were retained.

The nine authored plan checkpoints show root → semantic child → follow-up continuity. Final associations are `53→68`, `56→63`, and `69→75`. The root retains the unresolved budget, incorporates the child's intake/safety findings, and the follow-up applies a $120 cap and reduced staffing. The rendered proposal offers five continuing roles, short-shift setup support, four initial slots and conditional alternatives. See [`eval-dashboard.png`](eval-dashboard.png) and [`eval-response.png`](eval-response.png).

This is a bounded continuity observation. Early root/child checkpoints emphasize work and constraints; interface-purpose planning appears mainly later. It does not establish that every call planned interface purposes before substantive work, comparative improvement, or general model quality. Graph presentation is **Unjudged**. The captured Node Detail does not expose the budget breakdown for independent arithmetic review. LP-004 prompt delivery is deterministically covered; consistent early model adoption remains unqualified. Slice 2 remains deferred.

Earlier live attempts remain in the isolated Eval profile. Two stopped before inference while harness readiness was unavailable. A prior actual run accepted its interactions and passed its nine planning gates, but failed the repeated child-trace export check (15/16 overall). That failure led to cached trace validation/reuse and the real-process once-only export regression above. The successful run was a fresh execution after that fix; no failed record was rewritten.

## Adversarial review

Reviewer `/root/plan_prd_review` inspected graph ownership, immutable preparation, search provenance, failure atomicity, terminal trusted-writer authority, import spoofing, discovery size limits, automatic adoption, and Eval grading. Findings led to fixes for terminal publication, reserved import identity, scalar-versus-pointer provenance, oversized search rows, and false continuity grading. Final source review reported no remaining consequence-bearing defect in that scope; no tests were executed by the reviewer. This is non-certifying without a PR. The final digest binding is recorded below.

Reviewer `/root/eval_build_readiness` independently verified every manifest file at digest `50fbf77024754f91bc766f4a439f0e7898c02e8d137b98341986a4363ded846a`, reviewed Prime asset admission, off-target capability adaptation and trace reuse, and inspected all nine published plans and both screenshots. Verdict: no blocker to the narrow continuity receipt; early interface-purpose planning and comparative quality remain unproven. The reviewer ran no tests or inference. This review is non-certifying without a PR.

Final reviewer `/root/plan_prd_review` verified all 59 hashes at `aff5e6108d0d007faa99083c6a9910dd87256c61d320d623975d8338cd5b5aa2` and confirmed the 56 live-source entries are unchanged. Reviewed the ordinary-share fixture, startup allowances, optional task-system/Stop fixture publications, and sealed module registration. Verdict: pass, no unresolved code finding; no added authority or model-quality implication. No tests or inference executed by this reviewer. Non-certifying without a PR; full-check failures and consistent early interface-purpose planning remain outside the verdict.
