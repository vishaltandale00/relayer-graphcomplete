# Parallel invoke runs: live run and video

Issue #717 lets a run started from an invoke action work beside the thread's message turn. These two records check that with a real provider. They spend real inference, so they are opt-in and never part of `npm run check`.

Both ran on commit `7eb6d8d08566af5b5c152c92ab0572b6248f60b1` with a clean workspace. Each record names that commit and the workspace digest in its `source` field. They used the `prime-agent-basic` harness with `openai/gpt-6-luna` through OpenRouter. They also used the desktop's own temporal features, recorded in `temporalFeatures`.

## Live check: [`run.json`](run.json)

`npm run live:parallel-invoke` boots the same GraphComplete runtime and app server the desktop uses. It asks for one node per approach, each with a "Plan a first week" invoke action. It then clicks two of those actions and sends a follow-up message, all at once, through the product API.

| Check | Observed |
| --- | --- |
| All admitted | The two invokes and the message were all admitted. None was refused with `interaction_in_progress`. |
| Ran side by side | All three were `running` in the same samples for 19.3 s. Queued or still-starting runs do not count. |
| Traces complete | Every run's candidate trace is complete, not truncated, with full prompt coverage. |
| All accepted | All three runs were accepted. |
| Invoked runs fresh | Both invoke prompts carry the fresh-session history block. |
| History reached them | Both invoke prompts contain the first turn's message. |
| Message resumed | The message's complete prompt has no history block: it resumed the thread's native session. |

Other coverage features, such as reasoning summaries and tool calls, are not all `full` for this provider (`coverageComplete: false`). The checks above read only the prompt.

## Video: [`parallel-invokes.mp4`](parallel-invokes.mp4) and [`video-run.json`](video-run.json)

`scripts/record-parallel-invoke-video.mjs` drives the production renderer in an Electron window against the same runtime. It clicks a node, then its "Plan a first week" button in the node details, on two nodes. It types a follow-up message and clicks Send while both run. Frames come from the app window only. Stretches where the model works play at 5× speed, and the caption says so.

| Check | Observed |
| --- | --- |
| Both invokes clicked in the UI | The invoke buttons in the node details were clicked. |
| All admitted | Both invoked runs and the message were admitted within 512 ms of Send. |
| Ran side by side | All three were `running` together for 14.5 s. |
| Node showed its own Stop | The selected node listed exactly its own run, with a Stop. |
| All accepted | All three runs were accepted. The video ends by opening one invoke's result from its node. |

## Reproduce

Copy `live-run.example.json` to `live-run.local.json` and fill in a profile, then run:

```sh
RELAYER_PARALLEL_INVOKE_LIVE_RUN=1 npm run live:parallel-invoke -- --profile prime-openrouter
```

```sh
RELAYER_PARALLEL_INVOKE_LIVE_RUN=1 RELAYER_LIVE_PROFILE=prime-openrouter ./node_modules/.bin/electron scripts/record-parallel-invoke-video.mjs
```

The first writes `.relayer/live/parallel-invoke/<run id>/run.json`. The second writes `.relayer/evidence/parallel-invoke-video/`. Each exits non-zero unless every check passes.

## Limits

Each record is one run with one provider and model. Neither covers Codex or Claude live, nor approval prompts during parallel runs. The deterministic tests listed under PAR-001 to PAR-006 in the PRD cover those seams.
