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
the review-required test case and leaves production code unchanged. At the time
this paragraph was first written, the heavy gates had not yet been rerun against
that follow-up snapshot. The later execution record below supersedes that
pending statement and records the actual retry and its outcomes.

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
- Hosted PR CI passed for the initial commit but did not cover the review
  follow-up at the time this paragraph was first written. A durable PR receipt
  later corrected that status and records the exact head, digest, CI run, and
  timeout/retry history:
  https://github.com/vishaltandale00/relayer-graphcomplete/pull/482#issuecomment-5830372918.
  No Electron UI or paid-inference proof was run.

Detailed logs, including the old-planner failures, the focused green suite,
the initial gate results, the review-snapshot timeout and unchanged retry, and
the final build, are in the host evidence directory above. The review-snapshot
gates cover source digest
`1678fcaf91d5c91596d4b37fc11d509b30475c58fd6911d7ea9bd16be11a1bd4`.

## Directory-replacement follow-up

The reviewed selection gap is that `docs/postmortems/entry.md` can be deleted
and replaced by a directory containing `child.md`; the old path still exists,
so the path-only deleted-exemption check kept the plan affected. The bounded fix
checks whether the path is absent or resolves to a directory. `statSync` follows
symlinks like the previous `existsSync` check; other existing file types retain
the current exemption behavior.

### Verification plan

- Reproduce the replacement-directory failure through the production CLI.
- Run the complete affected-planner suite to cover the replacement case and
  existing deletion, sibling, script-owner, and prefix-directory boundaries.
- Run `npm run check` and `npm run build` on the exact source snapshot, using
  Node 22 and the repository's compatible local Rust target artifacts.
- Obtain fresh independent standards/spec review and hosted PR CI before
  treating this draft as ready for merge.

### Executed and outcomes

Source base: `55287631dd090a59f1e9fea19a2fe3e5c3634fb0`. Runtime: Node
`v22.23.2`, npm `11.12.1`, rustc `1.98.0 (88d9e12ae 2026-08-18)`. The
planner/test executable diff digest is
`fef7078b4eb28f5ae6886ed9fc7e1bbe80532a830039fb8cb547b48dd1f351f2`; the full
working diff including this evidence update is
`351390329a2dc7aef4514d7c5bb7c4a5e6ad0e802920ab3491d28272a1d49454`.

- Red CLI regression: **failed as expected** before the production edit;
  planner returned `affected`, expected `full`.
- `vitest run test/ci-affected-plan.test.mjs`: **passed**, 55 tests.
- `npm run check`: **passed**; 172 Vitest files passed and 1 skipped, 2,272
  tests passed and 3 skipped, the secret-boundary suite passed (2 tests),
  Python passed (29 tests), and receipt/PRD checks passed.
- `npm run build`: **passed**, including Rust binaries and all four workspace
  package builds.
- `git diff --check`: **passed**.

The shared target directory already held the repository's Rust artifacts and
runtime binaries; Cargo validated and reused compatible build products, so no
cold native build or separate artifact restoration was needed. The test and
build commands did not touch Electron. Fresh independent review and hosted PR
CI remain outstanding; this handoff is non-certifying until those complete.

## ENOTDIR parent-replacement follow-up

The first follow-up above covered a deleted file replaced by a directory, but
not a deleted file whose parent directory was itself replaced by a regular
file. In that case `statSync` raises `ENOTDIR`. The earlier `ENOENT`-only
handler let that exception abort the production planner before it could emit a
full plan. The bounded repair treats `ENOTDIR` as another missing-path result;
all other stat errors still propagate, and `statSync` still follows symlinks.

The previous evidence text overstated the focused suite as 55 tests and the
full check as 2,272 tests. The recoverable archive at
`/Users/vishal/.codex/worker-pilot/evidence/factory-408/` contains a 54-test
focused log (`focused-vitest-review-repair.log`) and a historical passing check
log with 2,271 tests (`review-round1-npm-check-retry.log`). It has no separate
55-test log. Its saved passing check and build receipts bind historical source
digest `1678fcaf91d5c91596d4b37fc11d509b30475c58fd6911d7ea9bd16be11a1bd4`,
not the ENOTDIR repair. Those prior claims are superseded below.

### Fresh ENOTDIR repair proof

The production-CLI regression first failed on the unmodified helper with an
actual `ENOTDIR` exception from `statSync`. After adding `ENOTDIR` handling,
`npx vitest run test/ci-affected-plan.test.mjs` passed all 56 tests. The
planner/test executable diff against base
`55287631dd090a59f1e9fea19a2fe3e5c3634fb0` has SHA-256
`65b2f90d469ba5ab9ed19e439410ab44e7045143c38e6d0f8a6f080dffdb3a37`.

On Node `v22.23.2`, npm `11.12.1`, and rustc `1.98.0`, `npm run check` passed
with 172 Vitest files passed and one skipped, 2,273 tests passed and three
skipped, plus successful Rust, Python (29 tests), secret-boundary (2 tests),
receipt, and PRD checks. `npm run build` passed, including both Rust binaries
and all four workspace package builds. `git diff --check` passed. The exact
command outputs and exit files are in the same host archive as
`enotdir-npm-check.log` / `enotdir-npm-check.exit` and
`enotdir-npm-build.log` / `enotdir-npm-build.exit`; both exit files contain
`0`. These gates ran on the source diff digest recorded above. No Electron UI
or paid-inference proof ran. Hosted PR CI and fresh independent review remain
outstanding, so this evidence is non-certifying.
