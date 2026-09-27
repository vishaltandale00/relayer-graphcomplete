# Developer-only Eval web host

The explicit product decision is in ADR 0003 and PRD section 9: Eval runs from a
checkout, its terminal owns the local backend, and it has no desktop package.
The production renderer, product persistence, graph authority, harness-native
recursion, and `complete(inputGraph)` are unchanged.

## Required verification plan and seam map

| Changed executable seam / promise | Smallest deterministic checkpoint | Heavy evidence |
| --- | --- | --- |
| Dashboard IPC becomes authenticated HTTP; foreign origins and hosts cannot operate it | `test/eval-web-host.test.mjs`: capability, Origin, Host, encoded-route, operation allowlist checks | `npm run test:eval-web`: real dashboard transport creates a fixture run and updates an open dashboard |
| Browser upload replaces native file picker; temporary import bytes are removed | Web-host uploaded-byte/temp cleanup checkpoint; existing `test/eval-conversation-import.test.mjs` and `test/conversation-export-eval-e2e.test.mjs` retain format, immutability, and persistence coverage | Existing service import lifecycle remains authoritative; browser transport is checked without inference |
| Human review gets read-only product authority plus scoped annotation authority; caller credentials cannot widen it | Web-host fresh-roster reopening, separate capability, wrong-thread, ordinary write, internal-route, cookie stripping and response-cookie checks; roster-bound read allowlist, state sidebar filtering, missing-thread fallback rejection, project/destination scope, and encoded opaque asset forwarding | Real renderer annotation create/revise/retract and annotation export; ordinary message rejected; fresh context denied |
| Judge capture/control moves from Electron IPC to isolated Chromium | Existing `test/review-session.test.mjs` retains capture integrity, tiled capture/restoration, revision and navigation-state failure boundaries | Actual `openBrowserReview`: fresh credentials, exact execution/thread/turn readiness, annotation rejection, node selection, turn change, Back/Forward, viewport/full capture, metadata digest |
| Dashboard events become polling; review/evidence/trace windows become browser pages | Web-host transport checks and retained dashboard/judge/trace model tests | Open dashboard observes new run; judge and trace pages load the selected execution |
| Terminal owns lifecycle; tab close leaves a pending execution running; one host owns each profile | Web-host stop-during-registration checkpoint; existing runtime startup/cleanup tests remain applicable | Pending native startup interrupted; child and lock removed; second host rejected; tab closed before terminal result; shutdown makes review unreachable; restart reopens saved run |
| Prime credentials use memory in the web host and explicit profile loading on restart | `test/eval-prime-provider.test.mjs`: production composition reopen, no credential file, memory cleared on close; existing explicit profile and sanitized failure tests | Paid provider execution is not required or claimed |
| Eval package/build path removed; product packaging retained | `test/desktop-shell.test.mjs`, `test/codex-browser-runtime.test.mjs`, `test/eval-configuration-paths.test.mjs`, `test/graph-client-packaged-detail.test.mjs` | No Eval package remains to certify; no product release claim |
| Tutorial API stays absent from Eval | `test/tutorial-lifecycle.test.mjs` checks web bridge and retained product evidence preload | No tutorial behavior is introduced |
| Versioned CI mapping and new heavy command | `scripts/ci/affected-modules.v1.json`, portfolio/planner tests, `npm run check` fallback | Browser proof is an explicit local heavy entry point; not part of the warm edit loop |

Run `npm run check` and `npm run build` before committing. Run
`npx playwright install chromium` once, then `npm run test:eval-web` against the
built checkout. All fixtures are inference-free; the browser proof clears inherited
Eval autorun settings. Paid judges and signed/release proof are outside this PR.

## Test subsumption

The encrypted credential-file assertion was replaced by no-file, in-memory lifecycle,
and production-composition reopen checks because Eval no longer persists that secret.
No behavioral ReviewSession, product-authority, graph, import, or trace tests were
retired. Eval package identity/resource assertions were removed because that
package no longer exists; product packaging checks remain. Tutorial exclusion now
covers the web bridge. The legacy dashboard preload moved to `scripts/lib` solely
for the existing Electron product-evidence driver. That driver does not certify
the supported web host. The retained Electron ReviewSession transport supports
those product evidence scripts; ordinary Eval uses the browser transport.

## Build acceleration and evidence limits

The initial browser migration reused a shared local Cargo target. That setup
allowed another worktree to replace binaries during verification and is no
longer supported by default Eval launch. Step 1 uses a physical checkout-local
`target`; migration removes only this checkout's symlink.

Before this step's cold preparation, local artifact inventories and the existing
private Cargo output were inspected. No compatible bundle with verified provenance,
identities, and hashes was available. Preparation therefore builds from source,
using ordinary Cargo registry/git dependency caches. The mutable shared target
is neither cloned nor reused as a trusted artifact. This is a local execution
record, not a claim about caches on other developer machines.

The PR records actual command results and the adversarial reviewers' exact source
snapshot. Browser proof certifies the shared workspace and local web host, not
Electron rendering equivalence, live provider quality, or release readiness.

## Checkout-only launch simplification

Normal and opt-in live Eval commands now start Node without a build. The existing
browser proof checks those command contracts and launches the declared entrypoint.
Shared Rust/TypeScript artifacts remain explicit preparation, documented in README.

Changed-seam checkpoints remain in the existing tests:
- Development targets and actual harness availability: `eval-configuration-paths`.
- Lazy runtime setup, cancellation, and credentials: `eval-managed-codex-runtime`
  and `eval-prime-provider`.
- Explicit live opt-in, conflicting selections, and harness availability:
  `simulated-user-electron-adapter`.

Only unreachable packaged-Eval cases and disabled maintenance assertions are
retired; their production callers already selected unpackaged/no-maintenance.
Required handoff proof is `npm run check`, `npm run build`, and
`npm run test:eval-web`. Product-native evidence and review authority are unchanged.
Adversarial deletion review and exact-source outcomes are recorded in the PR.

## Worktree-owned preparation

| Changed executable seam / promise | Deterministic checkpoint |
| --- | --- |
| Preparation and launch agree on private native outputs | `eval-runtime-artifacts`: two temporary checkouts receive divergent executable fixtures through the preparation runner and launch their own versions after the other is rebuilt |
| Migration preserves another checkout's output; external targets cannot silently win | Same suite: target-link migration preserves destination; external Cargo target, escaped debug directory, and escaped binary are rejected before build/launch |
| Overrides remain explicit and limited to the named binary | Same suite: external override accepted while the other default still needs local preparation |
| Preparation retains the full shared build and propagates failures | Same suite: build invocation, nonzero/spawn failure, post-build readiness, and Cargo-reported executable paths (rejecting older defaults under a configured target layout); `npm run build` exercises actual production compilation |
| Readiness includes indirect runtime dependencies and remains build-free | Same suite: root dist, all four workspace entries, graph-client agent bundle, renderer vendor files, and all launch/proof prehooks; absence points to preparation |
| Existing Eval execution, authority, capture, restart, and recursion remain valid | `npm run test:eval-web`; `npm run test:eval-prepared-runtime` reuses `test/recursive-complete-e2e.test.mjs` with its root Complete import redirected to emitted `dist/index.js`; the ordinary source suite remains in full check |

Required proof: `npm run check`, `npm run build`, `npm run test:eval-web`, and
`npm run test:eval-prepared-runtime`. The dedicated proof configuration is itself
a changed seam: its real recursive scenarios must pass after preparation, while
normal `npm run check` continues to use the source entry point.
The isolated warm suite is `npx vitest run test/eval-runtime-artifacts.test.mjs`.
The two-checkout test uses executable fixtures, not two complete native builds.
It proves output selection and replacement isolation, not compilation equivalence.

No test is retired in this step. Presence/containment checks do not establish
source freshness or sandbox arbitrary build scripts. Explicit binary overrides
and manually shared/hardlinked generated outputs are outside the default
ownership contract. Compiled edits require preparation and restart. No end-to-end
speed percentage or candidate/judge latency reduction is claimed.

### Teardown failure found during verification

The full check exposed an existing context-preview race. Happy DOM's task drain
does not wait for native WebCrypto integrity work, and workspace disposal called
`releaseSendAttempt`, which could start a new detail render after releasing the
mounted asset. The same real-preview checkpoint now waits for the actual image
and provenance, then asserts disposal retains the same host and releases the
asset exactly once. Reselection is suppressed when the workspace is disposed.
This changes only teardown, not node-selection or graph authority semantics.

Changed seam: the production workspace's send-attempt cleanup during disposal.
Checkpoint: `test/node-detail-runtime.test.mjs`, “resolves context-preview images
from their original presenting interaction and layer”. The strengthened assertion
failed before the one-line guard and passed afterward. Browser proof retains
shutdown/restart coverage. The full deterministic check remains required.
