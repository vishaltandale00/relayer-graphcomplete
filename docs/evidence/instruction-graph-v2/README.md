# Instruction graph V2 pilot

Implemented the user-requested smaller chunks, completion-scoped delivery bookkeeping, and operational retrieval reasons. V1 remains a separate immutable treatment. V2 is experimental and does not change the product default.

The corpus has 23 chunks, 22,389 UTF-8 body bytes in total, and a largest chunk of 2,025 bytes. Its digest is `e2e342244c7eb98e16ee142346e90fdd07bb62871b62a5740d429847b6e04224`. Each chunk is independently useful, with explicit manifest prerequisites. V6 preferences, authority, native recursion and the canonical `complete(inputGraph)` boundary remain explicit.

## Matched live result

Run: `run-2026-10-20T17-15-46-850Z-7c3b327d`. Two turns per harness, same task, Codex subscription `gpt-6.1-sol`, family, permissions and V6 pin. Both routes passed preflight before baseline inference. Dashboard confirmation recorded four roots, model-selected children and the authorized $10 declared cap. This cap is not a spend meter.

| Observation across two completions | Current codex-basic | V2 |
|---|---:|---:|
| Initial harness prompt characters | 159,383 | 32,163 |
| Observed native-session input tokens | 404,531 | 281,600 |
| Observed uncached input tokens | 57,907 | 39,936 |
| Input-bearing model requests | 11 | 12 |
| Output tokens | 4,396 | 3,841 |
| Elapsed including grading | 104.9 s | 95.7 s |
| Accepted root completions | 2 | 2 |
| Rejected graph writes | 0 | 0 |

V2 used 79.8% fewer initial harness prompt characters, 30.4% fewer observed session input tokens, and 8.7% less elapsed time. Its first native requests still included provider context: about 18.2k input tokens versus 31.2k for control. The character reduction therefore does not describe the entire native initial prompt. V2 made one more model request but carried less context through its requests.

This is one pilot, not an average across tasks or causal attribution. Chunk content and delivery bookkeeping changed together. All deterministic graph checks and matched-input/mechanism checks passed; semantic and presentation quality equivalence remain unproven. The graph presentation grade is explicitly unjudged. Neither cell created semantic children. Provider-native helper usage coverage remains unknown, so observed session counters are not whole-task totals.

## What was retrieved and why

V2 returned 16 instruction bodies across its two independent completions: 16,835 characters / 16,839 UTF-8 bytes. Every body had a recorded operational reason. There were no replay responses, explicit rereads, duplicate metadata responses or instruction-search calls.

| Completion | Chunks | Agent-stated operational reason |
|---|---|---|
| First, initial-authoring | completion-authority, publish-current, detail-basic, detail-theme, layout | Read authority and visual publication instructions for task flow explanation |
| First, finish-and-preview | finish-current, preview | Read final publication and advisory preview mechanics |
| Second, initial-authoring | completion-authority, publish-current, detail-basic, detail-theme | Read publication authority and visual authoring requirements |
| Second, flow-publication | layout, navigation-reference, detail-controls, preview, finish-current | Prepare sequence layout, prior-view control, preview and final return |

The second completion starts a fresh native session and has independent delivery state. Fetching shared chunks there is expected, rather than an unnecessary reread within one completion. Reasons document stated purposes, not private reasoning or proof of comprehension.

Suppression was not exercised by this live pilot because it attempted no duplicate retrieval. Deterministic tests separately prove suppression across programs/helpers, exact-key replay after transport loss, explicit justified rereads, concurrency, capability-epoch cutover and stale-request refusal. Tracking is in server memory and resets on restart. Identical request-key retries replay their original body and are counted as physical deliveries.

## How search works

The same query-v1 graph engine supports structured property lookup and bounded graph relationships. It has no substring, full-text, vector, synonym or semantic relevance ranking. V2 usually selects topics directly from the trusted metadata directory, then retrieves their bodies with a reason. Exact manifest prerequisites define dependency closure; generic graph neighbors mix directory and dependency edges.

The real-Ladybug benchmark on the actual frozen corpus passed 23/23 exact title lookups, four reviewed manifest prerequisite cases, corpus isolation, default-five/hard-eight row limits, and body-projection refusal. Twelve unchanged natural-language phrases produced zero exact title matches. This is evidence of the exact-match limitation, not a semantic-relevance score. The live pilot used no instruction search. See [search-benchmark.json](search-benchmark.json).

## Verification plan and actual execution

Required plan: PRD 12.4A checkpoints IG-001 through IG-013, `npm run check`, `npm run build`, `npm run test:eval-web`, then the separately authorized paired live run. The normal suite uses no paid inference. Native builds reused the repository-verified Ladybug bundle with its recorded hashes and private Cargo target.

Actual full `npm run check` exited 1. Its Rust format/clippy/workspace/crash checks, native/package builds and TypeScript checks passed. The full Vitest run reported 341 passed files, two failed files, one skipped file; 4,592 passed tests, two failed tests and three skipped tests. Failures were the newly extended recipe fixture with Current disabled and the two new modules missing from the exact telemetry inventory. An earlier attempt also caught a test-only `ApiError` compile issue; that was repaired before the full run.

The final source delta enables Current only for the V2 recipe fixture, adds exactly two code-owned module names, and maps that seam in the PRD. The actual shipped-recipe/reopen journey then passed 4/4; all five affected telemetry suites passed 19/19. These counts overlap the earlier suite and must not be added into a claimed green full-suite count. Unchanged source chapters are reused by hash, with an independent scoped review. The full command's original failure remains recorded.

Remaining chapters passed separately: two secret-boundary tests, 100 Python tests, Ladybug receipt checks and PRD readability. Required build passed. Browser proof passed all 46 reported chapters. The independent review is non-certifying without a PR; no commit or PR was created.

## Durable evidence

- [source-snapshot.json](source-snapshot.json): 42-file source digest `50a7554dcb602960ec1ab2b7ab685cdb70420c06bc2f611c37d030b700409237`.
- [verification.json](verification.json): required plan, actual outcomes, preserved failures and logs.
- [review.json](review.json): independent source, search and scoped verification-reuse assertions.
- [live-comparison.json](live-comparison.json): exact run, authorization, matched model/pins, observations and immutable bundle hash.
- [trace-analysis.json](trace-analysis.json): four trace/ledger SHA-256 checks, request-token arithmetic and complete operational reason receipts.
- [search-benchmark.json](search-benchmark.json): actual engine proof, reviewed cases, source/binary/native-cache identities and limitations.
- [comparison-result.png](comparison-result.png): completed Eval dashboard.
- [rendered-inspection.json](rendered-inspection.json): manual follow-up observations and hashes for both rendered screenshots; no formal quality score.

The prior V1 evidence is preserved under `../instruction-graph-v1/`. It is a historical experiment, not a third matched arm of this pilot.
