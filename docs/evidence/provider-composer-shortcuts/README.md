# Provider reconnect and composer shortcuts

Product decisions: the requested installed-provider reconnect overlap, model-click dismissal (including reselection), and Enter-confirm / Enter-send behavior are recorded in PRD sections 2.1, 2.3, and 7.1.

## Changed seams and checkpoints

| Seam | Observable checkpoint | Smallest production-seam proof |
| --- | --- | --- |
| Provider reconnect preparation and native login | Installed provider returns login while setup is held; no catalog publishes until setup and account succeed | `test/provider-connection-generation.test.mjs`: reconnect setup overlap |
| Pending connection polling and failure cleanup | Poll does not hold cancellation behind installation; cancellation/setup failure records signed out, late setup is inert | Same file: reconnect setup failure boundaries |
| Missing-runtime prerequisite | Failed activation installs before constructing native login | Same file: waits for installation before starting login |
| Provider execution admission | Reconnecting provider refuses execution; unrelated providers remain usable | `test/provider-adapters.test.mjs`: unrelated provider leases |
| Shutdown | Already-started setup drains before close; runtime closes once | Same file: drains reconnect runtime preparation |
| Model option click and focus | Both changed and reselected models close new/ongoing picker and focus trigger | `test/default-family-recovery.test.mjs`: model selection dismissal; native reselection in interaction-context runner |
| Annotation key handler, durable confirmation, and composer Send | First Enter confirms only; second Enter sends exact annotation without message text; Shift/IME/repeat do not confirm | `test/node-inspector-traces.test.mjs`: annotation keyboard confirmation |
| Running response and disabled Send | Enter confirms accepted-node annotation while running; no send until available and a new explicit Enter | `test/node-inspector-traces.test.mjs`: running-response keyboard confirmation |
| Browser focus after disabling annotation editor | Native Enter confirms and focuses composer; Enter Send failure preserves composition | `scripts/test-interaction-context-lifecycle.mjs`, invoked through `npm run test:desktop:interaction-context` |
| Source-bound running-response annotation evidence | Accepted follow-up remains annotatable while next response runs; confirmation survives reload | `scripts/capture-followup-node-annotations.mjs` and `test/followup-annotation-evidence.test.mjs` |
| Source-bound desktop preview evidence after renderer edits | Real light/dark capture, cancellation and cleanup pass; receipt matches served renderer and PNGs | `npm run evidence:share-preview` and `test/desktop-social-preview-evidence.test.mjs` |

No tests were deleted. Two existing reconnect assertions were updated because sign-in now owns the provider before setup finishes: target execution is refused sooner, and shutdown drains setup after login has already started. Their unrelated-provider and shutdown-drain boundaries remain observed.

## Required verification plan

Run focused in-process regressions while editing. Before handoff run `npm run check`, `npm run build`, and the PRD's deterministic assembled workspace entry points: `npm run test:desktop:interaction-context`, `npm run test:desktop:node-input-actions`, and `npm run test:desktop:project-new-thread`. Native proof is run after the edit loop. No paid inference or live provider authentication is required by these deterministic checkpoints.

## Current-main qualification

Base: `32e313213fe4355efabf3ec61cea2991eb145d71`. The isolated branch excludes the original checkout's breadcrumb and harness WIP. Ten scoped source files have digest `f1b0fd13b2d2efbb4ceb9e970f58c9689aabcfa2ef0f402c1224570498c38d4d` (sorted relative path + NUL + file bytes + NUL).

- Required `npm run build`: passed with Node 22.23.2.
- Required `npm run check`: passed with Node 22.23.2. All Rust/default/crash-reconciliation stages, TypeScript checks, 3,719 JavaScript tests (three skipped), two separate secret-boundary tests, 68 Python tests, receipt lints, and PRD readability passed. The prior sole stale-receipt failure was corrected before this complete rerun.
- Focused mounted production-seam regressions: four files, 177 tests passed, including idle/running annotation confirmation and disabled-Send/no-autosend behavior.
- Native interaction-context and node-input runners: inner scenarios passed, zero paid inference calls. They ran sequentially after the build using the package scripts' underlying wrapper entry points.
- Real desktop preview capture: passed cancellation and cleanup; inspected light/dark output; regenerated source-bound receipt. The PNGs match current main's prior output, so only receipt hashes changed.
- Real follow-up annotation A→B capture: passed all inner checkpoints, zero paid inference calls. All four images were inspected; current renderer and exact occurrence are bound by the regenerated receipt. Both visual receipt tests passed (two tests). Receipt binary hashes identify the capture-time executables; the subsequent full check rebuilt target binaries, so current-target byte equality is not claimed. The first full check found only the prior stale annotation receipt (3,718 tests passed); this regeneration repaired that evidence mismatch.
- Native project/new-thread runner: **failed** pending-draft restoration after restart. Its unchanged-main comparison reproduces the same failure, as detailed below. This checkpoint is not claimed passed.

[Qualification receipt](qualification.json) binds the tested source digest to [complete check output](check.txt), [build output](build.txt), and both passing native runner logs ([interaction-context](interaction-context.txt), [node-input](node-input.txt)). Their fixture warnings remain in the unedited output. The native project failure remains a separate failed checkpoint. Remote main was rechecked before commit and still matched the base.

### Existing project restart failure

Both changed-source and baseline runs fail at `scripts/test-desktop-project-new-thread.mjs:610`, waiting for the pending draft after app restart. The baseline uses HEAD's three production implementation files in a temporary copy of the desktop renderer/preload. Its unchanged current-main harness, runtime binaries, and proof driver use Node 22.23.2. The temporary driver only redirects desktop paths and resolves imports; neither run emits the required inner pass marker.

[Baseline source identity](project-baseline-source.json), [baseline result](project-baseline-result.json), [baseline log](project-baseline.txt), and [changed-source failure log](project-failure.txt) retain the exact comparison. Its underlying cause remains unresolved. It predates this change and is not repaired or waived here.

### Video

[Watch the 30-second current-source recording](fixes.mp4). [Video receipt](video-receipt.json) binds the MP4 to all three production implementation hashes and its video SHA-256. The H.264 video decoded fully at 2560×1640; captured source frames are 8 fps, encoded playback is 24 fps. Representative frames were inspected.

Native mouse/key events exercise selected-model reselection, alternate-model selection, Enter-confirm, and Enter-send. The graph/app servers are real with a deterministic task-system harness. Actual provider settings and `ProviderDefinitionService` use synthetic credentials and held runtime setup: setup/login/handoff occur at 22.5 seconds, login finishes at 24.5, setup finishes at 27, then catalog publication occurs at 27.75. No live OAuth, installation timing, harness readiness probe, or paid inference is claimed.

The first rebased recording failed because the driver clicked a hidden Providers control while initial Settings restoration selected Appearance. Only the recorder was changed to await the visible panel and reject hidden click targets. The final independent recording reports `passed: true`; its receipt, native assertions, and successful full decode support the claim. Failed capture log: `/private/tmp/provider-composer-main-video.log`; final log: `/private/tmp/provider-composer-main-video-qualified.log`.

### Cache and failed preparation attempts

The trusted Ladybug bundle at `/private/tmp/relayer-claude-preview-lbug-cache` passed the repository verifier for macOS ARM64, Rust 1.98.0, matching Cargo.lock, lbug 0.18.0, library/header identities and hashes. Existing runtime binaries came from an older Rust input and were not accepted as current-source proof. Fresh source compilation used that verified native library and warm copy-on-write Cargo artifacts. The copied Node cache omitted graph-client's nested parse5 dependency; the initial build failed TypeScript resolution, then lockfile-exact `npm ci` corrected the setup and the pinned build passed.

Earlier work on the original dirty checkout had a socket sandbox failure, disk-space build failure, duplicated nested-worktree discovery, and an unrelated breadcrumb assertion. Those results do not qualify this isolated snapshot. Logs remain at `/private/tmp/relayer-provider-shortcuts-*.log`. Current logs use `/private/tmp/provider-composer-main-*.log`.

### Adversarial review

Reviewer `/root/review_parallel_setup` approved digest `f1b0fd13b2d2efbb4ceb9e970f58c9689aabcfa2ef0f402c1224570498c38d4d` with no remaining blockers in provider lifecycle/authority, model dismissal, annotation focus/Send admission, checkpoint mapping, or changed test assertions. The initially found running-response mapping gap was repaired and reviewed. No tests were deleted. The reviewer independently reproduced the existing project proof failure against HEAD. Review remains non-certifying without an exact PR assertion; changed scoped source bytes invalidate it. The same reviewer approved the final video SHA-256 `44a80a763e20866827edfe12f08f2fa0a5014d77dd4eda4f84ec7d1880c38dd5`, its source binding, and fixture boundaries. The regenerated five-artifact annotation receipt/image bundle was separately approved at digest `ebe5fdedb3de4cb5c79738477100a924a450f5db07f9aec755d7ae54a6be0b5b` (sorted full repository-relative path + NUL + bytes + NUL), with capture-time binary identities explicitly distinguished from rebuilt targets. The final heavy-evidence audit independently verified the ten-file source digest, all four qualification log hashes, and inner pass markers at qualification receipt SHA-256 `7bbfcdc0fd0c5aa3eb1a5444f1ed0c174ed2005577f9506368a964ff82bc97aa`; verdict approved with no new blockers. The unwaived project checkpoint remains failed. Full runner results remain separate from this source review.
