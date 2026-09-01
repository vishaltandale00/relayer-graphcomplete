export const INTERACTION_VARIANTS = Object.freeze(["single-turn", "multi-turn"] as const);

export type InteractionVariant = typeof INTERACTION_VARIANTS[number];

export const DEFAULT_STEERED_MAX_HUMAN_TURNS = 6 as const;
export const SIMULATED_USER_STEERING_PROMPT_VERSION = "simulated-user-steering-prompt-v1" as const;

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
    throw new Error("Steered multi-turn cases start from exactly one opening prompt; later turns are simulated-user authored.");
  }
  return prompts[0]!;
}

export function buildSimulatedUserSteeringPrompt(input: {
  readonly openingPrompt: string;
  readonly simulatedUserBrief: string;
  readonly remainingHumanTurns: number;
  readonly lastTurnSummary: string;
}): string {
  if (input.simulatedUserBrief.trim() === "") {
    throw new Error("Steered multi-turn cases require a simulated-user brief.");
  }
  return [
    "You are the product user continuing one GraphComplete thread, not an evaluator rewriting the task.",
    `Steering prompt version: ${SIMULATED_USER_STEERING_PROMPT_VERSION}.`,
    "You already explored the latest accepted graph through the simulated-user review tools.",
    "Choose the next ordinary product action a real user could take now.",
    "You may send a follow-up message, accept the work as done, or abandon the thread.",
    "You cannot write graph records, mutate the workspace, or start a second human root while one complete() is still active.",
    "A new follow-up waits until the current human root has accepted, stopped, or failed.",
    `Remaining human turns including a possible follow-up: ${input.remainingHumanTurns}.`,
    "Original request:",
    input.openingPrompt.trim(),
    "Your role and knowledge:",
    input.simulatedUserBrief.trim(),
    "Latest accepted-turn summary:",
    input.lastTurnSummary.trim(),
    "Return one decision. follow-up requires the exact next user message. done means the visible work is sufficient to stop. abandon means you would stop without accepting the outcome.",
  ].join("\n");
}
