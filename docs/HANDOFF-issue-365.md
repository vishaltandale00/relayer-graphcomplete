# Handoff — Visual Node Details (orchestrator branch)

## Current position
- PR: #404 (`codex/visual-node-details-orchestrator`), OPEN, ready to merge after review.
- Head: 6f3a7a8e — eval-runner preference attach.
- Branches integrated: #365 (persist accepted visual Node Details) + #366 (constrained runtime). #368 remnant review findings all adjudicated and closed.
- Head of underlying work: #366→#371 (Eval integration), #368 pending acceptance (review-recheck), #367 pending final PrD proof.

## Decision log
1. Six review findings on #365 — adjudicated with user:
  - F4/F5/F6 engineering fixes committed (limits, filename normalization, staging cleanup, stable client-key memoization).
  - F1 (import assetId): live in as provenance label — digest is authoritative pin.
  - F2 (persistence revalidation): renderer is the authority — persistence does not re-check markup.
  - F3 (stable client-key): `submissionEnvelopes` memoized before request — verified.
2. Live-run harness configurations: opted for **fixture + three provider-backed configs** (`codex-basic-node-detail`, `claude-basic-node-detail`, `prime-agent-basic-node-detail`), so live inference runs are opt-in.
3. Prefer preference-version path: extended `personal-presentation-v2` (not the empty v3) with a fourth preference "Authored visual Node Details". The recursive-complete comparison (`codex-eval-complete-disabled` vs `codex-eval-complete-enabled`) now runs against v2.
4. Eval-runner attach fix: `packages/eval-runner/src/runtime-basic.ts` now ensures+publishes+attaches the manifest before each interaction, matching the app-server's attach route. Flag `--keep-state` added to CLI for inspection.

## Explicitly open for the next operator
1. **Design divergence** (your call on next chat — decide before merge):
   - The eval CLI now owns the preference attach route that the app server also owns. Duplication exists; the right home is either the app server at completion-prep time or the harness reading `personal_presentation_version_key` from its own config. Once that's decided, one of the two implementations can go away.
2. **Comparison eval not yet run**: the recursive-complete comparison (`empty-project.recursive-complete.comparison`) still needs the desktop Eval Electron app or an autorun extension. Live privileged access must be approved by the user.
3. **Known object-model tax**: the eval-runner preference attach works around several safety checks by using manifest definitions in code instead of workspace-driven data. This means the eval/runner has hardcoded manifest shapes in `runtime-basic.ts` — aligned with `crates/relayer-app-server/src/runtime.rs` — and a future v2 shape change must update both.

## State snapshot
- Live smoke: `npm run eval:basic -- --configuration codex-layered-personal-presentation-v2 --test-run-id <id>` — passed 2 turns end-to-end.
- Check/build: `npm run check`, `npm run build` verified on orchestrator HEAD.
- Hard disk repair: metal-target deletion was used; `CARGO_TARGET_DIR=/Users/...shared-target/` is used for isolation.
- Tested by: #365 accepted-persistence tests, #366 node-detail runtime, #365/#366 PRD section renumbered (6.4 persisted after 6.3 runtime).
