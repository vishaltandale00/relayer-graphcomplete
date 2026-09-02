# Handoff — Visual Node Details (orchestrator branch)

## Focus: testing the visual DSL through the desktop Eval
The next operator is working against the **Relayer Eval desktop app** (`npm run eval-app:dev`), not the CLI runner. The CLI's preference-attach code in `packages/eval-runner/src/runtime-basic.ts` is work-in-progress debris — **revert or ignore it**; the desktop app is the authoritative path.

## Current position
- PR: #404 (`codex/visual-node-details-orchestrator`), OPEN
- Head: cb46a66e — handoff document
- Integrated branches: #365 (persist accepted visual Node Details) + #366 (constrained runtime)
- Six review findings on #365: all adjudicated with the user and closed

## Decisions sealed
- **F1** (import assetId): provenance label; digest is authoritative pin
- **F2** (persistence revalidation): renderer is authority; persistence does not re-check markup
- **F3, F4, F5, F6**: engineering fixes, all committed (stable client-key memoization, pre-clone archive limits, filename normalization, staging cleanup)
- **Live harness configs chosen**: fixture + three provider-backed variants
- **Preference version**: preserved the established V2 baseline and added V3 with the fourth preference "Authored visual Node Details"

## What the next operator should rely on
1. **Case**: `empty-project.recursive-complete.comparison` pairs `codex-eval-visual-node-details-control` (V2 baseline) with `codex-eval-visual-node-details-treatment` (V3). Both retain recursive Complete; only V3 adds the authored visual Node Detail preference.
2. **Desktop Eval path**: `npm run eval-app:dev`, select that case, approve live inference, let it run through the Electron app with its own app server (which correctly attaches preference version at completion-prep time).
3. **What to test**: the agent should author `NodeDetailAuthoring.setComponent(...)` — structured HTML/CSS, placed visual assets (per #364), capability controls — and the constrained runtime should mount it (per #366). Issue #371 intact.

## Ignore these (debris from the CLI route)
- `packages/eval-runner/src/runtime-basic.ts` adds `ensurePersonalPresentationVersion` + `--keep-state` : ~100 lines of manifest-codable workaround.
- `docs/HANDOFF-issue-365.md` (this document) — explains why those lines exist; safe to delete before merging.

## Do these
- Keep `crates/relayer-app-server/src/runtime.rs` — the v2 preference definition and materialization tests.
- Keep the V2 baseline plus the V2/V3 visual Node Detail Eval pair registered in `configuration-paths.mjs`.
- Keep `#365` and `#366` in full.
