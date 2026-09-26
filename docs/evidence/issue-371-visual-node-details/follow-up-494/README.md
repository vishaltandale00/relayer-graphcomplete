# PR #494 CI and review follow-up

This follow-up starts from `283d03d98896ecb754584caa37a40a6910629677`.
Earlier evidence remains historical evidence for that exact source. New evidence
and reviews here supersede affected scopes when final verification is complete.

## Changed seams and checkpoints

| Seam | Deterministic checkpoint |
| --- | --- |
| CI dependency selection and clean build order | CI planner and chapter-runner tests require visual-assets before harness-host. Run the actual TypeScript chapter without existing visual-assets/dist. |
| Packaged Sharp entry points | Desktop verifier fixture uses the installed package's entry points and verifies its native filename against the installed files. Actual macOS packaging remains a CI gate. |
| File-backed asset input ownership | Visual-assets tests cover queued mutation, reentrant metadata changes, rejected reads, and failed byte copies without unhandled rejection. |
| No-op cursor stability | File-backed tag, association, organization, and archive no-ops preserve cursors and catalog revision. |
| Import media authority | Graph-server real-route test replaces the bridge during blocked validation and requires stale-response rejection followed by a successful fresh retry. |
| Asset content lifetime | Real graph/database tests cover replacement, clear, shared ownership, import removal, rollback, and reopening. |
| Export fetch cost | App export test counts production RuntimeClient requests for repeated accepted node placements. |
| Product import staging | App storage and import tests require separate per-digest content rows, legacy migration, and bounded row-by-row materialization. |

## Reproductions and decisions

`npm exec vitest -- run test/ci-chapter-runner.test.mjs test/desktop-shell.test.mjs --reporter=dot`
failed with an omitted visual-assets build and the same missing
`node_modules/sharp/lib/sharp.js` message as CI. A planner regression separately
failed because the host's dependency closure omitted visual-assets.

Installed Sharp 0.35.4 uses `dist/index.cjs` and `dist/index.mjs`; it really does
ship `sharp-darwin-arm64-0.35.4.node`. The review's claim that the versioned native
filename was invented is not supported by the installed package. The correction
uses the real entry points and verifies the fixture against package metadata and
files, rather than changing the native check to an older package layout.

The actual TypeScript CI chapter passed with its previous visual-assets/dist
moved aside. Focused CI/planner/desktop tests passed 101/101. These are focused
results; final full checks and CI outcomes are recorded separately.

## Final verification

The frozen source and scoped reviews are in [source-snapshot.json](source-snapshot.json)
and [reviews.json](reviews.json). [Verification results](verification.json) record
successful full checks and the rebuilt Desktop evidence runner. Vitest passed
2,293 tests across 176 files; three tests were skipped. The desktop manifest and
original/imported captures are in [desktop](desktop/manifest.json).

GitHub CI, including the actual macOS package build, is pending the updated PR.
No paid inference or release publication is part of this follow-up.

Full verification caught a Clippy clone lint and two legacy tests pinning the
migration count at 30. They were corrected to preserve the existing assertions
with schema 31 before the final successful run.
