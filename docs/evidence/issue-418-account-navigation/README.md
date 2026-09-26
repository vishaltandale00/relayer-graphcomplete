# Issue 418: Persistent sidebar and Account reachability

The current product decision keeps the existing sidebar visible at every viewport width. At widths up to 760px it starts as a collapsed icon rail; the existing toggle expands that same sidebar in document flow, reducing the graph canvas and composer width. An explicit expansion remains usable until the viewport leaves and re-enters the narrow breakpoint. Account and Settings remain footer controls: icons in the collapsed rail and labels in the expanded sidebar. There is no dropdown, overlay drawer, or duplicate navigation controller.

## Current deterministic checkpoints

- `test/sidebar.test.mjs` checks narrow initialization, accessible toggle state, explicit narrow expansion persistence, breakpoint re-entry behavior, in-flow sidebar markup, and parent-sized composer layout.
- `test/graph-viewport-resize.test.mjs` exercises the production graph resize observer: an automatic-fit camera refits after the stage changes size, while manual camera state and active gestures are preserved.
- `test/desktop-account-ui.test.mjs` preserves signed-out, signing-in, signed-in, onboarding, and desktop account guard behavior through the single footer Account control.
- `test/settings-navigation.test.mjs` covers Settings panel selection and return focus to the sidebar toggle.
- The replaced `test/shell-navigation.test.mjs` covered dropdown disclosure, dismissal, and duplicate Account-controller wiring. Those boundaries no longer exist in the decided interface. Their replacement boundaries are persistent rail state and keyboard toggle (`test/sidebar.test.mjs`), graph/canvas reflow (`test/graph-viewport-resize.test.mjs`), and the retained single-control account and Settings behavior (`test/desktop-account-ui.test.mjs`, `test/settings-navigation.test.mjs`).

The rendered capture entry point is `npm run evidence:provider-ux -- --output-dir <absolute-output-directory> --scene=<scene>`. It uses the production renderer with local fake product/account APIs and no live Auth0 or paid inference. Sidebar scenes audit real saved graph nodes and canvas bounds, composer viewport bounds, and document scroll width. The focused `sidebar-thread-journey` records the actual collapse → expand → collapse interaction at 620px; the remaining scenes cover collapsed/expanded saved graph, new-thread composer, light appearance, 375px, 760px/761px, and 1280px. These captures are implementation evidence, not user visual acceptance.

The repair-round-1 capture passed on macOS Chrome. Its pre-capture receipt is `/Users/vishal/.codex/worker-pilot/evidence/factory-418-r1-pre-capture.json`: HEAD `64526be55ebb31066d61ac014946e097b9b4a825`, workspace SHA-256 `6a4577225c0e8a8f8f19a2b99e3249a32facf9f87fee8fac4b166eb4420aa651`, with per-file SHA-256 for all nine changed/untracked files. Rerunning the receipt after capture produced a byte-identical JSON file. The command was `PATH=/Users/vishal/.nvm/versions/node/v22.23.2/bin:$PATH CARGO_TARGET_DIR=/Volumes/2T-SSD/worktrees/factory-418/target npm run evidence:provider-ux -- --output-dir /Users/vishal/.codex/worker-pilot/evidence/factory-418-provider-ux-r1`. All eight video chapters and all 25 variants passed their DOM and interaction audits. The two Eval screenshots visually show the app workspace with no extra header row; their manifest SHA-256 values are `bb353d4567f6ae8cce10bf0fc0dc058dc874b5adef6d17430648c05043cbd43e` (620px) and `af4b6bf6c0ea1cd9478ac626d8c5e386abe91aebccdc468206e46b24a9eff79e` (collapsed 1280px). Full capture log: `/Users/vishal/.codex/worker-pilot/evidence/factory-418-provider-ux-r1-attempt5.log`; screenshot hashes and video metadata are in its external `manifest.json`.

### Reproducible source receipt

From the dirty worktree, before staging, enumerate `git diff --name-only` plus `git ls-files --others --exclude-standard`, sort and de-duplicate the paths, and compute each existing file’s SHA-256. Record deleted paths separately (do not attempt to read them); the aggregate covers only extant changed or untracked source files. The aggregate is SHA-256 over the ASCII `HEAD` commit followed by LF, then each UTF-8 relative path, NUL, raw file bytes, NUL, in sorted path order. Generate canonical JSON with this recipe and save it before capture/check; rerun it afterward and byte-compare the receipts:

```python
import hashlib, json, subprocess
from pathlib import Path
root = Path.cwd()
head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
tracked = subprocess.check_output(["git", "diff", "--name-only"], cwd=root, text=True).splitlines()
untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard"], cwd=root, text=True).splitlines()
paths = sorted(set(tracked + untracked))
aggregate = hashlib.sha256(head.encode("ascii") + b"\n")
files, deleted = [], []
for name in paths:
    path = root / name
    if not path.exists():
        deleted.append(name)
        continue
    data = path.read_bytes()
    files.append({"path": name, "sha256": hashlib.sha256(data).hexdigest()})
    aggregate.update(name.encode("utf-8") + b"\0" + data + b"\0")
print(json.dumps({"head": head, "workspaceSha256": aggregate.hexdigest(), "files": files, "deletedPaths": deleted}, indent=2) + "\n")
```
Run with Node 22.23.2 in the environment. If only evidence documentation changes afterward, list it as a docs-only delta and retain the earlier source receipt without claiming a full-tree match.

The first capture failure history is retained in `/Users/vishal/.codex/worker-pilot/evidence/factory-418-provider-ux.log` and `factory-418-provider-ux-attempt3.log` through `attempt7.log`:

- The initial provider-UX capture stopped because its onboarding frame was only 7,077 bytes. The capture prerequisites were then completed with `npm run prepare:renderer` and `npm run build:packages`; do not treat that undersized frame as evidence.
- Attempts 3 and 4 timed out waiting for the optional Account controls. This was a fixture-readiness race: the runner needed to wait for either the optional onboarding step or the footer, continue without an account, then wait for the Account controls to render.
- Attempt 5 timed out returning from Settings because the capture wait predicate was inverted. The predicate was corrected and the focused Settings interaction then completed.
- Attempt 6’s Account audit failed because the production onboarding completion revealed only the footer Account control, leaving the disclosure item hidden. The production controller was fixed to reveal/hide both controls together; tests cover that shared lifecycle.
- Attempt 7 passed the navigation journey, but later screenshot inspection found the Navigation trigger overlapped the saved-thread Environment panel. The layout was adjusted to reserve a title row only when the disclosure is enabled; subsequent capture also corrected the 761px case to remain expanded.

These attempts are historical and superseded by the repair-round capture only when its source receipt and result are recorded below.

Repair-round capture attempts are also preserved separately. Attempt 1’s expected “Relayer Eval” text was not stable at the runner’s ready checkpoint; the audit was changed to test the actual disabled disclosure and zero padding. Attempt 2 showed `bodyMode=false` and `mainPaddingTop=44px`: the inline Eval stub had not taken effect before production state initialized, so it moved to the first-loaded external fixture module. Attempt 3 passed its layout audit but the screenshot still showed account onboarding because the runner observed the app shell before the account controller rendered. The fixture now waits for the optional step or footer, continues without an account, and waits for both onboarding dismissal and the footer control before capture. Attempt 4 passed with the prior account-state race; attempt 5 includes the completed wait and captured the workspace. Logs are `/Users/vishal/.codex/worker-pilot/evidence/factory-418-provider-ux-r1.log` and `factory-418-provider-ux-r1-attempt2.log` through `attempt5.log`.

The full `npm run check` first reported one unrelated timing-sensitive failure in `test/graph-operation-recorder.test.mjs`: under parallel load, its 10ms “still waiting” assertion observed the in-flight export settle first. The exact test passed in isolation (1 passed, 9 skipped), confirming a scheduling-sensitive failure. One unchanged full-check retry passed. Vitest reported 173 passed files, 1 skipped file, 2,273 passed tests, and 3 skipped tests; the Codex secret-boundary suite passed 2 tests, Python passed 29, and the receipt/readability checks passed. `npm run build` also passed. The full logs are `/Users/vishal/.codex/worker-pilot/evidence/factory-418-r1-check.log`, `factory-418-r1-check-retry.log`, and `factory-418-r1-build.log`. Compiler output contains only the existing `relayer-graph-server` dead-code warnings.

The pre-check receipt is `/Users/vishal/.codex/worker-pilot/evidence/factory-418-r1-pre-check.json`, workspace SHA-256 `b778d2d9ce361d4e073c51b002d2226c4d7e0f403b6e8a0fddef48deacfded4c` over nine files. The post-check receipt was byte-identical. Capture-to-check per-file comparison found one docs-only change: this README was updated with the successful capture history and result; the other eight file hashes match the pre-capture receipt. This final gate summary is another README-only delta after the pre-check receipt.

### Review history

The two round-one reports, `/Users/vishal/.codex/worker-pilot/factory-418-round1-standards.md` and `factory-418-round1-spec.md`, reviewed commit `64526be55ebb31066d61ac014946e097b9b4a825` and returned changes requested. Their verdicts apply only to that source and are invalidated by repair-round-1 changes. The confirmed findings were same-element Account click replay, empty reserved header space in Eval, and missing earlier capture-failure history. This section preserves the original reports as historical evidence; fresh review is required for the repair commit.

## Required repository gates

After the digest-bound capture, `test/provider-electron-evidence.test.mjs` was updated to expect the new 10 screenshot variants, and `desktop/shared/telemetry-module-inventory.mjs` was updated to include the new renderer module. Their focused tests passed (5/5). These two inventory/test files and this README are the only post-capture deltas; the renderer and capture-script bytes remain unchanged.

`npm run check` passed with Node 22.23.2, `CARGO_TARGET_DIR=/Volumes/2T-SSD/worktrees/factory-418/target`, `CARGO_BUILD_JOBS=2`, and `RUST_TEST_THREADS=2`. It includes Cargo formatting/clippy/tests, crash-reconciliation tests, native package builds, TypeScript/workspace checks, Vitest, the Codex secret-boundary tests, 29 Python tests, Ladybug receipt lint, and PRD readability. Vitest reported 173 passed files, 1 skipped file, 2,272 passed tests, and 3 skipped tests. `npm run build` passed with the same Node and private Cargo target settings. The only compiler diagnostics were the repository’s existing Rust dead-code warnings in `relayer-graph-server`. Full logs are `/Users/vishal/.codex/worker-pilot/evidence/factory-418-check-final.log` and `/Users/vishal/.codex/worker-pilot/evidence/factory-418-build.log`; the first check attempt’s two exact-inventory failures and their repairs are preserved in `/Users/vishal/.codex/worker-pilot/evidence/factory-418-check.log` and `/Users/vishal/.codex/worker-pilot/evidence/factory-418-inventory-focused.log`.

The pre-README gate source was HEAD `61ce7b0cc50ee819eb54568cb8fc7165bf6c1e01`, workspace SHA-256 `e98b3cf1123ae3d645d92ae80f9a1e458be65d425f88cd319ed5fcdf3b997b7e` over all 17 changed/untracked files. This README update is evidence-only; it does not change executable code or tests.

## Sidebar replacement evidence

The current persistent-sidebar capture is stored under `/Users/vishal/.codex/worker-pilot/evidence/factory-418-sidebar/final-v5/`. It ran 22 sidebar scenes individually against one frozen source receipt (workspace SHA-256 `88d97ddfcb712875d1ba7ebd09b1c5b48352640121875dced3f2275870836b91`); pre-capture and post-capture receipt JSON files are byte-identical. Coverage includes populated saved graphs and new-thread composers, collapsed and expanded rails, 375px, 421px, 450px, 480px, 483px open scope/permission/model menus, 620px light/dark, 760px/761px, and 1280px. The 620px collapse → expand → collapse recording has 54 production-renderer frames, lasts 9 seconds, and has SHA-256 `9edb9019772f011e59b0c39af4d8393c1b88b80d615cd18266f67197e9db3fa4`. Per-image hashes and geometry audits are in `/Users/vishal/.codex/worker-pilot/evidence/factory-418-sidebar/final-v5/capture-manifest.json`. These captures use deterministic local product/account fixtures, not live Auth0 or paid inference, and do not claim user visual acceptance. At 375px expanded, the 210px sidebar leaves a narrow graph area where content may be panned at the existing minimum zoom; page and controls remain within the viewport.

The earlier `final-v4` portfolio used source SHA-256 `82983657bf2b4c49ffcec08052591b7fed7615721f53754a4d5dba4df37a4a3f` and is superseded because later changes repaired provider-flow fixture isolation, stacked footer labels at the 761–980px range, and corrected the interaction-video screenshot frame metadata. Those final-source changes were followed by a four-test pass of `test/provider-electron-evidence.test.mjs`, including the full provider flow and the 960px account-footer state. The first final-v5 scene ended with a Chrome profile-directory `ENOTEMPTY` cleanup race; one unchanged retry passed. Its failed and retry logs are preserved under `final-v5/logs/`. A previous full `npm run check` had reached Vitest with one failure: the generic provider-flow capture timed out waiting for the optional account step after the sidebar fixture globally signed in. This failure led to restricting signed-in fixture recovery to `sidebar-*` scenes; generic provider scenes retain their signed-out start. The failed full-check log remains preserved in `/Users/vishal/.codex/worker-pilot/evidence/factory-418-sidebar/final-v4/npm-check.log`; do not report it as passing. Final gate results are recorded against the exact commit in PR #477.

The earlier `final-v3` capture used workspace SHA-256 `76426721d313bf35a751787eff2b3628dd74c95c7e808971c1a816e3bb42b25d` and covered 12 scenes. It remains preserved as superseded historical evidence; its receipt does not bind the final viewport-menu correction. The first expanded-scene attempt had a Chrome profile-directory `ENOTEMPTY` cleanup race and an unchanged retry passed. An earlier full-check attempt was stopped after the 421px responsive review superseded its source; its partial log is preserved separately and is not a passing result for the final source. Final gate results are recorded against the exact commit in PR #477.


### Final verification history

The first final-v5 full check failed the existing recorder timing assertion: expected `waiting`, observed `exported`. The isolated recorder suite passed 10/10 tests. One unchanged full retry passed all 2,274 Vitest tests (174 files), the secret-boundary suite, 29 Python tests, and Ladybug checks, then failed PRD readability on two sentences. The sentences were split without changing product meaning; standalone readability then passed. Logs are `final-v5/npm-check.log`, `final-v5/graph-operation-isolated.log`, and `final-v5/npm-check-retry1.log` under the external evidence directory. Neither failed full command is a passing full-check result. The final capture remains applicable to unchanged executable files; only PRD wording and this evidence ledger changed afterward. Final source receipts and check/build results are recorded separately under `final-v5/astra-final-*` and in PR #477.
