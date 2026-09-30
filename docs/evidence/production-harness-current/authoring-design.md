# Reducing graph authoring cost without prescribing agent flow

Read-only investigation, 2026-09-29. Baseline fd24be077444308698de35572128934f5d0200d4 plus existing local production-harness changes. No executable changes, inference, commit, or deployment. This proposal is not verification of an implemented fix.

## Recommendation

Start with a **small executable authoring reference and a short validation/repair path**, then evaluate optional compiler-compatible presentation utilities. Do not start with a publication orchestrator: the observed failures are mostly before graph writes, and neither trace demonstrates a publication-order failure. A helper that saves transport calls will not by itself fix spending minutes composing invalid or oversized source.

The shared prompt already embeds `detailAuthoringReference()` generated from the canonical compiler. Thus the problem is not simply a missing CSS allowlist. Test whether a compact, indexed reference with exact language signatures and independent examples makes existing capabilities easier to use. Preserve all authoritative constraints; do not simply append another long section.

Agent-owned flow, topology, content, design, recursion, questions, publication timing, and finalization remain unchanged. No minimum node count, required recursion, mandatory update cadence, or inferred question flow is proposed.

## Evidence from the actual traces

Source: ignored `events.jsonl` and separate `graph-operations.jsonl` in `.relayer/live/current-gate-codex-retry/codex-traces/1` and `.relayer/live/current-gate/prime-traces/1`. Event sequences below refer to `events.jsonl`. Extracted only tool arguments/results and lifecycle metadata; no credentials or hidden reasoning are reproduced.

| Observation | Evidence | Interpretation and limits |
| --- | --- | --- |
| Codex performed three API/source-reference commands before authoring | Completed command events 76, 80, 89; 04:40:47–04:41:06 UTC | Exact constructor, detail, and action signatures were sought despite supplied guidance. This is not proof all discovery was unnecessary. |
| Codex's first complete inline authoring program failed on `border-collapse` | Event 153 at 04:43:07.939; `unsafe_css` | Property was not in the compiler's allowlist, which was already delivered. |
| The replacement program failed on ordinary HTML interpolation | Event 204 at 04:44:57.261; interpolation must be an unquoted `gc=` or `asset=` binding, plus binding-consumption issues | A familiar template-literal pattern was incompatible with this DSL. |
| Third authoring program succeeded | Event 262 at 04:46:52.824 | About 225 seconds elapsed between first failed program and successful program completion. This interval includes generation, redesign, execution, and repair; it is not a measured removable repair cost. |
| Prime performed seven dedicated API introspection calls | Started events 2016, 2131, 2138, 2242, 2249, 2335, 2470 | Inspecting exported names, signatures, input types, node kinds, and package source consumed tool/model work. |
| Prime encountered preventable API/environment mismatches | Completed events 2012 and 2569 | Shell subprocess denied by the existing boundary; `InteractionInput.message` does not exist. Do not weaken the sandbox to fix the first mistake. |
| Prime also hit unsupported CSS | Event 9796, after first substantial style/helper program at 04:44:12.645 | Both `border-collapse` and `cursor` rejected. The next cell repaired styles and its probe passed (10227). |
| Prime built its own reusable presentation code | Event 11160 reports `helpers ready 7604` | Reusable layout/style functions are a real authoring pattern. It does not prove that shipping a particular template is best. |
| Prime needed two source-syntax repairs | Events 13663 and 15575; unclosed parenthesis | Large Python authoring cells failed before graph semantics were exercised. Later smaller repairs succeeded. |
| Server operations were late | Existing investigation: first node POST around 404 s Codex / 468 s Prime, trace-relative | Main cost precedes publication. No semantic child preparation or nonterminal advance in complete graph-operation logs. |

Prime's model-event trace is truncated at its configured limit; 22 tool calls are visible, not a claim of complete inference coverage. Its independent graph-operation log is complete. Neither run establishes causation for the reported one-node responses; Codex's accepted root had four nodes. No live Claude sample was run.

## Proposed first change: a usable capability reference

1. Keep a short shared semantic map in the prompt: what nodes, layers, details, actions, current, completion, and authority mean. Put mandatory constraints apart from optional examples and presentation preferences.
2. Supply exact public JS/Python signatures and return shapes where observed exploration exposed gaps: constructors, input fields and controls, action binding, current, and completion handles. Generate or validate these against public clients to prevent a second drifting specification.
3. Provide independent, executable examples for static detail, action-bound detail, question controls, publication, and recursion. A snippet demonstrates one capability; it is not an end-to-end recipe. Examples must not imply advancing only immediately before finishing.
4. Highlight the two observed traps next to the relevant call: arbitrary text interpolation is not supported by `html` binding slots; CSS is a constrained subset. Show a tested static-table or grid example using allowed properties. Keep the complete compiler-generated reference available.
5. Demonstrate checkpointing a small component and reusing the validated style source before generating a large authored closure. This is optional authoring support, not a product workflow obligation. Checkpoint does not accept graph content or advance current.
6. Improve structured repair feedback only where errors lack actionable locality; current errors already identify component, path, line, and column. Avoid building a redundant validator before identifying an actual diagnostic gap.

JS production authoring currently requires a fixed stdin heredoc and explicitly forbids creating source files in the project or temporary directory (`codex-basic.ts`, authoringInstructions). Pinned launcher execution has further inspection restrictions. Consequently, persistent file authoring is **not** a drop-in recommendation. A managed editable source workspace would require a separate design and authority review. Prime already has run-scoped persistent Python state; examples can use that existing facility without adding a scheduler.

## Second option: small optional visual primitives

If the first experiment still shows repeated style generation or DSL repair, offer compiler-tested presentation source helpers (for example spacing/layout utilities or table markup) and safe text/fragment construction. These must remain optional, composable, theme-aware, and permit custom HTML/CSS. They must not choose the user's node titles, group semantic content, create navigation, or prescribe a card-based response.

Proposed interface direction only: a safe text constructor or escaped-fragment utility, with dedicated typed action/asset bindings remaining explicit. Do not silently change `html` interpolation to accept arbitrary objects or strings: that risks confusing inert content with capabilities and changing ownership rules. Any helper must produce normal authoring source through the same owner-bound compiler, never accept precompiled packages or mint capabilities.

Before implementing, compare the cost of documenting valid existing fragment construction against expanding the DSL. Test hostile text, action identity, owner isolation, cross-node template reuse, both themes, export/import, and rendered controls. Preserve the compiled visual detail requirement; relaxing it requires a new presentation version and an explicit product decision.

## Third option: explicit graph materialization helper

Reserve this for evidence of repeated ordering or bookkeeping errors. A possible public client helper could accept an already-authored set of NodeObject, EdgeObject, LayerObject and source/action pairs, then write drafts in dependency order. It should return draft references and structured errors. Naming and exact interface remain design proposals.

Keep publication a separate explicit `advanceCurrent` call and completion a separate explicit terminal call. The helper must not invent edges, layout, actions, backreferences, identifiers, semantic children, or authority. It must not automatically retry a stale current with a new revision, discard orphan layers, or silently repair accepted content.

This would **not** make a multi-request draft write transaction atomic. Partial draft writes may remain after a failure; report them and preserve stable keys for exact retry. Existing graph core remains the acceptance and authority boundary. The helper has to preserve action source-node identity, source-layer provenance, owner-bound compiled controls, accepted-record immutability, and operation-key/CAS semantics. Attached-node presentation replacements remain governed by their exact grants and terminal publication rules; an ordinary advance helper cannot substitute for those rules.

A declarative whole-graph JSON alternative would introduce another authoring surface and complicated bindings. The object client already describes dependencies and ownership. Prefer composing it if a helper becomes warranted.

## Tests and controlled evaluation

- Offline: executable snippets against real JS/Python clients and canonical compiler; composed prompts for all three harnesses with broker present/absent; compare documentation signatures with client declarations. Include the two actual CSS failures, invalid interpolation, valid controls, question payload shape, owner mismatch, and supported light/dark visuals. These tests prove usable mechanics, not model adoption.
- If adding helpers: exercise partial failure and retry without duplicate drafts, accepted-node rejection, cross-completion authority, source provenance, orphan visibility, stale revision, and exact operation replay at the existing production boundaries. No default paid inference.
- Live: matched natural prompts with exact model/reasoning/runtime/presentation pins. First compare current prompt versus reorganized reference/examples only. Then independently compare optional visual utilities if needed. Use multiple paired trials; keep explicit delegation as a mechanism control, not natural-choice proof.
- Record discovery calls, compiler errors, repair attempts, generated authoring source size, first draft write, first accepted current, first useful rendered graph, final quality, total latency, and costs when available. Separate model-generation time from transport/compiler timings where instrumentation supports it. Do not label gaps between events as pure repair time.
- Review graphs visually for useful topology and explanation in both themes; include simple direct answers and complex navigation tasks. Count nodes, updates, and children diagnostically only. Obtain actual one-node conversations before claiming to fix that symptom.

## Source contract anchors

- `README.md`: canonical complete boundary, single graph store, object clients and detail ownership.
- `docs/architecture.md`: graph authority, native runtime and personal-presentation boundaries.
- `docs/decisions/0005-layered-navigation-contract.md`: typed navigation, stable keys, accepted history, author-owned flow.
- `docs/decisions/0008-temporal-current-and-completion-brokers.md`: current CAS/idempotency, native recursion, terminal access revocation.
- `docs/decisions/0009-personal-presentation-graph-attachments.md`: immutable presentation pins and optional recursive behavior.
- `docs/prd/index.html`: personal presentation and compiled detail sections; input-action semantics remain the next-interaction contract.
- `packages/harness-host/src/implementations/graph-presentation-guidance.ts`: existing generated visual reference, owner/publication contract.
- `packages/harness-host/src/implementations/codex-basic.ts`: heredoc restrictions and JavaScript capability instructions, shared with Claude.
- `packages/harness-host/src/implementations/prime-agent.ts`: Python reference and runnable whole-response example.
- `packages/graph-client/src/detail.ts`: `detailAuthoringReference()` exposes compiler-derived names/limits, not unrestricted browser CSS.
- `packages/graph-client/src/client.ts`: checkpoint binds owner and compiles source without publication.

No new empirical speedup is claimed. This is one subagent's source/evidence recommendation, not a certifying review or release gate.
