# Combined model-family roles PR handoff — 2026-10-08

This PR composes the product producer at
`6bd48c58cac50b0be2aa9a1d36c9db82916b0be5`, the harness consumer from
`4cefc2643b8119f1d854841dd0eff41e4dbc18ca`, and the approved compact family
roster, previous/next controls, and Mac wheel/motion behavior.

## Required verification plan

Product authority is PRD FAM-001–006 and ADR 0006. Changed executable seams and
their checkpoints are mapped in the [product portfolio](README.md),
[harness contract](../../contracts/harness-model-family-roles.md), and
[picker portfolio](roster-picker.md). This includes migration/reopen, family
resolution and atomic admission, historical digest compatibility, Settings and
Eval requests/consent, native prompts and selectors, picker dismissal/cycling,
gesture lifecycle, reduced motion, telemetry inventory and capture receipts.
No tests were removed by the composition or picker follow-ups.

Required deterministic entry points are `npm run check`, `npm run build`,
`npm run test:eval-web`, `npm run evidence:telemetry`, and
`npm run evidence:share-preview`. The latter two already ran on the unchanged
combined implementation; their exact results are in [live-smoke.md](live-smoke.md).
The earlier Eval browser run was on the producer/picker snapshot before consumer
composition and failed; it does not certify this combined snapshot. Release,
signing, packaged-platform qualification and new paid inference are outside this
PR submission. Existing trusted warm native outputs are described in the picker
cache-provenance section; tests are fresh observations, never cached proof.

## Live evidence already executed

- Codex subscription: Luna root with actual Sol/Astra native helpers, accepted
  product graph. The synthesized graph retained a NaN explanation error.
- Prime with OpenAI API: GPT-5.6-Luna root with actual GPT-5.6-Sol/GPT-5.5 native
  helpers, accepted graph with correct correction. It omitted the requested root
  label from the visible output.
- Claude subscription after desktop sign-in: Fable root with actual Sonnet/Opus
  native helpers, accepted graph. Fable corrected Sonnet's two errors. Specialist
  replies exceeded the requested word limit slightly.

The [Codex receipt](live-smoke.md) and [Prime/Claude receipt](prime-claude-smoke.md)
bind exact tested source/artifact identities and preserve earlier failed attempts.
These prove prompted same-provider native routing and product acceptance in one
task per harness. They do not establish autonomous delegation, quality/cost
parity or arbitrary cross-provider native launch capability. Native helpers remain
provider-owned and do not become semantic Complete children automatically.

## Submission boundaries

The PR targets `main` as one overall review surface; component PRs #705 and #706
remain independent existing reviews. This submission does not close, merge or
retarget them. The refreshed `main` at
`a283c0d00a04e8b039bab1733ad00d5f99cbe51e` must be integrated before merge.
A read-only merge preview found conflicts in product migration registration,
renderer CSS, and the social-preview receipt. The latter must be regenerated
from actual merged renderer bytes rather than resolved by selecting a stale
receipt. Source and live claims above apply to this combined branch, not that
unperformed merge.

Physical Mac trackpad cadence and animation feel remain unverified; deterministic
WheelEvent/Web Animations scenarios and actual desktop arrow navigation passed.
The user accepted the preview, but that does not replace hardware proof.

## Fresh PR preparation results

All results below use the unchanged executable source in
[`combined-source-snapshot.json`](combined-source-snapshot.json), with private
`CARGO_TARGET_DIR` pointing to this worktree's warm `target` directory.

| Entry point | Actual result |
| --- | --- |
| `npm run check` | **FAIL**, exit 1. Formatting, Clippy, Rust workspace and crash-reconciliation tests, native/package builds, TypeScript and workspace checks passed. Vitest: 298 files passed, two failed, one skipped; 3,769 tests passed, three failed, three skipped, 529.70 seconds. |
| `npm run build` | **PASS**, native servers, distribution TypeScript and all workspace package builds. |
| Selected unchanged Lantern quartet rerun | **PASS**, one test passed, 17 skipped, 14.43 seconds. This does not convert the full check to a pass. |
| Short-circuited tail, executed separately | **PASS**: secret-boundary process proof 2/2; Python 68/68; Ladybug receipt/probe lints; PRD readability. |
| Independent focused review run | **PASS**, 444 tests in 11 files; `git diff --check` passed. |
| `npm run test:eval-web` | **FAIL**, exit 1 at calibration's actor-setup identity assertion (`scripts/test-eval-web.mjs:1128`). Startup cleanup, lifecycle/reopen, host authority, production Settings, dashboard execution, Human Task, actor dispatch/redraw/native selection, diagnostic capture, setup revisions, judge configuration, independent completion selector and evaluator-release chapters reported PASS. Calibration's final assertion failed; later actor-input/judge chapters were unreached. No whole-run pass. |

Full-check failures retained:

1. `evidence-capture-integrity`: sealed private Homebrew Node closure exceeded
   its 30-second test bound.
2. `evidence-capture-integrity`: real graph client exact-port IPv4 fetch failed
   with `ERR_ACCESS_DENIED` under Node 25.9.0's network permission boundary.
3. `eval-app-integration`: the Lantern query-enabled/recursion-disabled scenario
   did not obtain three completed graph outputs; turn 3 was not accepted. The
   exact unchanged scenario passed alone afterward; causality is not established.

No whole-check, merge, or release pass is claimed. Local logs are retained under
`.relayer/evidence/family-roster-picker/harness-live/` as `pr-check.log`,
`pr-build.log`, `pr-lantern-rerun.log`, `pr-secret-boundary.log`, `pr-python.log`,
`pr-ladybug.log`, `pr-prd.log`, and `pr-eval-web.log`.

## Combined adversarial assertion

Reviewer `/root/roster_picker_review` reviewed producer → V2 consumer integration,
current-family/root authority, native role delivery, picker selection/swipe/motion
lifecycle, checkpoint mappings, and bounded live claims. Exact reviewed source:
merge-base `c2905c193c98529bfcda8891f8a0ada8e2dbc213`, canonical SHA-256
`32ced8a8b4b8fcdd55ad4dbc848b873aba214260d50190e9f1a4458f6efd5486`.
The manifest records the 98-file scope and hashing algorithm, excluding evidence
self-reference and ignored private artifacts. The submitting agent independently
recomputed and matched this digest.

Verdict: no actionable findings in examined seams; independent focused run
444/444 and diff check passed. The stale separate-consumer contract narrative was
corrected before digesting. Unresolved: whole-portfolio failures, physical
trackpad/animation feel, retained model-output findings and quality/cost claims,
and current-main integration. The reviewer did not run inference or certify an
unperformed main merge. This assertion is recorded in the combined draft PR;
its source identity remains independent of later evidence-only ledger edits.
