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


## Named-field guidance live matrix (2026-10-07)

Required plan: repeat both H3 coding tasks three times with codex-basic/gpt-6-luna
and simulated-user gpt-5.6-sol/high; preserve all six original attempts, failures,
partial captures and unavailable scores. Attest runtime/configuration and compiled
SDK/harness bytes before inference, then recheck them at collection finalization.

Actual execution: all six original candidates are terminal against commit
`57e5d1b9fa011b78c344537787d5f1f81c3fd8f7`, tree
`5b317aa94b81a84f3dafc938c9b69391e99ef5f1`, with the same 26-file reviewed digest
above. All 50 pinned runtime/configuration/compiled files remained unchanged.
Actual production attempt records verify gpt-6-luna/codex-subscription for all six
root interactions. All six executable traces invoke scoped authoring; all five
accepted root snapshots have scoped layer/node identities. There are no injected
or replacement candidates.

Resulting evidence is in `live-verification.json`, including hashes of the private
immutable state, ledgers, summaries, native judge diagnostics, accepted snapshots,
helper programs and model-route receipts. The immediate-before matrix is commit
`a12216c74dd202a9379a7fad13335c79112cfb57`, frozen summary SHA-256
`c8269972cdd77743bb205e0d272efffbdafbeee6a06c5701336c42d07500c0ea`.

| Observation | Immediate before | Guidance fixes |
| --- | --- | --- |
| Recorded authoring incidents | 8 server/icon rejections | 5 compiler binding incidents |
| Mandatory coding-task gate passes | 5/6 | 5/6 |
| Accepted graph attempts | 5/6 | 5/6 |
| Completed graph scores | 2/6: repair 3/8, investigation 2/8 | 2/6: repair 3/8, investigation 2/8 |
| Repair first backend publication median | 89.3 s (3 samples) | 114 s (3 samples) |
| Investigation first backend publication median | 136.45 s (2 samples, 1 missing) | 92.8 s (2 samples, 1 missing) |

The specific unsupported-icon failures did not recur. The recorded 8-to-5 change
is not proof of fewer total authoring failures: three supported-client validation
failures in instrumented scoped node/action methods have no matching diagnostic
receipt. Eleven failed graph-authoring commands are supplemental; they are not
added to or substituted for metric 2. They include those three validation failures,
five compiler failures and three ordinary repair-script failures.

A separate local fake-server reproduction retained the original error in ten
cases: all five uncaught synchronous failures exited before delivering a report;
all five caught failures with a 300 ms settling window delivered one client
validation report each. It used Node 25.9.0, differing from the live Node 24.1.0;
it establishes a process-termination loss mode, not the exact live cause. No
production capture behavior was changed during this matrix. Remaining control
errors omit the required gc binding syntax or capability key; the existing real
SDK-to-Rust bound-control journey passes, but the JS extension guidance needs a
complete runnable control example.

Failures remain explicit: the first investigation ended without acceptance after
local API and repair errors. The third repair committed only the implementation,
missing the required regression test. Three accepted graphs have partial judge
reviews; one third-repair judge was deliberately stopped with SIGTERM after over
88,000 completion events and repeated rejected action-ID guesses, retained as
partial without replacement. The other two partial judges naturally ended without
finalizing coverage. Missing reviews are unavailable, never zero scores.

Configuration/case/judge/presentation pins match the immediate-before collection,
but profile and family do not: an isolated profile protects another active Prime
eval, and a new single-member family pins Luna after startup advanced the curated
default. Shared account/runtime load, the judge intervention, tiny sample size,
partial/unattested client capture, absent qualitative task ratings, and backend
rather than renderer timing prevent causal improvement or broad nonregression
claims. The older baseline (6/6 task gates and accepted graphs, 4/6 graph reviews)
is preserved as secondary historical context in the receipt. The PR remains draft.


Final adversarial assertion: `/root/design_authority_review` passed evidence
fidelity for the exact source and live receipt above (SHA-256
`2e976b9852fbf4130141de5c974bd49978eb444b90b7ffd887171abbc2fbc00e`).
The reviewer independently verified 30 helper/private receipts, 50 runtime pins,
63 judge artifact receipts, 14 passing gate references, six actual candidate
routes and five accepted snapshots. No unresolved receipt blockers remain.
`live-review.json` records the assertion and substantive limitations; source or
receipt changes invalidate it. This is not a nonregression certification.


## Diagnostic delivery and control guidance follow-up

The six-attempt live run above remains historical evidence for commit
`57e5d1b9fa011b78c344537787d5f1f81c3fd8f7`. It is not evidence for this follow-up.
PRD §9.4 already authorizes partial, unattested origin measurement. PRD §6.2 and
§11 and ADR 0005 own compiled controls and scoped graph acceptance. No product
meaning, judge rubric, graph authority, compiler acceptance rule or metric total
is changed. No test is removed and no inference enters the default suite.

| Changed executable seam / checkpoint | Smallest production observation |
| --- | --- |
| SDK origin reporting persists bounded fixed-code diagnostics before synchronous throw; environment-only compiler origin preserves its program folder | `test/eval-authoring-error-delivery.test.mjs`: real built SDK subprocesses fail on node, action and nested template; exit 1/original error, sanitized spool and recorder metric |
| Host drains before folder removal and before caller revokes capability/exports receipts, without rewriting accepted/failure/cancellation | Same subprocess fixture through real HarnessHost + recorder; `packages/harness-host/test/host.test.ts` accepted/failed/cancelled cleanup journey |
| Recorder HTTP and spool replay share one incident ID, deduplicate before independent diagnostic budget, preserve partial/unknown totals | Delivery fixtures exercise both arrival orders and a one-origin budget; existing recorder overflow, token attribution and metric tests remain distinct |
| Spooled files have bounded slots/actual reads, reject unknown codes/fields and symlinks; unavailable transport, removed folder and opt-out preserve outcomes | Delivery suite malformed/oversized/symlink, one-deadline failure, saturation/opt-out/removal fixtures |
| Node/action field rejection remains strict and repairable with actionable bounded feedback | `packages/graph-client/test/scoped-authoring.test.ts` rejected fields then correct declarations under the same keys |
| Delivered JavaScript recipe declares and binds exact scoped action with stable control key and gc interpolation; child closure accepts | `test/graph-authoring-replay.test.mjs` executes the exact recipe through packaged SDK and real Rust acceptance; provider prompt composition suites retain delivery |

Required plan: focused in-process/real subprocess fixtures, then `npm run check`,
`npm run build`, `npm run test:eval-compiled-runtime`, `npm run test:eval-web`,
`npm run test:eval-graph-preview`, and refreshed adversarial review. The JavaScript
recipe is exercised by the real Rust replay journey. Unavailable/pinned clients,
Python local validation, restrictive launchers without a host program folder,
spool saturation, host crash and transport loss remain partial capture. Spool
ownership attributes reports to one turn; it cannot attest incident truth.

Actual final-source evidence: `delivery-verification.json` records full check
passed (Rust/Clippy/crash; 3,732 Vitest tests, 3 skipped; secret boundary 2/2;
Python 74/74; receipt/readability), build passed, compiled-runtime 4/4, all
browser chapters passed, and PREV-003 rendered three real PNGs plus a cached
response. The tested ten-path digest is
`de363d143720b0ed5068db7e699bec069b756787c6d686bb2e7dfaefacecd3f3`.
`delivery-review.json` records adversarial source/mapping PASS with no blockers
at that exact digest; aggregate and live execution were not independently rerun
by that review. Source changes invalidate the assertion.

Earlier failures remain explicit. The first full check found a new host fixture
calling the wrong overload; the fixture was corrected. The next aggregate had
one existing Lantern quartet recursive graph-memory failure while 3,731 tests
passed. That unchanged scenario passed in isolation, and the final full check
passed with one Vitest worker and four Rust test threads. The aggregate cause
remains unproven; this does not certify absence of regressions. An earlier browser
proof lost the task form after catalog refresh; its unchanged retry and the final
source proof passed. Initial drain placement delayed access release under the
force-stop fixture; the final host releases access before draining. Normal turns
return immediately when no first spool slot exists. No tests were deleted.

Trusted Ladybug cache verification checked platform, Rust version, source and
artifact hashes; the first verifier invocation omitted required platform flags
and was corrected. Warm private native artifacts accelerated compilation, with
fresh required tests. Logs are locally retained by byte hash in the receipt.
The upcoming live matrix uses the same two H3 tasks, three original attempts each,
Luna on codex-basic and the pinned simulated-user judge in a fresh isolated
profile. No injected failures or replacement candidates are planned.
