import { Codex, type CodexOptions, type ModelReasoningEffort, type ThreadOptions } from "@openai/codex-sdk";

import { sanitizeJudgeEnvironment } from "./judge-runner.js";
import { parseSteeringDecision, type SteeredLoopObservation, type SteeringDecision } from "./steered-loop.js";

export interface SteeringThread {
  run(prompt: string): Promise<{ readonly finalResponse: string }>;
}

export interface SteeringThreadFactory {
  start(input: { readonly codexOptions: CodexOptions; readonly threadOptions: ThreadOptions }): SteeringThread;
}

export const DEFAULT_STEERING_MODEL = "gpt-5.4" as const;
export const DEFAULT_STEERING_REASONING_EFFORT = "high" as const;

function defaultSteeringThreadFactory(codexPathOverride?: string): SteeringThreadFactory {
  return {
    start({ codexOptions, threadOptions }) {
      const codex = new Codex({
        ...codexOptions,
        ...(codexPathOverride === undefined ? {} : { codexPathOverride }),
      });
      const thread = codex.startThread(threadOptions);
      return {
        run: async (prompt) => {
          const turn = await thread.run(prompt);
          return { finalResponse: turn.finalResponse };
        },
      };
    },
  };
}

export function extractSteeringDecisionJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Simulated-user steering response did not contain a JSON object.");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

export async function runSimulatedUserSteeringDecision(options: {
  readonly observation: SteeredLoopObservation;
  readonly model?: string;
  readonly modelReasoningEffort?: ModelReasoningEffort;
  readonly codexPathOverride?: string;
  readonly threadFactory?: SteeringThreadFactory;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<SteeringDecision> {
  const threadFactory = options.threadFactory ?? defaultSteeringThreadFactory(options.codexPathOverride);
  const thread = threadFactory.start({
    codexOptions: {
      ...(options.codexPathOverride === undefined ? {} : { codexPathOverride: options.codexPathOverride }),
      env: sanitizeJudgeEnvironment(options.environment ?? process.env),
    },
    threadOptions: {
      model: options.model ?? DEFAULT_STEERING_MODEL,
      modelReasoningEffort: options.modelReasoningEffort ?? DEFAULT_STEERING_REASONING_EFFORT,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      skipGitRepoCheck: true,
    },
  });
  const turn = await thread.run(`${options.observation.steeringPrompt}\nRespond with one JSON object: {"kind":"follow-up"|"done"|"abandon","text":"...optional follow-up...","reason":"..."}.`);
  return parseSteeringDecision(extractSteeringDecisionJson(turn.finalResponse));
}
