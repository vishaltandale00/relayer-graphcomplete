# Task prompt size inspection, 2026-10-18

Source snapshot: `2ef4f7a4f14bb444a955a180a2f90cec34873e93` (clean tracked source when measured). This is a read-only implementation inspection with one research note added. It does not establish task-average token usage or acceptance-quality evidence.

## Measured Relayer-authored input

The shipped profiles produce roughly **69–77 KB of Relayer-authored task text before substantial user input, graph history, or a model-family roster**. These strings are mostly the ordinary provider task prompt, not the complete native system prompt.

| Shipped profile | Characters | UTF-8 bytes | Approximate tokens, characters / 4 |
| --- | ---: | ---: | ---: |
| Codex basic, layered + native-agent tail | 76,789 | 76,793 | 19,198 |
| Claude basic, layered | 77,251 | 77,255 | 19,313 |
| Prime basic | 69,443 | 69,447 | 17,361 |

The fixture has interaction ID `10`, the 18-character message `Explain recursion.`, no attached context, empty accepted-turn history and graph-history page, root origin, `contextMode: graph-v1`, the actual Structure/V6 preference content, graph search enabled, a completion broker, draft-preview capability and first-topic-icon eligibility. It has no sealed completion contract, family roster or screenshots. These optional/variable inputs make the table an illustrative measurement, not a production average or an exact receipt for an existing run.

The supplied path strings were:

```text
client: file:///Applications/Relayer.app/Contents/Resources/graph-client/index.js
complete: file:///Applications/Relayer.app/Contents/Resources/completion/index.js
Codex launcher: /Applications/Relayer.app/Contents/Resources/runtime/graph-authoring-launcher
```

These are explicit measurement parameters, not a claim about the installed application's paths. Claude used the ordinary Node/heredoc branch. Platform and path differences change the result slightly.

A diagnostic variant removing presentation preferences, broker, previews and topic-icon eligibility, while retaining graph search and the same root input/history, produced 68,675 characters for Codex, 67,762 for Claude and 61,391 for Prime. Removing V6 is not the shipped new-thread behavior; these figures only isolate optional attachments.

## Largest included pieces

Pieces overlap where stated; do not sum this table to obtain the total.

| Piece | Characters | Approximate tokens |
| --- | ---: | ---: |
| Current/publication authoring recipe, JavaScript | 17,527 | 4,382 |
| Current/publication authoring recipe, Python | 17,409 | 4,353 |
| Shared current-workspace guidance | 12,375 | 3,094 |
| Compiler-generated visual vocabulary JSON, inside current-workspace guidance | 5,916 | 1,479 |
| JavaScript graph-search block | 4,919 | 1,230 |
| V6 preferences plus authority text | 2,927 | 732 |
| General presentation guidance | 2,753 | 689 |
| Current communication guidance, JavaScript | 2,449 | 613 |
| Python graph API reference | 1,944 | 486 |
| One icon-guidance block | 1,646 | 412 |
| Separate native presentation-propagation instructions | 1,083 | 271 |

The exact icon-guidance string occurs **three times** in generated Codex and Claude input and **twice** in Prime input. Keeping one copy would remove 3,292 characters from each JavaScript prompt, or 1,646 from Prime, without changing the wording. Whether removing repetitions changes model behavior still requires verification.

Removing only the broker changes the illustrative prompt by 3,280 characters for Codex, 3,281 for Claude and 3,355 for Prime. Removing only previews changes it by 1,197, 1,202 and 1,058 characters respectively. V6 contributes the same 2,927 characters to all three.

## Source boundaries and variable context

- [Codex configuration](../../harnesses/codex-basic.yaml) selects `layered-navigation-multi-agent-v1`; [Codex prompt construction](../../packages/harness-host/src/implementations/codex-basic.ts) selects the shared layered builder and appends native-agent guidance. Its `threadParams` passes the separate 1,083-character propagation block through `developerInstructions`; the large assembled string is the turn input.
- [Claude](../../packages/harness-host/src/implementations/claude-basic.ts) calls the same layered builder and supplies its result as SDK `query({ prompt, options })`. Its native runtime instructions, native tools and MCP descriptions are outside this measurement.
- [Prime configuration](../../harnesses/prime-agent-basic.yaml) has no `promptProfile`, so [Prime](../../packages/harness-host/src/implementations/prime-agent.ts) uses its basic Python prompt branch. It passes task text to `promptAndWait`; presentation-propagation instructions enter its session-scoped instruction loader separately. Prime's native system/tool/skill content is outside this measurement.
- [Shared presentation guidance](../../packages/harness-host/src/implementations/graph-presentation-guidance.ts) eagerly includes the compiler's [visual authoring vocabulary](../../packages/graph-client/src/detail.ts), icon guidance and long publication/repair examples.
- [Interaction rendering](../../packages/harness-host/src/interaction-input.ts) serializes the current contract/message and bounded history pointers. Root execution receives up to eight graph-history entries from [the host](../../packages/harness-host/src/host.ts); attached bodies and older content are read on demand. Sealed contracts, annotations, submitted input values, screenshots, topic-icon eligibility and history vary per task.
- [Model-family guidance](../../packages/harness-host/src/implementations/model-family-guidance.ts) adds frozen orchestrator/roster JSON when a version-2 plan is supplied. This variable block was not included in the fixture.
- [V6 source content](../../crates/relayer-app-server/src/runtime.rs) is already an immutable accepted graph. [Its renderer](../../packages/harness-host/src/implementations/personal-presentation-guidance.ts) flattens all selected preference nodes into every applicable root task. [ADR 0009](../decisions/0009-personal-presentation-graph-attachments.md) requires exact preference pinning and native-authoring-child propagation.

Semantic child executions receive their own task/contract and run through the provider's normal prompt path. Provider-native helper prompts depend on the assigning agent and native runtime; they have no one fixed size established here. [ADR 0006](../decisions/0006-harness-provider-agnostic-product-boundary.md) keeps native helpers, semantic children and graph authority distinct.

## Method and limits

Measured the real `buildLayeredNavigationPrompt` function and Prime `prompt` method under Node 25.9.0's TypeScript transform, without installing dependencies, building native artifacts or invoking inference. A temporary module-resolution hook mapped local `.js` imports to their `.ts` sources. Uncalled YAML parsing and Prime visual-execution dependencies were stubbed. The graph-client dependency supplied the exact compiler allowlist declarations and `detailAuthoringReference` function extracted from tracked source, plus the actual edge-shape declarations. V6 fixture records came from the actual Rust built-in definitions and were passed through the production presentation renderer. The Codex native-agent tail was copied verbatim from its production selection branch.

Exact byte and character counts concern only these generated strings. Approximate tokens are `ceil(characters / 4)` because no tokenizer was available; this ratio can be materially wrong for code/JSON or a particular provider tokenizer. The separate native-propagation block is excluded from the main table. Native runtime system instructions, tool schemas, discovered skills, workspace instruction files, protocol framing, cached-token accounting, retrieved content, subsequent tool exchanges and actual provider-reported usage are unmeasured. No task corpus was sampled, so no savings or task-average claim follows from these counts.

The proposed instruction graph would therefore need a compact resident contract and selective loading of trusted, version-pinned references/recipes. Moving text into a graph alone saves no context if the renderer still reads and injects every node. Retrieval must preserve dependencies, explicit graph acceptance and authority, and V6's required visual-authoring support. Product meaning and acceptance remain with GraphComplete; native recursion remains with each provider.

A possible design keeps completion/authority rules and a trusted pinned instruction manifest always resident, then fetches language-specific recipes through applicability and dependency links. This requires a trusted instruction-read boundary distinct from ordinary user-content graph search: current search visibility does not grant access to hidden policy. The existing personal-presentation read API can read the execution's exact pin, but that alone does not create a general instruction search API. V6 needs graph and visual authoring on almost every task, so the useful retrieval unit may be a compact common recipe plus rarer repair, artifact, search and advanced-control references. Compare total task input tokens, acceptance/repair outcomes and latency, including retrieval results and repeated turns; initial prompt length alone cannot establish average savings. This is a proposal, not an implemented runtime change or a decided PRD update.
