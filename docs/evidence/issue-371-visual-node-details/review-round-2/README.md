# PR #494 second review follow-up

Base: `e808211b92328ef2e02bc99047c14211578b2568`. Integrates main
`bc8e51f0` (#487); its single conflict joins the two required test imports.
Historical evidence remains tied to its original source. This follow-up supersedes
only the changed scopes.

## Changed seams and checkpoints

| Production seam | Deterministic checkpoint |
| --- | --- |
| Eval selection admission | Real Eval service rejects the Node Detail fixture on unrelated cases or mixed case/config selections; dedicated pair still completes. |
| Trusted review control naming | Real constrained runtime and review adapter retain controls whose referenced labels use ARIA names or titles, preserving navigation, disabled state, and stale-control protection. |
| Bridge replacement compensation | Real graph-server route exercises multiple completions and failed handoff recovery, retaining authority fences. |
| Catalog content persistence | Real file-backed library deduplicates content independently from metadata, migrates legacy records, verifies reopened bytes, and handles publication failure without stale in-memory state. |
| Queued scope ownership | File-backed createTag/associate own nested scopes before caller mutation. |
| Product startup schema integrity | Product-store reopen rejects absent/malformed staged-content columns, composite keys, and cascading foreign keys. |
| Integrated main composer lifecycle | Preserve both branches' imports and run the retained workspace/runtime regressions and full suite. |

## Verification plan

Run focused in-process tests during edits. Then run `npm run check` and
`npm run test:desktop:visual-node-details` (includes `npm run build`) on the final
snapshot. Independent Astra source and checkpoint reviews must record exact hashes.
Fresh GitHub CI, including macOS packaging, is required after push.
No paid inference, release, or merge is authorized by this work.

## Results

Focused root tests passed: 65 runtime/review tests, the real Eval integration case,
and 147 tests covering main integration and CI planning. Eval admission and
referenced-label discovery each failed before the corresponding fix. Logs are
retained in `logs/`.

The catalog suite passed 44 tests and its package build. Startup schema validation
passed five tests. Independent source reviews are recorded separately in the review
JSON files. Final full checks and desktop evidence remain pending.

The catalog change removes duplicate durable payloads and metadata-triggered image
writes. It does not add concurrent multi-writer support or automatic crash-orphan
collection. Ordinary failed precommit writes clean up their newly created content;
crash leftovers may remain for safe reuse. Existing in-memory reconstruction cost
is not claimed to be constant-time.

The first full check was deliberately interrupted (exit 143) after independent
review identified a cross-retry irreversible-handoff gap. Its log is preserved;
it is not passing verification evidence. Final evidence must use the repaired snapshot.

The repaired bridge remembers pending cutover across registration retries and
blocks new capability minting during that phase. The cross-retry regression
observed two invalid resume calls before the repair and zero after it. The complete
graph-server unit suite passed 35 tests; independent rereview is recorded separately.

A subsequent full check passed Rust, crash recovery, builds, and types, then
failed only the existing graph-operation recorder test: the upstream timed
response completed before its `waiting` assertion. Vitest recorded 2,308 passes,
one failure, and three skips. The failure log is retained; a deterministic
upstream release gate replaces the fixture timing race before final verification.

Recorder checkpoint mapping: PRD section 9.1 requires an ordered, integrity-bound
graph-operation ledger. `waits for attributed in-flight work before sealing`
observes the real recorder export while the upstream response is held, then checks
that releasing it yields the expected recorded event. The change is limited to
fixture synchronization; it does not alter the production recorder or remove the
separate bounded-settlement failure test. Independent review must confirm that
the replacement preserves this failure boundary.

Final local verification passed: `npm run check` and
`npm run test:desktop:visual-node-details`, which includes `npm run build`.
Vitest passed 2,309 tests across 177 passing files; one file and three tests were
skipped. Secret-boundary tests passed 2/2 and Python passed 29/29. Rust, crash
reconciliation, Clippy, types, receipt checks, and readability passed.
The last failure was documentation readability only; the reviewed wording repair
preserves the checkpoint meaning.

[Source snapshot](source-snapshot.json), [verification](verification.json), and
[desktop manifest](desktop/manifest.json) bind the final local evidence. Original
and imported PNG tiles are retained beside the manifest. GitHub CI remains
pending the push of this exact snapshot. No paid inference ran.
