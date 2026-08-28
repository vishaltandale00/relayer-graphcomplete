# Issue 242: personal-presentation activation evidence

## Activation comparison

The opt-in existing-format Relayer Eval comparison completed on 2026-08-28 as
test run `run-2026-08-28T04-56-33-702Z-44830736`. It held the task system
one-turn case, `simulated-user-sol-high` judge, selected model, permission
profile, and layered Codex harness settings fixed.

| Version | Execution | Trace version ID | Presentation result |
| --- | --- | ---: | --- |
| V0 | `7422e22f-3afe-49be-84da-08a316e52bc3` | 1 | 4/4, no materially misleading layer; five-node flat graph accepted |
| V1 | `c9d21643-fc51-435f-8f0c-b6fce36e5c0d` | 3 | 4/4, no materially misleading layer; five-node flat graph accepted |

The V0 judge gave every layer dimension 4/4. The V1 judge gave purpose,
cohesion, visual organization, and coverage 4/4 and relationship clarity 3/4
because the shared renderer uses undirected connectors. It still assigned the
maximum overall presentation score, found no missing action opportunity, and
specifically credited the separate saturation node with directly explaining
what happens when both workers are busy. This is a minor renderer-level
weakness rather than a material regression attributable to V1.

V1 therefore clears the activation gate for future interactions. The product
policy activates V1 while immutable interaction pins preserve V0 for any
interaction created before activation.

## Hidden-infrastructure boundary

Both candidate traces are complete and record only the exact
`personalPresentationVersionId`. The trace manifest does not copy the hidden
profile graph or rendered preference text. The reviewed production-workspace
screenshots show only the authored response graph and ordinary task chrome; no
preference attachment, version, prompt text, graph record, badge, or control is
visible. Export and thread-list contract tests independently reject those
hidden records from ordinary product history.

Generated screenshots, judge reviews, coverage records, and trace manifests
are intentionally not checked into the repository. The complete local evidence
bundle was written to:

```text
/private/tmp/relayer-personal-presentation-eval.PAOOFs/eval-data/runs/run-2026-08-28T04-56-33-702Z-44830736
```

Attach that complete directory to the issue or PR when publication is
separately authorized.
