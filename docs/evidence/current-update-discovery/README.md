# Discovering Current after navigation

Approved October 18, 2026: preserve explicit browsing pinning, expose the latest published Current, and let a separately selected native simulated user notice it through visible controls.

The UI offers **View latest update** while another layer is pinned. A newer publication since the pin adds **New update available**. Explicit activation resolves the latest head and resumes following. The pin baseline records navigation, not reading. Navigation preserves history and drafts without submitting input or resuming a paused run.

Actor prompt v12 / behavior v9 / observation v5 can observe the actual pinned workspace while work runs. It receives historical pixels and a visible cue, never unseen result contents. Its latest-update action waits for the navigation handler and paint before observing again. Handler settlement alone is not proof of successful navigation: the subsequent screenshot establishes what was displayed. Existing immutable revisions and default selection remain unchanged; publication, selection and promotion are explicit. This revision uses native Codex execution only.

## Checkpoint mapping

| Promise or boundary | Smallest production-seam proof |
| --- | --- |
| Scoped visible cue; old view and composer preserved; pending navigation clears on failure | `test/current-update-discovery.test.mjs`: real workspace rendering and actual error toast |
| Explicit latest navigation follows the newest head and preserves Back history | `test/workspace-navigation-integration.test.mjs`: active, stopped, failed and returned Current |
| Newer head, navigation or attempt supersedes an old read; failed load retains the old view | Same controller test file: four separate race/failure boundaries |
| Resume replaces a paused/interrupted attempt without granting stale navigation authority | Same controller test file: real `resumeInteraction` path during layer read, then fresh activation; no implicit Resume |
| Pin baseline is optional navigation metadata, not a read receipt | `test/navigation-history.test.mjs`: legacy absence, round trip and invalid revision rejection |
| Actual pinned pixels remain distinct from viewing Current; no hidden announcement hints | Browser identity/control tests and `test/eval-task-actor.test.mjs`: distinct phases and honest revision gaps |
| Native cue identity excludes authored ID collisions; genuine authored navigation remains registry-backed | Shadow-DOM collision in `test/current-update-discovery.test.mjs` and the real registered/unregistered-control browser chapter |
| Future production-only changes retain the new checkpoints | `scripts/ci/affected-modules.v1.json` and two `test/ci-affected-plan.test.mjs` production-path selection assertions |
| Native-only v12 publication/reopen; immutable predecessor and defaults | `test/eval-setup-registry.test.mjs` and the real setup-editor chapter in `test:eval-web` |
| Real cue readability, scoped activation, async final refresh and Return race; draft not submitted | `scripts/eval-current-actor-proof.mjs`, run by `test:eval-web`: hold the layer GET and final state refresh, then observe immediately after activation |

The controller tests isolate lifecycle and authority changes; the browser proof observes assembled UI/async paint. They protect different boundaries. No tests were deleted or weakened. Cancellation retains the existing actor deadline and browser-context teardown. The new wait does not replay a click or submit an answer.

Required gates are `npm run check`, `npm run build`, `npm run test:eval-web` and `npm run test:eval-compiled-runtime`. Renderer-bound social-preview and follow-up annotation receipts require their documented real Electron recaptures. Those receipts bind the combined renderer, rather than having hashes patched without capture. `verification.json` records exact results and failures; `source.json` binds reviewed paths. Generated source, verification and review records are excluded from that digest to avoid self-reference.

## Historical live confirmation

[The portable confirmation record](live-20261018/confirmation.json) and six unmodified screenshots retain one live native v12 run. It ran on base `24de17f2`, before the merge-preparation rebase to `a7985983`; it is not live proof of the rebased snapshot.

1. The fixture opened an earlier comparison while Current revision 2 pointed to layer 8. The workspace displayed layer 7, pinned.
2. Only then it published revision 3 / layer 9. The workspace still displayed layer 7, with the visible **New update available** cue.
3. The real model chose **View latest update**. Its first target detached before dispatch; the recorded refusal certified `actionDispatched:false`.
4. A fresh screenshot and fresh model decision chose the control again. New-layer paint event 15 preceded action completion 16 and model observation 18.
5. The model actually saw Current revision 3 / layer 9 and correctly described Lake Bled, €84 transport for two, 10:15 departure and 18:40 return.

The fixture never clicked latest-update in the live branch. It controlled the initial browsing position and publication timing; candidate output was deterministic. Model decisions and the completion reviewer used the connected Codex subscription. Default tests use fixture inference only.

Independent `actor_renderer_review` inspected all six images, their hashes and ordered action/diagnostic evidence. One non-dispatch refusal and two intentionally unobserved initial Current revisions remain explicit. The endpoint was reported complete by the model judge with `success:null`; this is not calibrated task-quality evidence or a success-rate claim.

The earlier three exploratory vacation cases produced 14 working Current captures and three live answers but no working pinned/publication opportunity. A settled group return-cue activation exposed the capture race that motivated the navigation wait. Those incomplete outcomes and earlier overlapping-cue captures remain historical local evidence. They do not replace the targeted confirmation or establish natural candidate quality, causal improvement or exhaustive observation.

## Merge preparation

The change was rebased onto main's paused-run recovery change. Production code merged without conflict; generated image/receipt conflicts were replaced by fresh captures of the combined source. The developer-only external vacation catalog override is excluded from the PR and retained locally. Native binaries are rebuilt from the current Rust source using compatible warm Cargo/Ladybug outputs; cached binaries from the older live run are not used as proof for the rebased source.

Final adversarial assertions are recorded in `review.json` and the PR, bound to the exact source digest/commit. Earlier source reviews and live evidence remain qualified to their own snapshots. Hosted `check` and freshness statuses remain required before merging.
