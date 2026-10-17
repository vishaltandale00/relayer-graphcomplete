# Paused runs after a restart: live video

Issue #722 makes a restart stop runs where they were. A queued run becomes paused, and a run that was executing is interrupted. Nothing starts until the person resumes it. This record checks that with a real provider, through the production renderer. It spends real inference, so it is opt-in and never part of `npm run check`.

The owner reviewed the video on 2026-10-16 and accepted it ("722 looks good to me").

## Provenance

- **Source:** commit `5f949e99b7d93ac64c6a1d3b51f4444d243e1a3b`, recorded in `source` in [`video-run.json`](video-run.json).
- **Workspace:** `clean: false`, digest `sha256:186bc3ca…d3783e`. The workspace was not clean because the recording script, `scripts/record-paused-runs-video.mjs`, was still untracked when it ran. It was committed afterwards, unchanged.
- **Later commits:** they tightened Resume and Discard idempotency and the Codex-round edges. None changes what the video shows.
- **Harness and model:** `prime-agent-basic` with `openai/gpt-6-luna` through OpenRouter (profile `prime-openrouter`).
- **Runtime:** the desktop's own temporal features, recorded in `temporalFeatures`.
- **Binaries:** the app and graph server SHA-256s are in `executables`.

## Video: [`paused-runs.mp4`](paused-runs.mp4)

`scripts/record-paused-runs-video.mjs` drives the production renderer in an Electron window:

1. It asks for an answer where one node has three invoke actions, and clicks all three. One runs and two queue behind it on that node.
2. While the first runs, it closes the app server and runtime. It then starts them again on the same data and reloads the window, as a quit and relaunch would.
3. It watches the runs for 12 seconds after the restart.
4. It opens the interaction graph, discards the third run, and resumes the node's chain.

Frames come from the app window only. Stretches where the model works play at 5× speed, and the caption says so.

| Check | Observed |
| --- | --- |
| `allClickedInTheUi` | All three invoke buttons were clicked in Node Details. |
| `oneRanAndTwoQueuedBeforeRestart` | Before the restart the runs were `running`, `queued`, `queued`. |
| `restartInterruptedTheRunAndPausedTheQueue` | After the restart they were `interrupted`, `paused`, `paused`. |
| `nothingStartedOnItsOwn` | For 12 seconds every run stayed paused or interrupted. |
| `pausedBadgeShown` | The thread list showed "3 paused". |
| `restartNoticeShown` | The run view showed "Relayer restarted. 3 runs stopped where they were. Nothing resumes until you do." with Resume all (3). |
| `discardStoppedTheRunAndKeptItsText` | The discarded run ended `stopped` with its text unchanged. |
| `resumeRanTheChainInOrder` | After Resume, the second run started only after the first ended. |
| `resumedRunsAccepted` | Both resumed runs were accepted. |

## Reproduce

Copy `live-run.example.json` to `live-run.local.json` and fill in a profile, then run:

```sh
RELAYER_PARALLEL_INVOKE_LIVE_RUN=1 RELAYER_LIVE_PROFILE=prime-openrouter ./node_modules/.bin/electron scripts/record-paused-runs-video.mjs
```

It rebuilds the app and graph servers from the current source and records each binary's SHA-256. It writes `.relayer/evidence/paused-runs-video/`. It exits non-zero unless every check passes, and also when recording or encoding fails.

## Limits

- This is one run, with one provider and one model.
- It restarts by closing the servers, not by killing them.
- It does not cover a thread's first message interrupted by a restart, capacity-paused runs, agent children or Resume all. The deterministic tests under PAUSE-001 to PAUSE-006 in the PRD cover those seams without inference.
