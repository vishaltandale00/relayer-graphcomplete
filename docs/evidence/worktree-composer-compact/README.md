# Compact worktree base picker (PR #651 follow-up)

Product authority: the October 2 user decision replaces the crowded inline
search/select stack with a base control beside New worktree. Its hover highlight
opens a dropdown to the right, search at the top, and a short scrollable list.
PRD §3.4 records this explicit decision. origin/main and the committed local base
are first when available. Other locally available branches include a registered
checkout path where present; selecting them still uses the committed branch ref.
No fetch or filesystem mutation occurs until Send.

Changed executable seams and deterministic checkpoints:

| Seam / promise | Smallest production checkpoint |
| --- | --- |
| Compact trigger, closed flyout by default, chosen ref, search, pinned ordering and selection | `test/worktree-renderer.test.mjs`, real renderer DOM |
| Search ArrowDown/ArrowUp, wrap, Escape focus and submenu dismissal | Same realistic DOM fixture; outer checkout menu remains open on first Escape |
| Right-side positioning with viewport clamping, about five rows with scroll, top search focus | `scripts/test-desktop-worktrees.mjs`, actual geometry and computed overflow in Electron |
| Visible option keyboard activation, prompt focus and Enter create/start without reselect | Native Return includes keyDown, char and keyUp; existing real-Git/accepted-output/retry driver |
| File-path display and style integration | Actual desktop screenshot and decoded video frames |
| Refreshed served-renderer receipt | Real `evidence:share-preview`, then `desktop-social-preview-evidence.test.mjs` |

No tests were removed. The hidden native select carries internal selected-ref
state; visible option buttons activate the existing setBase controller boundary.
Creation, durable plan recovery, permission and acceptance semantics are unchanged.

Required verification: warm renderer/controller tests; build; full `npm run check`
as deterministic fallback; declared worktree desktop heavy runner. No paid/live
provider or release proof is required or claimed. Prior evidence in
`../worktree-composer-search` describes the previous inline UI and remains
historical, including its video.

Actual runs so far: warm renderer/controller passed 14 tests. Final build passed.
Desktop final runner passed all 17 independently reported checkpoints and actual
accepted fixture output, using the previously frozen and hash-verified native
binaries. `result.json` binds its actual source/binaries; screenshot copies are
actual capture output. No Rust code changed in this follow-up.

One intermediate desktop test failed because its synthetic Return sent only
keyDown/keyUp, without the native char event required for button default
activation. The final driver sends the complete native sequence and passes.
That failed run is preserved in `/tmp/relayer-compact-worktree-desktop-final.log`;
its successful replacement is `/tmp/relayer-compact-worktree-desktop-keypress.log`.
An earlier pointer-selection desktop run also passed, before the final CSS and
keyboard-driver changes; it is not final certification.

The fresh video records production Electron frames, selecting a searched branch
then Enter starting the task and producing accepted output in the created cwd.
Execution uses the inference-free fixture, not a paid/live provider. Its 119
frames encode to 11.9 seconds at 1420×900. `video-manifest.json` binds video,
source-snapshot digest, native hashes and exact archived recording driver.
The recorded HEAD predates the uncommitted compact picker; source hashes, not
that HEAD alone, identify recorded behavior. Representative encoded frames were
decoded and visually inspected. The driver archive can be copied into scripts
for repository-relative imports; the temporary executable has been removed.

Full-check result and final independent evidence review will be appended after
completion. No pending check is claimed as passed.

## Final verification

`RUST_TEST_THREADS=2 VITEST_MAX_WORKERS=2 npm run check` exited 0:
273 JavaScript files / 3,403 passed scenarios, one existing skipped file / three
skipped scenarios; secret-boundary 2; Python 66; every native/default/crash,
package/type/workspace, receipt and PRD-readability gate passed. Raw log:
`/tmp/relayer-compact-worktree-check.log`. Final renderer/CSS/driver edits happened
while native tests ran; Rust/native inputs were unchanged throughout. All
JavaScript/evidence gates ran after the final executable and receipt bytes were
settled. Final warm renderer/controller/social-receipt run separately passed
15 scenarios. The final build passed (`/tmp/relayer-compact-worktree-build-final.log`).
The existing project/new-thread desktop runner passed two threads, restart,
collapse and layer-selection persistence (`/tmp/relayer-compact-worktree-project.log`).

Adversarial reviewer `/root/review_worktree` verified exact source snapshot digest
`16e7babdacc096590b60054ab87f07f717f426287ffbd6bdba1dab00d611d573`,
all thirteen desktop source hashes, actual frozen binaries, screenshot copies,
actual 17-checkpoint marker, video SHA/dimensions/frame count and independently
decoded compact-dropdown frame. Verdict: pass; no unresolved source, authority,
UX or binding findings. This is a PR #651 review assertion and invalidates when
those source bytes change. The final full-check log review is separately recorded
in the PR. Paid/live-provider, complete OS-process restart, other platforms and
release-candidate proof are not claimed.
