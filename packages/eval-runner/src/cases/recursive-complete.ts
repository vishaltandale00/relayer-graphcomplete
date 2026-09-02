export const RECURSIVE_COMPLETE_EVAL_CASE_ID = "empty-project.recursive-complete.comparison";

/**
 * Natural product-planning task for comparing visual Node Detail presentation.
 *
 * The prompt is deliberately demanding without prescribing the visual-detail API.
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
  name: "Visual Node Details · recursive baseline",
  description: "Compares the established recursive V2 presentation baseline with V3 visual Node Detail guidance using the same natural planning task.",
  defaultSelected: false,
  requiredHarnessConfigurationNames: Object.freeze([
    "codex-eval-visual-node-details-control",
    "codex-eval-visual-node-details-treatment",
  ]),
  prompts: Object.freeze([RECURSIVE_COMPLETE_EVAL_PROMPT]),
  requiredChecks: Object.freeze(["agent-authored-complete", "visual-node-detail"]),
});
