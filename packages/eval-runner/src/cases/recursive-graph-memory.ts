export const RECURSIVE_GRAPH_MEMORY_CASE_ID = "empty-project.recursive-graph-memory.launch-readiness";

export const RECURSIVE_GRAPH_MEMORY_HARNESS_QUARTET = Object.freeze([
  "codex-eval-lantern-search-disabled-recursion-disabled",
  "codex-eval-lantern-search-query-v1-recursion-disabled",
  "codex-eval-lantern-search-disabled-recursion-enabled",
  "codex-eval-lantern-search-query-v1-recursion-enabled",
]);

export const recursiveGraphMemoryPrompts = Object.freeze([
  [
    "Prepare a decision brief for a six-week private beta of Lantern, a fictional macOS desktop agent for local developer tools.",
    "The team has four engineers, no cloud execution, and expects 100 technical users. Cover consent, runtime isolation,",
    "updates, recovery, and abuse risks. Include exactly one section titled “Offline recovery covenant” that makes a concrete",
    "promise about interrupted updates, rollback, and stale permissions. Preserve the reasoning and unresolved tensions so",
    "later decisions can build on this brief.",
  ].join(" "),
  [
    "New constraints: each device can retain only one last-known-good build, 12% of testers may be offline for 72 hours,",
    "and support is staffed four hours per day. Revise the beta plan around those constraints. Find the original",
    "“Offline recovery covenant” in the earlier work and keep the original attached as supporting context without recreating",
    "or paraphrasing it. Identify which earlier assumptions remain valid and which fail. Include exactly one section titled",
    "“Constrained recovery revision”.",
  ].join(" "),
  [
    "A pilot incident interrupted credential rotation on seven devices; two rolled back successfully but retained stale",
    "permission grants. Produce a final go/no-go memo that reconciles the original covenant, the constrained revision, and",
    "this incident. Keep both earlier briefs attached as inspectable supporting context and identify the assumption that failed.",
    "Before finalizing, ask one separate specialist to challenge whether a 48-hour containment plan can make stale grants",
    "impossible. Have that specialist provide one falsifiable condition under the heading “Red-team stop condition”, then",
    "quote that condition exactly in the final memo. Rank the five launch risks and finish with measurable launch, rollback, and",
    "stop thresholds plus named owners for each of the six weeks.",
  ].join(" "),
]);

export const recursiveGraphMemoryEvalCase = Object.freeze({
  id: RECURSIVE_GRAPH_MEMORY_CASE_ID,
  name: "Lantern launch readiness · search × recursion",
  description: "The same three natural turns compare graph search off/on and agent-authored recursion off/on in a controlled Codex 2×2.",
  defaultSelected: false,
  requiredHarnessConfigurationNames: RECURSIVE_GRAPH_MEMORY_HARNESS_QUARTET,
  prompts: recursiveGraphMemoryPrompts,
  requiredChecks: Object.freeze(["agent-authored-complete", "follow-up-graph-search"]),
});
