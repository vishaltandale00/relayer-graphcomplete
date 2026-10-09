# Composer family roster correction

Authority: the user's explicit decision to show the other family models and their
roles, recorded in PRD FAM-001. This extends the product producer at commit
`6bd48c58cac50b0be2aa9a1d36c9db82916b0be5`; the companion harness consumer is
not composed into this workspace.

## Changed seams and checkpoints

| Promise or boundary | Production seam | Deterministic observation |
| --- | --- | --- |
| Every selected-family member appears in family order with provider and all roles; unassigned members say so | `familyMembersMarkup` in the real composer picker | New and ongoing `default-family-recovery` DOM scenarios using the catalog fixture |
| Availability annotates the roster rather than removing specialists; blocked orchestrator recovery retains the roster | Existing `availableFamilyMembers` plus setup-panel rendering | The same multi-step scenarios change provider availability, harness compatibility, root roles and root availability |
| Compact roster buttons dismiss without changing root authority; family selection preserves pinned harness and focus behavior | Existing family-change handler; member dismissal handler | Click every member, verify closure and trigger focus without a selection callback; dismiss a blocked root without making execution ready; then switch families and verify the designated root |
| Labels and role descriptions are inert text | Existing HTML/text and attribute escaping | Malicious role label and quote-bearing description remain text with no image, script or event-handler node |
| Secondary renderer receipt still binds the served source | Social-preview capture and receipt validator | Real Electron light/dark capture, cancellation and cleanup; exact renderer manifest test |

No test was deleted. The two roster scenarios protect distinct new-chat and
pinned ongoing-chat boundaries. Existing compatibility refusal remains unchanged.

## Required plan

Warm loop: the four picker/availability suites. Before handoff: refreshed
`evidence:share-preview`, receipt validation, PRD readability, `npm run check`,
`npm run build`, and deterministic `npm run test:eval-web`. No paid inference,
release, signing or publication is part of this correction.

## Actual results

- Focused picker/availability and social receipt: **76/76 PASS**, five files,
  4.68 seconds on the compact, dismissible-row snapshot. PRD readability PASS.
- TypeScript distribution compilation PASS.
- Real Electron preview: all three Codex subscription members visible in compact
  rows; one `orchestrator`, two `No role assigned`. Clicking Astra closed the
  picker and returned focus to the unchanged family trigger. No inference sent.
  Local screenshot: `.relayer/evidence/family-roster-picker/desktop.png`.
- `evidence:share-preview`: PASS, distinct 1200×630 light/dark captures,
  cancellation and window/server cleanup. Both images visually inspected.
  Refreshed tracked receipt validates renderer digest
  `23574eb53c1286d507198bc3e28deca46e7caa65966806ba10e4acaf28d1e0f9`.
  An initial receipt test failed because the generated receipt had not yet been
  copied from the runner output to the tracked evidence directory; copying the
  actual capture output repaired that gap, and the validator then passed.
- `test:eval-web` on the initial roster snapshot, before the final compact-row
  revision: **FAIL**, shared-dashboard completion timed out with no turns.
  Startup cleanup, real lifecycle/export/reopen/read-only authority, host
  tabs/trace/restart, and production Settings chapters individually PASS.
  Later chapters were unreached. This repeats the producer workspace's existing
  result; it does not prove integrated V2 consumer execution.
- `npm run build`: **PASS** after the final compact-row revision.
- `npm run check`: **FAIL** (exit 1). Formatting, Clippy, Rust workspace tests,
  crash reconciliation, native/package builds, TypeScript and workspace checks
  PASS after dependency restoration. Vitest: 290 files / 3,729 tests PASS;
  10 files / 27 tests FAIL; one file / three tests skipped, 246.44 seconds.
  Nine suites reproduce the producer portfolio's 26 integration failures.
  The additional capture-integrity test fails in Node 25.9.0's network permission
  boundary: exact-port IPv4 fetch returns `ERR_ACCESS_DENIED`. It remains
  unresolved; no claim is made that all failures disappear after composition.
  Full check initially stopped after 361 Rust app tests passed and three failed
  because the borrowed root dependency directory lacked graph-client's nested
  parse5 8 declarations. Restoring the matching workspace dependency directories
  fixed that build boundary, and all Rust tests passed on the next run. An overlapping
  focused import retry was interrupted and makes no whole-run claim.
- Remaining check gates, run separately after Vitest failure: secret process
  boundary **2/2 PASS**; Python **68/68 PASS**; Ladybug qualification/native/contract
  receipt lints PASS; PRD readability PASS. Inner scenario results were inspected,
  rather than inferred from the final shell exit status.

## Source and review assertion

The prior compact-roster four-file binary Git diff (picker, CSS, PRD, roster test) had SHA-256
`028a913b7b3548143a497e4e810475f9f5e14de5c80fecd2594c5ecd82d41d2a`.
Refreshed social captures/receipt are bound separately above. Reviewer
`/root/roster_picker_review` independently confirmed this digest and reran the
roster suite: 30/30 PASS. Verdict: no actionable findings in compact roster
semantics, dismissal/focus, authority, escaping and checkpoint mapping; no tests removed. Native layout,
full-check and heavy-portfolio completion were outside its certification.
Earlier assertions were invalidated by the added checkpoints and the user's
compact-row/dismissal decision. Without a PR, this review is non-certifying.

## Family cycling follow-up

Authority: the user's explicit request for previous/next family buttons on hover,
recorded in FAM-001. Changed seams: shared family-header markup, family commit and
cycle handlers, recovery navigation, and hover/focus/touch CSS. The existing
compatible-family projection and designated-orchestrator resolver remain authoritative.

| Checkpoint | Production observation |
| --- | --- |
| Compatible families cycle in order and wrap; the roster and trigger update while the picker stays open | New and ongoing real-picker DOM sequences exercise both directions, exact root identity, roster replacement and pinned harness |
| No eligible alternative disables navigation; leaving blocked-family recovery requires an explicit click | Single-family and unavailable-family fixture cases; recovery into the only usable family |
| Re-rendered arrows retain keyboard focus; disabling both returns focus to the family selector | Assertions on the real document's active element after each handler |
| Arrows appear on header hover/focus and remain available without hover | Native desktop screenshot with pointer over Family; native-button focus and reviewed `hover:none` media rule. Touch hardware was not exercised |
| Secondary social receipt binds the final renderer | Fresh real Electron capture plus receipt validation |

Required follow-up plan: focused picker portfolio, PRD readability, build, real
desktop cycling/hover verification, the existing deterministic heavy
`evidence:share-preview` entry point and its manifest validator. The added seams
are explicitly mapped and adversarially reviewed. The earlier full-check and
Eval-web failures above remain limits; they are not passes for this new snapshot.
No native code, execution plan or runtime consumer changed in this follow-up.

Actual results on the cycling snapshot: **79/79 PASS**, five focused files in
1.84 seconds; PRD readability PASS; `npm run build` PASS; real Electron social
capture/cancellation/cleanup PASS. Light/dark PNG hashes remain identical to the
visually inspected captures above; the refreshed renderer digest is
`10b2ea1dffed9c36c6142515e7ce36883038987d33fe7b3c14e218c1f7b239fd`.

Native desktop verification passed both directions and forward/backward wrap,
retaining the open picker and updating the selected family. A copy named
`Preview family` was saved in the isolated preview profile to provide a second
family. The original family was restored as the current composer selection.
Screenshot: `.relayer/evidence/family-roster-picker/family-cycle.png`. No inference sent.

Historical cycling four-file binary diff SHA-256:
`613be4654b13af9557f4374a5506faae0740aefaabf5cd28cfa76e1981099c0d`,
on base `6bd48c58cac50b0be2aa9a1d36c9db82916b0be5`.
Reviewer `/root/roster_picker_review` independently confirmed this identity and
passed **33/33** roster/recovery tests. Verdict: no actionable findings in cycling,
compatibility, root/pinned-harness authority, focus and checkpoint mapping; no
tests deleted. Native appearance and whole-pipeline results remain separate.
This supersedes the previous source assertion and is non-certifying without a PR.

## Roster navigation and Mac swipe follow-up

Authority: the user's explicit request to place the arrows around the model/role
names in the lower box and support Mac swiping, recorded in FAM-001. Changed
seams: roster/navigation markup and CSS, shared family selection, delegated wheel
handling and gesture reset/disposal. The family header retains its selector.

| Checkpoint | Production observation |
| --- | --- |
| Arrows flank the lower roster rather than the Family header | Real picker DOM placement assertions and refreshed native desktop screenshot |
| Horizontal input accumulates and changes one compatible family per gesture, retaining root/harness authority and the open picker | New/ongoing picker WheelEvent sequences exercise threshold, momentum, reversal tails, idle reset and pixel/line/page normalization |
| Vertical scrolling, pinch/modifiers, the header, Advanced and closed picker do not select a family | Scoped real picker event sequences, including default-prevention assertions |
| Reopen/context changes reset gesture state; disposal removes its listener | Real picker lifecycle sequences and reviewed production reset/disposal seams |
| Existing roster dismissal, escaping, availability, recovery and focus promises survive | Retained roster/recovery and compatible-family portfolio; no tests deleted |
| Secondary social receipt binds the final renderer | Fresh real Electron capture and manifest validator |

Required plan: focused picker/availability/receipt portfolio, PRD readability,
build, native appearance/navigation check, deterministic heavy
`evidence:share-preview` capture and adversarial seam/mapping review. Actual:
**81/81 PASS**, five files in 2.24 seconds; PRD readability PASS;
`npm run build` PASS; Electron social capture/cancellation/cleanup PASS.
Renderer digest: `d9d3d366916a50b7fdb4fe21f5ff43b63b2ed496e28d64e775f02c826192cc76`.
Light/dark social image hashes remain identical to the previously inspected images.

Native desktop arrow placement and both click directions passed, retaining the
open picker. Original family selection was restored. Screenshot:
`.relayer/evidence/family-roster-picker/family-swipe.png`. The automated native
Mac horizontal scroll calls did not change the family; they are not swipe proof.
Physical two-finger trackpad behavior remains unverified. The 180 ms idle boundary
is a gesture heuristic; deterministic wheel handling passes but hardware momentum
and idle cadence need manual validation. No inference sent.

Current four-file binary diff SHA-256:
`86a3d5d104c4f52c0fa0b2d5b5118178711426e727d89342c4e7952a21fff51c`,
on base `6bd48c58cac50b0be2aa9a1d36c9db82916b0be5`.
Reviewer `/root/roster_picker_review` independently confirmed this identity and
passed **35/35** roster/recovery tests. Verdict: no actionable findings across
placement, cycling, root/harness authority, wheel scope/normalization, momentum,
lifecycle, escaping, dismissal and checkpoint mapping. Native trackpad behavior
remains unresolved as described above. This supersedes earlier source assertions
and is non-certifying without a PR. Earlier full-check and Eval-web failures
remain explicit limits; neither was rerun or claimed as passing this snapshot.

## Reversal and motion follow-up

Authority: the user reported unreliable back-and-forth scrolling and explicitly
requested natural animation. FAM-001 now permits meaningful immediate reversals,
partial-drag settling, directional slides and reduced-motion suppression.
Changed seams: wheel reversal state, gesture feedback/settle timer, transition
creation/cancellation, roster viewport and inert outgoing presentation.

| Checkpoint | Production observation |
| --- | --- |
| Meaningful reversal works without an idle gap, but same-direction momentum and tiny bounce tails do not skip families | Three-family new/ongoing real-picker wheel sequences failed before the fix (expected two changes, observed one), then passed |
| Partial movement follows input and settles; forward/back slides use corresponding directions | Production transform and Web Animations calls exercised by realistic picker interaction; 120 ms settle and 240 ms slide |
| Outgoing rows cannot act as a second picker or accessibility list; rapid navigation and lifecycle changes clean up motion | Inert/aria-hidden outgoing clone, finish removal, rapid cancellation and close/disposal assertions plus adversarial review |
| Reduced motion keeps selection functional without transforms/animation | The same interaction scenario with a reduced-motion document |
| Root identity, compatible families, pinned harness, recovery and other input boundaries survive | Retained focused picker/availability/refresh suite; no tests deleted |
| Secondary preview manifest binds current renderer | Refreshed Electron social capture and receipt validator |

Required plan: red/green reversal reproduction, focused deterministic portfolio,
PRD readability, build, native desktop appearance/navigation check, social capture
and adversarial review. Actual: reversal reproduction **2 failures before fix**;
picker/recovery **37/37 PASS**, broader four-file portfolio **80/80 PASS**;
final five-file portfolio including the refreshed receipt **81/81 PASS** in 1.37 s;
PRD readability PASS; build PASS; Electron social capture/cancellation/cleanup PASS.
The initial build used the environment's shared Cargo target; it completed before
a stop attempt (the processes no longer existed). A second build explicitly used
the already verified isolated target and passed. No cold dependency provisioning.

Native desktop settled appearance and forward/back arrow selection passed,
restoring the original family. Screenshot:
`.relayer/evidence/family-roster-picker/family-motion.png`. Automated Mac scroll
still produced no visible family change. Temporary targeted wheel diagnostics
confirmed its events reach the roster but total absolute deltaX and deltaY are
both zero. The diagnostic code was removed and the reviewed four-file digest
restored exactly before handoff. This tool cannot prove horizontal movement.
Physical trackpad cadence and natural
animation feel remain unverified; mocked animation calls and a settled screenshot
do not certify either. The 180 ms idle and 48 px movement thresholds remain
heuristics. No paid inference. Prior full-check/Eval integration limits remain.

Current four-file binary diff SHA-256:
`d9d1ccaa4bdecffb4099bb66cfb07f18423f4887721652b774805e577e658e74`,
base `6bd48c58cac50b0be2aa9a1d36c9db82916b0be5`.
Reviewer `/root/roster_picker_review` independently confirmed this identity and
ran **37/37 PASS**. Verdict: no actionable findings in reversal, motion lifecycle,
inert presentation, reduced motion, authority and checkpoint mapping. Native
gesture feel remains unresolved. This supersedes prior source assertions and is
non-certifying without a PR. Renderer digest:
`b86826d73c6e1e8f5d3561dab11c43cde91ea79cad96b4e5f57ccb36de30afb4`;
social light/dark image hashes remain identical to previously inspected captures.

## Cache provenance

Rust inputs match the product producer: 230 files, digest
`c8ad14a02fc815ad39d34fa7ca56373e1bdec4dbede81374a8ab18a957fb9bc0`.
Repository runtime-artifact creation and verification checked source identity,
macOS ARM64, rustc 1.98.0, debug package set and binary hashes before installation
into this workspace's isolated target. Product compilation outputs were cloned
to that isolated target for warm Cargo checks; Cargo revalidates current source.
The repository Ladybug verifier accepted the existing trusted artifact at
`/Volumes/2T-SSD/relayer-build-cache/model-family-ladybug`, binding Cargo.lock,
platform, rustc, lbug 0.18.0 and library SHA-256 `02a76a5ea8d1…`.
An initial invocation omitted the required platform argument and failed; the
corrected invocation passed. Cached outputs replace no tests.
