# Apple Silicon desktop 0.2.39 to 0.2.40 canary

This evidence observes PRD UPD-002 and ADR 0002 at the native install and updater boundaries.
It qualifies the exact signed Preview 0.2.40 bytes for protected Stable promotion.
Promotion and live Stable verification remain separate proof.

Signed source: `8201faac88c7d979909517ddace51f6f46d25c07`, protected tag `desktop-v0.2.40`.
[Source PR #726](https://github.com/vishaltandale00/relayer-graphcomplete/pull/726) promotes immutable Structure/personal-presentation V6 for new basic Codex, Claude and Prime threads while preserving historical pins.
Candidate [37901872320/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/37901872320) and
Preview [37905737364/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/37905737364) pin the same immutable artifact.
`release-provenance.json` records numeric artifact IDs, API archive digests, exact source/tree, seed identity and actual canary implementation checkout.
Archives were downloaded by immutable ID and hash-verified before extraction.
The committed publication receipt and public-byte report match all six artifacts and the Preview manifest.

Native [canary 37906128296/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/37906128296) ran on macOS 15.7.9 arm64 using the signed source commit above.
Both DMGs and applications passed hashes, Developer ID, Gatekeeper and stapled-notarization checks.
The exact target was launched for first-install proof, then terminated before seed installation.
The signed 0.2.39 seed discovered Preview 0.2.40, downloaded with visible progress,
reached readiness and restarted through the real updater into 0.2.40.
The production validator re-derived the flow and verified screenshot hashes, artifact hashes, versions, channel and process replacement.
The 19-record trace identifies seed PID 3822 and relaunched target PID 4497.
Post-update signature and platform acceptance passed.
All four screenshots were visually inspected: provider onboarding on first launch, update availability, readiness, and installed Preview 0.2.40 in Settings.

Required plan: exact-source repository checks and clean Prime proof before signing; reviewed signed candidate;
public-byte verification; native install/update proof; reviewed committed evidence and protected PR CI;
protected Stable promotion; then live Stable pointer verification.
Actual release-source `npm run check` and `npm run build` passed on the exact merged source before this evidence commit.
The suite passed all Rust and crash-reconciliation checks, 4233 JavaScript tests (3 skipped), 2 secret-boundary tests and 95 Python tests, plus lint/readability checks.
[Exact-main CI 37901025996/1](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/37901025996) passed.
Clean `prime@0.8.1` assembly and the provider-free real-kernel probe passed before signing.
The required plan and preceding failed local attempts remain recorded in `docs/evidence/structure-default-promotion/README.md`; those attempts are not relabeled as passes.
This evidence-only change modifies no executable seams or tests. The prior exact-source check/build is retained for those unchanged executable bytes; the copied evidence is separately validated through the production Stable validator before commit. The existing production publication/Stable-promotion fixture also passed (1 selected scenario; 47 unrelated scenarios skipped), including changed trace and duplicate screenshot rejection.

No compatible trusted native cache was available, so the candidate compiled from source (Cargo release 20m51s).
Cache save was unavailable due to incomplete dSYM generation diagnostics; no cache-hit or end-to-end symbolication acceptance is claimed.
The isolated disconnected-provider profile proves packaging and updater behavior without paid inference.
It does not certify saved chats or provider recovery in an existing connected profile; that signed-upgrade acceptance remains indeterminate.
Target scope is Apple Silicon macOS; Intel and Windows remain disabled.
The user prohibits subagents in this side conversation; the recorded self-review is non-certifying.
