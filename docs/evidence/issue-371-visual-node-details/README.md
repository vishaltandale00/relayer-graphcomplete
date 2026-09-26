# Visual Node Details in Product and Eval

## Required verification plan

Issue #371 reuses ordinary accepted product state and the production Node Detail
runtime. The deterministic Desktop Eval case is
`empty-project.visual-node-detail.single-turn`. The existing V2/V3 live comparison
remains separate and requires explicit live-run authorization.

The user selected implementation of the asset integration tracked by #451 on
2026-09-25. Successful image coverage must use authenticated production asset
resolution, accepted content storage, and conversation export/import. Injected
blob URLs and standalone archive tests cannot establish that coverage.

| Changed seam or promise | Required checkpoint |
| --- | --- |
| Fixture and Desktop Eval admission | Real graph/app-server execution accepts the canonical package and all five capability kinds; fixture cannot be mistaken for a live treatment. |
| Isolated authored controls in review tools | Runtime-registered controls expose accepted action identity, support expand/reference, and reject disabled mutation and stale controls. Author-supplied review attributes confer no authority. |
| Read-only production workspace | Electron opens the normal product review window using the server read-only session; invoke/input are disabled and server mutation is rejected. |
| Rendered evidence | The existing ReviewSession captures the selected detail and binds pixels to execution, thread, revision, layer, and node; navigation/history and reopening preserve the subject. |
| Asset authoring and resolution | Authorized file-backed assets resolve through the production boundary; unauthorized, corrupt, unsupported, and unavailable content fail closed. The client preserves typed discovery and file-handle semantics across transport. |
| Asset authority lifecycle | Revocation and every terminal completion path fence and drain old catalog writes. Rejected submissions remain repairable; stale operations cannot regain authority after resume. |
| Accepted-current images | The ordinary authorized layer read permits accepted Advance imagery before Return while rejecting draft nodes and unrelated layers. |
| Accepted asset durability and portability | Accepted bytes survive catalog changes and reopen; export deduplicates reachable content; import verifies integrity and preserves each placement. |
| Product/Eval parity | Both surfaces render the same accepted package and pinned image bytes through the shared runtime. |

The versioned PRD checkpoint map also names secondary boundaries:

- Terminal/revocation/replacement recovery: lifecycle tests in `crates/relayer-graph-server/src/lib.rs`, plus `packages/harness-host/test/visual-assets-bridge.test.ts`.
- Advance delivery and draft/unrelated-layer denial: `test/eval-app-integration.test.mjs`.
- Immutable asset file transport and packaged exports: `packages/graph-client/test/visual-assets.test.ts` and `test/graph-client-packaged-detail.test.mjs`.
- Bridge startup and native Sharp packaging: `test/desktop-shell.test.mjs` and `test/codex-browser-runtime.test.mjs`.
- Bounded content records and graph transport: `crates/relayer-app-server/tests/conversation_export_contract.rs` and `crates/relayer-graph-server/tests/import_visual_asset_transport.rs`.

Run the relevant focused tests during edits, then `npm run check`,
`npm run build`, and the declared Electron evidence entry point before handoff.
No paid inference belongs in the deterministic suite. Release proof is outside
this change.

## Verification environment

- Dependencies installed from the lockfile using `npm ci`.
- Hosted runtime artifacts inspected were Linux x64 and incompatible with this
  macOS arm64 host.
- The initial local Rust cache used rustc 1.94 and was rejected for this checkout's
  rustc 1.98.0. A compatible local Cargo cache matching the then-current Cargo.lock hash was
  copied from the trusted local `1b65` checkout. This change subsequently adds a
  direct dependency already present transitively, changing the lockfile hash.
  Cargo rebuilds current sources; the earlier sealed bundle does not certify the
  final lockfile.
- The repository Ladybug artifact workflow packaged and verified that checkout's
  pinned 0.18.0 native library, source commit
  `f6ef714263aa863a62f24c050d81fbdb08d953dc`, platform macOS-ARM64,
  rustc 1.98.0, and manifest/content hashes. Cached build outputs are acceleration,
  not test evidence.

## Actual runs and resulting evidence

The final executable source is recorded in [source-snapshot.json](source-snapshot.json).
Final command outcomes and log hashes are recorded in [verification.json](verification.json).
The source digest excludes documentation so these results can be recorded without
changing the tested executable snapshot.

The declared Electron entry point rebuilt the current sources and passed all
original, window-reopened, and exported/imported image assertions. The receipt
records natural width 300 for all three images, accepted pin preservation,
read-only server mutation rejection, expand/reference navigation, and disabled
invoke/input controls. Both original and imported ReviewSession captures have
two tiles. Their corresponding image tiles have identical content hashes.

The [desktop manifest](desktop/manifest.json) retains execution/thread/layer/node
attribution. Portable copies of the inspected captures are
[original detail](desktop/original-001.png), [original controls](desktop/original-002.png),
[imported detail](desktop/imported-001.png), and [imported controls](desktop/imported-002.png).
Visual inspection confirmed the illustration and every supported control.

GPT-6-Astra independently reviewed controls/asset delivery, authority lifecycle,
import staging, and the product checkpoint map. Exact scoped hashes, limits, and
clean verdicts are retained in the `review-*.json` files. The implementation
record is historical evidence, not an independent review assertion.

Paid inference calls: **0**. The V2/V3 live comparison, signed/release proof,
and deferred #367 geometry/browser checkpoints were not run.

### Integration failures retained during development

- The first combined runtime build passed, but the real Eval startup test failed
  before readiness with `visual_assets_unavailable` (HTTP 503). Successful graph
  completion had already revoked host asset authority; normal token cleanup then
  sent a new revoke barrier which the host rejected. The host was changed to
  acknowledge cleanup of irreversible revoked authority without permitting resume.
  A focused regression covers that sequence; the integrated startup rerun passed.
- Temporal fixture attempts initially timed out without exposing harness errors.
  Explicit gate diagnostics identified an unsupported fixture icon, followed by
  missing temporal test flags. Both were corrected. The integrated Advance test
  passed, including accepted image delivery and draft/unrelated-node rejection.
- An intermediate Electron run at `run-2026-09-26T14-59-55.575Z-4fd346ff` passed
  strict original/reopen/import image checks. Original and imported screenshots
  were visually inspected and contained the same illustration and controls.
  Authority and large-import review fixes were still in progress, so this run
  does not certify the final source snapshot.

The branch incorporates upstream `a8965826`, retaining removal of the standalone
Eval runner and the import-removal SQL module boundary. The earlier full check
was interrupted for this integration after default Rust tests passed; its
partial result is not final verification.

- The first full JavaScript pass reported 2,286 passes and four failures: three
  fake desktop startup fixtures lacked the newly required bridge-registration
  response, and one graph-memory fixture referenced the wrong configuration
  variable. Test fixtures were repaired without weakening their existing
  assertions; focused reruns passed before the full suite rerun.
- Early full checks also caught a Rust let-chain lint and a missing empty asset
  field in a Ladybug import fixture; both were repaired before final verification.
