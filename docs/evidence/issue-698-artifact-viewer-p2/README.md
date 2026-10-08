# Issue #698: artifact viewer, phase 2

Product meaning is PRD §6.6.6 to §6.6.8 and ADR 0014. P2 builds on P1 (#697): web apps started by a server invoke, starting state, and Annotate. No paid inference ran, and no release claim is made.

## Checkpoints and production seams

| Checkpoint | Promise | Deterministic observation |
| --- | --- | --- |
| ART-009 | The server invoke reuses, asks once, starts, reports failure, stops when idle and records nothing | `test/artifact-server.test.mjs` runs real processes: approval once per thread and command, a confined start of the fixture app, reuse, a server that already answers (used, never stopped), a failing command with its log, Seatbelt refusing a write outside the thread folder, refusal where confinement is unavailable, and the idle stop. Desktop run: the approval card, Run, the app serving, a reopen reusing the same process, and a broken build's log with Retry and Add to chat. Graph-core: `server_invokes_and_starting_state_are_checked`. |
| ART-010 | Starting state resets on every open | Desktop run: the site opens with its seeded cart; the page empties it; reopening shows the seed again. The web app shows its seeded cookie and storage. Graph-core rejects malformed or oversized seeds and website cookies. |
| ART-011 | Notes collect, pause media, and send as one interaction with screenshots | `test/artifact-viewer-renderer.test.mjs` (Annotate panel, note text, remove, Esc order). `packages/harness-host/test/artifact-notes.test.ts` (screenshots copied into the turn folder). Desktop run: Annotate freezes the view and pauses the video; the note joins the chat draft; Send creates one interaction carrying it; the agent opens a PNG. |

Exporting note screenshots is #703, decided 2026-10-07. Export and shares keep each note's text and location.

## Heavy entry point

`npm run test:desktop:artifact-viewer` runs the real `desktop/main/index.mjs` with the `fixture.artifact-viewer` harness in place of Codex, and checks P1 and P2 together. `RELAYER_ARTIFACT_VIDEO=<file>.mp4` records the run with captions.

## Files

- `artifact-viewer-p2-demo.mp4`: the recorded run.
- `results.json`: every check from the recorded run.
