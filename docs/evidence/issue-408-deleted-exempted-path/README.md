# Issue 408: deleted exempted paths

## Scope and source snapshot

The planner now sends a deleted changed path that matches a zero-chapter
chapter or script owner to the existing full-plan fallback. Present exemptions
retain their affected/no-chapter behavior. Exact owners, prefix owners, and
script owners are covered through the production planner CLI and isolated
temporary repositories. The optional recursive corpus scan and arbitrary
location test discovery hardening remain deferred.

Base commit: `61ce7b0cc50ee819eb54568cb8fc7165bf6c1e01`.

The implementation host keeps exact source digests and command logs under
`/Users/vishal/.codex/worker-pilot/evidence/factory-408/`. The initial heavy
gates passed against executable diff digest
`e31eeaa118651ec80c89d8ee91969d74b117e4ffbb465154bb166ea767a09d98`, at commit
`00ff1ca546182003ce519a192636ad5ba691b941`. A subsequent spec review required
an additional test for deleting the empty exempted prefix directory. The
current working source diff against the same base is
`1678fcaf91d5c91596d4b37fc11d509b30475c58fd6911d7ea9bd16be11a1bd4`; it adds
the review-required test case and leaves production code unchanged. The heavy
gates have not yet been rerun against this follow-up snapshot.

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
  `full` mode. The review-required empty-prefix-directory regression also
  failed against the old planner with `affected` mode.
- Initial `npx vitest run test/ci-affected-plan.test.mjs`: **passed**, 53 tests.
- Review follow-up `npx vitest run test/ci-affected-plan.test.mjs`: **passed**,
  54 tests. The added case removes both `docs/postmortems/entry.md` and the now
  empty `docs/postmortems/` directory before invoking the planner CLI.
- `npx vitest run test/ci-affected-plan.test.mjs test/ci-chapter-runner.test.mjs test/ci-verification-portfolio.test.mjs test/ci-required-check.test.mjs`:
  **passed**, 81 tests across 4 files.
- `git diff --check`: **passed**.
- Running the production planner for `scripts/ci/plan-affected.mjs` selected
  `full` with reason `full-portfolio input`; all seven chapters were true.
- Review-snapshot `npm run check` first hit one timeout in the unrelated
  macOS-only Homebrew Node closure test. The same test passed alone in 15.00s
  with its existing 30s limit, and it had passed in the initial full gate. The
  single unchanged full-check retry passed. It reported 2,271 passed and 3
  skipped across 172 passing files and 1 skipped file; Rust workspace and
  crash-reconciliation tests passed; secret-boundary reported 2 passed; Python
  reported 29 passed; Ladybug receipt checks and PRD readability passed. Both
  failed-first and passing-retry logs are preserved on the implementation host.
- Review-snapshot `npm run build`: **passed**, exit 0; root Rust/TypeScript and
  all four package builds completed.
- Hosted PR CI passed for the initial commit but does not cover the review
  follow-up. Updated hosted PR CI and a fresh adversarial review are **pending**.
  No Electron UI or paid-inference proof was run.

Detailed logs, including the old-planner failures, the focused green suite,
the initial gate results, the review-snapshot timeout and unchanged retry, and
the final build, are in the host evidence directory above. The review-snapshot
gates cover source digest
`1678fcaf91d5c91596d4b37fc11d509b30475c58fd6911d7ea9bd16be11a1bd4`.
