import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Codex,
  type CodexOptions,
  type ModelReasoningEffort,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
} from "@openai/codex-sdk";
import type { LayerReview, NodeReview, TurnReview } from "./contracts.js";
import type { FinalizedReviewResult, IncrementalReviewStore } from "./review-store.js";
import {
  DEFAULT_SIMULATED_USER_RUBRIC,
  type SimulatedUserRubricManifest,
} from "./rubric.js";
import {
  SIMULATED_USER_MCP_SERVER_NAME,
  SIMULATED_USER_MCP_TOKEN_ENV,
  SIMULATED_USER_MCP_TOOL_NAMES,
  startSimulatedUserReviewMcpServer,
  type McpToolTraceEntry,
  type ReviewSessionController,
  type SimulatedUserMcpServerOptions,
} from "./mcp-server.js";

export const SIMULATED_USER_PROMPT_VERSION = "simulated-user-judge-prompt-v1" as const;

export interface JudgeThreadResult {
  readonly items: readonly ThreadItem[];
  readonly finalResponse: string;
  readonly usage: Usage | null;
}

export interface JudgeThread {
  readonly id: string | null;
  run(input: string, options?: TurnOptions): Promise<JudgeThreadResult>;
}

export interface JudgeThreadStartRequest {
  readonly codexOptions: CodexOptions;
  readonly threadOptions: ThreadOptions;
}

export interface JudgeThreadFactory {
  start(request: JudgeThreadStartRequest): JudgeThread;
}

export interface SimulatedUserJudgeConfiguration {
  readonly model: string;
  readonly modelReasoningEffort: ModelReasoningEffort;
  readonly promptVersion?: typeof SIMULATED_USER_PROMPT_VERSION;
  readonly rubric?: SimulatedUserRubricManifest;
}

export interface SimulatedUserJudgeRunOptions {
  readonly executionId: string;
  readonly originalRequest: string;
  readonly configuration: SimulatedUserJudgeConfiguration;
  readonly controller: ReviewSessionController;
  readonly reviewStore: IncrementalReviewStore<LayerReview, NodeReview, TurnReview>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly workingDirectory?: string;
  readonly signal?: AbortSignal;
  readonly threadFactory?: JudgeThreadFactory;
  readonly mcpServer?: Pick<SimulatedUserMcpServerOptions, "bearerToken" | "now" | "port">;
}

export interface SimulatedUserJudgeRunRecord {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly originalRequest: string;
  readonly judge: {
    readonly model: string;
    readonly modelReasoningEffort: ModelReasoningEffort;
  };
  readonly prompt: {
    readonly version: typeof SIMULATED_USER_PROMPT_VERSION;
    readonly text: string;
  };
  readonly rubric: SimulatedUserRubricManifest;
  readonly enforcement: {
    readonly sandboxMode: "read-only";
    readonly approvalPolicy: "never";
    readonly networkAccessEnabled: false;
    readonly webSearchMode: "disabled";
    readonly allowedMcpServer: typeof SIMULATED_USER_MCP_SERVER_NAME;
    readonly allowedTools: typeof SIMULATED_USER_MCP_TOOL_NAMES;
    readonly environmentKeys: readonly string[];
  };
  readonly codexThreadId: string | null;
  readonly finalResponse: string;
  readonly usage: Usage | null;
  /** Complete Codex turn items, including failed calls rejected before an MCP handler ran. */
  readonly codexTrace: readonly ThreadItem[];
  readonly toolTrace: readonly McpToolTraceEntry[];
  readonly review: FinalizedReviewResult<LayerReview, NodeReview, TurnReview>;
}

const ENVIRONMENT_ALLOWLIST = new Set([
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

export async function runSimulatedUserJudge(
  options: SimulatedUserJudgeRunOptions,
): Promise<SimulatedUserJudgeRunRecord> {
  requireNonEmpty(options.executionId, "execution ID");
  requireNonEmpty(options.originalRequest, "original request");
  requireNonEmpty(options.configuration.model, "judge model");
  const rubric = structuredClone(options.configuration.rubric ?? DEFAULT_SIMULATED_USER_RUBRIC);
  const promptVersion = options.configuration.promptVersion ?? SIMULATED_USER_PROMPT_VERSION;
  if (promptVersion !== SIMULATED_USER_PROMPT_VERSION) {
    throw new Error(`Unsupported simulated-user prompt version: ${promptVersion}`);
  }
  const prompt = buildSimulatedUserJudgePrompt(options.originalRequest, rubric, options.reviewStore.inventory);
  const temporaryWorkingDirectory = options.workingDirectory === undefined
    ? await mkdtemp(join(tmpdir(), "relayer-simulated-user-judge-"))
    : undefined;
  const workingDirectory = options.workingDirectory ?? temporaryWorkingDirectory!;
  const mcp = await startSimulatedUserReviewMcpServer({
    controller: options.controller,
    reviewStore: options.reviewStore,
    ...options.mcpServer,
  });

  try {
    const environment = sanitizeJudgeEnvironment(options.environment ?? process.env, {
      [SIMULATED_USER_MCP_TOKEN_ENV]: mcp.bearerToken,
    });
    const codexOptions: CodexOptions = {
      env: environment,
      config: {
        mcp_servers: {
          [SIMULATED_USER_MCP_SERVER_NAME]: {
            url: mcp.endpoint,
            bearer_token_env_var: SIMULATED_USER_MCP_TOKEN_ENV,
            enabled_tools: [...SIMULATED_USER_MCP_TOOL_NAMES],
          },
        },
      },
    };
    const threadOptions: ThreadOptions = {
      model: options.configuration.model,
      modelReasoningEffort: options.configuration.modelReasoningEffort,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      workingDirectory,
      skipGitRepoCheck: true,
      additionalDirectories: [],
    };
    const threadFactory = options.threadFactory ?? defaultJudgeThreadFactory;
    const thread = threadFactory.start({ codexOptions, threadOptions });
    const turn = await thread.run(prompt, options.signal === undefined ? {} : { signal: options.signal });
    assertReviewOnlyCodexTrace(turn.items);
    const review = options.reviewStore.finalizedResult();
    if (review === undefined) {
      throw new Error("Simulated-user judge ended without submitReview finalizing complete review coverage");
    }

    return deepFreeze({
      schemaVersion: 1 as const,
      executionId: options.executionId,
      originalRequest: options.originalRequest,
      judge: {
        model: options.configuration.model,
        modelReasoningEffort: options.configuration.modelReasoningEffort,
      },
      prompt: { version: promptVersion, text: prompt },
      rubric,
      enforcement: {
        sandboxMode: "read-only" as const,
        approvalPolicy: "never" as const,
        networkAccessEnabled: false as const,
        webSearchMode: "disabled" as const,
        allowedMcpServer: SIMULATED_USER_MCP_SERVER_NAME,
        allowedTools: SIMULATED_USER_MCP_TOOL_NAMES,
        environmentKeys: Object.keys(environment).sort(),
      },
      codexThreadId: thread.id,
      finalResponse: turn.finalResponse,
      usage: turn.usage,
      codexTrace: structuredClone(turn.items),
      toolTrace: mcp.trace(),
      review,
    });
  } finally {
    await mcp.close();
    if (temporaryWorkingDirectory !== undefined) {
      await rm(temporaryWorkingDirectory, { recursive: true, force: true });
    }
  }
}

export function buildSimulatedUserJudgePrompt(
  originalRequest: string,
  rubric: SimulatedUserRubricManifest,
  inventory: IncrementalReviewStore<LayerReview, NodeReview, TurnReview>["inventory"],
): string {
  return [
    "You are the simulated user reviewing one completed GraphComplete turn in the read-only production workspace.",
    "Use only the simulated_user_review MCP tools. Do not use a shell, files, web search, network access, or any other MCP server.",
    "Explore only through visible controls. Element references allow interaction but are not evidence.",
    "Capture screenshots before rating. Review every reachable layer with the same recursive rubric; root and child layers have no different rules.",
    "Treat node count as qualitative context only, never as an automatic threshold.",
    "Write layer and node reviews incrementally. Include every visible navigate or invoke action inside its source node review.",
    "A navigate action requires source and traversed destination evidence. An invoke action requires visible source evidence and remains disabled.",
    "Use null only when UI evidence genuinely cannot assess a criterion, and provide a criterion-specific justification.",
    "Call submitReview only after complete lower-subject coverage. Do not put new layer or node assessments in submitReview.",
    "",
    "Original user request:",
    originalRequest,
    "",
    "Required review inventory:",
    JSON.stringify(inventory, null, 2),
    "",
    `Rubric manifest (${rubric.rubricVersion}):`,
    JSON.stringify(rubric, null, 2),
  ].join("\n");
}

export function sanitizeJudgeEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  additions: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const key of [...ENVIRONMENT_ALLOWLIST].sort()) {
    const value = source[key];
    if (value !== undefined) sanitized[key] = value;
  }
  for (const [key, value] of Object.entries(additions)) {
    if (key !== SIMULATED_USER_MCP_TOKEN_ENV) throw new Error(`Judge environment addition is not allowlisted: ${key}`);
    sanitized[key] = value;
  }
  return sanitized;
}

export function assertReviewOnlyCodexTrace(items: readonly ThreadItem[]): void {
  const allowedTools = new Set<string>(SIMULATED_USER_MCP_TOOL_NAMES);
  for (const item of items) {
    if (item.type === "command_execution") {
      throw new Error(`Simulated-user judge trace used forbidden shell command: ${item.command}`);
    }
    if (item.type === "file_change") {
      throw new Error("Simulated-user judge trace attempted a forbidden file change");
    }
    if (item.type === "web_search") {
      throw new Error(`Simulated-user judge trace attempted forbidden web search: ${item.query}`);
    }
    if (item.type === "mcp_tool_call" && (
      item.server !== SIMULATED_USER_MCP_SERVER_NAME || !allowedTools.has(item.tool)
    )) {
      throw new Error(`Simulated-user judge trace used forbidden MCP tool: ${item.server}/${item.tool}`);
    }
  }
}

const defaultJudgeThreadFactory: JudgeThreadFactory = {
  start(request) {
    const codex = new Codex(request.codexOptions);
    return codex.startThread(request.threadOptions);
  },
};

function requireNonEmpty(value: string, label: string): void {
  if (value.trim() === "") throw new Error(`Simulated-user ${label} must not be empty`);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
