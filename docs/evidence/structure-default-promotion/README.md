# Structure default promotion

The explicit 2026-10-09 decision selects immutable personal-presentation V6 for new Codex, Claude and Prime basic threads. It retains V4's first four preferences and replaces its explanatory preference with task-sensitive relationships and distinct deeper inspection. Internal Prime deep stays on V4. Existing published preference bytes, active product policy, model-family defaults, thread selections and accepted pins remain unchanged. The production communication contract from main remains in force. This change introduces V6 only; experimental V5/V7 and interactive comparison code are outside this release.

## Checkpoints and required verification

| Changed seam or authority boundary | Deterministic production checkpoint |
| --- | --- |
| Schema 46 upgrades add V6 without changing published V4, active policy or existing pins; repeated reopen stays idempotent | `schema_46_adds_v6_without_changing_published_preferences_or_pins` through the real migration runner and Product store |
| V6 configuration lookup, accepted graph publication, distinct immutable identity, V4 preservation and replay | The existing personal-presentation publication test in `crates/relayer-app-server/src/runtime.rs`, extended through the real graph server |
| Exact shipped main configuration selection and revisions; internal deep exception | `packages/harness-host/test/configuration.test.ts` |
| Native Codex/Prime admission of V6 | Shipped-config execution in `codex-basic.test.ts`; real Prime factory and Python authoring in `test/prime-visual-integration.test.mjs` |
| Packaged Prime accepts the exact promoted harness bytes and rejects tampering | `test/prime-agent-packaging.test.mjs` through runtime admission and packaged verification; manifest and runtime SHA-256 identity updated together |
| Trace context admits V6 with a pin, rejects unpublished V5 and malformed identity | `packages/harness-host/test/host.test.ts`; actual exported traces in both persistence integrations |
| Presentation selection outside Claude provider-session identity while execution/permission changes still invalidate reuse | Configuration compatibility tests plus real reopened Claude integration |
| V6 new threads; V1/V3/V4 reopened Codex/Claude follow-up and invoke pins unchanged | `test/first-message-composer-integration.test.mjs` with production persistence and only inference replaced |
| Prime V6 new threads, V1 continuity, visual export/import; deep remains V4 | `test/prime-visual-integration.test.mjs` with fixture inference |
| Eval recognizes V6 authored detail requirements at the root and on accepted semantic children | `test/eval-app-integration.test.mjs` compiled/partial/plain output and plain-child checks through production evaluators |
| Numeric macOS release version 0.2.40 | Existing desktop release/version/source metadata tests, exact-source CI, signed candidate receipt and updater canary |

No tests are retired. Warm editing uses configuration and native-host tests. Before commit: `npm run check` and `npm run build`. Before signed candidates: exact-source main CI and `npm run test:prime-managed-runtime`. Release proof additionally requires the authority audit, signed candidate receipt/signatures, immutable Preview publication, native updater canary and committed reviewed canary evidence before Stable promotion. No paid inference is part of these tests.

## Build reuse and review limits

This isolated checkout uses a private copy of the previously built local Cargo dependency cache after another active build held the shared cache lock. Project objects copied from the actively changing shared cache failed coherency verification (GraphAction/ActionDraft field mismatches). All four project-crate cached outputs were discarded in the private directory; project Rust is compiled from source. The copied Ladybug static library matched the source SHA-256 `b0efad6167605648a6556434277375d82eb1a79ab1e1e5611ae9e49fac94c576`. Cargo rechecks source inputs and recompiles changed Rust; no cached bare runtime binary is adopted as source proof. A source build remains required because main's Rust input identity differs from the experimental checkout. Locked npm installation uses the existing npm download cache and independent workspace links. No cold native dependency build or fresh coding worker is provisioned.

The user prohibits subagents in this side conversation. Local self-review therefore supplies no certifying adversarial-agent receipt. Source tests establish delivery, integrity and pin persistence; they do not establish graph quality or a full live-model comparison. Hosted candidate, signing, canary and publication evidence remains separate from local tests.

## Local execution record

- `npm run build` passed with the pinned Node 22.23.2 toolchain and isolated Cargo directory after project-crate source compilation.
- The warm host/configuration checks passed: 294 tests across four files.
- The Codex/Claude historical-pin, Prime visual and packaged Prime integration files passed. The accompanying Eval file passed 18 of 19 scenarios; its existing six-turn H3 fixture exceeded its run deadline while other compilation was active. This is not a full Eval-file pass.
- The fresh-source `npm run check` passed formatting and Clippy, and 392 of 393 app-server tests, including V6 publication/replay and the real schema-46 upgrade/pin preservation. It stopped at the unchanged command-output-bound fixture. That exact fixture subsequently passed alone. The outer check remains failed; its later stages were not reached.
- Earlier attempts exposed a missing Prime configuration integrity hash (fixed and covered by packaged tests), Node 25 permission behavior (replaced by the pinned toolchain), contention timeouts, a shared build-cache lock, and incoherent copied project objects (discarded before source compilation). Those attempts are not full passing proof.

Required hosted CI, exact-candidate managed Prime proof, signing, Preview publication, the native updater canary, and Stable promotion remain pending at this source handoff. This record distinguishes completed local observations from the remaining release gates.
