# Issue 257: harness-owned browser evidence

This ledger records the delivery proof for the three independent browser routes assembled by issue #257. It is evidence about these exact harness/runtime combinations, not a browser capability or conformance contract for Relayer.

## Proof boundary

Each predecessor mechanism-proof lane used an already-running Chrome instance with remote debugging on loopback and a dedicated, non-default persistent profile. The benign page marker existed before the harness route started. Proof retained only hashes and booleans: no cookies, tokens, page bodies, private URLs, tab inventories, profile bytes, screenshots, or credentials. The manifest identifies each durable GitHub proof receipt and hashes its exact comment body; the integrated source-set digest binds those receipts to the assembled implementation bytes without claiming that live browser work runs in the deterministic suite.

The lane-specific `predecessorLiveProof` fields record only outcomes stated by each hashed live receipt. Deterministic implementation tests separately cover the `deterministicProof` fields; they are not represented as live observations.

Across those two evidence classes, the delivered routes cover existing-state observation, benign bounded actions, harness-owned cleanup, honest endpoint failure, and Ask denial at the enclosing native MCP tool or IPython cell. No inner browser-action taxonomy was introduced. Only the Codex and Prime live receipts explicitly record a reversed test-page action; Claude's committed deterministic coverage exercises its bounded read, navigate, click, and fill batch instead.

Claude Ask currently leaves its coarse MCP tool outside `allowedTools`, so the native tool never runs. Codex uses the existing generic MCP approval bridge and Prime uses its existing cell approval/confinement. Auto and Full retain their existing harness translations.

## Deterministic evidence

[`manifest.json`](manifest.json) pins the exact configuration and implementation digests used by the proof. Tests cover:

- Codex helper identity/version, explicit loopback arguments, packaged ASAR presence, native approval labels, cancellation, and Codex-local failure isolation;
- Claude target selection, bounded payloads and operations, navigation failure, cancellation, sanitized errors, native Ask/Auto/Full translation, and socket-only cleanup;
- Prime archive/tree/three-target dependency closures, required root/dist skill assets, configuration discovery, production preflight, and unchanged permission profiles;
- packaged presence of each harness-owned route alongside the ordinary GraphComplete runtime.

The Prime target closure receipts were replayed through the real `verifyPackagedPrimeAgent` implementation for macOS arm64, macOS x64, and Windows x64. Cross-target staging used placeholder Relayer server binaries where necessary, so that proof covers the Electron `app.asar` Prime closure—not signing, release readiness, or cross-architecture Rust binaries.

## Limitations

This evidence does not promise identical sites, prompts, approvals, authenticated access, CAPTCHA behavior, downloads, uploads, or action semantics across harnesses. It does not certify arbitrary attachment to Chrome's default profile. Chrome/profile setup and browser credentials remain outside Relayer, and no release, deployment, merge, or publication is part of this evidence.
