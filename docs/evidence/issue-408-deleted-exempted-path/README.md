# Issue 408: deleted exempted paths

## Scope and source snapshot

The planner now sends a deleted changed path that matches a zero-chapter
chapter or script owner to the existing full-plan fallback. Present exemptions
retain their affected/no-chapter behavior. Exact owners, prefix owners, and
script owners are covered through the production planner CLI and isolated
temporary repositories. The optional recursive corpus scan and arbitrary
location test discovery hardening remain deferred.

Base commit: `61ce7b0cc50ee819eb54568cb8fc7165bf6c1e01`.

The exact executable-source diff digest and command logs are recorded under
`/Users/vishal/.codex/worker-pilot/evidence/factory-408/` on the implementation
host. The pre-gate executable diff digest was
`e31eeaa118651ec80c89d8ee91969d74b117e4ffbb465154bb166ea767a09d98`. Both
heavy gates ran against that same executable-source diff; only this evidence
ledger changed afterward.

## Required verification plan

- Demonstrate exact and prefix deletion failures against the old planner.
- Run the affected planner suite, then the four adjacent CI contract suites.
- Confirm that changing the affected planner itself selects full mode.
- Before commit, run `npm run check` and `npm run build` as required by the
  repository gate. Hosted PR CI must report the selected chapter and inner-lane
  outcomes for the exact PR head.

## Executed and outcomes

- Node `v22.23.2`; `npm ci` completed and its Electron postinstall downloaded
  the runtime. A later `npx electron install` attempt launched the Electron app
  with `install` as its argument, so it was terminated; the installed binary
  was confirmed with `node_modules/.bin/electron --version` (`v43.0.0`).
- Old-planner regression run: **expected failure reproduced**. Exact
  chapter-owner deletion, script-owner deletion, and prefix member deletion
  with a surviving sibling each returned `affected` instead of the required
  `full` mode.
- `npx vitest run test/ci-affected-plan.test.mjs`: **passed**, 53 tests.
- `npx vitest run test/ci-affected-plan.test.mjs test/ci-chapter-runner.test.mjs test/ci-verification-portfolio.test.mjs test/ci-required-check.test.mjs`:
  **passed**, 81 tests across 4 files.
- `git diff --check`: **passed**.
- Running the production planner for `scripts/ci/plan-affected.mjs` selected
  `full` with reason `full-portfolio input`; all seven chapters were true.
- `npm run check`: **passed**, exit 0. Rust workspace and crash-reconciliation
  tests passed; the full Vitest suite reported 2,270 passed and 3 skipped across
  172 passed files and 1 skipped file; the Codex secret-boundary suite reported
  2 passed; Python reported 29 passed; Ladybug receipt checks and PRD
  readability passed.
- `npm run build`: **passed**, exit 0; root Rust/TypeScript and all four package
  builds completed.
- Hosted PR CI and adversarial review are **pending**. No Electron UI or
  paid-inference proof was run.

Detailed logs, including the pre-fix expected failure and both heavy-gate
outputs, are in the host evidence directory above. The focused CLI tests observe
the changed production seam; the two heavy gates separately cover the
repository's deterministic verification portfolio for this executable source
snapshot.
