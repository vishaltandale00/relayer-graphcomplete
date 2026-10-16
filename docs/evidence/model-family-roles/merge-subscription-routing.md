# Latest-main merge with native subscription routing

This integration combines role-aware families and the evaluator repairs at
`ecaa615c03fd7dc503744dce00a2b12296033f59` with main
`c8225db3139f1c944022b50d2293c14d7f5862f0` (#725). The previous
16-cell comparison remains evidence only for its recorded sources. It is not
rerun or reinterpreted as proof of this merged source.

## Product meaning and executable seams

PRD FAM-001–006 and ADR 0006 govern frozen family admission and native routing.
PRD sections 12 and 13 and the child-approval decisions on main govern independent
completion, provider and approval lifetimes. Native providers continue to own
recursion; `complete(inputGraph)` and graph acceptance retain their owners.

Native family guidance is called directly by the normal Codex, Claude and Prime
prompt constructors. The experiment's private loader is not part of the product.
Codex and Claude native selectors retain the exact admitted provider definition
and access contract, including managed subscriptions. Other-provider members
remain metadata-only in those adapters. This enables the supported subscription
routes; it does not promise arbitrary cross-provider delegation or API fallback.
Eval's independent Codex evaluator refreshes native subscription discovery under
its lease, without changing candidate defaults or installing a missing runtime.
No configuration switch or new authority is introduced by this integration.

| Executable seam / checkpoint | Deterministic production proof |
| --- | --- |
| Actual Codex/Claude/Prime root and invoked prompts carry the frozen roster; current-provider subscription selectors never substitute credentials | Complete `codex-basic`, `claude-basic`, `prime-agent` harness test files and host admission journeys |
| Judge subscription discovery refresh, stale cached status, cancellation, missing runtime, model/effort checks and preserved candidate defaults | `test/eval-provider-setup.test.mjs` |
| App-server recursive launch/settlement, per-child approval stream, decision reservation, late requests, fail-closed observer and prepared-resource cleanup | `relayer-app-server` completion-trace support scenarios through `cargo test --workspace`; the own-row approval journey runs both legacy and v2 selected admission |
| Role-aware subscription admission and own-row child approval preserve the same v2 plan and held native lease across graph Return | `a_childs_approval_is_recorded_on_its_own_row_and_its_decision_resumes_it` in `crates/relayer-app-server/tests/support/completion_traces.rs`, both `selected=false` and `selected=true` |
| Storage approval outcomes preserve graph-owned child terminal state; accepted settlement while waiting; thread/archive activity includes answerable child approvals | App-server SQLite approval, completion-execution and thread tests through `cargo test --workspace` |
| Graph current settlement retains its canonical terminal reason | Graph-core current and database tests through `cargo test --workspace` |
| Renderer child status/refresh keeps late approvals answerable without making every child a running message turn | `test/approval-model.test.mjs`, `test/run-state.test.mjs`, native completion-trace scenarios |
| Compiled input occurrence capture and artifact modal identity remain scoped to visible trusted presentation | `test/node-detail-runtime.test.mjs`, `test/review-session.test.mjs`, full `npm run test:eval-web` |
| Social preview and follow-up annotation renderer receipts match this actual merged renderer | Real Electron capture runners and both evidence receipt tests; inspect generated images |
| Packaged telemetry module/source integrity remains current | `npm run evidence:telemetry` |

No test is deleted or weakened. These checkpoints cover separate native,
persistence, presentation and authority failure boundaries. Required local gates
are `npm run check` and `npm run build`; Eval browser and declared evidence
runners remain separate heavy checkpoints. There is no paid inference in these
gates. Signed, release and unavailable-platform proof is not claimed.

## Build preparation and evidence

The existing isolated Cargo target is warm. Before compilation the repository's
`lbug-artifact.mjs verify` accepted the existing macOS-ARM64 / Rust 1.98.0 Ladybug
bundle, checking identities and hashes against this checkout. No cached test
result is reused. Both Rust servers rebuild against the merged source.

Visual evidence is regenerated rather than resolving conflicting receipts or
PNG files by choosing either parent. Verification outcomes and exact-source
adversarial assertions are recorded in the PR after execution. Prior failures
and prior-source review assertions remain historical; they do not certify the
merged source.

The integration review found that main's own-row child-approval journey only
covered the legacy unselected path. Its existing scenario now runs both paths
with all previous correlation, resume, settlement and no-cancellation assertions.
The selected path additionally observes the persisted v2 Codex subscription plan,
its orchestrator role, unchanged admitted bytes and held lease before and after
graph Return while the provider still runs. The real production journey passed
in 0.92 seconds. Main's new storage fixture also needed the added optional
provider constraint explicitly set to `None`; the first compile failure and the
corrected passing run are preserved in the private integration ledger.

Adversarial reviewer `/root/repair_authority_review` found no concrete blockers
in the exact 39-file integration/authority scope recorded in
[the source receipt](merge-subscription-routing-review.json), SHA-256
`84c8044667582a16989401dcf2159167d03f3a3ae7e18b31074734d6efa8cef3`
(sorted relative path + NUL + bytes + NUL). The reviewer independently passed
86 renderer tests. Source changes invalidate this assertion. Full/heavy gate
outcomes were pending at review and are not certified by it.

## Executed local gates

The earlier `cc73f9cf` integration executable/source-test snapshot passed:

- `npm run check`: complete aggregate, including 446 app-server unit tests,
  4,365 JavaScript tests (three skipped), secret boundary 2/2, Python 99,
  native/crash chapters, package/type checks and receipt/readability checks.
- `npm run build`: final rerun after the integration test change passed.
- `npm run test:eval-web`: all declared chapters passed, including accepted
  artifact/input capture, Current/settled actors, judge screenshots and native
  Product restart/reopen.
- `npm run evidence:telemetry`: local gateway privacy passed; release proof
  remains indeterminate, as recorded in its structured verdict.
- Actual Electron social-preview and follow-up-annotation runners passed; all
  six images were visually inspected and both receipt tests passed.
- Focused harness/provider/renderer suite: 423/423 across nine files.

The initial compile failure remains preserved separately; it is not rewritten
as a pass. No inference run was added for this merge. Required hosted CI still
checks the exact PR merge source before integration. These local gates do not
constitute signed/release proof or an orchestrator quality promotion.

## Canonical version ingress review follow-up

After CI passed on `cc73f9cf`, the merge gate correctly refused an unresolved
review finding: Rust accepted explicit `schemaVersion: 1`, then omitted that
field from the v1 digest and re-export. This violates the existing contract
that v1 is represented only by an absent field. A real JSONL mutation test
first reproduced the acceptance; its red run is retained.

| Changed executable seam / checkpoint | Smallest production proof |
| --- | --- |
| Requested, admitted and portable plan serde preserve absent-v1 and explicit-v2, but refuse explicit1/null/0/3/string versions | `family_role_fixtures_bind_versions_and_exact_roles`, all three production structs, both golden versions |
| Import cannot accept and canonicalize an explicit1 receipt under the original omitted-version digest | `role_bearing_and_historical_plans_roundtrip_with_versioned_integrity`, actual `decode_export_jsonl` with mutated legacy receipt |
| Programmatically constructed malformed versions/roles remain rejected by full and incremental validators | Existing typed-validation parity assertions retained in that contract journey |

One shared present-field deserializer is applied to the two internal plan types
and the portable plan. Defaulting and legacy serialization remain unchanged.
This changes only version ingress; no roles, selection, credential routing,
scoring or graph acceptance policy is widened. No tests are deleted. The
preceding local/hosted green gates remain evidence for `cc73f9cf`; required
check/build and focused ingress verification are rerun for this follow-up.

Follow-up adversarial reviewer `/root/repair_authority_review`: no concrete
blockers in the five-file version delta, digest
`2fff7e0ebdf810887b501e984cd587f70f0412c4b8cc5fe7909c22e9f9e20e4c`.
The integrated 43-file scope digest is
`464e38fc91f3fd91d46a48d1bd7f44d2fde5d0ebd31e7fb021e9c7325375547c`;
exact paths and per-file hashes are in the
[follow-up receipt](merge-subscription-version-review.json). The prior
39-file assertion is historical after the additional product re-export.
Both scopes use sorted path + NUL + bytes + NUL, and source changes invalidate
the assertions. All 50 export contracts and the internal fixture matrix passed;
required full gates remain separate from this review.

Follow-up executed results: all native/Clippy/crash and type/package stages
passed. The required outer `npm run check` then failed three JavaScript cases
(4,362 passed, three skipped): 10,000-layer traversal exceeded 15 seconds,
live-answer HTTP waiting timed out, and Lantern's control lacked its third
output. All three entire files subsequently passed sequentially, 165/165,
with identical source, assertions and bounds. The failed aggregate is retained
and is not relabeled green; the sequential result does not establish the exact
cause of the concurrent failures. Final `npm run build` passed, as did the
remaining secret-boundary 2/2, Python 99, Ladybug and PRD-readability chapters.
The previous browser and telemetry proof stays attributed to `cc73f9cf`;
this follow-up changes only Rust plan ingress and its tests. Current hosted CI
must pass before merge.


## Final review repairs

The follow-up review retained the same product meaning and subscription routing.
Its seven executable boundaries map to these checkpoints; none requires paid
inference or changes a permission default.

| Changed seam | Production checkpoint and deterministic proof |
| --- | --- |
| Preparation versus fresh model-family route | A different orchestrator refuses the stale preparation before provider admission, clears prepared identity, records a coherent fresh-route failure and permits preparation again. `changed_orchestrator_refuses_stale_preparation_before_admission` uses real graph/Product storage and the execution service. |
| Durable creation-request upgrade replay | A reopened app replays an authentic old three-field selection to the same thread; changed task text, subscription constraints or extra selection fields conflict. Extended `subscription_authority_refuses_family_change_between_validation_and_creation` API/storage journey. |
| Host role ingress | Real HTTP lease admission rejects unpaired UTF-16 before acquiring access. Valid supplementary characters at 80/240 scalar limits survive real admitted-plan normalization. Harness-host rejection and producer-contract journeys. |
| Family recovery destination | An unavailable/incompatible orchestrator with a connected provider opens Model Families; a disconnected provider retains Providers. Picker model tests and actual recovery-button click journeys. |
| Family editor role lengths | 80/240 supplementary scalar values save unchanged; 81/241 fail without saving. Existing editor save/reopen journey, with obsolete UTF-16 maxlength restrictions removed. |
| Compiled input full capture | Trusted occurrence capture uses the actual inspector overflow. A long accepted authored input produces ordered screenshots including its lower footer, restores scroll position and retains modal/stale/forged/read-only guards. Node-detail runtime tests plus `proveArtifactReview` in `test:eval-web`. |
| Actor scroll authority | Hidden or fitting details offer no scroll; boundary refusals dispatch no input. The real browser journey resizes the same accepted content to overflow and checks trusted wheel movement in both directions, top/bottom refusal and working/settled Current correlation. `proveActorScroll` through `test:eval-web`. |

The social-preview capture is regenerated for the changed renderer inventory.
The unchanged follow-up annotation renderer retains its earlier source-bound
receipt. Earlier review receipts and failed commands remain historical; the
final repair review and gate outcomes are recorded separately in the PR.


Adversarial reviewer `/root/repair_authority_review` found no concrete blockers
in the [20-file final repair scope](merge-subscription-repair-review.json),
SHA-256 `df6f8d78492533dbe5206bd657ae5397e04836666b9ce02e14b31975607a8578`.
The reviewer checked authority, persistence, Unicode, UX and proof mappings,
including the stronger scroll coverage replacing the old visibility premise.
Both reviewer and primary agent visually inspected the actual last compiled
input tile and saw the authored footer pixels. That tile came from a partial
browser run whose later wrapper failure is preserved; it does not certify full
browser completion. Full/heavy gates were still pending at the review; source
changes invalidate this assertion.


At the final repair commit, the build and focused five-file JavaScript suite
passed (261 tests), as did the route-change regression, all 447 app-server unit
tests, 50 export contracts and all 10 model-catalog API journeys. The required
`npm run check` invocation stopped in unchanged `project_environment_flow`:
a staged Git file was observed as zero tracked changes rather than one. That
aggregate remains failed; the exact cause is not established. The native
workspace and remaining deterministic chapters run separately, and full Eval
browser completion and hosted CI remain required before merge. Earlier capture
fixture CSS errors, its later observation-wrapper failure and the obsolete
short-scroll availability assertion are retained as failed attempts in the
private ledger. No production bounds or assertions were weakened to pass them.


The final proof-only correction also removes the same obsolete short-scroll
assumption from the working-Current fixture. Its separate actual scrolling
journey passed in both native-input and authored-input modes. The valid Unicode
fixture constructs immutable routes after hosted TypeScript checking caught an
invalid assignment to a readonly property; host `tsc --noEmit` then passed.
Earlier CI/workspace-check failures remain failures. A later browser attempt
passed native-input Current and both scrolling modes, then failed authored
navigation while reporting temporarily unavailable visual assets during a
parallel generated-package rebuild. No causal claim or production fix is made
from that failure; a post-build browser run remains required.


## Downstream custom-family recovery

The final review found a second consumer of the recovery action: the Settings
default-family presentation still inferred its destination from optional
`providerLabel` metadata. A disconnected custom default has no managed recovery
row, so it incorrectly offered Model Families. The presentation now branches on
the explicit `family-settings` action; provider recovery derives its accessible
name from the actual provider label, then stable ID. Refresh recovery is unchanged.

PROV-008 and the existing reconnect/family-edit promise apply. The changed seams
are the default-recovery presentation, its Providers-tab activation/focus and the
social-preview renderer inventory. The existing editor/save/reopen/refresh journey
now disconnects its custom default and checks the visible button, accessible
reconnect name, actual Providers-tab click/focus and retained family. The test
failed with “Open Model Families” before the fix (447 ms), then the four related
files passed all 81 tests. This extends a distinct failure boundary without new
fixture duplication, test deletion or weaker assertions. Required check/build
and regenerated preview evidence run again before committing this delta.

Adversarial reviewer `/root/repair_authority_review` found no blocker in the
[two-file delta and combined 21-file scope](merge-subscription-recovery-review.json).
The delta digest is
`08d13ec123777afac202f47b216c80d382c63319c7dba44469d15025bf64c2c1`;
the combined digest is
`af96ec174f34de1771079b596f7174a41494b30f5e722f09832cdcba1fb1e356`.
Full gates and hosted CI were pending at review; earlier source receipts and
passing CI remain historical at `212b1d1e`. Scoped changes invalidate the assertion.


The downstream-recovery source subsequently passed the complete required
`npm run check` invocation, including 447 app-server unit tests, 50 export
contracts, 10 catalog API journeys, native/crash/Clippy, root/workspace types,
4,366 JavaScript tests (three existing skips), secret boundary 2/2, Python 99,
Ladybug receipts and PRD readability. `npm run build` passed sequentially after
that check. The regenerated preview images match the already inspected PNG
bytes and bind the changed renderer inventory. New browser/hosted CI outcomes
remain separate; earlier failed commands retain their historical attribution.
