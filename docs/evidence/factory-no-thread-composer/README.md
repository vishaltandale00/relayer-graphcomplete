# No-thread composer lifecycle evidence

This evidence accompanies product source commit [`1bcbb6574873150c06f5050db7a7c4f145a10118`](https://github.com/vishaltandale00/relayer-graphcomplete/commit/1bcbb6574873150c06f5050db7a7c4f145a10118). It is the test-only follow-up to production fix `8b50ae3a635f225663700f90028c3210458d586a`. At verification time, HEAD was `8b50ae3a` and the sole source change was the updated test; its exact bytes were later committed unchanged as `1bcbb657`. This evidence branch adds documentation and media only. `source-native.sha256` records the exact test, workspace, controller, runner, and Electron wrapper digests used by the checks and capture.

## Deterministic checks

Runtime: Node.js 22.23.2, npm 10.9.8, Electron 43.0.0, Cargo 1.98.0, macOS ARM64. Rust target output, temporary files, and npm cache were reused from the approved shared/external locations. No paid inference was used.

- `npm exec vitest -- run test/node-detail-runtime.test.mjs`: 41/41 passed (`logs/focused-final.*`).
- `npm run check`: passed; 172 test files passed, 1 skipped; 2,267 tests passed, 3 skipped; secret-boundary 2/2; Python 29/29; Rust/clippy, crash reconciliation, receipt lint, and PRD readability passed (`logs/check-final.*`).
- `npm run build`: passed (`logs/build.*`).
- `npm run test:desktop:context-draft-warning`: passed; inner `RELAYER_CONTEXT_DRAFT_WARNING_SMOKE` marker reports `passed:true`, `inferenceCalls:0` (`logs/desktop-warning.*`). This command builds before launching Electron.

Two earlier `npm run check` attempts failed in the expanded test while it included a post-submit detach assertion. The control was observed disabled at that point; the cause was not established. That assertion was outside the no-thread checkpoint and was removed. An intermediate focused run with an explicit detach-enabled assertion also failed and is retained. These runs do not establish a detach correctness issue or its cause. The final focused and full checks above pass on the exact published product source. Earlier fixed-rate media and its output log are superseded and do not certify this capture.

## Actual-button recording

The runner clicked the real `#newThread` button after visibly persisting a follow-up on a saved thread, then returned to that thread and recreated its BrowserWindow. The inner record reports `currentThreadId:null` and `activeThreadId:2`; this is separate from the forced no-thread regression and does not prove that an ordinary button click itself yields `getThread() === undefined`. The main app process and services were not restarted.

The timestamped recording contains 30 captured frames. Capture completion timestamps come from `performance.now()`. Measured readable holds were 1,401.7 ms before the click, 1,899.5 ms on New Thread, and 1,803.5 ms after returning to the saved thread; each exceeds the 1,400 ms minimum. The media timeline measured 5,150.7 ms; the decoded H.264 video duration is 5.2 seconds. The runner verifies timing agreement, decodes the video, and records video/screenshot SHA-256 values in the inner marker. `video-frames.csv` contains the encoded frame timestamps.

The original file `ordinary-new-thread-view-original-failed-capture.png` was published under a misleading filename and caption. It shows the saved-thread graph and follow-up, not the empty New Thread state. It is retained unchanged as a failed capture, with its original hash, and is not used as proof. The replacement `video-frame-new-thread-empty-at-2.5s.png` was decoded from the already-published recording at 2.5 seconds using ffmpeg, then visually inspected; it shows the empty New Thread composer. Its SHA256 is covered by the directory manifest.

The other selected screenshots show the saved-thread follow-up before navigation and after BrowserWindow recreation. The timestamped recording, not a montage, demonstrates the transition. These images and video were visually inspected.

- Timestamped video: [`ordinary-new-thread-transition.mp4`](media/ordinary-new-thread-transition.mp4)
- Correct empty New Thread frame: [`video-frame-new-thread-empty-at-2.5s.png`](media/video-frame-new-thread-empty-at-2.5s.png)
- Saved-thread before/after screenshots: [`saved-thread-draft-before-new-thread.png`](media/saved-thread-draft-before-new-thread.png), [`saved-thread-draft-after-window-restart.png`](media/saved-thread-draft-after-window-restart.png)
- Retained failed capture: [`ordinary-new-thread-view-original-failed-capture.png`](media/ordinary-new-thread-view-original-failed-capture.png)
- Full inner marker and executable command outputs: [`logs/desktop-warning.inner-marker.txt`](logs/desktop-warning.inner-marker.txt)
- Exact source digests: [`source-native.sha256`](source-native.sha256)

## Identity and authority scope

The real workspace regression observes the restored input's displayed label/value and preview, and the revision supplied through the Send callback. Its `get.mock.results` equality assertion confirms only that the mock returned the expected fixture; it does not prove the controller restored the exact occurrence/source/draft-revision identity into workspace state. Existing controller tests in [`test/node-input-controls.test.mjs`](https://github.com/vishaltandale00/relayer-graphcomplete/blob/1bcbb6574873150c06f5050db7a7c4f145a10118/test/node-input-controls.test.mjs) cover authoritative per-thread revision, occurrence CAS, and invalid mutation postconditions. These are separately mapped boundaries; this PR does not claim the workspace regression directly proves that full identity.

`SHA256SUMS` at this directory root covers every included evidence file except itself. Verify with `shasum -a 256 -c SHA256SUMS` from this directory.
