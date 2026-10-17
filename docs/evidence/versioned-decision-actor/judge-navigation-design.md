# Judge navigation with Decisions: proposed execution seam

This is a design proposal, not an implemented or promoted judge revision.
The navigation-heavy experiment separately measures the existing actor versions.

**The distinction.** The task actor already emits structured action JSON; the
host applies browser actions. Native Codex is not given browser tools in that
actor. The existing presentation judge does use scoped MCP tools for screenshot,
interact, history, reviewNode, reviewLayer and submitReview. The completion judge
is different again: it receives a bounded evidence packet and makes one structured
assessment without navigation or tools. A completion-judge call offers no
navigation loop to optimize.

**Same operations, different selector.** The presentation judge's existing
ReviewSessionController is the execution seam: screenshot, interact and history.
A Decisions adapter could enumerate concrete operations from the current visible
review state, assign opaque choice IDs and ask which to perform next. It would
map the returned ID back to the exact offered operation and call that existing
controller. Decisions itself does not execute tools. For example:

```
current screenshot + current controls + inspection history + remaining coverage
  -> choose one operation (Codex, Decisions, or a prescribed coverage walk)
  -> host validates the offered operation and current scope
  -> existing interact / history / screenshot implementation
  -> new screenshot and recorded outcome
  -> Codex writes a node/layer assessment when its evidence is ready
  -> existing evidence validator and bottom-up review store accept or reject it
```

An offer can bind `interact({elementRef, activate:true})` to one visible node or
navigation action, `history({delta:-1})` to an available return, or screenshot to
one currently visible capture target. A capture-region control cannot be
activated as navigation. No arbitrary tool name, selector, graph ID, file path,
write operation or unobserved input option should be synthesized by the selector.
The current control binding must still hold when dispatch occurs. Preserve
refusals, missing controls, failed captures and unknown outcomes; an intent is not
proof of execution. All prior observations and effects used by selection must be
chronological. Selected operations can be recorded without inventing a textual
rationale from a model that returned only a choice.

**Judgment remains a separate operation.** Textual explanations, criterion scores,
missing-action findings, child-layer interpretation and final conclusions still
need semantic assessment. Initially retain the same Codex model, rubric and
scoring rules for those calls. Existing screenshot provenance, complete coverage,
evidence binding, bottom-up expansion review, reference-cycle handling and final
store validation remain authoritative. Presentation quality remains separate from
underlying task correctness; selecting a control correctly does not grade the
content behind it. Decisions predicate/score questions could be a separate future
calibration experiment, but are not a demonstrated replacement for this review.

**An even simpler option for exhaustive judging.** This judge already inventories
all required nodes/actions/layers and cannot finalize missing review subjects.
Mechanical traversal of required coverage may need no model selection: the host
can collect required screenshots in the contract's dependency order, then ask
Codex for the semantic review using those exact captures. This uses deterministic
rules for required evidence coverage, not to decide quality or suppress missing-
action judgments. Decisions is more useful for discretionary extra inspection,
ambiguous next actions or participant-like exploration. Any collector must retain
real production rendering, action source/destination captures, current state
binding and explicit capture failures. It cannot substitute raw graph text for
user-visible evidence.

**A comparison that would answer the judge question.** Freeze one accepted graph
and required review inventory. Compare (A) existing Codex MCP exploration and
assessment, (B) Decisions-selected exploration with the same Codex assessment, and
(C) prescribed required-evidence collection with the same assessment. Record
coverage and screenshot evidence separately from final scores. Compare exploration
inference, browser/tool time, assessment inference, calls, usage, failures and
wall time. First use the same imposed inspection itinerary to isolate selector
latency; separately let each route choose its path to measure autonomous coverage
and behavior. Label those experiments distinctly. Use identical frozen evidence
packets when testing scoring alone; different exploration traces are not an
identical-evidence judge comparison.

Native session token counters must use terminal cumulative values, while
independent Decisions HTTP request usage is summed. Subscription token usage does
not provide a per-run dollar charge. Do not claim cheaper overall judging from a
cheap selector or fewer tool calls alone.

This requires an explicit new immutable judge execution contract and selection;
no existing judge or rubric should be silently changed. Root publication in an
isolated experimental registry is distinct from publishing a descendant revision
or promoting a default. Existing feedback lineage and human calibration remain
necessary for normal revision/promotion workflows. Default tests must inject
inference and test the actual controller/store seams; paid comparisons remain
opt-in.

Production source references: desktop/eval-main/browser-review.mjs,
review-session.mjs, simulated-user-judge.mjs and task-completion-judge.mjs;
packages/eval-runner/src/simulated-user/judge-runner.ts, mcp-server.ts,
recursive-review.ts and evidence validators. Product authority: PRD13.2.3–13.2.4,
ADR0003 and ADR0016. OpenAI's Decisions reference supports constrained choice
responses and does not expose tool execution:
https://developers.openai.com/api/reference/resources/decisions/methods/create
