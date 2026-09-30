# Harness authoring-strategy experiment

This is an opt-in harness experiment, not a production rollout. It starts from
the PR #610 control at `01ea0c446871c7a061d83406bf51f1819a929899` and varies one
named, code-owned guidance treatment per harness configuration. No experiment
configuration is loaded or packaged by Relayer Desktop.

## Product decision and executable seams

The explicit decision is to compare whether stronger guidance helps a model do
real work through reusable functions or saved source, produce useful graph state
earlier, and use native or semantic decomposition when it judges that useful.
The model retains control of flow. There is no GraphComplete scheduler and no
node, child, recursive-call, or publication quota.

Changed executable seams:

- `codex.basic` and `prime.agent` strictly parse the optional
  `experimentalAuthoringStrategy` setting. Omission is the unchanged PR #610
  control.
- Language-specific prompt composition adds exactly one of
  `function-increments-v1`, `saved-module-v1`, or `decompose-publish-v1`.
- The sealed telemetry inventory admits the new compiled prompt-only module; it
  adds no telemetry collection or transport behavior.
- Codex requires a layered-navigation prompt profile for every treatment. The
  saved-module arm additionally requires the launcher to be unpinned. The code
  does not infer Eval origin or workspace isolation; this study supplied those
  conditions in its local gate, and no experiment configuration is shipped.
  A trusted pinned launcher rejects the arm rather than widening its
  zero-argument stdin approval boundary.

The treatments preserve three distinct concepts:

1. Recursive JavaScript/Python functions and imported helpers are computation
   inside the current completion.
2. Codex subagents and Prime RLM helpers are provider-native helpers inside the
   current provider execution attachment and completion identity.
3. Only explicit `complete(inputGraph)` / `complete(input_graph)` creates a
   semantic child with a distinct GraphComplete completion and scoped authority.

## Checkpoint mapping

| Promise or boundary                                                          | Deterministic checkpoint                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Control remains unmodified when the setting is absent                        | `experimental-authoring-guidance.test.ts` freezes the exact PR #610 control prompt SHA-256 and rejects experiment text   |
| Every admitted Codex treatment is language-correct and keeps terminal submit | the same test renders all enum values through `buildLayeredNavigationPrompt`                                            |
| Saved source does not silently widen the pinned launcher                     | constructor checkpoint rejects `saved-module-v1` with `graphAuthoringLauncherPath`                                      |
| Prime accepts the same named strategies with Python-only guidance            | `prime-agent.test.ts` executes each strategy through the strict parser and prompt path                                  |
| Codex and Prime admit only the named strategies                              | provider-prompt tests exercise both strict parsers, all enum values, and unknown-value rejection                         |
| Functions, native helpers, and semantic children remain distinct             | exact guidance assertions for both languages                                                                            |
| Useful early publication remains optional and cannot be an empty placeholder | exact treatment assertions plus existing temporal-current tests                                                         |
| No production rollout                                                        | no experiment YAML is added to Desktop or Eval catalogs; packaging/catalog tests remain unchanged                       |
| Compiled module stays inside the sealed desktop inventory                    | `desktop-telemetry-module-inventory.test.mjs` compares the exact built harness-host module set                           |

Focused entry:

```sh
npx vitest run \
  packages/harness-host/test/experimental-authoring-guidance.test.ts \
  packages/harness-host/test/codex-basic.test.ts \
  packages/harness-host/test/prime-agent.test.ts
```

Repository-required final gates remain `npm run check` and `npm run build`.

## Pre-registered initial screen

The initial screen is exactly four serial Codex subscription root executions,
all on GPT-5.6 Sol, medium reasoning, Auto, the same natural Lantern launch-plan
task, the same built runtime, and a 600-second deadline with one stop request and
a 30-second settlement grace:

| Arm               | Difference from control                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| control           | no experiment setting                                                                                               |
| functions         | precise reusable-function and narrow-repair guidance                                                                |
| saved-module      | one ignored, per-run-workspace ES module edited in small steps; this is a composite affordance and prompt treatment |
| decompose-publish | model-chosen function/native-helper/semantic-child decomposition plus truthful useful early-current guidance        |

Arm order is randomized and frozen before inference. Every arm gets a fresh
product database, standalone workspace, Codex home/session, trace spool, and
configuration. A provider turn counts once inference begins; there is no
unchanged retry in the initial screen. Failures remain evidence.

The projection poll is 250 ms. `firstGraphMs` is therefore first observed
current-projection availability, not renderer paint and not automatically a
useful graph. Human review separately labels the earliest rendered current that
is truthful, coherent, contains at least one concrete Lantern decision or
finding with rationale, and is not status text, a table of contents, empty
scaffolding, or agent mechanics. The final graph is reviewed for the declared
Lantern obligations and visible quality. Tool/program sizes, repairs, graph
operations, current revisions, native helpers, explicit Complete calls,
semantic children, final status, and provider-reported usage are recorded when
available. Subscription dollar cost is reported as unavailable rather than
estimated.

A treatment is only promising for replication when it was adopted, accepted,
has no authority/integrity defect, produces a useful graph at least 30 seconds
and 20 percent earlier than the concurrent control, covers every deterministic
task obligation without a critical defect, and loses no more than one point on
the blinded 1–8 turn assessment. The screen stops after four runs for assessment.
It cannot establish a general improvement. Before any expansion, a second
representative task and rubric must be frozen, then control and only promising
arms repeated on both tasks.

## Frozen replication decision

The initial screen prioritized `function-increments-v1` for replication. It
used five named helper functions, reached accepted state without a repair, and
reached its first useful current projection 98.807 seconds (35.8 percent)
before the concurrent control. This is not evidence that it reduced
pre-authoring latency: first successful node write was nearly unchanged, and
the treatment published only about 257 ms before terminal return. The observed
gain is repair avoidance in one sample. `decompose-publish-v1` is not advanced
because it adopted neither decomposition nor meaningfully early publication.
These are screening observations, not general claims.

Before replication inference, the expansion is frozen at exactly four more
serial executions: control and `function-increments-v1` once more on Lantern,
and those same two arms once on the following distinct architecture task. The
four-arm order is randomized once and recorded before inference. Every run
keeps the initial model, reasoning, permissions, timeout, fresh-state, trace,
and no-retry rules.

> You are designing SyncSmith, a fictional local-first macOS app used by field
> engineers to edit structured inspection reports on unreliable networks. A
> four-engineer team must choose between operation-based CRDTs, an append-only
> event log with deterministic merge, and server-authoritative versioning. The
> beta will have 100 technical users, some devices may be offline for seven
> days, attachments can reach 500 MB, and the cloud may store encrypted sync
> data but must not see report plaintext. Recommend one architecture and explain
> why the alternatives lose. Produce a navigable design covering data and key
> boundaries, conflict semantics, attachment transfer, migration and rollback,
> observability without plaintext, the five highest risks, a six-week
> implementation sequence, and a concrete go/no-go checklist.

The SyncSmith checklist is frozen at one point each for: explicit architecture
choice and rejected alternatives; data model and merge semantics; encryption
and key boundary; seven-day-offline behavior; 500 MB attachment transfer;
migration and rollback; privacy-preserving observability plus ranked five
risks; and six-week sequence plus concrete go/no gate. A critical authority,
integrity, confidentiality, or unrecoverable-migration defect fails the arm
regardless of score. Replication is evidence for another bounded study only;
it does not authorize a production default or establish generality.

### Blinded-review amendment

The primary four-run replication above was frozen and started before the
blinded content review returned. That review scored every initial arm 8/8 with
no critical content defect and confirmed that `saved-module-v1` did adopt its
mechanism: one isolated 27,981-byte module, three executions, and one repair.
Because that arm therefore also satisfies the declared screening threshold,
the follow-on adds exactly two supplemental saved-module executions, one on
each frozen task, after the primary four. This amendment is recorded before
either supplemental execution. It does not alter the primary four, add a retry,
or advance `decompose-publish-v1`. Saved-module results remain a composite test
of prompt guidance plus a new saved-source affordance and are reported
separately from the cleaner function-guidance comparison.

## Results

The machine-readable receipt is
[`live-screen-2026-09-29.json`](./live-screen-2026-09-29.json). Raw traces,
provider homes, local databases, review tokens, and auth material remain in the
ignored local evidence directory and are not committed.

The initial screen accepted all four graphs. An observational blinded content
review, performed
against opaque labels before revealing the arm mapping, scored every graph 8/8
with no critical defect. Browser review also found each root readable and its
authored detail useful. The committed receipt does not include the opaque-label
mapping, reviewer transcript, or screenshots, so those quality judgments are not
independently reproducible durable proof. The observed first-current times were control 275.884 s,
functions 177.077 s, saved module 184.474 s, and decompose/publish 170.146 s.
Functions used five named helpers and no repair; control and saved module each
needed one repair. Decompose/publish used neither a native helper nor a semantic
child, and no arm produced a meaningfully pre-terminal rendered result.

The apparent initial speedup did not clear the declared threshold on the second
task. SyncSmith functions reached first current in 216.180 s versus 239.166 s
for control, an arithmetic 9.61 percent difference; saved module reached it in
233.233 s, an arithmetic 2.48 percent difference. These are cross-snapshot
observations, not matched comparisons: a mid-run source edit changed the
workspace/gate identity after the SyncSmith control. All three results were
accepted and browser-reviewed as clear, useful graphs. On Lantern, the valid,
same-snapshot saved-module repeat was slower than the valid control (240.378 s
versus 152.655 s). The Lantern function repeat is invalid and was not retried
because the identity check caught that same edit. The control repeat itself was
44.7 percent faster than the initial control, demonstrating large run-to-run
variance.

Therefore this bounded experiment does not support changing the production
default or claiming general latency improvement. It does support keeping the
strict, optional strategy seam available for further controlled work: the
treatments were adopted without an observed authority defect, every valid run
was accepted, and visual/content quality remained high. A later study would
need repeated matched snapshots, renderer paint instrumentation, and enough
runs to estimate variance. No further inference is authorized by this receipt.

### Verification scope and caveats

- Initial and supplemental traces report full prompt, message, model-call,
  tool-call, and usage coverage; no native child streams or native artifacts
  were present. Provider-reported token totals and subscription dollar cost were
  unavailable and are not estimated.
- The initial saved-module receipt lookup used the wrong local path. Its
  27,981-byte module, 158 newline count, and SHA-256 were recovered directly
  from the preserved isolated workspace; the gate was corrected before
  supplements.
- Exact app and graph binary hashes match the PR #610 control artifacts. They
  were restored from an exact-source trusted worktree because this change does
  not touch Rust inputs. The reason and hashes are recorded in the JSON receipt.
- The live runs identify the executed bundles, but the workspace was dirty and
  later documentation/source edits changed its digest. The live evidence is
  experimental and non-certifying for the eventual committed source snapshot.
- SyncSmith control and treatment runs do not share one workspace/gate source
  digest. Their timing differences are descriptive only and cannot satisfy the
  pre-registered matched-comparison threshold.
- `firstCurrentMs` is a 250 ms polling observation, not a browser paint time.
  Visual inspection proves the settled layouts shown in Relayer Eval, not the
  precise time at which a user first saw them.
