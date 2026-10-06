# Time to first graph

Analysis date: 2026-10-04. Base: `3fd7624d` (`origin/main`).

## Problem

Getting a graph can take a few minutes, where plain chat shows its first token in seconds. That makes Relayer too slow for a lot of everyday work.

## What the traces show

The three real-model Codex traces already in the repo, all on the fallback `node --input-type=module` heredoc path that Desktop uses:

| Run | Trace | Wall | Full drafts | Rejected | Time typing programs | First draft sent | Accepted |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | `docs/evidence/issue-517-attached-navigation/live-failure-2026-09-28/recovered-trace-spool/1/events.jsonl` | 425 s | 6 | 5 | 336 s (79%) | 100 s | 422 s |
| B | `.../recovered-trace-spool/2/events.jsonl` | 477 s | 6 | 5 | 313 s (66%) | 118 s | 474 s |
| C | `docs/evidence/issue-517-attached-navigation/desktop-root-live-2026-09-28/traces/3/events.jsonl` | 95 s | 1 | 0 | 65 s (68%) | 90 s | 90 s |

Findings:

1. Every repair is a full rewrite. The prompt said "edit the same program and rerun it", but the program only existed as a heredoc on stdin and the prompt forbids saving a script, so changing one line meant retyping the whole program at about 57 tokens per second. In run A, draft 2 to draft 3 changed 2 of 147 lines and still retyped 9,624 characters in 58 s.
2. Node titles and summaries are 2 to 5 percent of each program. The rest is Node Detail HTML and CSS for both themes, control bindings, layout, checks and wiring. In runs A and B the node text in draft 1 is word for word what was finally accepted.
3. 5 of the 10 rejected drafts failed on Node Detail control bindings (`capability_invalid`, or a button without a typed binding). Because a layer needs every detail and action before it can be published, one node's binding error hides the whole layer.
4. In run A, draft 1 tried `advanceCurrent` first and got `feature_disabled`. The publication contract lets current advance only after the full closure is written, and accepted node title, text and presentation are immutable. So today the pointer cannot show an outline early without re-authoring new node records later.

## Reproduce

The analysis script is a small stdlib Python tool kept outside the repo (`ttfg.py`). From the repo root:

```sh
python3 ../ttfg.py .
python3 ../ttfg.py . --diff 2:3
```

It reads each `events.jsonl`, finds the `commandExecution` items carrying `RELAYER_GRAPH_PROGRAM`, and measures the gap from the previous item to each command start as time spent typing that program.

## What this change does

A retry can now send edits instead of the whole program.

- The host grants every run a per-turn path (`RELAYER_GRAPH_PROGRAM_DIR`) and removes it with the turn. The client creates the folder on first save, so unused runs cost nothing and the grant itself cannot throw.
- `RelayerGraphClient.fromEnv()` saves the stdin program it is running under a short content-hash id and prints `graph program id: <id>` (Node exposes the stdin source as `process._eval`). A program that crashes before `fromEnv()`, or a run where `_eval` is missing, never prints an id and is not patchable.
- A new graph-client export, `rerunGraphProgram(id, edits)`, applies exact-match find/replace edits to that named program, saves the result under its own new id, and runs it. Each `find` must match exactly one place; a missing id or a missing or ambiguous match fails before anything runs.
- Both Codex prompt builders and the Claude prompt describe this only when the run has a program folder and is on the fallback heredoc. The pinned launcher strips the environment and reads no files, so it keeps whole-program reruns.

Nothing else changes: the model still writes no files, the heredoc is still the only shell action for graph authoring, the approval shape is identical, stable clientKeys make the edited rerun update the same drafts, and a full rerun still works.

Estimated effect, from replaying the traces with each retry costing only its changed lines: run A 422 s to about 257 s, run B 474 s to about 281 s. Run C had no retries and does not change. This estimate assumes every retry retypes the program, which was true on Codex CLI 0.147.0 with `gpt-5.6-sol`; see the measured runs below for the current pin.

## Measured on the Eval runner

Eight live Codex runs of `empty-project.hierarchical-overview.single-turn` with `codex-basic`, four on `main` and four on this branch, same machine, same model (`gpt-6.1-sol`, Codex CLI 0.159.3). Traces and the full table are in `docs/evidence/time-to-first-graph-patch-retries/`.

| Branch | Accepted at (median, range) | Full drafts per run | Patch reruns per run | Retry typing (total) | Output tokens (median) |
| --- | --- | ---: | ---: | ---: | ---: |
| main | 349 s (184–561) | 3–5 | 0 | 357 s | 8,840 |
| patch-retries | 262 s (230–325) | 1 | 4–6 | 166 s | 6,440 |

All 8 turns accepted and passed the deterministic judge. On this branch the model sent one full program per run and then only patches (300 to 2,400 characters, 4 to 27 s each), from the prompt alone.

Two things the baseline taught us. On the current Codex pin, a full retry that changes only a few lines is already cheap (1.5 to 6 s, 50 to 430 tokens for a 12 to 14 k character program), so the old 58 s per small fix no longer holds. Retries that restructure the program still cost the full price (100 to 120 s each; `main` run 02 had three and finished at 561 s). The patch path removes that cost. Four runs per branch is too few to call the median difference a measured speedup.

## Proposals for discussion

These are not in this change. Both need an issue first.

**Publish the outline before the details.** Let a layer be accepted with only its nodes' icons, titles and summaries, its edges and its layout. Each node's Node Detail and actions then arrive in one later write that happens exactly once: pending, then filled, never edited. ADR 0005's leased invoke target is already a one-time transition of this kind. ROADMAP 0.3 lists "draft graph event streaming"; this gets much of that benefit inside today's acceptance model. Estimated effect: a readable graph around 34 s instead of 422 s in run A.

**Make one node the unit of failure.** `checkpointNodeDetail` already compiles one node at a time. Accept details per node too, so a binding error marks one node "detail failed, retrying" while the rest of the layer stays on screen, and write details per node in parallel so the slowest node sets the time instead of the sum.

## Caveats

- These are attached-navigation qualification runs, so they probably retry more than everyday use.
- Some of run B's rejections came from a writer ordering bug that the evidence README says is fixed.
- Every saving above is an estimate from replaying the traces, not a measured run.
- Related open work: [#612](https://github.com/vishaltandale00/relayer-graphcomplete/pull/612) adds opt-in authoring experiments, including saving the program to a file in an unpinned configuration; [#654](https://github.com/vishaltandale00/relayer-graphcomplete/issues/654) proposes a scoped authoring library. Neither lets a retry send a diff against a named saved program.
