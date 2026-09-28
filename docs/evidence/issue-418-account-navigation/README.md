# Issue 418: Persistent sidebar and Account reachability

The current product decision keeps the existing sidebar visible at every viewport width. At widths up to 760px it starts as a collapsed icon rail; the existing toggle expands that same sidebar in document flow, reducing the graph canvas and composer width. An explicit expansion remains usable until the viewport leaves and re-enters the narrow breakpoint. Account and Settings remain footer controls: icons in the collapsed rail and labels in the expanded sidebar. There is no dropdown, overlay drawer, or duplicate navigation controller.

## Current deterministic checkpoints

- `test/sidebar.test.mjs` checks narrow initialization, accessible toggle state, explicit narrow expansion persistence, breakpoint re-entry behavior, in-flow sidebar markup, and parent-sized composer layout.
- `test/graph-viewport-resize.test.mjs` exercises the production graph resize observer: an automatic-fit camera refits after the stage changes size, while manual camera state and active gestures are preserved.
- `test/desktop-account-ui.test.mjs` preserves signed-out, signing-in, signed-in, onboarding, and desktop account guard behavior through the single footer Account control.
- `test/settings-navigation.test.mjs` covers Settings panel selection and return focus to the sidebar toggle.
- The replaced `test/shell-navigation.test.mjs` covered dropdown disclosure, dismissal, and duplicate Account-controller wiring. Those boundaries no longer exist in the decided interface. Their replacement boundaries are persistent rail state and keyboard toggle (`test/sidebar.test.mjs`), graph/canvas reflow (`test/graph-viewport-resize.test.mjs`), and the retained single-control account and Settings behavior (`test/desktop-account-ui.test.mjs`, `test/settings-navigation.test.mjs`).

The rendered capture entry point is `npm run evidence:provider-ux -- --output-dir <absolute-output-directory> --scene=<scene>`. It uses the production renderer with local fake product/account APIs and no live Auth0 or paid inference. Sidebar scenes audit real saved graph nodes and canvas bounds, composer viewport bounds, and document scroll width. The focused `sidebar-thread-journey` records the actual collapse → expand → collapse interaction at 620px; the remaining scenes cover collapsed/expanded saved graph, new-thread composer, light appearance, 375px, 760px/761px, and 1280px. These captures are implementation evidence, not user visual acceptance.

The repair-round-1 capture passed on macOS Chrome. Its pre-capture receipt is `/Users/vishal/.codex/worker-pilot/evidence/factory-418-r1-pre-capture.json`: HEAD `64526be55ebb31066d61ac014946e097b9b4a825`, workspace SHA-256 `6a4577225c0e8a8f8f19a2b99e3249a32facf9f87fee8fac4b166eb4420aa651`, with per-file SHA-256 for all nine changed/untracked files. Rerunning the receipt after capture produced a byte-identical JSON file. The command was `PATH=/Users/vishal/.nvm/versions/node/v22.23.2/bin:$PATH CARGO_TARGET_DIR=/Volumes/2T-SSD/worktrees/factory-418/target npm run evidence:provider-ux -- --output-dir /Users/vishal/.codex/worker-pilot/evidence/factory-418-provider-ux-r1`. All eight video chapters and all 25 variants passed their DOM and interaction audits. The two Eval screenshots visually show the app workspace with no extra header row; their manifest SHA-256 values are `bb353d4567f6ae8cce10bf0fc0dc058dc874b5adef6d17430648c05043cbd43e` (620px) and `af4b6bf6c0ea1cd9478ac626d8c5e386abe91aebccdc468206e46b24a9eff79e` (collapsed 1280px). Full capture log: `/Users/vishal/.codex/worker-pilot/evidence/factory-418-provider-ux-r1-attempt5.log`; screenshot hashes and video metadata are in its external `manifest.json`.

### Reproducible source receipt

From the dirty worktree, before staging, enumerate `git diff --name-only` plus `git ls-files --others --exclude-standard`, sort and de-duplicate the paths, and compute each existing file’s SHA-256. Record deleted paths separately (do not attempt to read them); the aggregate covers only extant changed or untracked source files. The aggregate is SHA-256 over the ASCII `HEAD` commit followed by LF, then each UTF-8 relative path, NUL, raw file bytes, NUL, in sorted path order. Generate canonical JSON with this recipe and save it before capture/check; rerun it afterward and byte-compare the receipts:

```python
import hashlib, json, subprocess
from pathlib import Path
root = Path.cwd()
head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
tracked = subprocess.check_output(["git", "diff", "--name-only"], cwd=root, text=True).splitlines()
untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard"], cwd=root, text=True).splitlines()
paths = sorted(set(tracked + untracked))
aggregate = hashlib.sha256(head.encode("ascii") + b"\n")
files, deleted = [], []
for name in paths:
    path = root / name
    if not path.exists():
        deleted.append(name)
        continue
    data = path.read_bytes()
    files.append({"path": name, "sha256": hashlib.sha256(data).hexdigest()})
    aggregate.update(name.encode("utf-8") + b"\0" + data + b"\0")
print(json.dumps({"head": head, "workspaceSha256": aggregate.hexdigest(), "files": files, "deletedPaths": deleted}, indent=2) + "\n")
```
Run with Node 22.23.2 in the environment. If only evidence documentation changes afterward, list it as a docs-only delta and retain the earlier source receipt without claiming a full-tree match.

The first capture failure history is retained in `/Users/vishal/.codex/worker-pilot/evidence/factory-418-provider-ux.log` and `factory-418-provider-ux-attempt3.log` through `attempt7.log`:

- The initial provider-UX capture stopped because its onboarding frame was only 7,077 bytes. The capture prerequisites were then completed with `npm run prepare:renderer` and `npm run build:packages`; do not treat that undersized frame as evidence.
- Attempts 3 and 4 timed out waiting for the optional Account controls. This was a fixture-readiness race: the runner needed to wait for either the optional onboarding step or the footer, continue without an account, then wait for the Account controls to render.
- Attempt 5 timed out returning from Settings because the capture wait predicate was inverted. The predicate was corrected and the focused Settings interaction then completed.
- Attempt 6’s Account audit failed because the production onboarding completion revealed only the footer Account control, leaving the disclosure item hidden. The production controller was fixed to reveal/hide both controls together; tests cover that shared lifecycle.
- Attempt 7 passed the navigation journey, but later screenshot inspection found the Navigation trigger overlapped the saved-thread Environment panel. The layout was adjusted to reserve a title row only when the disclosure is enabled; subsequent capture also corrected the 761px case to remain expanded.

These attempts are historical and superseded by the repair-round capture only when its source receipt and result are recorded below.

Repair-round capture attempts are also preserved separately. Attempt 1’s expected “Relayer Eval” text was not stable at the runner’s ready checkpoint; the audit was changed to test the actual disabled disclosure and zero padding. Attempt 2 showed `bodyMode=false` and `mainPaddingTop=44px`: the inline Eval stub had not taken effect before production state initialized, so it moved to the first-loaded external fixture module. Attempt 3 passed its layout audit but the screenshot still showed account onboarding because the runner observed the app shell before the account controller rendered. The fixture now waits for the optional step or footer, continues without an account, and waits for both onboarding dismissal and the footer control before capture. Attempt 4 passed with the prior account-state race; attempt 5 includes the completed wait and captured the workspace. Logs are `/Users/vishal/.codex/worker-pilot/evidence/factory-418-provider-ux-r1.log` and `factory-418-provider-ux-r1-attempt2.log` through `attempt5.log`.

The full `npm run check` first reported one unrelated timing-sensitive failure in `test/graph-operation-recorder.test.mjs`: under parallel load, its 10ms “still waiting” assertion observed the in-flight export settle first. The exact test passed in isolation (1 passed, 9 skipped), confirming a scheduling-sensitive failure. One unchanged full-check retry passed. Vitest reported 173 passed files, 1 skipped file, 2,273 passed tests, and 3 skipped tests; the Codex secret-boundary suite passed 2 tests, Python passed 29, and the receipt/readability checks passed. `npm run build` also passed. The full logs are `/Users/vishal/.codex/worker-pilot/evidence/factory-418-r1-check.log`, `factory-418-r1-check-retry.log`, and `factory-418-r1-build.log`. Compiler output contains only the existing `relayer-graph-server` dead-code warnings.

The pre-check receipt is `/Users/vishal/.codex/worker-pilot/evidence/factory-418-r1-pre-check.json`, workspace SHA-256 `b778d2d9ce361d4e073c51b002d2226c4d7e0f403b6e8a0fddef48deacfded4c` over nine files. The post-check receipt was byte-identical. Capture-to-check per-file comparison found one docs-only change: this README was updated with the successful capture history and result; the other eight file hashes match the pre-capture receipt. This final gate summary is another README-only delta after the pre-check receipt.

### Review history

The two round-one reports, `/Users/vishal/.codex/worker-pilot/factory-418-round1-standards.md` and `factory-418-round1-spec.md`, reviewed commit `64526be55ebb31066d61ac014946e097b9b4a825` and returned changes requested. Their verdicts apply only to that source and are invalidated by repair-round-1 changes. The confirmed findings were same-element Account click replay, empty reserved header space in Eval, and missing earlier capture-failure history. This section preserves the original reports as historical evidence; fresh review is required for the repair commit.

## Required repository gates

After the digest-bound capture, `test/provider-electron-evidence.test.mjs` was updated to expect the new 10 screenshot variants, and `desktop/shared/telemetry-module-inventory.mjs` was updated to include the new renderer module. Their focused tests passed (5/5). These two inventory/test files and this README are the only post-capture deltas; the renderer and capture-script bytes remain unchanged.

`npm run check` passed with Node 22.23.2, `CARGO_TARGET_DIR=/Volumes/2T-SSD/worktrees/factory-418/target`, `CARGO_BUILD_JOBS=2`, and `RUST_TEST_THREADS=2`. It includes Cargo formatting/clippy/tests, crash-reconciliation tests, native package builds, TypeScript/workspace checks, Vitest, the Codex secret-boundary tests, 29 Python tests, Ladybug receipt lint, and PRD readability. Vitest reported 173 passed files, 1 skipped file, 2,272 passed tests, and 3 skipped tests. `npm run build` passed with the same Node and private Cargo target settings. The only compiler diagnostics were the repository’s existing Rust dead-code warnings in `relayer-graph-server`. Full logs are `/Users/vishal/.codex/worker-pilot/evidence/factory-418-check-final.log` and `/Users/vishal/.codex/worker-pilot/evidence/factory-418-build.log`; the first check attempt’s two exact-inventory failures and their repairs are preserved in `/Users/vishal/.codex/worker-pilot/evidence/factory-418-check.log` and `/Users/vishal/.codex/worker-pilot/evidence/factory-418-inventory-focused.log`.

The pre-README gate source was HEAD `61ce7b0cc50ee819eb54568cb8fc7165bf6c1e01`, workspace SHA-256 `e98b3cf1123ae3d645d92ae80f9a1e458be65d425f88cd319ed5fcdf3b997b7e` over all 17 changed/untracked files. This README update is evidence-only; it does not change executable code or tests.

## Sidebar replacement evidence

The current persistent-sidebar capture is stored under `/Users/vishal/.codex/worker-pilot/evidence/factory-418-sidebar/final-v5/`. It ran 22 sidebar scenes individually against one frozen source receipt (workspace SHA-256 `88d97ddfcb712875d1ba7ebd09b1c5b48352640121875dced3f2275870836b91`); pre-capture and post-capture receipt JSON files are byte-identical. Coverage includes populated saved graphs and new-thread composers, collapsed and expanded rails, 375px, 421px, 450px, 480px, 483px open scope/permission/model menus, 620px light/dark, 760px/761px, and 1280px. The 620px collapse → expand → collapse recording has 54 production-renderer frames, lasts 9 seconds, and has SHA-256 `9edb9019772f011e59b0c39af4d8393c1b88b80d615cd18266f67197e9db3fa4`. Per-image hashes and geometry audits are in `/Users/vishal/.codex/worker-pilot/evidence/factory-418-sidebar/final-v5/capture-manifest.json`. These captures use deterministic local product/account fixtures, not live Auth0 or paid inference, and do not claim user visual acceptance. At 375px expanded, the 210px sidebar leaves a narrow graph area where content may be panned at the existing minimum zoom; page and controls remain within the viewport.

The earlier `final-v4` portfolio used source SHA-256 `82983657bf2b4c49ffcec08052591b7fed7615721f53754a4d5dba4df37a4a3f` and is superseded because later changes repaired provider-flow fixture isolation, stacked footer labels at the 761–980px range, and corrected the interaction-video screenshot frame metadata. Those final-source changes were followed by a four-test pass of `test/provider-electron-evidence.test.mjs`, including the full provider flow and the 960px account-footer state. The first final-v5 scene ended with a Chrome profile-directory `ENOTEMPTY` cleanup race; one unchanged retry passed. Its failed and retry logs are preserved under `final-v5/logs/`. A previous full `npm run check` had reached Vitest with one failure: the generic provider-flow capture timed out waiting for the optional account step after the sidebar fixture globally signed in. This failure led to restricting signed-in fixture recovery to `sidebar-*` scenes; generic provider scenes retain their signed-out start. The failed full-check log remains preserved in `/Users/vishal/.codex/worker-pilot/evidence/factory-418-sidebar/final-v4/npm-check.log`; do not report it as passing. Final gate results are recorded against the exact commit in PR #477.

The earlier `final-v3` capture used workspace SHA-256 `76426721d313bf35a751787eff2b3628dd74c95c7e808971c1a816e3bb42b25d` and covered 12 scenes. It remains preserved as superseded historical evidence; its receipt does not bind the final viewport-menu correction. The first expanded-scene attempt had a Chrome profile-directory `ENOTEMPTY` cleanup race and an unchanged retry passed. An earlier full-check attempt was stopped after the 421px responsive review superseded its source; its partial log is preserved separately and is not a passing result for the final source. Final gate results are recorded against the exact commit in PR #477.


### Final verification history

The first final-v5 full check failed the existing recorder timing assertion: expected `waiting`, observed `exported`. The isolated recorder suite passed 10/10 tests. One unchanged full retry passed all 2,274 Vitest tests (174 files), the secret-boundary suite, 29 Python tests, and Ladybug checks, then failed PRD readability on two sentences. The sentences were split without changing product meaning; standalone readability then passed. Logs are `final-v5/npm-check.log`, `final-v5/graph-operation-isolated.log`, and `final-v5/npm-check-retry1.log` under the external evidence directory. Neither failed full command is a passing full-check result. The final capture remains applicable to unchanged executable files; only PRD wording and this evidence ledger changed afterward. Final source receipts and check/build results are recorded separately under `final-v5/astra-final-*` and in PR #477.


## Collapsed sidebar alignment correction

The user requested a centered plus inside the collapsed New Thread button, then aligned the sidebar logo to that same centerline. The changed product seam is collapsed sidebar CSS: center its title logo, remove layout space from the hidden shortcut, remove gaps and horizontal padding, and center the icon in both resting and keyboard-focused states. Expanded labels and shortcuts retain their layout. This refines ACC-008 without changing navigation or graph behavior.

The production-renderer capture runner measures the plus span center against the button center before and after keyboard focus, with a half-pixel tolerance. It also checks the sidebar logo against the same horizontal centerline. Collapsed 375px and 620px captures, light appearance, and the collapse/expand/collapse recording exercise this checkpoint. An expanded capture protects the existing label/shortcut layout. The measured audit is included in the existing rendered-evidence gate; no duplicate CSS-text unit test is added. The external evidence folder is `/Users/vishal/.codex/worker-pilot/evidence/factory-418-alignment/`. Exact source receipts, capture results, final required check/build results, and independent review assertions are recorded there and in PR #477. Earlier reviews apply only to their recorded commits.

## Review follow-up checkpoints

Automatic graph fitting defers a resize while a pointer gesture is active, then
flushes once on release or cancellation. Manual cameras and disposed workspaces
never consume that pending resize as an automatic fit. The in-process viewport
test covers these boundaries; the production-renderer journey resizes during a
real node press and checks both release and cancellation before recording.

Focused main-scene captures copy from `frames/`; variant captures use `variants/`.
Sidebar-only capture manifests list only newly rendered sidebar variants and no
omitted provider video. The process-bound evidence test exercises a focused
onboarding capture, then reuses its output directory with stale sentinel files
for a sidebar-only run and verifies every declared artifact hash. These checks
cover capture provenance separately from product layout.

## Native minimum and remaining-pane review repair

Five later findings invalidate earlier PASS assertions as merge clearance. The
native window still had a 960px minimum, Settings could overflow the expanded
375px layout, collapsed destination buttons lost their names, and capture checks
could accept absent graph nodes or invisible controls. Earlier receipts prove
only the scenarios they actually sampled.

Changed seams are the production BrowserWindow minimum, remaining-pane Settings
CSS, production sidebar destination names (including Eval), and evidence
presence/visibility/geometry predicates. ACC-008's approved narrow behavior
requires a reachable native width; its current minimum is 375px, with the existing
640px minimum height. No smaller-width or cross-platform visual claim is made.

`test/window-factory.test.mjs` checks the production constructor contract and
security options. `test/eval-sidebar-navigation.test.mjs` renders real destination
buttons with quoted names. `npm run test:desktop:narrow-sidebar` is the declared
native proof: it uses `createWindowFactory`, the production preload and renderer,
and native `setSize`, without device-metrics emulation. It records outer/content
sizes and actual viewport dimensions; exercises breakpoint entry, expansion,
preservation and re-entry; inspects the collapsed accessibility tree; and opens
all seven populated Settings panels through their real navigation controls at
375px expanded and 620px collapsed. It checks horizontal containment, scrolls
controls into view, changes theme, and exercises Back focus and the Account path.
It uses a temporary product profile and deterministic local account/updater and
provider fixtures, with no paid inference. Screenshots and result JSON are written
to `RELAYER_NARROW_EVIDENCE_DIR` (default `.relayer/evidence/issue-418-native`).

The Chrome capture portfolio separately covers saved graph identity, visible
controls and open menus. Native reachability does not replace that portfolio or
the canonical check/build, compiled Eval, web Eval, and desktop Stop gates.
Final results and independent source-bound assertions are recorded in PR #477;
this plan is not a proof claim.

The native portfolio also samples 375px collapsed, 483px expanded (just outside
the composer's compact threshold), 620px expanded, and 1280px expanded. Every
system/custom family card is selected and audited, including explicit Enabled,
Move, Copy/Edit/Delete controls. The custom family editor is opened and cancelled.
Native text fields/selects may scroll their values internally; their control boxes
must fit. The existing family carousel may scroll between cards; each selected
card must fit. At the 640px minimum height, workspace vertical scrolling is allowed,
and textarea, model selector and Send must each be reachable inside the viewport.

Run the actual-DOM negative proof with
`node scripts/capture-provider-ux-video.mjs --scene=sidebar-thread-collapsed --audit-mutations --output-dir <directory>`.
Its fresh `.mutations.json` must include passing baseline and restored-baseline
checks, plus rejection of missing/duplicate nodes, both vertical clipping
directions, hidden ancestors/toolbar/composer, and absent/invisible expected menus.
The same snapshot collector and predicate drive ordinary capture acceptance.

Iterative native attempts are preserved under the external
`factory-418-native/diagnostic-*` evidence folder. Earlier attempts caught the
real provider-card overflow, then runner defects (unsupported preload-option
introspection, a missing embedded variable, inactive carousel cards counted as
visible, stale test attributes, a nonexistent harness button selector, smooth
carousel settling, wide sidebar controls checked against the Settings pane, and
input value scroll widths mistaken for control overflow). They are not passing
proof. Native diagnostics 9 and 10 passed 56 sampled scenarios before further
editor coverage was added. The separate `chrome-inspection/` screenshots and
pointer transcript show actual native collapsed/expanded toggle activation at
375px on this Mac; this is a limited native hit-target observation, not a
cross-platform titlebar geometry claim. Final frozen-source results supersede
diagnostics only when their own receipts and inner scenario results pass.

The first frozen-source gate run (tree `6ff5f5f82cc942860cbf463b06a507dc4eacdd13`)
was stopped during `npm run check`, before final gate completion. A runner-lifecycle
defect let Electron exit on last-window close before async cleanup delivered its
failure exit code. The native runner now handles `window-all-closed` and owns its
final exit status. A deliberate wrong-minimum assertion is retained externally in
`factory-418-native/exit-status-proof/` to compare the old and repaired behavior.
The superseded check log remains under `factory-418-native/gates/`; only a fresh
frozen-source gate run can certify this repair.

## Composer and pending-approval narrow-layout repair

The next mapped repair adds vertical containment to the browser capture predicate
for the active composer and actual-DOM mutations that move it above and below the
viewport while its controls remain inside it. The native narrow-sidebar runner
scrolls each saved-thread and New Thread control into view and checks its visible
rectangle against the viewport and every clipping ancestor. This preserves
vertical workspace scrolling while rejecting controls that cannot be reached.

The approval dock now reflows against the remaining `.main-area` width. Its
header and queue controls stack, metadata becomes a single column, and all three
decision buttons stack and wrap. The deterministic native approval harness
checks a real pending three-request queue at 375px collapsed, 375px expanded,
and 620px expanded. It checks queue navigation, the three distinct decision
controls, two-axis viewport and dock containment, unchanged pending request IDs
across layout changes, and then continues the existing approval-authority flow.
That fixture uses a long temporary project path, a longer build command, and a
long review reason to exercise wrapping. It supplies a rejecting `openExternal`
stub because the native smoke runner must not open external browsers; draft IPC
is an in-memory local fixture. These test seams do not replace approval routing.
Screenshots and `approval-layout.json` are written to
`RELAYER_APPROVAL_EVIDENCE_DIR`; the existing `npm run test:desktop:approval`
entry point is the native checkpoint. This source update has not yet completed
the canonical check/build or final source-bound review; the focused results
below are separately identified and do not replace those gates.

Focused diagnostic attempts are preserved under
`/Users/vishal/.codex/worker-pilot/evidence/factory-418-approval-repair/`.
Attempts 1–9 exposed stale native-fixture setup (external-browser authority,
draft/share IPC, and account state), an `evaluate` typo, and the initial-load
focus timing boundary; each attempt has a separate log. No renderer focus call
is injected by the passing run: it invokes the production `threads.refreshState`
with a real pending request while the visible thread is active, then preserves
the focus assertion. The existing three-request pending reload and resolved
history reload remain in the journey. Automatic focus on a deep-linked pending
approval while the application shell is still hidden is not claimed by this
checkpoint. `focused-10` and `focused-12` passed the approval journey; focused-12
captures the decision group centered in the viewport so all three buttons and
the session qualifier are visible together. `focused-11` passed the updated
native sidebar run with 58 scenarios, including saved-thread and New Thread
composer reachability. These focused results are diagnostics, not the final
canonical check/build or source-bound review.


A subsequent native-titlebar review found that the collapsed toggle's old
`left:13px;top:9px` box overlapped part of macOS's traffic-light region. The prior
center-point clicks proved activation at those points only; they did not prove
clearance of the whole button. The collapsed toggle now sits below the top 40px
native inset, with matching sidebar header space. Expanded positioning is
unchanged. The native runner checks the complete toggle rectangle against the
reserved top-left 80x40 region in every collapsed/expanded shell scenario.
This CSS/native-check delta requires fresh source-bound gates and visual proof;
commit `55a963bf` evidence does not certify the final titlebar repair.

## Integration with main ac7657: Share header and toggle animation

Incoming Share controls exposed a previously unmeasured narrow header seam. Native diagnostics recorded the menu extending beyond620px and into the sidebar at375px expanded. The menu now anchors to the title-group right edge and caps its width to the remaining pane. The native shell scenario requires visible, positive, contained, non-overlapping header controls, audits both menu actions, and exercises Share title entry then Cancel at375/620px without publishing. Local IPC supplies pending-null and ready preflight; create throws if called. These checks extend ACC-008 containment across the incoming Share seam; they do not claim live share-service proof.

A native diagnostic also caught the whole toggle rotating into the reserved80×40 macOS region despite safe final coordinates. Rotation now belongs only to the18px SVG; the32×30 button hit box stays fixed at left13/top43 collapsed and left84/top9 expanded. Native checks sample active transform animations at0/25/50/75/100percent in addition to each resting shell checkpoint. Collapsed header padding78 preserves room beneath the button. Prior final-only clearance assertions do not certify this correction.

Diagnostic failures and fixes live under the external factory-418-ac7657-integration evidence directory. Required canonical check/build, compiled/web Eval, desktop Stop, native sidebar, capture mutation/visual gates, and incoming theme CSP/visual-node-details integration proof must bind the final frozen source. Prior two canonical environment-test failures remain preserved; reduced local concurrency did not establish a pass or a sole cause.


## Integration with main 17b50d95

The approval repair was preserved as tree `11e23dbf086f8e1aacd20a16f8ffa4a3bdd39c5e` before integrating the current main branch. Its canonical check failed: 2,627 Vitest tests passed, 18 failed, and 3 were skipped. Failures included process/test/query time budgets, incomplete Eval execution, and a blank onboarding capture. Concurrent external CPU workloads were observed, but contention alone is not established as the cause. The full log remains at `/Users/vishal/.codex/worker-pilot/evidence/factory-418-approval-repair/final-gates/check.log`; later stages did not run.

Main adds authored default-node selection, persistent selection memory, and revised node-detail/annotation geometry. The workspace conflict preserves incoming preferred-node selection followed by the existing sidebar camera-restoration helper. The approved ACC-008 behavior remains intact. Renderer and native evidence must be refreshed for this combined source, including the NDT-003/004 node-input-actions, interaction-context, and project-new-thread desktop entry points. Their existing build prerequisite may be shared across the serialized proof run. The next canonical check uses two Vitest workers through the supported environment setting, with unchanged assertions and timeouts. Final results are recorded externally and in the PR; this paragraph is a plan and failure record, not a pass claim.

The node-input-actions native runner now asserts the real window factory minimum of
375×640 and tests its 720px layout without changing that minimum. At 720px it
checks the collapsed 58px rail and its in-rail accessible toggle, requires settled
Environment content to remain visible, expands the same sidebar in normal flow,
then collapses it again before restoring the desktop geometry checkpoint. This
replaces the obsolete 640px temporary minimum and the claim that the toggle is
unavailable at narrow widths. It is a targeted native checkpoint; it does not
replace the combined-source canonical gates.


The subsequent integration includes completion-client parity and locked release-tool dependencies from main `92a89d6a`. The web Eval fixture previously activated the first node after NDT-003 had already opened that default, so the review adapter correctly rejected a no-op. Its checkpoint now activates a different enabled node and asserts the exact changed selection; the production review adapter remains unchanged. Prior native project-draft restart failure, one passing unchanged retry, the Mac capture wrapper's 120-second timeout (direct capture passed in 153.44 seconds), and Linux's missing `zip` prerequisite remain distinct external receipts. The derived Linux image adds distro `zip`/`unzip` for the new freshness test; it does not change tests or source. New final-source results are pending.

## Populated scope-menu viewport repair

Later review found that the sparse scope-menu capture did not establish reachability
with existing projects. At commit `695b6fa9`, a production-renderer reproduction
created twelve temporary projects through the authenticated product API. At
375×640 with the sidebar expanded, the menu measured 149px wide and 2,031px tall,
with its top at −1,463px. Its vertical overflow was `visible`, leaving early
choices outside the non-scrolling document. The first run used system Node 25;
the unchanged reproduction also failed under supported Node 22.23.2. Both inner
exit codes were 1. The outer wrapper's status capture is not a passing result.
Logs and screenshots are retained under
`/Volumes/2T-SSD/evidence/temp/factory-418-scope-menu/`.

The changed production seams are scope-popup height, user scrolling, and text
wrapping at the existing ≤760px breakpoint. The cap reserves the existing 72px
bottom offset and 44px above the popup. Only scope-menu rules change; project
selection, permission menus, model pickers, and backend authority remain intact.

ACC-008's no-clipped-controls promise maps to the populated scenario in
`scripts/test-desktop-narrow-sidebar.mjs`, reached by the existing declared
`npm run test:desktop:narrow-sidebar` entry point. Its real product fixture adds
long-name and long-path projects after the sparse fixture checkpoints. It checks
exact option IDs and the two non-project choices, four-edge popup containment,
horizontal text containment, actual wheel scrolling, and keyboard traversal of
every option within its effective clipping ancestors. Wheel input is browser-routed
through CDP in the production Electron window, with trusted event receipts and
observed scrolling; it does not certify OS or physical-device wheel delivery. First and last option
screenshots are checked at capture time. Selecting a late project must preserve
its exact stable ID and the draft, close the menu, and create no thread before
Send. Keyboard selection of No folder must preserve the draft and remain
standalone. These checks observe existing scope behavior without adding a new
selection policy or claiming filesystem-dialog or Git-worktree proof.

Cap-removal and disabled-user-scrolling probes protect different failure
boundaries: a menu must fit the viewport, and its off-screen contents must be
reachable through user input. Programmatic `scrollIntoView` alone is insufficient
for the latter. The earlier sparse capture and unrelated native scenarios remain
useful for their own boundaries, but do not certify this populated case. Fresh
source-bound native evidence, applicable deterministic checks, canonical
check/build, and independent review are required before this repair is declared
verified. Results belong to their recorded source snapshots; this section records
the mapping and failed baseline, not a passing repair claim.

## Follow-up 563/564: turn picker and populated sidebar

After PR 477 was merged as `f764dd44`, follow-up review reported two additional
ACC-008 reachability failures. The recorded production-renderer red for the
turn picker was a 320px popup extending from x=42 to x=362 while the remaining
workspace began at x=210 in a 375px expanded-sidebar window. The populated
sidebar red at 960×640 recorded `overflow-y: visible`, scrollHeight 631 versus
clientHeight 510, and a final project row below the viewport (bottom y=707).
These are separate failure boundaries: popup geometry and readable turn
metadata in the narrow workspace, and navigation scrolling while keeping the
footer controls fixed. The prior green scope-menu captures and the 59 existing
native scenarios do not cover either boundary. Their receipts remain under
`/Volumes/2T-SSD/evidence/temp/factory-418-navigation-repair/`; neither an
earlier green probe of the first CSS candidate nor the pre-follow-up canonical
proof certifies the current source.

The replacement mapping stays in the existing
`scripts/test-desktop-narrow-sidebar.mjs` production Electron runner and its
declared `npm run test:desktop:narrow-sidebar` entry point. The turn-picker
checkpoint uses real accepted turns, an active Stop lifecycle, and two
API-created annotations so sequence, bounded prompt preview, status, and comment
metadata are present together. It checks the 375px expanded and collapsed
states plus the 483px expanded boundary against the workspace and clipping
ancestors; it also exercises Escape/focus restoration, keyboard turn selection,
draft retention, exact interaction identity, and unchanged server history. The
populated navigation checkpoint uses real project and chat IDs at 960×640,
checks the scrolling region and fixed Account/Settings footer, reaches late
project actions by keyboard and wheel input, and verifies project scope without
creating a thread. It covers Settings Back and the first/last narrow Settings
tabs at 375px, with 375px collapsed/expanded and 1280px companion layout checks.
These checkpoints observe existing navigation and selection authority; they do
not certify OS-level wheel delivery, filesystem dialogs, or live provider
execution.

The baseline reproductions are confirmed failures. The follow-up native
checkpoint and applicable deterministic checks have not yet run on the final
combined source. No pass is claimed here; fresh source-bound receipts, the
applicable canonical check/build, and independent review remain required.

Native3 and its single unchanged retry native4 were interrupted before the new
checkpoints: macOS occluded the window, Page Visibility became hidden, and
animation frames stopped. Both failures are preserved in the external ledger.
The follow-up runner keeps the production window factory, preload, security,
minimum size, and real viewport, then disables background throttling for the
test. Electron also changes Page Visibility under that override. The result
records this foreground-like scheduling, and native input requires window and
web-content focus. Screenshots prove rendered content; this test does not prove
default occlusion, background refresh, physical OS visibility, or hardware input.
Bounded frame, input, visibility, and clipping checks remain required.

Native7 passed its 65 mapped scenarios on tree `14565737`, but independent
screenshot review found a separate occlusion gap at 483px: the background layer
comment badge (stacking level 6) appeared above the open turn picker inside the
banner (stacking level 3). Within the app shell, the banner now rises to
level 7 only while history is open; public-share pages have no app shell and
retain their existing stacking. The existing annotated fixture checks the exact overlap with
`elementFromPoint`, sends native pointer input there, and requires selection of
Turn 2. Once history closes, the layer-comment badge must again be visible,
enabled, and own its hit target. The previous geometry pass does not certify
this stacking correction; fresh native and canonical evidence is required.
