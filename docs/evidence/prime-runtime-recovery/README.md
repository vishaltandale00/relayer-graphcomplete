# Prime setup recovery

Base: `b39604cc` (main). Branch: `codex/prime-runtime-recovery`.

## Product decision

A connected compatible provider can finish a missing supported harness runtime
when an upgrade marks that harness due. Harness Settings retains unavailable
loaded configurations with a repair icon when a current provider can finish setup.
The reason stays in the tooltip; the accessible name identifies the Repair action. Composer and onboarding
continue to exclude unavailable configurations. Repair preserves selected defaults.
This follows the user's explicit decision on October 8, 2026.

## Changed seams and checkpoints

| Production seam | Promise / boundary | Deterministic checkpoint |
| --- | --- | --- |
| Readiness coordinator recipe-update targets | Missing supported Prime is installed once from an existing eligible route; no inference | `harness-readiness.test.mjs`: real recipe target resolution; due mark clears on committed result |
| Provider composition route cache and readiness generation | Connected catalog must be current; sign-out and reconnect cannot authorize setup | `provider-composition.test.mjs` shared upgrade; existing realistic `provider-connection-generation.test.mjs` lifecycle traces now assert readiness routes |
| Runtime resolver, Desktop and Eval wiring | Missing and unsupported recipes are distinct | Real resolver/recipe path in readiness scenario; existing startup wiring assertion; full check includes Eval setup |
| Startup runtime catalog | Unsupported target remains typed; local validation performs no probe | `desktop-shell.test.mjs` corruption/unsupported catalog scenario |
| SQLite Model Settings projection | Exact repair providers obey lifecycle, model visibility, access contracts, allow/deny rules, loaded digest and platform support; enabled family is not required to finish setup | `model_settings_project_repair_routes_without_admitting_execution`: real store, unavailable execution, each excluded route, reopen and repaired state |
| Harness Settings presentation and click | Icon only, exact provider, busy duplicate block, failed refresh and failed readiness preserve retry, success updates pickers without changing defaults | `provider-ui.test.mjs`, `harness-settings-repair.test.mjs` |
| Global social-preview source/renderer receipt | SOC-001 existing evidence must remain bound to current served bytes | `evidence:share-preview` actual Electron recapture and `desktop-social-preview-evidence.test.mjs`; both PNGs unchanged |
| Actual renderer and refresh/reread chain | Connected OpenRouter -> missing Prime -> repair failure -> retry -> usable Prime in composer | `evidence:provider-ux -- --scene=harness-repair` production renderer with deterministic HTTP/desktop provider fixture |

No tests were retired. The shared upgrade scenario now covers a missing Prime
alongside installed Codex. Separate missing-subscription/no-route recovery tests
still protect the installed-only preliminary provider recovery boundary.

## Required verification plan

- Warm loop: affected readiness, composition, provider lifecycle, renderer and
  startup catalog tests; real SQLite projection test.
- Handoff: `npm run check`, `npm run build`, clean exact Prime installation/kernel
  via `npm run test:prime-managed-runtime`, actual renderer journey capture.
- Paid inference and signed/package upgrade proof require their separate context.
  This fix runs no inference and does not install a release over `/Applications/Relayer.app`.

## Executed evidence

- [Focused suite](focused-tests.txt): seven files, 151 tests passed with pinned
  Node 22.23.2 on macOS arm64.
- Real SQLite projection: both matching `model_settings_project` tests passed.
- [Prime kernel](prime-kernel.txt): clean exact `prime@0.8.1` assembly on
  `macos-arm64`, ready=true, actual isolated Python kernel imports and deterministic
  expression without a provider or inference.
- [Renderer recording](harness-repair.mp4), [missing](harness-repair-missing.png),
  [failure](harness-repair-failure.png), [success](harness-repair-success.png),
  [connected OpenRouter](harness-repair-connected.png), [composer option](harness-repair-composer.png),
  [journey assertions](harness-repair-journey.json). The provider and setup result
  are deterministic fixtures. The actual installer/kernel check above is separate;
  this recording does not claim a live OpenRouter credential or signed upgrade.
- The first recording's DOM assertions ran behind the optional-account gate;
  inspection rejected those screenshots. The runner now dismisses that gate using
  the real control and asserts visible Settings before capturing the retained evidence.
- The available sealed Ladybug cache was rejected because its Cargo.lock identity
  differed from main. Native checks compiled from source; no mismatched artifact
  was admitted.
- The first full check passed Clippy but failed one unrelated completion trace:
  `a_failed_activation_fails_the_child_in_both_stores_and_an_exact_retry_reports_it`
  observed `life=failed/status=failed` while `phase=launching`, before settling.
  That trace passed an isolated rerun. Its fixture awaits failure but asserts the
  later phase. The failure remains recorded here; it was not changed in this PR.
- The next full check stopped on the new unsupported-target fixture because it
  set a reason code without its paired message, violating the existing SQLite CHECK.
  The fixture now supplies both fields. Both real SQLite projection tests pass.
- A subsequent full check reached real model-catalog integration and required
  the new `repairProviderIds` API field in two renderer fixtures. Regeneration
  through the actual test added only an empty array to available harnesses. That
  integration scenario passed; the fixture consumers passed 30 renderer tests.
- `npm run build` passed, including native app/graph servers, TypeScript and all
  workspace packages. The subsequent sequential `npm run check` also passed.
  Its broad Vitest suite passed 310 files and 3,846 tests (one file and three
  tests skipped); the secret boundary passed two tests, and Python passed 77.
  Workspace native tests, crash reconciliation, formatting, Clippy, TypeScript,
  Ladybug receipts and PRD readability all passed. [Final gate summaries](final-gates.txt)
  bind these results to the reviewed source digest below.

- The broad Vitest run passed 3,844 scenarios but failed the old capture scene
  inventory and global social-preview receipt. The capture test now expects the
  added repair scene and verifies its complete journey. The named real Electron
  social-preview recapture passed; both images are byte-identical to their prior
  evidence, while the genuine generated receipt binds the current renderer/main.
  No assertion, image check or receipt check was removed. The two real renderer
  evidence test files then passed all six scenarios in 83.68 seconds. The reviewer
  independently verified the regenerated receipt against the runner output, source
  files and renderer manifest; both old PNGs remain byte-identical.

- A further broad run was invalidated by my concurrent `npm run build`: its
  clean step removed `packages/harness-host/dist` while Vitest was importing it.
  That run failed missing-package/ENOENT boundaries, not a qualified source gate.
  The build completed successfully. The final check ran sequentially against
  stable output, with no concurrent build, and passed. This collision is preserved explicitly.

## Adversarial review

Reviewer `/root/recovery_review` found the missing/unsupported-target conflation
and independently reproduced the failure through the real recipe resolver.
After correction, their same macOS x64 scenario prepared nothing. Those original review assertions at
`7666f0abb833c55d4e9e5e443653faf1129f55799548624784c8bb79289f664b` and
`dc62ec9262c7f20552afb80d3e7c07973a7d64c5dddcdb308f4e7e404da2eff1`
are withdrawn: they checked admission but missed authorization expiration during
installation. The final source review below supersedes them.
They also inspected all five retained screenshots and the genuine secondary
social-preview recapture. This is a non-certifying
source review; heavy checks and actual kernel evidence are separate. It excludes
live credentials, paid execution, packaged/signed upgrades and unavailable platforms.

## Reproduce the visible journey

```sh
fnm exec --using 22.23.2 npm run prepare:desktop-runtime
fnm exec --using 22.23.2 npm run evidence:provider-ux -- --scene=harness-repair --output-dir /private/tmp/prime-recovery-ui
```

Chrome and ffmpeg are required. The recording verifies OpenRouter appears connected, missing Prime is excluded
from the picker, exactly one refresh per click targets OpenRouter, failure retains
the icon, success exposes the actual Prime option in the composer, and saved defaults remain equal.

## Merge refresh on October 9, 2026

Main advanced through sealed CompletionContracts and the communication baseline.
The sole merge conflict was the generated social-preview receipt. The real
Electron recapture regenerated it against combined source; both PNGs remained
byte-identical. No repair production code required conflict resolution.

The source reviewer rechecked the combined 25-path digest above and found no
remaining interaction or authority issue. The newer Prime client seal required
fresh runtime proof: the retained kernel log now records the combined recipe.
[Merge-refresh gates](merge-refresh-gates.txt) record passing build, full check,
319 Vitest files / 4,189 tests, two secret-boundary tests, 91 Python tests, and
clean exact Prime assembly/kernel. The earlier gate summary remains historical.

## Review corrections before merge

GitHub's unresolved reviews identified provider authorization expiring during first
installation, and missing access contracts exposing an impossible Repair. Merge was
held while these findings were reproduced and corrected.

| Additional production seam | Boundary | Deterministic checkpoint |
| --- | --- | --- |
| Provider lifecycle authorization | Original discovery generation survives async work; sign-out, removal, reconnect, shutdown and disconnected catalogs invalidate setup. A late connected callback cannot reopen setup during a pending sign-out commit. | Actual composition lifecycle scenarios and delayed sign-out commit in `provider-connection-generation.test.mjs` |
| Explicit catalog/readiness order | A fresh connected catalog commits before guarded readiness; disconnected catalogs run no readiness. | Existing disconnected-provider recovery and superseded-refresh composition scenarios |
| Coordinator async boundaries | Expiration during target validation, checking or queued publication records nothing and retains due marks. | `harness-readiness.test.mjs` lifetime boundary table |
| Resolver and shared installer | Forward cancellation through Desktop and Eval. One valid consumer preserves shared work; all cancelled consumers stop installation. A new consumer waits for cancelled cleanup then retries. | Real installer/immutable activation scenarios in `managed-runtime-promotion.test.mjs`, plus full Desktop/Eval gates |
| Rust readiness update wire and transaction | Transient provider stamps require active, connected and exact generation in the readiness commit; rejected writes retain unavailable and due. No provider-by-harness persistence is added. | Real SQLite `readiness_provider_generation_is_checked_in_the_commit_transaction`, including same-generation disconnection |
| Evidence subprocess cleanup | Both browser paths close inherited stderr after bounded browser shutdown; Chrome crash-reporters cannot retain the capture process. | Actual full-video and focused/onboarding/sidebar subprocess scenarios in `provider-electron-evidence.test.mjs` exit with intact artifacts and manifests |
| Repair projection | Missing reason and empty access-contract declarations produce no repair provider. Existing legacy usable-route semantics remain unchanged. | Existing real SQLite repair scenario extended with independent reason/list boundaries |

The focused suite passed 160 scenarios across eight files; both named SQLite
checkpoints passed. No tests were deleted. Existing mock assertions now check the
forwarded signal and exact provider stamp. The old superseded-refresh scenario
uses connected discovery so it still exercises readiness after the explicit
connected-catalog gate. An explicit refresh queues another refresh for the same
provider; the independent committed-disconnection callback tests that separate
boundary directly.

Reviewer `/root/recovery_review` independently verified the final 28-path digest
`c1267eef021cff013eabfa5d225f0cb9e91a8b245d1fe821672cc1f587d32c74`,
repeated the late-catalog public-service reproduction and ran the actual delayed
sign-out regression. Verdict: no remaining findings. This supersedes the withdrawn
review assertions and remains a non-certifying source review; required full gates
are reported separately. Genuine Electron recapture refreshed the source receipt;
both retained images stayed byte-identical.

The first full review-fix run passed 4,202 JavaScript scenarios and failed three
Eval fixture assertions around cancellation options. A follow-up focused run
also caught a changed logged-out status. The final implementation keeps existing
status overrides unchanged; lifetime safety rests on the complete sign-out
transition, unrecorded-sign-out fence and committed catalog state. Eval retains
the unscoped preparation call shape and forwards exact guarded preparation and
publication options. All 20 Eval setup scenarios and the combined 160-scenario
focused suite pass. A broad run started before that focused correction completed
was stopped; it is not evidence of a complete pass.

The subsequent full run passed 4,204 JavaScript scenarios but timed out in the
focused capture subprocess. An isolated reproduction completed all artifacts yet
kept running: `lsof` identified a Chrome crash-reporter retaining the inherited
stderr socket after browser exit. The runner now destroys that pipe after bounded
browser shutdown in both capture paths. The actual five-scenario capture file
passed in 61.96 seconds without changing timeouts or artifact assertions. The
reviewer independently verified the refreshed digest above and this cleanup seam;
no remaining findings. The reproduction was interrupted after confirming the
leaked pipe, and is not a passing gate.

### Final review-fix gates

The final sequential `npm run build` and `npm run check` passed on the 28-path
source digest above. The full Vitest portfolio passed 319 files / 4,205 scenarios,
with one file / three scenarios skipped. Both real capture subprocess scenarios
passed within that full run. Secret-boundary verification passed two tests;
Python passed 91 tests. Native workspace and crash-reconciliation tests, formatting,
Clippy, TypeScript, Ladybug receipt gates and PRD readability passed.
[Compact gate record](review-fix-gates.txt) and [actual capture run](review-fix-capture.txt)
retain the results. Clean exact Prime assembly and its actual isolated kernel
reported `ready=true`; no inference was used.
