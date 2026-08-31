export const RECURSIVE_COMPLETE_EVAL_CASE_ID = "empty-project.recursive-complete.comparison";

/**
 * Natural product-planning task for observing visible working state and semantic scopes.
 *
 * The prompt is deliberately demanding without instructing delegation: the enabled
 * treatment passes only when the agent independently decides to create semantic work.
 */
export const RECURSIVE_COMPLETE_EVAL_PROMPT = [
  "You're planning a six-week private beta for Lantern, a fictional macOS desktop agent",
  "that runs local developer tools. The team has four engineers, no cloud execution, and",
  "expects 100 technical beta users. Produce an integrated launch plan covering onboarding,",
  "consent, and recovery UX; runtime isolation, updates, and failure recovery; and abuse",
  "scenarios and operational risks. Resolve conflicts between usability and safety, rank",
  "the five most important launch risks, and finish with weekly milestones and a concrete",
  "go/no-go checklist.",
].join(" ");

export const recursiveCompleteEvalCase = Object.freeze({
  id: RECURSIVE_COMPLETE_EVAL_CASE_ID,
  name: "Visible working state · recursive comparison",
  description: "Combined experience comparison: V1 without recursive Complete versus V2 with recursive Complete, using the same natural planning task.",
  defaultSelected: false,
  requiredHarnessConfigurationNames: Object.freeze([
    "codex-eval-complete-disabled",
    "codex-eval-complete-enabled",
  ]),
  prompts: Object.freeze([RECURSIVE_COMPLETE_EVAL_PROMPT]),
  requiredChecks: Object.freeze(["agent-authored-complete"]),
});
