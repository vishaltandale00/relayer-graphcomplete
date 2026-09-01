import {
  buildSimulatedUserSteeringPrompt,
  interactionCaseType,
  steeredMaxHumanTurns,
  type EvalInteractionCaseType,
  type InteractionVariant,
} from "../project-cases/interaction-variants.js";

export const STEERING_DECISION_KINDS = Object.freeze([
  "wait",
  "navigate",
  "commit-input",
  "invoke",
  "abandon",
] as const);

export type SteeringDecisionKind = typeof STEERING_DECISION_KINDS[number];

export interface SteeringDecision {
  readonly kind: SteeringDecisionKind;
  readonly reason: string;
  readonly target?: string;
  readonly text?: string;
}

export interface InFlightSnapshot {
  readonly interactionId: string;
  readonly completionStatus: string;
  readonly terminal: boolean;
  readonly currentSummary: string;
}

export interface PublishedCurrentAction {
  readonly id: unknown;
  readonly kind?: unknown;
  readonly label?: unknown;
  readonly prompt?: unknown;
  readonly control?: unknown;
  readonly targetLayerId?: unknown;
  readonly sourceNodeId?: unknown;
}

export interface PublishedCurrentNode {
  readonly id: unknown;
  readonly title?: unknown;
  readonly detail?: unknown;
}

export interface PublishedCurrentSurface {
  readonly threadId: unknown;
  readonly interactionId: unknown;
  readonly graphNodeId: unknown;
  readonly layerId: unknown;
  readonly nodes: readonly PublishedCurrentNode[];
  readonly actions: readonly PublishedCurrentAction[];
}

function normalizedTargetNeedle(target: string): string {
  return target.trim().toLowerCase().replace(/^(node|action|layer):/u, "");
}

function valueMatchesTarget(value: unknown, needle: string): boolean {
  if (needle === "") return false;
  const text = String(value ?? "").trim().toLowerCase();
  return text === needle || text.includes(needle);
}

export function summarizePublishedCurrent(
  completionStatus: string,
  surface: PublishedCurrentSurface | null | undefined,
): string {
  const nodes = surface?.nodes ?? [];
  const actions = surface?.actions ?? [];
  const nodeParts = nodes.flatMap((node) => {
    const title = typeof node.title === "string" ? node.title.trim() : "";
    const detail = typeof node.detail === "string" ? node.detail.trim() : "";
    if (title === "" && detail === "") return [];
    return [detail === "" ? title : `${title}: ${detail}`];
  });
  const actionParts = actions.flatMap((action) => {
    const kind = String(action.kind ?? "action");
    const label = typeof action.label === "string" && action.label.trim() !== ""
      ? action.label.trim()
      : typeof action.prompt === "string" && action.prompt.trim() !== ""
        ? action.prompt.trim()
        : `id ${String(action.id ?? "")}`;
    return [`${kind} ${label}`];
  });
  const parts = [
    `Turn ${completionStatus}.`,
    surface?.layerId == null ? "" : `Current layer ${String(surface.layerId)}.`,
    ...nodeParts,
    ...actionParts,
  ].filter((part) => part !== "");
  return parts.join(" ");
}

export function resolvePublishedCurrentTarget(
  surface: PublishedCurrentSurface,
  target: string,
  preferredKind?: "input" | "invoke" | "navigate",
): {
  readonly node?: PublishedCurrentNode;
  readonly action?: PublishedCurrentAction;
} {
  const needle = normalizedTargetNeedle(target);
  if (needle === "") {
    throw new Error("A steering target is required against published current.");
  }
  const preferredActions = preferredKind === undefined
    ? surface.actions
    : surface.actions.filter((action) => String(action.kind ?? "") === preferredKind);
  const action = preferredActions.find((candidate) => (
    valueMatchesTarget(candidate.id, needle)
    || valueMatchesTarget(candidate.label, needle)
    || valueMatchesTarget(candidate.prompt, needle)
  )) ?? surface.actions.find((candidate) => (
    valueMatchesTarget(candidate.id, needle)
    || valueMatchesTarget(candidate.label, needle)
    || valueMatchesTarget(candidate.prompt, needle)
  ));
  const node = surface.nodes.find((candidate) => (
    valueMatchesTarget(candidate.id, needle)
    || valueMatchesTarget(candidate.title, needle)
  ));
  if (action !== undefined) {
    const source = surface.nodes.find((candidate) => String(candidate.id) === String(action.sourceNodeId));
    return { action, ...(source === undefined ? {} : { node: source }) };
  }
  if (node !== undefined) {
    const owned = preferredActions.find((candidate) => String(candidate.sourceNodeId) === String(node.id))
      ?? surface.actions.find((candidate) => String(candidate.sourceNodeId) === String(node.id));
    return { node, ...(owned === undefined ? {} : { action: owned }) };
  }
  throw new Error(`Published current has no node or action matching ${target}.`);
}

export interface SteeredLoopObservation {
  readonly openingPrompt: string;
  readonly simulatedUserBrief: string;
  readonly remainingHumanTurns: number;
  readonly snapshot: InFlightSnapshot;
  readonly steeringPrompt: string;
}

export interface SteeredLoopPolicy {
  readonly interactionVariant?: InteractionVariant;
  readonly caseType?: EvalInteractionCaseType;
  readonly openingPrompt: string;
  readonly simulatedUserBrief: string;
  readonly maxHumanTurns?: number;
}

export interface SteeredLoopPorts {
  readonly startOpening: (prompt: string) => Promise<{ readonly interactionId: string }>;
  readonly observe: (interactionId: string) => Promise<InFlightSnapshot>;
  readonly decide: (observation: SteeredLoopObservation) => Promise<SteeringDecision>;
  readonly apply: (decision: SteeringDecision, snapshot: InFlightSnapshot) => Promise<void>;
  readonly waitForChange: (interactionId: string) => Promise<void>;
}

export type SteeredLoopTerminal = "accepted" | "abandon" | "budget-exhausted" | "unaccepted-turn";

export interface SteeredLoopResult {
  readonly interactionId: string;
  readonly decisions: readonly SteeringDecision[];
  readonly terminal: SteeredLoopTerminal;
}

export function parseSteeringDecision(value: unknown): SteeringDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Simulated-user steering decision must be an object.");
  }
  const record = value as {
    readonly kind?: unknown;
    readonly reason?: unknown;
    readonly target?: unknown;
    readonly text?: unknown;
  };
  if (!(STEERING_DECISION_KINDS as readonly string[]).includes(String(record.kind))) {
    throw new Error("Simulated-user steering decision kind must be wait, navigate, commit-input, invoke, or abandon.");
  }
  if (typeof record.reason !== "string" || record.reason.trim() === "") {
    throw new Error("Simulated-user steering decision requires a reason.");
  }
  const kind = record.kind as SteeringDecisionKind;
  if (kind === "navigate" || kind === "invoke") {
    if (typeof record.target !== "string" || record.target.trim() === "") {
      throw new Error(`A ${kind} steering decision requires a target.`);
    }
    return { kind, target: record.target.trim(), reason: record.reason.trim() };
  }
  if (kind === "commit-input") {
    if (typeof record.target !== "string" || record.target.trim() === "") {
      throw new Error("A commit-input steering decision requires a target node or action.");
    }
    if (typeof record.text !== "string" || record.text.trim() === "") {
      throw new Error("A commit-input steering decision requires the user value.");
    }
    return { kind, target: record.target.trim(), text: record.text.trim(), reason: record.reason.trim() };
  }
  return { kind, reason: record.reason.trim() };
}

export async function runSteeredInteractionLoop(
  policy: SteeredLoopPolicy,
  ports: SteeredLoopPorts,
): Promise<SteeredLoopResult> {
  if (interactionCaseType(policy) !== "in-turn-steered") {
    throw new Error("Steered interaction loop is only for in-turn-steered cases.");
  }
  const maxHumanTurns = steeredMaxHumanTurns(policy);
  const opening = policy.openingPrompt.trim();
  const brief = policy.simulatedUserBrief.trim();
  if (opening === "" || brief === "") {
    throw new Error("In-turn steered cases require an opening prompt and simulated-user brief.");
  }

  const started = await ports.startOpening(opening);
  const decisions: SteeringDecision[] = [];

  for (let used = 0; used < maxHumanTurns; used += 1) {
    const snapshot = await ports.observe(started.interactionId);
    if (snapshot.terminal) {
      return {
        interactionId: started.interactionId,
        decisions,
        terminal: snapshot.completionStatus === "accepted" ? "accepted" : "unaccepted-turn",
      };
    }
    const remainingHumanTurns = maxHumanTurns - used;
    const decision = parseSteeringDecision(await ports.decide({
      openingPrompt: opening,
      simulatedUserBrief: brief,
      remainingHumanTurns,
      snapshot,
      steeringPrompt: buildSimulatedUserSteeringPrompt({
        openingPrompt: opening,
        simulatedUserBrief: brief,
        remainingHumanTurns,
        currentSummary: snapshot.currentSummary,
        completionStatus: snapshot.completionStatus,
      }),
    }));
    decisions.push(decision);
    if (decision.kind === "abandon") {
      await ports.apply(decision, snapshot);
      return { interactionId: started.interactionId, decisions, terminal: "abandon" };
    }
    if (decision.kind === "wait") {
      await ports.waitForChange(started.interactionId);
      continue;
    }
    await ports.apply(decision, snapshot);
  }

  let snapshot = await ports.observe(started.interactionId);
  while (!snapshot.terminal) {
    await ports.waitForChange(started.interactionId);
    snapshot = await ports.observe(started.interactionId);
  }
  return {
    interactionId: started.interactionId,
    decisions,
    terminal: snapshot.completionStatus === "accepted" ? "budget-exhausted" : "unaccepted-turn",
  };
}
