# Apple Silicon desktop 0.2.38 to 0.2.39 canary

This evidence observes PRD UPD-002 and ADR 0002 at the native install and updater boundaries.
It qualifies the exact signed Preview 0.2.39 bytes for protected Stable promotion.
Promotion and live Stable verification are separate proof.

Signed source: `dfd2b2888193fdaf34ff7b2ec2ecda7b42a44eb4`, protected tag `desktop-v0.2.39`.
Candidate [37232292435/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/37232292435) and
Preview [37234508105/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/37234508105) pin the same immutable artifact.
`release-provenance.json` records numeric artifact IDs, API archive digests, seed identity and actual canary implementation checkout.
Archives were downloaded by immutable ID and hash-verified before extraction.
The committed publication receipt and public-byte report match all six artifacts and the Preview manifest.

Native [canary 37234774025/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/37234774025) ran on macOS 15.7.9 arm64.
Its verified implementation checkout was `dfd2b2888193fdaf34ff7b2ec2ecda7b42a44eb4`.
Both DMGs and applications passed hashes, Developer ID, Gatekeeper and stapled-notarization checks.
The target was launched for first-install proof, then terminated before seed installation.
The signed 0.2.38 seed discovered Preview 0.2.39, downloaded with visible progress,
reached readiness and restarted through the real updater into 0.2.39.
The production validator re-derived the flow and verified screenshot hashes, artifact hashes, versions, channel and process replacement.
The 16-record trace identifies seed PID 3036 and relaunched target PID 3455.
Post-update signature and platform acceptance passed.
The four inspected screenshots show first launch, update availability, readiness and installed Preview 0.2.39.

The signed ZIP's Info.plist binds `icon.icns` to `ai.relayer.desktop` version 0.2.39.
`packaged-icon-review.json` binds the ICNS, inspected 512px derivative and exact source logo/mask/mark-module bytes.
`packaged-app-icon.png` visibly contains the merged three-slash mark from PR #657.
This static resource proof does not independently certify Finder/Dock cache refresh.

Required plan: exact-source repository checks and clean Prime proof before signing; reviewed signed candidate;
public-byte verification; native install/update proof; reviewed committed evidence with its own full check/build and protected PR CI;
protected Stable promotion; then live Stable pointer verification.
Actual release-source full check/build, full exact-main CI, clean Prime proof, candidate signature/notarization and all six public artifacts passed before this canary.
The local source suite passed 3444 JavaScript tests (3 skipped), 2 secret-boundary tests and 68 Python tests, plus Rust/lint/readability checks.
Hosted exact-source CI passed 3420 JavaScript tests with 27 platform/context skips; the separate secret-boundary job had two platform/context skips, both passed locally.
No compatible trusted native cache was available, so the candidate compiled from source (Cargo release 18m54s).
Cache save was unavailable due to incomplete dSYM generation diagnostics; no cache-hit or end-to-end symbolication acceptance is claimed.

The isolated disconnected-provider profile proves packaging and updater behavior without paid inference.
It does not certify saved chats or provider recovery in an existing connected profile; that signed-upgrade acceptance remains indeterminate.
Target scope is Apple Silicon macOS; Intel and Windows remain disabled.
This evidence-only change modifies no executable seams or tests.
