# Apple Silicon desktop 0.2.30 to 0.2.37 canary

This evidence observes PRD UPD-002 and ADR 0002 at the production native install,
updater and Stable-promotion boundaries. It qualifies the exact signed Preview
0.2.37 bytes for the protected Stable workflow; that workflow and its live pointer
verification remain separate proof.

Signed source: `f32506a8f529e1454463b056e8872dc5841967ce`, protected tag
`desktop-v0.2.37`. Candidate [36894985772/2](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/36894985772)
and publication [36903947224/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/36903947224)
pin the same immutable artifact. `release-provenance.json` records numeric
artifact IDs, full archive digests, seed identity and exact implementation commit.
All API archives were downloaded by ID and hash-verified. The committed publication
receipt and public-byte report match all six artifacts and the Preview manifest.

Native [canary 36908147263/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/36908147263)
ran on macOS 15.7.9 arm64 with implementation
`ae2951aebe8acbc9f12855b66935f4bf429d87d6` (the actual checkout was verified).
The target DMG was mounted and launched for first-install proof. Both DMGs and
applications passed hash, Developer ID, Gatekeeper and stapled-notarization checks.
The seed discovered Preview 0.2.37, downloaded with monotonic displayed progress
15 → 39 → 65 → 89 → 99, reached verified readiness and restarted through Squirrel.
The 16-record trace identifies seed process 3528 and updater-relaunched target
process 4157. Post-update code signature and platform acceptance passed.

The four reviewed screenshots show first launch, version 0.2.37 available, ready
to restart, and Settings displaying Preview, Current version 0.2.37 and Up to date.
The production Stable validator re-derived the trace and verified every screenshot
hash, primary artifact hash, version, channel and process replacement.
The isolated provider-free canary exposes Settings for capture; it proves no live
account, inference, physical-device-specific behavior or end-to-end symbolication.

Validation plan and results are distinct. The source had successful full main CI,
local check/build and clean Prime assembly/kernel proof before signing. Actual
candidate signature/notarization/metadata checks, telemetry upload and hosted
byte verification passed. The canary orchestration repair in PR #647 passed four
in-process CDP tests and full local check/build (3402 JavaScript and 66 Python tests),
then required PR CI/freshness. A compatible trusted native cache was absent;
fresh compilation was used and no cache-hit acceptance is claimed.

Failed evidence is preserved separately: candidate attempt 1 failed Apple agreement
HTTP403; old-implementation canary 36904544950 attempts 1 and 2 failed document
readiness and the old seed's delayed-check ordering respectively. Only one
unchanged canary retry was attempted. PR #647 repaired orchestration before the
new successful run; neither failure is presented as acceptance evidence.
