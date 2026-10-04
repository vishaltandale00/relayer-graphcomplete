# New worktree keeps its menu open

Product authority: the user's October 2 follow-up explicitly agrees that checking
New worktree should leave the checkout menu open, with the compact base beside
it. The branch flyout opens only when the base is clicked. PRD §3.4 records this
decision. Earlier inline and compact-picker evidence/video remains historical
in its separate folders; this folder records the final follow-up.

## Changed seams and verification plan

| Production seam / promise | Deterministic checkpoint |
| --- | --- |
| Checkbox keeps outer menu open and flyout closed | Production DOM in `test/worktree-renderer.test.mjs`; real Electron worktree driver |
| Valid default restores prompt focus for Enter | Existing actual `bindComposerKeydown` + `createFirstThread` DOM admission/retry test; native Enter desktop startup |
| Unknown default focuses the base button without opening its flyout, and Send still rejects missing base | Same realistic production DOM fixture |
| Draft persistence completion does not steal search focus after an immediate base click | DOM test clicks the base before persistence settles; native driver checks actual search focus |
| Explicit dropdown click/selection, geometry, scrolling, durable creation and retry remain valid | Declared worktree heavy runner's 17 independent checkpoints |
| Refreshed served renderer artifact | Real `evidence:share-preview` capture and existing social-preview receipt test |

Required checks: warm renderer/controller/receipt tests; `npm run build`; full
`npm run check` as deterministic fallback; declared worktree desktop runner.
No tests were removed. No native code, inference, permission, durable admission,
creation receipt or provider execution contract was changed.

## Actual runs and preserved failure

Renderer/controller warm run passed 14 scenarios. The final build passed
(`/tmp/relayer-worktree-stay-open-build-final.log`). Actual desktop final runner
passed all 17 checkpoints, restart persistence and accepted fixture output
(`/tmp/relayer-worktree-stay-open-desktop-final.log`). Its `result.json`, source
hashes and screenshot copies bind the actual final production renderer and
previously frozen/hash-verified native binaries.

The first desktop attempt failed its compact-picker checkpoint. The diagnostic
rerun established that placement, bounding, scroll, overflow and pin order were
all correct, but search focus was false. Checkbox draft persistence completed
after a quick base click and restored prompt focus too late. The fix restores
focus immediately after the controller's synchronous change/render, then awaits
the durable save without another focus change. The added immediate-click DOM
checkpoint and successful native run observe that exact failure boundary.
Failed logs remain `/tmp/relayer-worktree-stay-open-desktop.log` and
`/tmp/relayer-worktree-stay-open-desktop-diagnostic.log`; they are not passes.

The fresh 118-frame, 11.8-second video is actual production Electron page capture.
At 1.3 seconds the menu remains open with New worktree checked and flyout closed;
later an explicit base click opens the flyout, search narrows the branches, and
native Enter starts and accepts the task in the created cwd. The provider is the
inference-free fixture. Encoding explicitly limits output to the new 118 frames;
no leftover frame from an earlier recording is included. The video manifest
binds exact bytes/dimensions, archived executed driver, source snapshot and
native binary hashes. Its recorded HEAD is the preceding commit; exact source
hashes identify the uncommitted follow-up. The temporary executable was removed.

The social-preview receipt was regenerated through its declared real workflow,
not by reassigning hashes. Its images remain actual capture bytes.
Full check and final adversarial evidence assertion will be recorded after
completion. No pending check is claimed as passed; no paid/live provider,
complete OS-process restart, other-platform or release proof is claimed.

Final warm renderer/controller/social-receipt checks passed 15 scenarios in
778ms (`/tmp/relayer-worktree-stay-open-warm.log`). Adversarial reviewer
`/root/review_worktree` independently verified exact source digest
`30f66d33f74850a20d673ff528eb5ea31268c56a19e3535bb46af82b37c7f7ca`,
all thirteen desktop receipt source hashes, actual frozen native bytes,
screenshot copies, actual 17-checkpoint marker, encoded video and archived
driver. An independently decoded one-second frame shows the checked checkbox,
open menu and closed flyout. Source/evidence verdict: PASS, no unresolved
findings. This assertion invalidates if those source bytes or bindings change.
The pending complete check is excluded from this assertion until its actual
results are reviewed.

## Complete-check result

The final `RUST_TEST_THREADS=2 VITEST_MAX_WORKERS=2 npm run check` exited 0
against the unchanged final source snapshot. JavaScript: 273 files and 3,403
scenarios passed, with one existing skipped file / three skipped scenarios.
Secret boundary: 2 passed. Python: 66 passed. Every native/default/crash,
package/type/workspace, Ladybug receipt/contract and PRD-readability gate passed.
Raw log: `/tmp/relayer-worktree-stay-open-check.log`. No executable source changed
while that check ran. Build, warm tests and heavy desktop results above are
separate observed passes, not inferred from this outer command's exit status.
The final full-check review assertion is recorded in PR #651 with the source
commit and workspace digest. Prior failed attempts remain explicitly preserved.
