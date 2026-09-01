import {
  buildSimulatedUserSteeringPrompt,
  steeredMaxHumanTurns,
  type InteractionVariant,
} from "../project-cases/interaction-variants.js";

export type SteeringDecisionKind = "follow-up" | "done" | "abandon";

export interface SteeringDecision {
  readonly kind: SteeringDecisionKind;
  readonly text?: string;
  readonly reason: string;
}

export interface SteeredTurnRecord {
  readonly turnIndex: number;
  readonly interactionId: string;
  readonly accepted: boolean;
  readonly summary: string;
}

export interface SteeredLoopObservation {
  readonly openingPrompt: string;
  readonly simulatedUserBrief: string;
  readonly humanTurnCount: number;
  readonly remainingHumanTurns: number;
  readonly lastTurn: SteeredTurnRecord;
  readonly steeringPrompt: string;
}

export interface SteeredLoopPolicy {
  readonly interactionVariant: InteractionVariant;
  readonly openingPrompt: string;
  readonly simulatedUserBrief: string;
  readonly maxHumanTurns?: number;
}

export interface SteeredLoopPorts {
  readonly runOpening: (prompt: string) => Promise<SteeredTurnRecord>;
  readonly reviewTurn: (turn: SteeredTurnRecord) => Promise<{ readonly summary: string }>;
  readonly decide: (observation: SteeredLoopObservation) => Promise<SteeringDecision>;
  readonly runFollowUp: (text: string) => Promise<SteeredTurnRecord>;
}

export type SteeredLoopTerminal = "done" | "abandon" | "budget-exhausted" | "unaccepted-turn";

export interface SteeredLoopResult {
  readonly turns: readonly SteeredTurnRecord[];
  readonly decisions: readonly SteeringDecision[];
  readonly terminal: SteeredLoopTerminal;
}

export function parseSteeringDecision(value: unknown): SteeringDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Simulated-user steering decision must be an object.");
  }
  const record = value as { readonly kind?: unknown; readonly text?: unknown; readonly reason?: unknown };
  if (record.kind !== "follow-up" && record.kind !== "done" && record.kind !== "abandon") {
    throw new Error("Simulated-user steering decision kind must be follow-up, done, or abandon.");
  }
  if (typeof record.reason !== "string" || record.reason.trim() === "") {
    throw new Error("Simulated-user steering decision requires a reason.");
  }
  if (record.kind === "follow-up") {
    if (typeof record.text !== "string" || record.text.trim() === "") {
      throw new Error("A follow-up steering decision requires the next user message.");
    }
    return { kind: "follow-up", text: record.text.trim(), reason: record.reason.trim() };
  }
  return { kind: record.kind, reason: record.reason.trim() };
}

export async function runSteeredInteractionLoop(
  policy: SteeredLoopPolicy,
  ports: SteeredLoopPorts,
): Promise<SteeredLoopResult> {
  if (policy.interactionVariant !== "multi-turn") {
    throw new Error("Steered interaction loop is only for multi-turn variants.");
  }
  const maxHumanTurns = steeredMaxHumanTurns(policy);
  const opening = policy.openingPrompt.trim();
  const brief = policy.simulatedUserBrief.trim();
  if (opening === "" || brief === "") {
    throw new Error("Steered multi-turn cases require an opening prompt and simulated-user brief.");
  }

  const turns: SteeredTurnRecord[] = [];
  const decisions: SteeringDecision[] = [];
  const openingTurn = await ports.runOpening(opening);
  turns.push(openingTurn);
  if (!openingTurn.accepted) {
    return { turns, decisions, terminal: "unaccepted-turn" };
  }

  while (turns.length < maxHumanTurns) {
    const lastTurn = turns[turns.length - 1]!;
    const reviewed = await ports.reviewTurn(lastTurn);
    const remainingHumanTurns = maxHumanTurns - turns.length;
    const decision = parseSteeringDecision(await ports.decide({
      openingPrompt: opening,
      simulatedUserBrief: brief,
      humanTurnCount: turns.length,
      remainingHumanTurns,
      lastTurn: { ...lastTurn, summary: reviewed.summary },
      steeringPrompt: buildSimulatedUserSteeringPrompt({
        openingPrompt: opening,
        simulatedUserBrief: brief,
        remainingHumanTurns,
        lastTurnSummary: reviewed.summary,
      }),
    }));
    decisions.push(decision);
    if (decision.kind !== "follow-up") {
      return { turns, decisions, terminal: decision.kind };
    }
    const followUp = await ports.runFollowUp(decision.text!);
    turns.push(followUp);
    if (!followUp.accepted) {
      return { turns, decisions, terminal: "unaccepted-turn" };
    }
  }

  await ports.reviewTurn(turns[turns.length - 1]!);
  return { turns, decisions, terminal: "budget-exhausted" };
}
