# Issue 418: Account reachability

This change preserves Account in the expanded sidebar footer and adds a shell Navigation disclosure when the sidebar is collapsed or the viewport is at most 760px wide. The disclosure contains Settings and Account. Account uses the same controller state, accessible presentation, sign-in action, and Account settings route as the footer control. It does not create a floating Account overlay.

## Deterministic checkpoints

- `test/desktop-account-ui.test.mjs` exercises both Account controls against the same controller, including direct sign-in, signing-in disabled presentation, state updates, and the existing-account Settings action.
- The same suite confirms both controls are hidden when the desktop account API is absent.
- `test/shell-navigation.test.mjs` exercises responsive visibility, navigation dispatch, Escape focus return, outside dismissal, and listener cleanup. Its happy-dom regression wires the real Account and shell-navigation controllers to the same Account element and holds the Settings transition guard pending while verifying a single transition.
- The shell-navigation controller test also verifies Eval keeps the disclosure hidden when the sidebar is collapsed.
- Rendered Eval capture verifies narrow and collapsed layouts keep the disabled disclosure hidden and reserve no navigation header space.
- `test/settings-navigation.test.mjs` exercises Settings panel selection and return navigation.

## Rendered renderer evidence

The applicable rendered entry point is `npm run evidence:provider-ux -- --output-dir <absolute-output-directory>`. It uses the production renderer with local fake product/account APIs and no live Auth0 or paid inference. The interaction audit checks Settings routing and return focus, the compact Settings selector at narrow widths, Escape focus return, disclosure bounds, and synchronized Account controls during fake sign-in. Variants include the open and closed menu at 620px, dark and light appearance, emulated forced-colors mode, 760px/761px behavior, collapsed navigation at 1280px, the expanded footer at 980px/1280px, saved-thread Environment panel, and disabled Eval layouts at 620px and collapsed 1280px.

The repair-round-1 capture passed on macOS Chrome. Its pre-capture receipt is `/Users/vishal/.codex/worker-pilot/evidence/factory-418-r1-pre-capture.json`: HEAD `64526be55ebb31066d61ac014946e097b9b4a825`, workspace SHA-256 `6a4577225c0e8a8f8f19a2b99e3249a32facf9f87fee8fac4b166eb4420aa651`, with per-file SHA-256 for all nine changed/untracked files. Rerunning the receipt after capture produced a byte-identical JSON file. The command was `PATH=/Users/vishal/.nvm/versions/node/v22.23.2/bin:$PATH CARGO_TARGET_DIR=/Volumes/2T-SSD/worktrees/factory-418/target npm run evidence:provider-ux -- --output-dir /Users/vishal/.codex/worker-pilot/evidence/factory-418-provider-ux-r1`. All eight video chapters and all 25 variants passed their DOM and interaction audits. The two Eval screenshots visually show the app workspace with no extra header row; their manifest SHA-256 values are `bb353d4567f6ae8cce10bf0fc0dc058dc874b5adef6d17430648c05043cbd43e` (620px) and `af4b6bf6c0ea1cd9478ac626d8c5e386abe91aebccdc468206e46b24a9eff79e` (collapsed 1280px). Full capture log: `/Users/vishal/.codex/worker-pilot/evidence/factory-418-provider-ux-r1-attempt5.log`; screenshot hashes and video metadata are in its external `manifest.json`.

### Reproducible source receipt

From the dirty worktree, before staging, enumerate `git diff --name-only` plus `git ls-files --others --exclude-standard`, sort and de-duplicate the paths, and compute each file’s SHA-256. The aggregate is SHA-256 over the ASCII `HEAD` commit followed by LF, then each UTF-8 relative path, NUL, raw file bytes, NUL, in sorted path order. Generate canonical JSON with this recipe and save it before capture/check; rerun it afterward and byte-compare the receipts:

```python
import hashlib, json, subprocess
from pathlib import Path
root = Path.cwd()
head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
tracked = subprocess.check_output(["git", "diff", "--name-only"], cwd=root, text=True).splitlines()
untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard"], cwd=root, text=True).splitlines()
paths = sorted(set(tracked + untracked))
aggregate = hashlib.sha256(head.encode("ascii") + b"\n")
files = []
for name in paths:
    data = (root / name).read_bytes()
    files.append({"path": name, "sha256": hashlib.sha256(data).hexdigest()})
    aggregate.update(name.encode("utf-8") + b"\0" + data + b"\0")
print(json.dumps({"head": head, "workspaceSha256": aggregate.hexdigest(), "files": files}, indent=2) + "\n")
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
