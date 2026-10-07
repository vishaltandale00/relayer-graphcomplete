# Issue #654: first scoped-authoring slice

## Required plan and product meaning

Authority: PRD §11.1–11.6 (model-authored layers/layout, navigation and immutable
accepted graph), §11.10 (advisory draft previews), ADR0005 (native recursion and
navigation), ADR0008 temporal current, and issue #654's scoped library proposal.
This is client assembly and bounded transport over existing graph semantics.
The first slice changed no prompt, renderer, acceptance, current-transition or recursion behavior. The follow-up below adopts its API in harness guidance.
No tests are deleted.

Changed seams and their deterministic checkpoints:

| Seam / promise / failure or authority boundary | Smallest real seam observation |
| --- | --- |
| TS public and packaged agent API, named lossless bounded identities, exact source objects | `packages/graph-client/test/scoped-authoring.test.ts`; `test/graph-client-packaged-detail.test.mjs` exercises the isolated single-file agent resource and relocated runtime |
| Node reservation captures envelopes, canonical programs and explicit-clear state before await; direct calls join without starting queued work | Scoped TS capture/retained-package/direct-overlap scenarios; existing `objects.test.ts` and `detail-ownership.test.ts` |
| Selected closure only, accepted boundaries, reference cycles, explicit layouts/routes/options/defaults | Scoped TS/Python fixtures mutate original aliases during blocked transport; unrelated unfinished declaration excluded |
| Bounded dependency stages, settle started requests, original causes and partial IDs, fresh same-key repair | TS/Python partial-stage scenarios; distinct Python repeated-cancellation drain scenario; queued direct retry scenarios |
| Edge/action provenance history and accepted records cannot become authority | Scoped identity fixtures; real Rust journey rejects a foreign-project accepted endpoint, expansion cycle and orphan; accepts authorized reuse and reference cycle |
| Metric 2 per-origin coverage, capture/compiler reporting, server/aggregate/cancellation dedup | Scoped TS diagnostic fixture; `test/eval-authoring-errors.test.mjs` |
| Python ordinary node reservation and canonical Prime bridge capture/single-flight/frozen replay, typed server causes versus unknown outcomes | Python scoped suite and existing visual/ownership suites; real Python -> `PrimeVisualAuthoring` -> Rust journey in `test/graph-authoring-replay.test.mjs` |
| Advisory previews survive writer results without acceptance effect | Scoped TS/Python result fixtures; existing preview suite; `npm run test:eval-graph-preview` |
| Python package tree changes reach verified runtime/packaging contracts | Runtime, vendor manifest and managed recipe pins; `test/prime-managed-runtime.test.mjs`, `test/prime-agent-packaging.test.mjs` |

Warm edit-loop entry points: the scoped TS test plus object/ownership/metric and
Prime compiler tests; Python unittest suite. Required heavy handoff entry points:
`npm run check`, `npm run build`, the real scoped Rust/Python journey,
`npm run test:eval-compiled-runtime`, and `npm run test:eval-graph-preview`.
No paid inference or new worker provisioning is required. No release candidate
or renderer visual proof applies to unchanged product UI.

Verified acceleration: `scripts/ci/lbug-artifact.mjs verify` accepted the existing
macos-arm64 lbug 0.18.0 bundle for rustc 1.98.0 and this Cargo.lock. Its build
provenance is commit `35d28d6ceb83f4b6b82a1b9ea072214eeab2e996`; identity and bytes
were checked before use. Existing private Cargo target is reused. Cache
acceleration does not replace any checks.

## Limits

This slice omits `publishCurrent`/`finish`, their freshness/unknown-outcome guards,
and their publication recipes. Harness prompt adoption is covered below. Shared-process arbitrary low-level overlap and
cross-process replay are not guaranteed by the scoped writer. Existing Rust
validation still applies. The named first-useful-graph-after-paint rubric and
rendered performance entry point remain undefined, so performance proof is
indeterminate and no speed or graph-quality improvement is claimed.

## Actual execution and resulting evidence

All required handoff commands passed against source digest `65bff52001574f159803bca67c23f049383227064d6694d84b7f6dd35eb65466`
(20 named files in source-snapshot.json; evidence outputs excluded):

- `npm run check`: Clippy, Rust workspace and crash reconciliation, package/type
  checks passed; Vitest 298 files / 3,718 tests passed, one file / three tests
  skipped. Secret boundary 2/2 and Python 74/74 passed. Receipt lint and PRD
  readability passed. No failed aggregate or hidden inner scenario remains.
- `npm run build` passed.
- `npm run test:eval-compiled-runtime`: 4/4 passed.
- `npm run test:eval-graph-preview`: PREV-003 passed, three real rendered PNGs
  and one cached response; advisory metadata and acceptance remained intact.
- The full check includes both real Rust replay/scoped journeys and 21 packaged
  SDK cases, including isolated and relocated scoped authoring.

`verification.json` records exact results and SHA-256/byte lengths of the local
logs. Raw local logs are ignored under `.relayer/issue-654-validation`; the preview
runner cleans up its transient fixture images. This is deterministic production
seam evidence, not model task/graph-quality or rendered-usefulness evidence.

Adversarial reviewer `/root/design_authority_review` passed all 20 named files and
the checkpoint map with no unresolved findings, independently running scoped TS
6/6 and Python 74/74. The assertion is in `review.json`; source edits invalidate
it. Heavy proofs were source-reviewed, not independently rerun by that reviewer.

## Follow-up: named-field guidance and repair feedback

Required plan: PRD compiler §6.2/CSS guidance, §11.1–11.6 authority and explicit
acceptance, §11.10 advisory previews, §9.4 origin measurement; ADR0005/0008.
No compiler allowlist, metric, presentation pin, recursion, task or judge changes.

| Changed executable seam / checkpoint | Production observation |
| --- | --- |
| Codex flat and layered / shared Claude, Prime and graph-authoring child guidance prefer named fields; exact import and root acceptance remain explicit | Provider composition tests, including historical presentation redaction; execute the exact delivered JS/Python recipes via canonical SDK/Prime bridge -> Rust in `test/graph-authoring-replay.test.mjs` |
| Generated CSS reference and complete allowed CSS rules reach authoring without a second compiler or Python API | JS recipe imports the packaged export and points to the shared generated reference; Prime prompt compares the existing shared embedded JSON against the compiler function; both delivered recipes compile and accept |
| Local invalid-icon feedback identifies the frozen attempted field, retains server status/code/path/issues and metric origin | `objects.test.ts` reproduces positional misuse with live-builder mutation during transport; existing packaged/compiler and `eval-authoring-errors.test.mjs` cover origin exclusion/dedup |
| Exact-match edits retain fail-closed validation, exact supplied import URL, graph-only fresh repair after known rejection, and unknown-outcome reconciliation | `program.test.ts` executes patch successes/missing/ambiguous cases; composed prompt checks matching/import/fallback/unknown branches and restricted-launcher availability |
| Existing accepted-node additions/replacements retain grants and revisions | Unchanged attached-navigation guidance and provider grant/presentation tests in full check; no new accepted mutation API |

No tests are deleted. Positional recipe assertions now observe the named-field
recipe at the same provider-delivery boundary; real execution covers assembly,
compilation, write ordering and acceptance. Old source receipts above remain
historical. New source edits invalidate their certification for this follow-up.

Required handoff: warm relevant tests, `npm run check`, `npm run build`, compiled
runtime and graph-preview entry points. Authorized live proof: both H3 coding
cases, three original attempts each, fixed candidate/judge settings. Record source
and actual SDK/harness/runtime hashes before the matrix, inspect scoped API
adoption, preserve all failures and unavailable graph reviews, compare against
both the immediate previous matrix and the older baseline with limits stated.

Follow-up actual execution: final reviewed source digest
`144fb0723490d5b2fe6ccd0f150a33298bab3e39b4fda3ab4b33ba2399e25d1b`
passed full check (298 Vitest files / 3,719 tests; one file / three tests skipped;
secret boundary 2/2; Python 74/74; Rust/Clippy/crash checks, receipt lint and PRD
readability), build, compiled-runtime 4/4, and PREV-003 (three real PNGs plus
cached response). `guidance-verification.json` preserves earlier failed attempts
and exact local log digests; final full check uses four Rust test threads after
an unchanged timing fixture failed under load and passed alone. No test scope
was narrowed. `guidance-review.json` records the renewed exact-source review.
