# Parallel sends: live video

Issue #719 lets everything a person sends from a thread run at once. This record checks that with a real provider, through the production renderer. It spends real inference, so it is opt-in and never part of `npm run check`.

The owner reviewed the video on 2026-10-16 and accepted it: it "matches my expectation".

## Provenance

- **Source:** commit `544340a74029dce6889f067e78fe38adc87fd83d`, recorded in `source` in [`video-run.json`](video-run.json).
- **Workspace:** `clean: false`, digest `sha256:dbb19064…336b80`. The workspace was not clean because the recording script, `scripts/record-parallel-sends-video.mjs`, was still untracked when it ran. It was committed afterwards, unchanged.
- **Harness and model:** `prime-agent-basic` with `openai/gpt-6-luna` through OpenRouter (profile `prime-openrouter`).
- **Runtime:** the desktop's own temporal features, recorded in `temporalFeatures`.
- **Binaries:** the app and graph server SHA-256s are in `executables`.

## Video: [`parallel-sends.mp4`](parallel-sends.mp4)

`scripts/record-parallel-sends-video.mjs` drives the production renderer in an Electron window, as a person would:

1. It asks for one node per approach to learning a language. One node gets a "Plan a first week" invoke action, and another a "Daily minutes" text question.
2. It clicks the invoke in the node details.
3. It sends a plain message from `#threadPrompt` with `#sendInteraction`.
4. While both run, it annotates a node through `#attachNodeContext` and `#contextAnnotationEditor`, then sends a message that carries the annotation.
5. While those run, it answers the node's question in Node Details, then sends a message that carries the answer.

Frames come from the app window only. Stretches where the model works play at 5× speed, and the caption says so.

| Check | Observed |
| --- | --- |
| `allAdmitted` | The invoke and all three messages were admitted. None was refused. |
| `threeSendsRanTogether` | The plain, annotated and answered messages were all `running` in the same sample. Queued or still-starting runs do not count. |
| `sendsRanBesideTheInvoke` | The invoked run was `running` beside at least one message. |
| `plainSendCarriedNothing` | The plain message carried no annotation and no answer. |
| `annotatedSendCarriedOnlyItsAnnotation` | The annotated message carried exactly its one annotation ("I already know Python, so lean on that.") and no answer. |
| `answeredSendCarriedOnlyItsAnswer` | The answered message carried exactly its one answer (`20`) and no annotation. |
| `allAccepted` | All four runs were accepted. |

The `snapshots` field records each run's annotations and answers, as the app server reports them in the thread state.

## Reproduce

Copy `live-run.example.json` to `live-run.local.json` and fill in a profile, then run:

```sh
RELAYER_PARALLEL_INVOKE_LIVE_RUN=1 RELAYER_LIVE_PROFILE=prime-openrouter ./node_modules/.bin/electron scripts/record-parallel-sends-video.mjs
```

It rebuilds the app and graph servers from the current source and records each binary's SHA-256. It writes `.relayer/evidence/parallel-sends-video/`. It exits non-zero unless every check passes, and also when recording or encoding fails.

## Limits

- This is one run, with one provider and one model. It does not cover Codex or Claude live, or approval prompts during parallel runs.
- It does not exercise Stop, Stop all, capacity waits or restart.
- The deterministic tests under PAR-015 to PAR-019 in the PRD cover those seams without inference.
