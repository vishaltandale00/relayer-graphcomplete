# Apple Silicon desktop 0.2.40 to 0.2.41 canary

This evidence observes PRD UPD-002 and ADR 0002 at the native installation and updater boundaries.
It qualifies the exact signed Preview 0.2.41 bytes for protected Stable promotion.
Stable publication and subsequent live verification are separate proof.

Signed source: `2ef4f7a4f14bb444a955a180a2f90cec34873e93`, tree `d412aa7da19bd77f726e37a6e0226cd674514d31`, protected tag `desktop-v0.2.41`.
[Source PR #760](https://github.com/vishaltandale00/relayer-graphcomplete/pull/760) changed only the release version and lockfile.
Candidate [39182768486/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/39182768486),
Preview publication [39185504259/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/39185504259),
and native canary [39185696271/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/39185696271) bind that source.
`release-provenance.json` records immutable artifact IDs, archive digests, exact source/tree, seed identity, and prior verification results.
The publication receipt and public-byte report match all six public artifacts and the Preview manifest.
The `stableUnchanged` field in that report describes the earlier Preview publication observation, not the subsequent Stable promotion.

The native canary ran on macOS 15.7.9 arm64. First installation and post-update signature,
Gatekeeper, and stapled-notarization acceptance passed. The signed 0.2.40 seed discovered Preview 0.2.41,
downloaded with visible monotonic progress, reached readiness, and restarted through the real updater.
The production validator re-derived the 17-record trace, artifact hashes, screenshot hashes,
versions, channel, and replacement of PID 5777 by PID 6362.
The four screenshots show first-install onboarding, update availability, readiness, and installed Preview 0.2.41 in Settings.

Required plan: retain exact-source check/build, main CI, clean Prime runtime proof, signed candidate,
Preview publication and native canary; validate and review these copied files; pass protected evidence PR CI;
run protected Stable promotion; verify the live Stable manifest and unchanged artifact hashes.
Prior release-source check/build passed with Node 22.23.2: 4568 JavaScript tests (3 skipped),
2 secret-boundary tests, 100 Python tests, and Rust, crash-reconciliation, lint and readability checks.
[Exact-source main CI 39182250230](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/39182250230) passed.
Clean `prime@0.8.1` assembly and the provider-free real-kernel probe passed before signing.
This evidence-only change alters no executable seams or tests. Its precommit checks and adversarial evidence review are recorded in the evidence PR against the exact reviewed source or workspace digest.

No compatible trusted native artifact was available for the signed candidate, so it compiled from source.
Cache save was unavailable due to incomplete dSYM generation diagnostics; no reusable-cache or full symbolication claim is made.
The isolated disconnected-provider canary proves packaging and updater behavior without paid inference.
It does not certify connected-provider recovery, saved-chat recovery, or all supported macOS versions.
The reported Codex and Claude subscription Repair symptom remains present in 0.2.41: a stalled Prime readiness check can delay publication of otherwise healthy harness results.
Stable promotion reuses these same bytes and does not fix that symptom.
Target scope is Apple Silicon macOS; Intel and Windows are outside this promotion.
