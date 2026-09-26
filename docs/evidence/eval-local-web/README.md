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
| Human review gets read-only product authority plus scoped annotation authority; caller credentials cannot widen it | Web-host fresh-roster reopening, separate capability, wrong-thread, ordinary write, internal-route, cookie stripping and response-cookie checks | Real renderer annotation create/revise/retract and annotation export; ordinary message rejected; fresh context denied |
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

The local machine supplied an existing Cargo target cache at
`/Volumes/2T-SSD/cargo/relayer-graphcomplete`. Cargo rebuilt the current workspace
and validated its dependency fingerprints; no downloaded native artifact was
adopted or represented as test proof. Existing process tests assume
`target/debug`, so the ignored local `target` link points to that configured Cargo
output. A first full check exposed that missing link and one 30-second Homebrew
sealing timeout. Those failures are retained in the PR verification report; later
runs are reported separately.

The PR records actual command results and the adversarial reviewers' exact source
snapshot. Browser proof certifies the shared workspace and local web host, not
Electron rendering equivalence, live provider quality, or release readiness.
