# Ask-profile approval evidence

This directory is populated locally by the opt-in Ask-profile replay for issue #85. It uses the ordinary desktop ProductWorkspace, the real `codex-basic` harness, the local connected Codex account, and paid `gpt-5.6-luna` inference.

The replay covers baseline graph completion, Approve once, Deny, Approve always, a future exact match, a near match, explicit completion cancellation, and provider-session loss. It checks protected-action files before and after every decision and exports candidate traces with product interaction correlation.

The generated manifest, screenshots, traces, and continuous MP4 prove only the tested local development checkout. They do not claim packaged or release behavior, and they are ignored by Git so real traces and media are not added to a pull request.

## Parent #54 acceptance mapping

| Parent criterion | Evidence |
| --- | --- |
| Ask pauses and resumes the same `complete()` | Each observation in `manifest.json` pins one interaction, completion call, harness session, and provider item. The corresponding trace continues after the decision and reaches accepted, stopped, or failed. |
| Bottom dock keeps the graph visible | Every `*-waiting.png` capture shows the ordinary ProductWorkspace, prior accepted graph, and live bottom dock. The continuous MP4 and manifest hold each of the six user-visible prompts stable for at least three seconds and 24 recorded frames before the decision or interruption. |
| Deny, Approve once, and Approve always | The manifest records user decisions and terminal outcomes for all three. Marker checks prove the protected action boundary. |
| Denial adapts in the same turn | `approve-once-repeat-denied` shows Luna continuing after denial and accepting a useful graph without creating the file. |
| Approve once is not reusable | `approve-once-repeat-waiting.png` shows an identical future create scope asking again; denial leaves the reset marker absent. |
| Approve always is exact and session-local | `exact-auto-resolved` records actor `session_grant`; `exact-grant-near-match-waiting.png` shows a path-only near match still asking in the same live session. |
| Cancellation and session loss fail closed | Interaction 7 explicitly ends `stopped`/`cancelled`. For interaction 8 the runner kills only the live Codex app-server process while the host and graph runtime remain up; it ends `failed`/`aborted`. Both protected files remain absent. |
| Useful output requires genuine completion | Baseline and decision-adapted interactions have accepted graph node IDs. Cancelled and provider-loss turns have no accepted graph. |
| Reload, concurrency, ownership rejection, missing-key, and cross-session isolation | Covered by the inference-free approval model, host, Rust persistence, and desktop integration tests run by `npm run check` and `npm run test:desktop:approval`; the paid replay does not replace those deterministic cases. |
| Provider-native payload stays adapter-private | Screenshots and `manifest.json` contain the normalized action, files, scope, and correlations; renderer evidence contains no raw provider approval payload. |
| Approval history remains visible | The terminal ProductWorkspace automatically expands a fixed-height receipt viewport. `final-receipts.png` and `final-receipts-scrolled.png` prove that seven receipts remain available by scrolling without growing the dock or relying on capture-script expansion. |

The runner gives the live Codex app-server a disposable `CODEX_HOME` containing only copied authentication, so personal memory, skills, sessions, and configuration are unavailable to the eval. Candidate traces redact credentials, local user and machine identifiers, environment authority, reasoning content, size justifications, and account credit/rate-limit metadata. Disposable paths in the manifest use placeholders. The manifest inventories every screenshot, video, and trace with its byte length and SHA-256; its own checksum is stored in `manifest.sha256`.

The runner requires a clean source worktree, records its exact commit in the manifest, generates into a staging directory, and replaces the ignored local output only after the replay, artifact checks, and service shutdown all succeed. This README is the only tracked file in the directory.

The macOS-only command is intentionally excluded from default tests because it spends paid inference and needs a connected local Codex account:

```sh
RELAYER_CAPTURE_ASK_PROFILE_EVIDENCE=1 /bin/sh "$PWD/scripts/launch-ask-profile-evidence.sh" \
  /absolute/path/to/trusted/node
```
