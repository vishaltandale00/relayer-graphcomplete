# Parallel invoke runs: live run

Issue #717 lets a run started from an invoke action work beside the thread's message turn. This live run checks that with a real provider. It spends real inference, so it is opt-in and never part of `npm run check`.

## What ran

`scripts/run-parallel-invoke-live-run.mjs` boots the same GraphComplete runtime and app server the desktop uses. It runs the `prime-agent-basic` harness with `openai/gpt-6-luna` through OpenRouter, with no completion broker, so the agent cannot run its own invoke actions.

1. The first turn asks for one node per approach, each with a "Plan a first week" invoke action. It authored three.
2. The run clicks two of those actions and sends a follow-up message, all at once, through the product API.
3. It polls the product state every 250 ms, as the desktop does, until all three settle.
4. It exports each run's candidate trace and checks what its prompt said.

## Result

[`run.json`](run.json) records run `8c5d0530-1d35-4fd1-b2e9-6306fb5b256f` on 2026-10-09. It ran before two later review fixes: the node Stop rows now update in place, and the unproven invoke retry was removed. Neither touches admission, the host, the providers, or the history the run exercised. Every check passed:

| Check | Observed |
| --- | --- |
| All admitted | The two invokes and the message were admitted within 36 ms. None was refused with `interaction_in_progress`. |
| Ran side by side | All three were active in the same samples for 30.2 s. At most three were active at once. |
| All accepted | Interactions 2, 3 and 4 were accepted. |
| Invoked runs fresh | Both invoke prompts carry the fresh-session history block. |
| History reached them | Both invoke prompts contain the first turn's message. |
| Message resumed | The follow-up message's prompt has no history block: it resumed the thread's native session. |

An earlier attempt the same day found the same behavior: admission within 48 ms and 28 s with all three active. Its trace export then failed because the script passed no graph node ids to the integrity check. The script was fixed and rerun; that earlier attempt is not recorded here.

## Reproduce

Copy `live-run.example.json` to `live-run.local.json` and fill in a profile, then run:

```sh
RELAYER_PARALLEL_INVOKE_LIVE_RUN=1 npm run live:parallel-invoke -- --profile prime-openrouter
```

The run writes `.relayer/live/parallel-invoke/<run id>/run.json`. It exits non-zero unless every check passes.

## Limits

This is one run with one provider and model. It does not cover Codex or Claude live, the desktop UI, or approval prompts during parallel runs. The deterministic tests listed under PAR-001 to PAR-006 in the PRD cover those seams.
