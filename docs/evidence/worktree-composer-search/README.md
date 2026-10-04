# Worktree composer search and Enter

Product authority: the October 1, 2026 user decision asks for a limited,
searchable branch list with Local checkout and origin/main always visible,
and creation followed by task startup on Enter without another selection.
PRD §3.4 records that decision. A missing committed local HEAD or uncached
origin/main is not fabricated or fetched. Twenty matching branches plus the
selected base and these two available pinned bases is the implementation limit.

## Changed seams and checkpoints

| Changed executable seam / boundary | Deterministic checkpoint |
| --- | --- |
| Base rendering and search: cap results, preserve local/origin-main/selected base, search beyond the initial cap | Production composer DOM in `test/worktree-renderer.test.mjs`; real Git branches in the desktop driver `boundedBranchSearchPinnedBases` |
| Menu replacement after New worktree/base/registered-checkout selection preserves useful keyboard focus | Same DOM fixture, including unknown-default focus on base and rejection of Send until a valid base |
| Enter uses existing Send, durable plan, creation, and thread admission without reselecting the created checkout | `worktree-renderer.test.mjs` binds the real composer key handler and `createFirstThread`, asserts created cwd in thread POST, and retries a rejected POST with the same plan/request; `scripts/test-desktop-worktrees.mjs`: native keyboard events; `enterCreatesAndStartsTask`, exact saved cwd and actual fixture harness cwd, accepted output |
| Creation failure/recovery preserves draft, same plan and exact checkout rather than duplicate mutation | Existing controller receipt tests; desktop lost-create-reply, draft reopen and Enter retry checkpoints |
| Branch options and focus styling; existing scroll footer stays outside registered list | Production DOM plus desktop screenshot and existing registered-checkout-scroll checkpoint |
| Driver and runner enforce independently reported additional scenarios | Worktree runner now requires all seventeen checkpoints; each flag follows its scenario's assertions |

No tests were deleted. The DOM fixture covers fast renderer behavior; the desktop
scenario covers native focus/key routing and actual startup/storage boundaries.
Existing controller and real-Git tests cover retained plans and filesystem
recovery independently of presentation. Permission, model, acceptance and
provider-native recursion contracts are unchanged.

## Required verification

Warm edit loop: `npx vitest run test/worktree-renderer.test.mjs
 test/worktree-controller.test.mjs` (subsecond). Real-Git lifecycle tests run
before handoff. The Enter/admission fixture runs in-process with mocked IPC/HTTP boundaries; actual accepted harness execution belongs to the heavy desktop driver. Full deterministic fallback: `npm run check`. Production build:
`npm run build`. Heavy desktop portfolio: `npm run test:desktop:worktrees`;
existing project/new-thread runner checks draft/navigation compatibility.
All use zero paid inference; no release-candidate proof is due.

## Actual runs

The original production DOM fixture failed after checkbox selection with focus
on the document instead of the prompt. After the fix, renderer and controller
checks passed thirteen scenarios. The expanded DOM fixture also verifies the
unknown-default boundary. Renderer/controller/real-Git run passed twenty
scenarios (36.19 seconds including real Git lifecycle setup). These early runs
are not certification of later edits.

This fresh checkout initially had no npm dependencies. `npm ci` installed the
lockfile dependencies. The shared local Cargo target was already warm. CI cache
rules were read before compilation; no external artifact restore or unverified
runtime receipt is claimed. Cargo rebuilds local packages for this checkout's
source. Cached dependencies never replace fresh tests.

Full check, build, desktop results and final independent review are recorded
below when they finish. Without a PR the adversarial review is non-certifying.

## Frozen source and observed desktop proof

Pre-main six-file change manifest: `pre-main-source-snapshot.json`, based on HEAD
`ebb1a1be3a805ca93482ccb958cce3881ef0136f`, digest
`5930c30254d38e25ebd15e6fdaf19d7073533afa63af8c5e65c5f9d709905866`.
The final warm controller/renderer run passed fourteen scenarios in 649ms.
The added Enter fixture proves admission and retry, deliberately stopping its
HTTP fixture during post-admission loading; it does not claim accepted output.

`npm run build` passed. The two native binaries were copied to a frozen private
runtime directory with before/after/copied SHA-256 equality. Then
`CARGO_TARGET_DIR=<frozen-directory> node scripts/run-worktree-test.mjs` passed
all seventeen independently reported checkpoints, including actual accepted
fixture output and harness execution in the exact created cwd. The pre-main
result is copied to `pre-main-result.json`; two screenshot copies show the picker and
accepted task. Native keyboard Enter is exercised after base selection and again
when retrying the retained creation plan after reopening the draft. No created
worktree is selected from the list before either Send.

The existing `scripts/run-project-new-thread-test.mjs` passed with its actual
`RELAYER_PROJECT_NEW_THREAD` marker: two threads, restart persistence, project
collapse and layer-selection persistence. Raw local logs are
`/tmp/relayer-worktree-build.log`, `/tmp/relayer-worktree-desktop.log` and
`/tmp/relayer-worktree-project.log`.

Reviewer `/root/review_worktree` independently checked this exact manifest,
all thirteen production receipt source hashes, both frozen native binaries,
both screenshot copies, all seventeen true worktree checkpoints and the
project-runner marker. Verdict: no actionable source or observed-evidence
findings. Without a PR this review is non-certifying. It excludes the pending
complete check. Complete Electron OS-process restart, Windows and release/live
provider proof are not claimed.

## Complete-check result and artifact repair

The actual `RUST_TEST_THREADS=2 VITEST_MAX_WORKERS=2 npm run check` exited 1.
Formatting, Clippy, native default/crash suites, runtime compilation, package,
TypeScript and workspace checks passed. Vitest passed 3,392 scenarios across
270 files, with three existing skipped tests / one skipped file. Its sole
failure was `desktop-social-preview-evidence.test.mjs`: the saved served-renderer
receipt still held the old checkout.js bytes. This original outer failure is
preserved in `/tmp/relayer-worktree-check.log` and is not claimed as a pass.

The declared `npm run prepare:renderer` then `npm run evidence:share-preview`
workflow passed with zero inference. Its actual receipt and light/dark outputs
were copied into the existing social-preview evidence portfolio. PNG bytes were
unchanged; the receipt now binds the new checkout.js and styles.css. The added
artifact seam maps to `desktop-social-preview-evidence.test.mjs`, which freshly
passed alongside the controller/renderer fixtures (15 scenarios, three files).
No executable or test source changed after the complete suite.

The four gates short-circuited by that original failure were run explicitly:
secret boundary passed 2 scenarios; Python passed 66; Ladybug receipt checks
passed; PRD readability passed. Their raw local logs are
`/tmp/relayer-worktree-secret.log`, `/tmp/relayer-worktree-python.log`,
`/tmp/relayer-worktree-receipts.log` and `/tmp/relayer-worktree-readability.log`.
The repaired checkpoint and these individual passes do not rewrite the outer
`npm run check` failure. No scenario budget or assertion was weakened.

Supplementary reviewer `/root/review_worktree` independently verified the exact
social receipt SHA-256 `61e2190a7f81bda0e378de7eabe513dea2a4e956c3f989b6cd0276670194da11`, all ten captured source hashes,
all 92 served renderer identities and their aggregate, both unchanged PNGs, and
the actual successful capture/cancellation/cleanup result. Verdict: no binding
findings; non-certifying without a PR. This supplements the unchanged six-file
source review and does not certify the original failed outer check.


## PR #651 and main integration (October 2, 2026)

PR #651 first opened at `3ad8e07d`. Its fresh complete `npm run check` passed:
271 Vitest files / 3,393 scenarios, the existing one skipped file / three skipped
scenarios, secret boundary 2, Python 66, and every native/default/crash,
package/type/workspace, receipt and readability gate. Log:
`/tmp/relayer-worktree-pr-check.log`. Earlier failed runs remain historical.

Main `99c7ddc12b5c505ed21c9ab176776b19117b76d3` was merged at `eb4ec76f`.
CSS resolution preserves worktree search/input styling and archive hover
controls. The social preview receipt was regenerated through its real workflow
for the combined renderer. Its light/dark images and source identities are the
actual capture output, never manually reassigned hashes.

The integrated warm run passed 18 renderer/controller/archive/evidence scenarios.
The integrated build passed and its exact binaries were frozen with matching
before/after/copied SHA-256 values. The worktree driver passed all 17 checkpoints
against those bytes; the project/new-thread runner passed its restart, collapse
and layer-selection markers. Current `result.json`, screenshot copies and
`source-snapshot.json` now bind the integrated source. The earlier snapshot and
result are explicitly retained with a `pre-main-` prefix. The integrated complete check passed: 273 Vitest files / 3,403 scenarios, the
existing one skipped file / three skipped scenarios, secret boundary 2, Python
66, and all native/default/crash, package/type/workspace, receipt and readability
gates. Log: `/tmp/relayer-worktree-integrated-check.log`. It ran the exact
unchanged executable source at integrated digest
`82afe6041ca99e991d4ac21119501b9dd9838c5721deb1503e0b593f182c5f61`.

`worktree-demo.mp4` is an 11.8-second recording of live production Electron page
frames, with optional embedded captions. It shows New worktree, search across
100 fixture branches, selection of search-fixture-99 and one native Enter,
followed by actual accepted graph output in the created checkout. The app server,
Git service, controller and renderer are production paths; provider execution
is the deterministic inference-free fixture. It is not paid/live provider proof.

`video-manifest.json` records video dimensions/hash, exact production source and
native binary hashes, frame/stage boundaries and the recorded commit. The exact
recording driver bytes are archived in `video-driver-source.txt`; copying that
file to `scripts/.worktree-demo-capture.mjs` restores its repository-relative
imports. The driver derives from the declared worktree test, disables its
injected lost reply, records capturePage frames and adds viewing delays. It
checks actual selected bases, created cwd and accepted output. Its shortened
happy path does not claim the recovery scenarios covered by the separate full
desktop driver. Disposable executable recording files are removed after use.
