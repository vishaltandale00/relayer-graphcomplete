import { Codex, type CodexOptions, type Input, type ModelReasoningEffort, type ThreadItem, type ThreadOptions, type TurnOptions, type Usage } from "@openai/codex-sdk";
import type { InputOccurrenceSnapshot, InputOptionSnapshot, ProductInputValue } from "./input-operator.js";

export interface InputRoundTripExpectation {
  readonly occurrence: InputOccurrenceSnapshot;
  readonly sourceNodeId: number;
  readonly action: Readonly<Record<string, unknown>>;
  readonly value: ProductInputValue;
}

export interface InputRoundTripEvidence {
  readonly authoredAccepted: boolean;
  readonly interaction: {
    readonly id: string | number;
    readonly graphNodeId: string | number | null;
    readonly submittedInputs: readonly unknown[];
  };
  readonly inputChildren: readonly unknown[];
  readonly harnessTraceEvents: readonly unknown[];
}

export interface InputRoundTripCheck {
  readonly name:
    | `input-roundtrip:materialized-provenance:action-${number}`
    | `input-roundtrip:normalized-harness-input:action-${number}`
    | "input-roundtrip:required-control-inventory"
    | "input-roundtrip:complete-commit-set";
  readonly passed: boolean;
  readonly detail: string;
}

export interface InputRoundTripControlIdentity {
  readonly presentingInteractionNodeId: number;
  readonly presentingLayerId: number;
  readonly sourceNodeId: number;
  readonly actionId: number;
  readonly control: "text" | "single_select" | "multi_select";
  readonly options: readonly InputOptionSnapshot[];
  readonly minimumSelections?: number;
}

export interface InputGroundingJudgeThread {
  readonly id: string | null;
  run(input: Input, options?: TurnOptions): Promise<{
    readonly items: readonly ThreadItem[];
    readonly finalResponse: string;
    readonly usage: Usage | null;
  }>;
}

export interface InputGroundingRating {
  readonly schemaVersion: 1;
  readonly status: "completed";
  readonly submittedInput: unknown;
  readonly screenshot: {
    readonly screenshotId: string;
    readonly threadRevision: string;
    readonly imageRefs: readonly string[];
  };
  readonly verdict: "grounded" | "not_grounded" | "indeterminate";
  readonly reason: string;
  readonly visibleEvidence: readonly string[];
  readonly judge: {
    readonly model: string;
    readonly modelReasoningEffort: ModelReasoningEffort;
    readonly codexThreadId: string | null;
    readonly usage: Usage | null;
    readonly trace: readonly ThreadItem[];
  };
}

const groundingRatingSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["grounded", "not_grounded", "indeterminate"] },
    reason: { type: "string" },
    visibleEvidence: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "reason", "visibleEvidence"],
  additionalProperties: false,
} as const;

const GROUNDING_ENVIRONMENT_ALLOWLIST = new Set([
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

export async function runInputGroundingJudge(options: {
  readonly submittedInput: unknown;
  readonly screenshot: {
    readonly screenshotId: string;
    readonly threadRevision: string;
    readonly imagePaths: readonly string[];
    readonly imageRefs?: readonly string[];
  };
  readonly codexPathOverride: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly workingDirectory: string;
  readonly model: string;
  readonly modelReasoningEffort: ModelReasoningEffort;
  readonly threadFactory?: (codexOptions: CodexOptions, threadOptions: ThreadOptions) => InputGroundingJudgeThread;
}): Promise<InputGroundingRating> {
  if (!options.screenshot.screenshotId || !options.screenshot.threadRevision || options.screenshot.imagePaths.length === 0) {
    throw new Error("Input grounding rating requires one versioned screenshot with image evidence.");
  }
  const environment = Object.fromEntries(Object.entries(options.environment ?? process.env)
    .filter((entry): entry is [string, string] => (
      GROUNDING_ENVIRONMENT_ALLOWLIST.has(entry[0]) && entry[1] !== undefined
    )));
  const codexOptions: CodexOptions = {
    codexPathOverride: options.codexPathOverride,
    env: environment,
    config: {
      features: {
        apps: false,
        browser_use: false,
        computer_use: false,
        image_generation: false,
        shell_tool: false,
        skill_search: false,
        unified_exec: false,
        view_image: false,
      },
    },
  };
  const threadOptions: ThreadOptions = {
    model: options.model,
    modelReasoningEffort: options.modelReasoningEffort,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    workingDirectory: options.workingDirectory,
    skipGitRepoCheck: true,
  };
  const thread = options.threadFactory?.(codexOptions, threadOptions)
    ?? new Codex(codexOptions).startThread(threadOptions);
  const input: Input = [{
    type: "text",
    text: [
      "Rate only whether the visible answer materially uses the submitted interaction input.",
      "The screenshot is the sole authority for the visible answer. Do not inspect files, use tools, or infer hidden behavior.",
      "Choose grounded only when visible answer content depends materially on the submitted value, not merely when the answer is generically compatible with it.",
      "When Submitted input contains a values array, choose grounded only when the visible answer materially uses every value. Return one visibleEvidence entry per submitted value, in the same order.",
      "Choose not_grounded when the answer is visible but would say materially the same thing without the submitted value.",
      "Choose indeterminate when the screenshot does not expose enough of the answer to decide.",
      `Submitted input: ${JSON.stringify(options.submittedInput)}`,
    ].join("\n"),
  }, ...options.screenshot.imagePaths.map((path) => ({ type: "local_image" as const, path }))];
  const turn = await thread.run(input, { outputSchema: groundingRatingSchema });
  assertInputGroundingTrace(turn.items);
  const parsed: unknown = JSON.parse(turn.finalResponse);
  const expectedEvidenceCount = submittedValueCount(options.submittedInput);
  if (!isRecord(parsed)
    || !["grounded", "not_grounded", "indeterminate"].includes(String(parsed.verdict))
    || typeof parsed.reason !== "string" || !parsed.reason.trim()
    || !Array.isArray(parsed.visibleEvidence)
    || parsed.visibleEvidence.some((entry) => typeof entry !== "string" || !entry.trim())
    || (parsed.verdict === "grounded" && parsed.visibleEvidence.length !== expectedEvidenceCount)) {
    throw new Error("Input grounding judge returned an invalid structured rating.");
  }
  return {
    schemaVersion: 1,
    status: "completed",
    submittedInput: structuredClone(options.submittedInput),
    screenshot: {
      screenshotId: options.screenshot.screenshotId,
      threadRevision: options.screenshot.threadRevision,
      imageRefs: [...(options.screenshot.imageRefs ?? options.screenshot.imagePaths.map((path) => path.split(/[\\/]/).at(-1)!))],
    },
    verdict: parsed.verdict as InputGroundingRating["verdict"],
    reason: parsed.reason,
    visibleEvidence: [...parsed.visibleEvidence] as string[],
    judge: {
      model: options.model,
      modelReasoningEffort: options.modelReasoningEffort,
      codexThreadId: thread.id,
      usage: turn.usage,
      trace: structuredClone(turn.items),
    },
  };
}

function submittedValueCount(input: unknown): number {
  return isRecord(input) && Array.isArray(input.values) ? input.values.length : 1;
}

export function assertInputGroundingTrace(items: readonly ThreadItem[]): void {
  for (const item of items) {
    if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type)) {
      throw new Error(`Input grounding judge used forbidden capability: ${item.type}`);
    }
  }
}

export function gradeInputRoundTrip(
  expectation: InputRoundTripExpectation,
  evidence: InputRoundTripEvidence,
): { readonly passed: boolean; readonly checks: readonly InputRoundTripCheck[] } {
  validateExpectation(expectation);
  const expectedSemantic = { action: expectation.action, value: expectation.value };
  const exactChild = evidence.inputChildren.find((candidate) => isRecord(candidate)
    && canonical(candidate.occurrence ?? occurrenceFromFlatChild(candidate)) === canonical(expectation.occurrence)
    && Number(candidate.parentInteractionNodeId) === Number(evidence.interaction.graphNodeId)
    && Number(candidate.sourceNodeId) === expectation.sourceNodeId
    && canonical(candidate.action) === canonical(expectation.action)
    && canonical(candidate.value) === canonical(expectation.value));
  const submitted = evidence.interaction.submittedInputs.some((candidate) => canonical(candidate) === canonical(expectedSemantic));
  const materialized = evidence.authoredAccepted
    && positiveId(evidence.interaction.graphNodeId)
    && submitted
    && exactChild !== undefined;

  const normalizedInputs = evidence.harnessTraceEvents.flatMap(normalizedInputsFromTraceEvent);
  const traced = normalizedInputs.some((candidate) => canonical(candidate) === canonical(expectedSemantic));
  const checks: InputRoundTripCheck[] = [
    {
      name: `input-roundtrip:materialized-provenance:action-${expectation.occurrence.actionId}`,
      passed: materialized,
      detail: materialized
        ? "An accepted authored input was submitted with a root interaction and one provenance-exact input child."
        : "Accepted authoring, submitted semantic input, root materialization, or provenance-exact child evidence is missing.",
    },
    {
      name: `input-roundtrip:normalized-harness-input:action-${expectation.occurrence.actionId}`,
      passed: traced,
      detail: traced
        ? "The next harness prompt contains the exact normalized submitted input snapshot."
        : "The next harness trace does not contain the exact normalized submitted input snapshot.",
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

export function gradeInputRoundTripControlSet(
  authored: readonly InputRoundTripControlIdentity[],
  committed: readonly InputRoundTripControlIdentity[],
): { readonly passed: boolean; readonly checks: readonly InputRoundTripCheck[] } {
  const authoredIds = new Set(authored.map(({ actionId }) => actionId));
  const nodeOccurrences = new Set(authored.map(({ presentingInteractionNodeId, presentingLayerId, sourceNodeId }) => (
    `${presentingInteractionNodeId}:${presentingLayerId}:${sourceNodeId}`
  )));
  const actionFor = (control: InputRoundTripControlIdentity["control"]) => authored.find((entry) => entry.control === control);
  const text = actionFor("text");
  const single = actionFor("single_select");
  const multi = actionFor("multi_select");
  const exactOptions = (actual: readonly InputOptionSnapshot[], expected: readonly InputOptionSnapshot[]) => (
    new Set(actual.map(({ key }) => key)).size === actual.length
      && actual.every(({ key, label }) => key.trim() !== "" && label.trim() !== "")
      && canonical(actual.map(({ label }) => label).sort()) === canonical(expected.map(({ label }) => label).sort())
  );
  const authoredInventory = authored.length === 3
    && authoredIds.size === 3
    && nodeOccurrences.size === 1
    && authored.every(({ presentingInteractionNodeId, presentingLayerId, sourceNodeId, actionId }) => (
      [presentingInteractionNodeId, presentingLayerId, sourceNodeId, actionId].every(positiveId)
    ))
    && text !== undefined && text.options.length === 0 && text.minimumSelections === undefined
    && single !== undefined && single.minimumSelections === undefined && exactOptions(single.options, [
      { key: "canary", label: "Canary" },
      { key: "full-rollout", label: "Full rollout" },
    ])
    && multi !== undefined && multi.minimumSelections === 2 && exactOptions(multi.options, [
      { key: "health-metrics", label: "Health metrics" },
      { key: "logs", label: "Logs" },
      { key: "synthetic-checks", label: "Synthetic checks" },
    ]);
  const authoredById = new Map(authored.map((identity) => [identity.actionId, canonical(identity)]));
  const committedIds = new Set(committed.map(({ actionId }) => actionId));
  const completeCommitSet = authoredInventory
    && committed.length === authored.length
    && committedIds.size === committed.length
    && committed.every((identity) => authoredById.get(identity.actionId) === canonical(identity));
  const checks: InputRoundTripCheck[] = [
    {
      name: "input-roundtrip:required-control-inventory",
      passed: authoredInventory,
      detail: authoredInventory
        ? "One accepted decision node exposes the exact required text, rollout single-select, and minimum-two validation multi-select contracts."
        : "The accepted graph does not expose the exact three-control contract on one shared decision-node occurrence.",
    },
    {
      name: "input-roundtrip:complete-commit-set",
      passed: completeCommitSet,
      detail: completeCommitSet
        ? "Every required input action was committed exactly once with its authored control kind."
        : "The operator commit set is missing, duplicating, or mismatching a required authored input action.",
    },
  ];
  return { passed: checks.every(({ passed }) => passed), checks };
}

function validateExpectation(expectation: InputRoundTripExpectation): void {
  if (!Object.values(expectation.occurrence).every((id) => positiveId(id)) || !positiveId(expectation.sourceNodeId)) {
    throw new Error("Input round-trip expectation requires positive provenance identities.");
  }
  if (!isRecord(expectation.action) || !isRecord(expectation.value)) {
    throw new Error("Input round-trip expectation requires immutable action and value snapshots.");
  }
}

function normalizedInputsFromTraceEvent(event: unknown): unknown[] {
  if (!isRecord(event) || event.type !== "prompt" || !isRecord(event.data) || typeof event.data.text !== "string") return [];
  const marker = "Normalized interaction input:\n";
  const start = event.data.text.indexOf(marker);
  if (start < 0) return [];
  const json = extractJsonObject(event.data.text, start + marker.length);
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) && Array.isArray(parsed.submittedInputs) ? parsed.submittedInputs : [];
  } catch {
    return [];
  }
}

function extractJsonObject(text: string, offset: number): string | null {
  const start = text.indexOf("{", offset);
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function occurrenceFromFlatChild(child: Readonly<Record<string, unknown>>): unknown {
  return {
    presentingInteractionNodeId: child.presentingInteractionNodeId,
    presentingLayerId: child.presentingLayerId,
    actionId: child.actionId,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function positiveId(value: unknown): boolean {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
