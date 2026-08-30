export const RECURSIVE_COMPLETE_EVAL_CASE_ID = "empty-project.recursive-complete.comparison";

/**
 * Fixed capability-comparison task for agent-authored Complete.
 *
 * The prompt is deliberately demanding without instructing delegation: the enabled
 * treatment passes only when the agent independently decides to create semantic work.
 */
export const RECURSIVE_COMPLETE_EVAL_PROMPT = [
  "Compare three real approaches to running untrusted agent code on a developer laptop:",
  "OS-level sandboxing, container isolation, and a separate virtual machine.",
  "For each approach, cover the isolation boundary it actually enforces, the escape it",
  "does not prevent, and the developer-experience cost of adopting it.",
  "Ground every claim in a named mechanism rather than a general principle, and end with",
  "a recommendation for a team shipping a desktop agent product.",
].join(" ");

export const recursiveCompleteEvalCase = Object.freeze({
  id: RECURSIVE_COMPLETE_EVAL_CASE_ID,
  name: "Agent-authored Complete · capability comparison",
  description: "Compares the same Codex task with agent-authored Complete unavailable and available.",
  defaultSelected: false,
  requiredHarnessConfigurationNames: Object.freeze([
    "codex-eval-complete-disabled",
    "codex-eval-complete-enabled",
  ]),
  prompts: Object.freeze([RECURSIVE_COMPLETE_EVAL_PROMPT]),
  requiredChecks: Object.freeze(["agent-authored-complete"]),
});
