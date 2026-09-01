export const INTERACTION_VARIANTS = Object.freeze(["single-turn", "multi-turn"] as const);

export type InteractionVariant = typeof INTERACTION_VARIANTS[number];

/** Product-facing catalog types from PRD §13.2.2. */
export const EVAL_INTERACTION_CASE_TYPES = Object.freeze(["single-turn", "in-turn-steered"] as const);

export type EvalInteractionCaseType = typeof EVAL_INTERACTION_CASE_TYPES[number];

export const EVAL_INTERACTION_CASE_TYPE_LABELS = Object.freeze({
  "single-turn": "Single-turn",
  "in-turn-steered": "In-turn steered",
} as const satisfies Record<EvalInteractionCaseType, string>);

export const CASE_TYPE_BY_INTERACTION_VARIANT = Object.freeze({
  "single-turn": "single-turn",
  "multi-turn": "in-turn-steered",
} as const satisfies Record<InteractionVariant, EvalInteractionCaseType>);

export const INTERACTION_VARIANT_BY_CASE_TYPE = Object.freeze({
  "single-turn": "single-turn",
  "in-turn-steered": "multi-turn",
} as const satisfies Record<EvalInteractionCaseType, InteractionVariant>);

export const DEFAULT_STEERED_MAX_HUMAN_TURNS = 6 as const;
export const SIMULATED_USER_STEERING_PROMPT_VERSION = "simulated-user-steering-prompt-v2" as const;

export interface InteractionVariantPolicy {
  readonly variant: InteractionVariant;
  readonly openingPrompt: string;
  readonly simulatedUserBrief?: string;
  readonly maxHumanTurns?: number;
}

export interface InteractionCaseTypePolicy {
  readonly interactionVariant?: InteractionVariant;
  readonly caseType?: EvalInteractionCaseType;
}

export function interactionCaseType(
  policy: InteractionCaseTypePolicy | object | null | undefined,
): EvalInteractionCaseType | undefined {
  if (policy == null || typeof policy !== "object") return undefined;
  const record = policy as InteractionCaseTypePolicy;
  if (record.caseType !== undefined) return record.caseType;
  if (record.interactionVariant === undefined) return undefined;
  return CASE_TYPE_BY_INTERACTION_VARIANT[record.interactionVariant];
}

export function interactionVariantForCaseType(caseType: EvalInteractionCaseType): InteractionVariant {
  return INTERACTION_VARIANT_BY_CASE_TYPE[caseType];
}

export function isInTurnSteered(policy: InteractionCaseTypePolicy | null | undefined): boolean {
  return interactionCaseType(policy) === "in-turn-steered";
}

export function isSteeredMultiTurn(policy: InteractionCaseTypePolicy | null | undefined): boolean {
  return isInTurnSteered(policy);
}

export function steeredMaxHumanTurns(policy: { readonly maxHumanTurns?: number } | null | undefined): number {
  const configured = policy?.maxHumanTurns;
  if (configured === undefined) return DEFAULT_STEERED_MAX_HUMAN_TURNS;
  if (!Number.isInteger(configured) || configured < 2) {
    throw new Error("In-turn steered cases require maxHumanTurns of at least 2.");
  }
  return configured;
}

export function requireSingleOpeningPrompt(
  prompts: readonly string[],
  type: InteractionVariant | EvalInteractionCaseType,
): string {
  const caseType = type === "multi-turn" || type === "in-turn-steered" ? "in-turn-steered" : "single-turn";
  if (caseType === "single-turn") {
    if (prompts.length !== 1 || prompts.some((prompt) => prompt.trim() === "")) {
      throw new Error("Single-turn cases must carry exactly one opening prompt.");
    }
    return prompts[0]!;
  }
  if (prompts.length !== 1 || prompts[0]!.trim() === "") {
    throw new Error("In-turn steered cases start from exactly one opening prompt; later participation is in-flight on the published current.");
  }
  return prompts[0]!;
}

export function decorateEvalCaseCatalogEntry<Definition extends object>(
  definition: Definition,
): Definition & { readonly caseType?: EvalInteractionCaseType; readonly caseTypeLabel?: string } {
  const caseType = interactionCaseType(definition);
  if (caseType === undefined) return definition;
  return {
    ...definition,
    caseType,
    caseTypeLabel: EVAL_INTERACTION_CASE_TYPE_LABELS[caseType],
  };
}

export function buildSimulatedUserSteeringPrompt(input: {
  readonly openingPrompt: string;
  readonly simulatedUserBrief: string;
  readonly remainingHumanTurns: number;
  readonly currentSummary: string;
  readonly completionStatus: string;
}): string {
  if (input.simulatedUserBrief.trim() === "") {
    throw new Error("In-turn steered cases require a simulated-user brief.");
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
