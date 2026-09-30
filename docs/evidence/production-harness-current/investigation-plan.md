# Agent-owned flow: investigation and proposed experiments

Date: 2026-09-29. Source baseline: `fd24be077444308698de35572128934f5d0200d4`,
with the existing uncommitted production-harness/current changes. This document
does not change executable behavior or certify a release. No new inference ran
for this investigation.

## Product direction from this discussion

The agent chooses the flow of each query: direct work, semantic recursion,
questions, graph structure, current publication, and completion. Supply accurate
capabilities and consequences without prescribing a workflow. GraphComplete
continues to enforce authority, integrity, and explicit lifecycle. Native helpers
are distinct from semantic children; no additional scheduler is proposed.

Evaluate useful user outcomes, not a minimum number of nodes, recursive calls,
or pointer updates. Existing thread configuration and presentation pins remain
unchanged. Any new presentation policy must use a new immutable version.

## What the evidence establishes

1. **The capabilities are wired, but were not chosen in these runs.** The live
   receipt in this directory records recursion enabled and completion brokers
   available. The complete graph-operation logs contain no completion preparation
   or nonterminal current advancement. Codex submitted once; Prime never submitted.
   Claude uses the shared JavaScript prompt builder and receives a broker in its
   execution environment (`claude-basic.ts:287`, `:398`); this is source evidence,
   not live Claude qualification.
2. **Delay precedes graph writes.** Relative to each trace's first graph request,
   Codex first POSTed a node at 404.05 s, then submitted at 404.52 s. Prime first
   POSTed a node at 468.48 s and had only draft nodes/edges/layers at its deadline.
   These are trace-relative server-operation observations, not first-render
   timings. Model/tool work before publication is the first investigation target.
3. **Visible progress is already requested.** V4 inherits V2's Visible working
   state preference, including useful early current and separate semantic scopes
   when useful (`runtime.rs:2192`, `:2227`). More copies of that instruction alone
   are not an evidence-based solution.
4. **Every node has a visual authoring obligation.** V4 requires compiled visual
   detail for every authored node (`runtime.rs:2236`). Both harnesses teach
   ownership, checkpointing, binding, actions, and immutable publication. The
   traces show API exploration and authoring repair. This is evidence of work;
   its causal contribution to topology or elapsed time is not yet isolated.
5. **Examples can imply a sequence.** Prime's runnable example creates one answer
   node and one detail node in separate layers, then advances current immediately
   before final submission (`prime-agent.ts:2036`). Its explicit disclaimer says
   this is mechanics only. Nevertheless, whether the demonstrated sequence biases
   behavior is a testable hypothesis. JavaScript also allows flat answers and
   teaches consolidation of nodes with duplicate explanations. These permissions
   do not prove the cause of single-node output.
6. **Questions have a concrete capability limit.** The PRD's node-authored input
   contract (`docs/prd/index.html:2420`) makes committed answers draft attachments
   for the next Send, which creates a new root interaction. Re-reading the active
   interaction input does not receive a newly committed answer. A general
   same-completion await-user/resume operation is not established by these APIs.
   Permission approval tools must not be treated as equivalent semantic input.
   More specifically, `canonical_input_occurrence` in
   `crates/relayer-graph-core/src/storage/sqlite/actions.rs:136` requires the
   `completions` row for the presenting interaction. Advance only publishes;
   Return also finalizes and inserts that row (`graph/completion/current.rs:104`,
   `graph/completion/accept.rs:15`). Thus a newly authored input in nonterminal
   current is not yet commit-eligible from that occurrence. Answering an older
   accepted input while another run is active is a different, supported case.
   This is source-path evidence; a dedicated product test remains in the plan.
7. **Earlier success used a different task.** Run `0fc27a06` explicitly requested
   three semantic workstreams. Its recorded result was first graph at 20 s, 11
   root advances, and all four completions accepted in 211 s. The latest runs used
   a natural task without delegation instructions and different execution
   snapshots. They are not a controlled regression comparison.

Historical evidence:
https://github.com/vishaltandale00/relayer-graphcomplete/issues/503#issuecomment-5857995870

The reported recent single-node conversations have not yet been sampled. The
latest measured Codex graph had four root nodes and four authored layers, so it
does not reproduce that symptom. Prime's incomplete drafts likewise do not
establish a one-node accepted response. A thread title or query has been requested.

## Ranked hypotheses and how to distinguish them

| Hypothesis | Prediction | Controlled comparison |
| --- | --- | --- |
| Authoring overhead makes publication and additional nodes expensive | Most pre-publication effort is API discovery, visual construction, and repairs; reducing mechanical work improves time without reducing explanation quality | Keep the task, model, policy, and visual requirement; compare existing recipes with equivalent concise, executable recipes or supported helpers |
| Prompt organization makes final artifact construction more salient than available interaction choices | A capability-oriented prompt changes chosen flow on natural tasks without requiring recursion or updates | Hold APIs and presentation version fixed; change only prompt organization and remove incidental sequencing from examples |
| A capability gap prevents intended user interaction | Questions can be authored, but their answer cannot resume the active completion through the existing input API | Deterministic actual-product input round trip plus an explicit check of which completion receives the answer |
| Presentation requirements or examples encourage content consolidation | Complex explanations collapse into a rich single detail even when distinct graph objects would aid navigation | Compare matched natural queries under separately versioned presentation variants; retain plain-answer cases and human topology review |
| Thread pins, provider/model choice, or later changes explain the perceived regression | Behavior clusters by actual delivered prompt/presentation or model, rather than the named production config alone | Record the frozen thread/version and delivered prompt identity for real examples; compare matched new threads |

These are hypotheses. A trace replay can deterministically count publication and
child events; it cannot reproduce a model's decision or prove a prompt fix.

## Ways to make it work

### A. Clarify the capability contract first

Propose one shared semantic description with native Python/JavaScript bindings.
Explain what nodes, layers, details, input actions, invokes, semantic children,
current, and terminal submission mean to the user and runtime. State which
operations are available in this execution and their consequences. Separate hard
ordering/authority rules from preferences and from nonbinding mechanics examples.

Use small independently usable examples for publication, observation, recursion,
questions, and finishing. Avoid a single sample that accidentally becomes the
default end-to-end algorithm. Preserve freedom to choose structure and flow.
The Python quick reference should cover input authoring and answer consumption as
explicitly as graph construction and recursion. Verify equivalent delivered
capabilities across all three providers, including broker-absent executions.

This is the smallest first experiment. It does not guarantee behavior changes.

### B. Reduce mechanical authoring work if measurements support it

Try concise, validated public-client helpers for repeated layout/detail/binding
mechanics while preserving model-authored semantics and explicit publication.
Helpers must not select when to recurse, ask, advance, or finish. First test
whether better examples suffice; add API surface only for observed repeated cost.

Relaxing the all-nodes-visual requirement is a separate presentation decision,
not a hidden prompt optimization. Test it only as a separately versioned option;
do not silently weaken the accepted visual feature or mutate historical pins.

### C. Extend interaction capabilities only for an agreed use case

The current product can collect answers into a later human interaction. Document
that accurately now. If the desired experience requires an active completion to
receive an answer and continue, design the authority and lifecycle explicitly:
question identity, durable answer delivery, cancel/restart behavior, duplicates,
concurrent work, and which completion may observe which answer. Do not invent
polling of composer state or imply an input action grants a waiting API.

This option is a product/runtime change, not something prompt wording can enable.
It has two independently testable boundaries: allowing input from nonterminal
current, and delivering an answer to an active completion. Implementing the first
does not automatically implement the second.

## Proposed verification sequence

1. **Capture the baseline.** Obtain representative one-node conversations and
   record actual prompt, personal-presentation pin, provider/model/reasoning,
   query, graph topology, current history, children, tool failures, and outcome.
   Inspect only task-relevant local records; do not modify existing conversations.
2. **Offline capability audit.** Exercise actual composed Claude/Codex/Prime
   prompts with broker present/absent. Validate recipes against public clients.
   Test current publication, immutable history, child settlement, and input Send
   round trip at their existing production seams. Prompt assertions prove
   delivery only. No paid inference enters the default suite.
3. **Run one-variable live experiments.** Begin with A, holding model/settings,
   task, native runtime, and presentation version fixed. Keep the earlier
   explicit-delegation task as a mechanism control, not natural-choice evidence.
   Then isolate B or presentation variants if needed; avoid changing everything
   together. Claude requires its own authenticated live proof.
4. **Use natural task families.** Include a simple direct answer, an integrated
   multi-workstream task, a consequential ambiguity, a question with independent
   work available, and a comparison/evidence task with useful navigable structure.
   Include continuation after an actual user answer. Do not tell the natural-task
   models to recurse or meet node/update counts.
5. **Measure the experience.** Record request-to-first useful rendered graph,
   server publication separately, meaningful revisions, root and child timing,
   question-to-answer-to-next-work timing, total latency, tool errors, token/cost
   usage where available, and final task quality. Report node/layer/child counts
   diagnostically, not as universal passing criteria. Judge usefulness and
   topology blind to the prompt arm where practical.
6. **Repeat and preserve failures.** One trial is a smoke test. Compare repeated
   paired trials, state sample counts, preserve incomplete/truncated traces, and
   avoid cross-model speedup claims. Human visual review must establish that the
   graph helps understanding rather than merely looking busy.
7. **Review before rollout.** Map each changed seam to deterministic checkpoints,
   run the repository's applicable heavy checks and adversarial review, then keep
   new configuration/presentation activation limited to new conversations. No
   merge, release, or deployment is part of this investigation.

## Immediate decision

Recommended first implementation proposal: capability-oriented prompt structure
plus accurate question semantics and equivalent native examples (A). Validate
it against a pinned baseline before deciding that stronger instructions or a
new API are needed. Keep B and C as evidence-driven options. No executable
changes were made as part of this investigation.

## Review and limits

Independent read-only audit by `/root/audit_flow` corroborated shared Claude/JS
prompt wiring, conditional semantic-child guidance, missing Python question
examples, workflow heuristics mixed with hard rules, and the input-occurrence
finalization boundary. Its final plan-review turn failed due to model capacity;
there is no completed adversarial certification of this document. No PR exists.
`git diff --check` passed for the existing tracked diff; no implementation test
suite was run for this documentation-only investigation. Historical live results
remain qualified by the source snapshots and trace limits in the adjacent receipt.
