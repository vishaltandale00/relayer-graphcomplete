# Main integration before merge of PR #651

Candidate combines feature `8b12da16410b89796119b8f9327936acc1ee7f7d`
with main `c76ab6e26c9cfffec1366d697c5d419896ba3487`. Main adds the already
reviewed provider-availability refresh (#650) and desktop version 0.2.38 (#652).
Worktree renderer/controller/style behavior is unchanged. PRD automatic merge
preserves both the worktree decision and PROV-009; no new product decision is
invented. This is feature merge proof, not a release or signed-update context.

The only conflict was the source-bound social-preview receipt. The real
`npm run build` then `npm run evidence:share-preview` workflow regenerated it
for the combined main/preload/renderer, including the new provider modules.
Generated receipt and actual light/dark captures were copied into their existing
portfolio. No hash was manually reassigned or conflict side selected as proof.

Changed executable integration seams: #650's provider publication/preload/
renderer refresh and retained composer compatibility, plus regenerated renderer
artifact identities. Checkpoints are existing model-availability tests, actual
worktree renderer/controller tests, and the social-preview receipt test. Warm
entry passed 21 scenarios across four files. The final build passed. Full
`npm run check` is the deterministic fallback; the declared worktree desktop
runner is the applicable heavy entry point. Paid, live, signed and release proof
are not due or claimed.

The actual desktop runner passed all 17 independently reported checkpoints,
restart persistence and accepted fixture output on merged renderer bytes.
`result.json` is copied from its actual receipt. Its exact previously frozen
native binaries remain compatible: no Rust crate, graph-client or harness-host
source changed between the feature and combined candidate. Those binary bytes
are verified, not replaced by a cache claim. The earlier feature video remains
bound to its original feature source; merged behavior is observed by this fresh
desktop result.

`source-snapshot.json` binds 23 source/receipt identities, with digest
`64d82f7ec80be2f55ef05c1cd888ac8d5e5ac97d55c22165c5ea76fc93883d37`.
Adversarial reviewer `/root/review_worktree` independently verified those hashes,
13 desktop source hashes, actual native bytes, 17-checkpoint marker, all preview
source hashes, 94 served-renderer identities and aggregate, PNG hashes, and
exact equality to the actual capture producer's receipt. Verdict: PASS, no
unresolved integration or evidence findings. This invalidates on bound source
or evidence changes. Complete check and hosted merge-gate proof remain pending
until their actual outcomes are recorded.

Raw local logs: `/tmp/relayer-worktree-merge-build.log`,
`/tmp/relayer-worktree-merge-social.log`, `/tmp/relayer-worktree-merge-warm.log`,
`/tmp/relayer-worktree-merge-desktop.log`, `/tmp/relayer-worktree-merge-check.log`.
No tests were deleted or weakened.

Complete local check passed on unchanged integrated executable/source identities:
274 JavaScript files / 3,409 passed scenarios, one existing skipped file / three
skipped scenarios, secret-boundary 2, Python 66, and all native/default/crash,
package/type/workspace, Ladybug receipt/contract and PRD-readability gates.
The actual `/tmp/relayer-worktree-merge-check.log` command exited 0. Build,
21 warm scenarios and 17 desktop checkpoints are separately observed passes.
Hosted required CI and merge freshness remain separate gates; the repository's
protected-main rules require `check` and `merge-freshness-status`. Squash merge
will use those gates without administrative bypass. Final exact-commit review
and hosted outcome are recorded in PR #651.
