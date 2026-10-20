# Reproducible native-service upgrade replay

Follow-up to [PR #762](https://github.com/vishaltandale00/relayer-graphcomplete/pull/762).
This fills the process/persistence gap between the fast coordinator tests and
signed existing-profile release qualification. It requires no dedicated Mac,
saved personal profile, credentials, vendor login, or paid inference. Run it on
an Apple Silicon developer Mac or the existing macOS packaging CI worker.

## Versioned baseline and exact inputs

`scripts/upgrade-replay/baseline.v1.json` pins the public 0.2.40 ZIP's size,
SHA-256, release source and target. The runner verifies its bytes before
extraction, then verifies the bundled package metadata. There is no `latest`
lookup. A locally supplied `--baseline-archive` must pass the identical checks.
The predecessor's actual service modules, bundled harness host/graph client and
native binaries create each baseline. No SQL snapshot or hand-written due mark
substitutes for predecessor behavior.

Fixture version 1 creates three connected fixture providers, a custom selected
family, and an ordinary message. Controlled harness output submits an accepted
graph through `complete(inputGraph)` and the graph client. Its ordinary source
node has an accepted navigate action into a website artifact layer. The file
is written only inside that replay's disposable profile.

Candidate native startup loads the real release-owned configuration digests and
recipe identities. The 0.2.40 configurations differ from the candidate's, so
the app server itself creates all three persisted due marks. Candidate startup
uses production provider composition, catalog publication, post-upgrade lifecycle,
readiness coordination and native persistence. Only upstream discovery, runtime
installation validity/preparation and readiness responses are controlled. No
candidate phase calls fixture seeding, Connect, Repair or authoring.

## Changed executable seams and checkpoints

| Seam | Promise and observation |
| --- | --- |
| Pinned artifact loader | Reject size/hash, bundled source/version/target mismatches before executing predecessor services. Fast contract test covers refusals. |
| Predecessor seed worker | PROV-006/009: actual old service processes create ready providers and accepted graph/artifact through APIs; the seed records one fixture execution. |
| Candidate upgrade worker | PROV-009/011: observe native startup-created due marks before composition. Hold Prime preparation pending. Codex and Claude commit independently; only Prime stays due. Both subscriptions appear in the production picker projection and pass native model-selection validation. |
| Stop and recovery worker | PROV-009/011: stop aborts Prime, close both native children, exit the worker. A new process resumes only Prime; healthy checks are not repeated. |
| Final reopen worker | PROV-006: all due marks remain clear, readiness restores, picker projection and native selection validation remain usable, and no preparation or check repeats. |
| Saved state reads and artifact plan | PROV-008 and ART-006: preserve exact custom defaults, family members, provider IDs/connection generations, accepted interaction/output/action/layer/node identities, artifact descriptor and content hash. Verify the accepted fingerprint against the actual saved file tree and resolve the production viewer plan to that same content. |
| Independent replay and cleanup | Repeat all four phases from another empty profile. Explicit saved-state schema v1 produces identical baseline fingerprints. Every phase uses a new Node process and closes owned native children. Timeout/failure kills the private process group; leftover descendants or cleanup failures fail the run. Both profiles and extracted applications are discarded. |
| CI packaging gate | Run after the existing Apple Silicon package build and ASAR inspection, using that package's service modules and binaries. Runner/fixture changes select packaging. Upload named inner phase results and the top-level receipt, including failures. |

The saved-state schema explicitly selects meaningful fields; it never removes
unknown fields recursively to make two runs match. No existing tests are removed.
Fast tests cover trust, preservation refusal, process cleanup and CI selection.
The heavy replay adds real version/process/native-store boundaries; existing
coordinator authority and Electron viewer tests protect different boundaries.

## Required verification plan

During editing: `npx vitest run test/desktop-upgrade-replay.test.mjs`.
Before handoff: `npm run check`, `npm run build`, then the heavy entry point:

```sh
npm run test:desktop:upgrade-replay
```

Use the pinned Node version. Build workspace packages first (`npm run build`)
on a fresh checkout. Local default performs an incremental Cargo build before
copying candidate binaries into private storage. Follow `docs/agents/ci.md`
before any cold build. The CI path reuses the native package already built with
verified cache handling; it does not provision another machine or cold build.

Optional arguments:

```sh
npm run test:desktop:upgrade-replay -- \
  --baseline-archive /absolute/path/Relayer-0.2.40-mac-arm64.zip \
  --candidate-app "/absolute/path/Relayer Dev.app" \
  --evidence-directory /absolute/path/evidence
```

`--candidate-app` requires a clean checkout and an application whose embedded
source, version and target match that checkout. The CI build sets
`RELAYER_DESKTOP_SOURCE_COMMIT` to its exact immutable checkout SHA. For a local
package build, set that variable to the clean checkout's `git rev-parse HEAD`.
An arbitrary borrowed package cannot qualify. The receipt records source workspace identity,
module/package and binary hashes, target, baseline pin, normalized seed hashes,
worker/native PIDs, child exits, due states, checks, publications, preserved
state, every inner checkpoint and exclusions. A top-level `passed: true` plus
all eight passed phase records is required. Stale loose phase files or an outer
zero exit alone are not proof. Failed runs retain a failed receipt. Raw profile
databases, credentials and local service capabilities are never uploaded.

## Proof boundary

This is native-service upgrade integration under controlled external responses.
It does not run Electron main startup, click the desktop UI, render the viewer,
exercise the updater, verify signing, test real account login, download managed
runtimes, probe real vendor executables, or ask a model to author an artifact.
The saved artifact check establishes preservation and viewer-plan resolution.
`npm run test:desktop:artifact-viewer` separately proves Electron navigation and
rendering. Neither replaces the signed candidate, connected-account and bounded
live-authoring gates in `docs/desktop-release-operations.md`. This test performs
no release publication and requires no release credentials.
