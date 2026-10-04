# Apple Silicon desktop 0.2.37 to 0.2.38 canary

This evidence observes PRD UPD-002 and ADR 0002 at the native install and updater boundaries.
It qualifies the exact signed Preview 0.2.38 bytes for protected Stable promotion.
Promotion and live Stable verification remain separate proof.

Signed source: `c76ab6e26c9cfffec1366d697c5d419896ba3487`, protected tag `desktop-v0.2.38`.
Candidate [37071544819/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/37071544819)
and Preview [37074844481/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/37074844481)
pin the same immutable artifact. `release-provenance.json` records numeric artifact IDs,
API archive digests, exact seed identity and actual canary implementation checkout.
Archives were downloaded by immutable ID and hash-verified before extraction.
The committed publication receipt and public-byte report match all six artifacts and the Preview manifest.

Native [canary 37093891333/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/37093891333)
ran on macOS 15.7.9 arm64. Its verified checkout was `f4c3617d240f1bbeaa9ec9ab075dd3c5707f2f22`.
The target DMG was mounted and launched for first-install proof, then terminated before seed installation.
Both DMGs and applications passed hashes, Developer ID, Gatekeeper and stapled-notarization checks.
The signed seed discovered Preview 0.2.38, downloaded with displayed progress 16 → 39 → 57 → 81 → 99,
reached readiness, and restarted through the real updater into 0.2.38.
The production validator re-derived the flow and verified screenshot hashes, artifact hashes, versions,
channel and process replacement. The 18-record trace identifies seed PID 7625 and relaunched target PID 8507.
Post-update signature and platform acceptance passed.

The four inspected screenshots show first launch, version 0.2.38 available, ready to restart,
and Settings showing Preview, Current version 0.2.38 and Up to date.
The isolated disconnected-provider profile proves packaging and updater behavior without paid inference.
It does not certify saved chats or provider recovery in an existing connected profile.
That signed-upgrade acceptance remains indeterminate, despite the merged provider-recovery fix and its local tests.

Required plan: exact-source repository checks and clean Prime proof before signing; signed candidate validation;
public-byte verification; native install/update proof; reviewed committed evidence; protected Stable promotion;
then live Stable pointer verification. Actual release-source check/build, full main CI, clean Prime proof,
candidate signatures/notarization and all six public artifacts passed before this canary.
No compatible trusted native cache was available, so the candidate compiled from source.
Cache save was unavailable due to incomplete symbol diagnostics; no cache-hit or symbolication acceptance is claimed.

Two earlier native canaries failed and remain distinct from acceptance.
Run [37075038884/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/37075038884)
hit the outer 60-minute deadline after readiness. Its unresolved boundary included screenshot write or install IPC.
PR #653 bounded the driver commands and labelled native stages.
Run [37081769241/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/37081769241)
then failed at the install Runtime.evaluate deadline after 900 seconds.
Both failed archive identities and digests remain in provenance; neither qualifies for an unchanged retry.

A controlled signed-seed diagnostic reproduced the runtime-staging quit confirmation locally.
At app readiness, default disconnected Codex staging was still active.
PR #655 waits for authenticated incoming runtime receipts and staging teardown before requesting restart.
It preserves the protected default provider and unchanged quit guard.
The sanitized diagnostic summary records the actual guard returning normally after staging finished.
That diagnostic invoked no native install or relaunch and makes no hosted-modal observation claim.
The successful native run above supplies the separate install-and-relaunch acceptance.

PR #655 retained the preceding 12 timeout scenarios and added four staging-boundary scenarios.
All 16 focused tests, full local check/build and required hosted CI/freshness passed before merge.
The first full check failed an unrelated Rust output-boundary test under concurrent execution.
Its unchanged isolated recheck and final serial full suite passed without excluding tests or changing deadlines.
The exact local result was 3420 JavaScript tests, 2 secret-boundary tests, 66 Python tests,
plus Rust, receipt integrity and readability checks. Hosted CI passed 3397 tests with 27 platform/context skips.
The evidence-only branch still requires its own exact-snapshot local gates and protected PR CI before promotion.
