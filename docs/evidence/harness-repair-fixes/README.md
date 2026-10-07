# Harness repair fixes: live runs

Date: 2026-10-05. Two small changes, measured together on one local branch that merges both:

- the graph client names the real method when a program guesses one (#672);
- the prompt names the two Node Detail mistakes seen most, quoted `gc=` bindings and `cursor`/`border-collapse` CSS (#673).

The baseline is the four `main` runs recorded in `docs/evidence/time-to-first-graph-patch-retries/runs/main` (PR #661), same case, harness, model, machine and day.

## Setup

Eval host from the checkout, built-in case `empty-project.hierarchical-overview.single-turn`, harness `codex-basic`, judge `deterministic-graph-contract`, Codex subscription, model `gpt-6.1-sol`, Codex CLI 0.159.3. Four runs, one at a time. Each `runs/repair-fixes/run-NN/` holds `events.jsonl`, `graph-operations.jsonl`, `manifest.json` and `run.json`. Cash cost $0.

## Rejections by cause

| Cause | `main` (4 runs, 17 drafts) | repair fixes (4 runs, 16 drafts) |
| --- | ---: | ---: |
| `graph.submitEdge` guessed | 2 (in 2 runs) | 4 (in 4 runs), each now fixed by the very next draft |
| `binding_not_allowed` | 3 (in 3 runs) | 1 (in 1 run) |
| `unsafe_css` | 2 (in 2 runs) | 0 |
| `detail_template_nested` | 1 | 1 |

All 8 turns accepted; the deterministic judge passed all 8. Accepted at 184, 561, 322, 377 s on `main` (median 349) and 216, 201, 152, 132 s with the fixes (median 176).

## What this shows and does not show

- The model guesses `graph.submitEdge` in most runs even though the prompt says `createEdge`. With the new error, every recovery took one draft; before, run 02 on `main` needed two. The round trip still happens. An alias (`submitEdge` calling `createEdge`) or a "createEdge, not submitEdge" line in the prompt would remove it; that is a maintainer call, see #672.
- `unsafe_css` did not appear in four runs where it had appeared in two of four. `binding_not_allowed` dropped from three to one. Four runs is a small sample; read these as consistent with the sentence working, not as a measured rate.
- The faster acceptance is mostly luck of the draw: none of the four fixed-branch runs had a restructuring rewrite, which is what made `main` run 02 slow. Do not attribute the median difference to these two changes.

## Verification run on the source

Per-package `tsc --noEmit` and the focused tests for each change (`packages/graph-client/test/method-errors.test.ts`; `codex-basic.test.ts` and `claude-basic.test.ts` prompt assertions). `npm run check` and `npm run build` were run today on PR #661's branch with the same toolchain; see that evidence README for the environmental failures on this machine. They were not rerun for these two branches.
