export const INTERACTION_VARIANTS = Object.freeze(["single-turn", "multi-turn"] as const);

export type InteractionVariant = typeof INTERACTION_VARIANTS[number];

export const DEFAULT_STEERED_MAX_HUMAN_TURNS = 6 as const;
export const SIMULATED_USER_STEERING_PROMPT_VERSION = "simulated-user-steering-prompt-v2" as const;

export interface InteractionVariantPolicy {
  readonly variant: InteractionVariant;
  readonly openingPrompt: string;
  readonly simulatedUserBrief?: string;
  readonly maxHumanTurns?: number;
}

export function isSteeredMultiTurn(policy: { readonly interactionVariant?: InteractionVariant } | null | undefined): boolean {
  return policy?.interactionVariant === "multi-turn";
}

export function steeredMaxHumanTurns(policy: { readonly maxHumanTurns?: number } | null | undefined): number {
  const configured = policy?.maxHumanTurns;
  if (configured === undefined) return DEFAULT_STEERED_MAX_HUMAN_TURNS;
  if (!Number.isInteger(configured) || configured < 2) {
    throw new Error("Steered multi-turn cases require maxHumanTurns of at least 2.");
  }
  return configured;
}

export function requireSingleOpeningPrompt(prompts: readonly string[], variant: InteractionVariant): string {
  if (variant === "single-turn") {
    if (prompts.length !== 1 || prompts.some((prompt) => prompt.trim() === "")) {
      throw new Error("Single-turn cases must carry exactly one opening prompt.");
    }
    return prompts[0]!;
  }
  if (prompts.length !== 1 || prompts[0]!.trim() === "") {
    throw new Error("Steered multi-turn cases start from exactly one opening prompt; later participation is in-flight on the published current.");
  }
  return prompts[0]!;
}

export function buildSimulatedUserSteeringPrompt(input: {
  readonly openingPrompt: string;
  readonly simulatedUserBrief: string;
  readonly remainingHumanTurns: number;
  readonly currentSummary: string;
  readonly completionStatus: string;
}): string {
  if (input.simulatedUserBrief.trim() === "") {
    throw new Error("Steered multi-turn cases require a simulated-user brief.");
  }
  return [
    "You are the product user continuing one in-flight GraphComplete turn, not an evaluator rewriting the task.",
    `Steering prompt version: ${SIMULATED_USER_STEERING_PROMPT_VERSION}.`,
    `The human-root complete() is still ${input.completionStatus}. Visible working state is the live steering surface.`,
    "You may navigate, answer input actions on many current nodes, and use authored invoke actions.",
    "Do not start a second human-root complete() while this one is active.",
    "Do not send a composer follow-up. Composer Send is a later human root.",
    "You cannot write graph records or mutate the workspace yourself.",
    "A full screenshot review still runs independently after this root settles.",
    "This steering step only chooses the next ordinary product action from the current summary.",
    "Do not invent repository, screenshot, or transcript facts that are not present in that summary.",
    `Remaining in-flight actions including wait: ${input.remainingHumanTurns}.`,
    "Original request:",
    input.openingPrompt.trim(),
    "Your role and knowledge:",
    input.simulatedUserBrief.trim(),
    "Published current summary:",
    input.currentSummary.trim(),
    "Return one decision. kind is wait, navigate, commit-input, invoke, or abandon.",
    "commit-input and invoke may target different nodes in this same turn.",
    "wait means let current advance. abandon means stop the in-flight complete.",
  ].join("\n");
}
