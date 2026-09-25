# Issue 418: Account reachability

This change preserves Account in the expanded sidebar footer and adds a shell Navigation disclosure when the sidebar is collapsed or the viewport is at most 760px wide. The disclosure contains Settings and Account. Account uses the same controller state, accessible presentation, sign-in action, and Account settings route as the footer control. It does not create a floating Account overlay.

## Deterministic checkpoints

- `test/desktop-account-ui.test.mjs` exercises both Account controls against the same controller, including direct sign-in, signing-in disabled presentation, state updates, and the existing-account Settings action.
- The same suite confirms both controls are hidden when the desktop account API is absent.
- `test/shell-navigation.test.mjs` exercises responsive visibility, navigation dispatch through the existing controls, Escape focus return, outside dismissal, and listener cleanup.
- The shell-navigation controller test also verifies Eval keeps the disclosure hidden when the sidebar is collapsed.
- `test/settings-navigation.test.mjs` exercises Settings panel selection and return navigation.

## Rendered renderer evidence

The applicable rendered entry point is `npm run evidence:provider-ux -- --output-dir /Users/vishal/.codex/worker-pilot/evidence/factory-418-provider-ux-final`. It uses the production renderer with local fake product/account APIs and no live Auth0 or paid inference. The interaction audit checks Settings routing and return focus, the compact Settings selector at narrow widths, Escape focus return, disclosure bounds, and synchronized Account controls during fake sign-in. Captured variants include the open and closed menu at 620px, dark and light appearance, emulated forced-colors mode, 760px/761px breakpoint behavior, collapsed navigation at 1280px, the expanded footer at 980px/1280px, and a saved-thread Environment panel.

Capture passed on macOS Chrome with no platform limitation observed. The exact captured source was HEAD `61ce7b0cc50ee819eb54568cb8fc7165bf6c1e01` and workspace SHA-256 `3ef1a9c204f845c9f1815dee0424bac308923c4a23157ba64e1d91b0681bd4bb` over all 15 modified/untracked repo files, including the new controller and tests. The pre-capture source inventory is `/Users/vishal/.codex/worker-pilot/evidence/factory-418-final-capture-source.txt`. The command was `PATH=/Users/vishal/.nvm/versions/node/v22.23.2/bin:$PATH CARGO_TARGET_DIR=/Volumes/2T-SSD/worktrees/factory-418/target npm run evidence:provider-ux -- --output-dir /Users/vishal/.codex/worker-pilot/evidence/factory-418-provider-ux-final`; all eight video chapters and all 22 screenshot variants passed their DOM and interaction audits. Full output: `/Users/vishal/.codex/worker-pilot/evidence/factory-418-provider-ux-final.log`; screenshot hashes and bytes are in the external `manifest.json`. Visual inspection confirmed the Navigation trigger is clear of the saved-thread Environment panel and the 761px expanded layout does not show the disclosure.

## Required repository gates

After the digest-bound capture, `test/provider-electron-evidence.test.mjs` was updated to expect the new 10 screenshot variants, and `desktop/shared/telemetry-module-inventory.mjs` was updated to include the new renderer module. Their focused tests passed (5/5). These two inventory/test files and this README are the only post-capture deltas; the renderer and capture-script bytes remain unchanged.

`npm run check` passed with Node 22.23.2, `CARGO_TARGET_DIR=/Volumes/2T-SSD/worktrees/factory-418/target`, `CARGO_BUILD_JOBS=2`, and `RUST_TEST_THREADS=2`. It includes Cargo formatting/clippy/tests, crash-reconciliation tests, native package builds, TypeScript/workspace checks, Vitest, the Codex secret-boundary tests, 29 Python tests, Ladybug receipt lint, and PRD readability. Vitest reported 173 passed files, 1 skipped file, 2,272 passed tests, and 3 skipped tests. `npm run build` passed with the same Node and private Cargo target settings. The only compiler diagnostics were the repository’s existing Rust dead-code warnings in `relayer-graph-server`. Full logs are `/Users/vishal/.codex/worker-pilot/evidence/factory-418-check-final.log` and `/Users/vishal/.codex/worker-pilot/evidence/factory-418-build.log`; the first check attempt’s two exact-inventory failures and their repairs are preserved in `/Users/vishal/.codex/worker-pilot/evidence/factory-418-check.log` and `/Users/vishal/.codex/worker-pilot/evidence/factory-418-inventory-focused.log`.

The pre-README gate source was HEAD `61ce7b0cc50ee819eb54568cb8fc7165bf6c1e01`, workspace SHA-256 `e98b3cf1123ae3d645d92ae80f9a1e458be65d425f88cd319ed5fcdf3b997b7e` over all 17 changed/untracked files. This README update is evidence-only; it does not change executable code or tests.
