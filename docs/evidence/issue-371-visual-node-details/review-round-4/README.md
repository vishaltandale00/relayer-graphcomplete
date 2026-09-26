# PR 494 fourth review follow-up

Base: `703eef85be8082328de10f7ed63a60d664d18c81`. Its local and GitHub checks passed. Seventeen later comments across the integration and third-review snapshots remained unresolved, so merge stayed blocked. This follow-up addresses those comments without changing production presentation or model defaults.

## Changed seams and checkpoints

| Seam | Checkpoint |
| --- | --- |
| Direct archived asset authorization | Host permits scoped inspect/download while ordinary discovery hides archived records; foreign and unknown assets remain indistinguishable. |
| Canonical detail admission | Malformed/oversized packages fail canonical validation before visibility fan-out. |
| Durable bootstrap input ownership | Factory captures nested authority and data synchronously without freezing caller-owned values. |
| Raster resource limit | One durable-library guard spans current and candidate generations, including overlapping reads and publication. |
| Product import publication | Successful publication removes only its staging bytes; injected cleanup failure rolls back publication and allows retry. |
| Graph import content processing | Each digest is read, hashed, and inserted once per import; all reference metadata and pin checks remain. |
| External review links | Blocked external links are inspect-only in review snapshots and reject activation without clicking. Product link markup remains unchanged. |
| Proof-runner cancellation | Real wrapper subprocess preserves SIGINT and SIGTERM after forwarding and cleanup, with Electron mocked out. |
| Upload validation | Reject empty/oversized asset content, unknown provenance, and inconsistent reused-node associations before publication. |
| Fresh and stored asset catalogs | Validate content digests before any bootstrap file writes and reject invalid loaded media/authority before returning or migrating. |
| Recorder asset transport | Preserve supported asset payload sizes with bounded route-specific transport while retaining ordinary and trace limits. |
| Deterministic fixture grading | Require a compiled accepted package, pinned image mount, and all supported capability mounts independently of experiment version settings. |
| Repeated image mounts | Resolve a shared asset once per mounted package and release its handle once when the package is disposed. |
| Desktop proof shutdown | Attempt all cleanup steps, retain failures, and publish passing evidence only after successful cleanup. |

## Verification plan

Focused production-seam regressions, independent source/checkpoint review with exact hashes, full `npm run check`, and `npm run test:desktop:visual-node-details` (includes build) precede commit. Fresh GitHub CI precedes merge. No paid inference or release operation is included.

## Executed evidence

The final frozen source passed `npm run check` (2,347 Vitest tests, 3 skipped, plus 2 secret-boundary tests) and `npm run test:desktop:visual-node-details`, including the required build. Rust/default/crash, Clippy, types, Python, receipts and readability passed. The Electron wrapper verified rendering, reopen, portable import and successful cleanup. Original and imported captures were visually inspected. Exact hashes and limits are in `verification.json`; independent review assertions are separate JSON files.

An earlier desktop run failed because Electron quit when cleanup closed its last window. `cleanup-diagnosis.json` preserves the minimal reproduction and successful repair; passing evidence is from the later run. No paid inference or release operation ran.
