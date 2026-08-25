import { spawn, type ChildProcess } from "node:child_process";
import type { GraphCapability, GraphNode } from "@relayer/graph-client";
import type {
  Harness,
  HarnessExecutionAccess,
  HarnessFactory,
  HarnessFactoryContext,
  HarnessRunContext,
  HarnessSessionState,
  HarnessTraceSupport,
} from "../types.js";
import { buildLayeredNavigationPrompt } from "./codex-basic.js";

export const CLAUDE_BASIC_KEY = "claude.basic";

export interface ClaudeBasicDependencies {
  readonly spawnProcess?: typeof spawn;
  readonly clientModuleUrl?: string;
  readonly executable?: string;
}

export class ClaudeBasicHarness implements Harness {
  private readonly spawnProcess: typeof spawn;
  private readonly clientModuleUrl: string;
  private sessionId: string | undefined;

  constructor(
    private readonly context: HarnessFactoryContext,
    private readonly dependencies: ClaudeBasicDependencies = {},
  ) {
    this.spawnProcess = dependencies.spawnProcess ?? spawn;
    this.clientModuleUrl = dependencies.clientModuleUrl ?? import.meta.resolve("@relayer/graph-client");
    this.sessionId = typeof context.savedState?.claudeSessionId === "string"
      ? context.savedState.claudeSessionId
      : undefined;
  }

  async complete(context: HarnessRunContext, signal?: AbortSignal): Promise<void> {
    if (context.model === undefined || context.access === undefined) {
      throw new Error("claude.basic requires an exact model and execution access");
    }
    if (!new Set(["anthropic-api", "claude-subscription"]).has(context.model.adapterId ?? "")) {
      throw new Error(`claude.basic cannot run provider adapter ${context.model.adapterId ?? "unknown"}`);
    }
    const graph = context.graph.acquireCapability();
    const prompt = this.prompt(context.inputGraph);
    await context.trace.emit({ type: "prompt", data: { text: prompt, interactionNodeId: context.inputGraph.id } });
    const result = await this.run(prompt, context.model.modelId, graph, context.access, signal);
    await context.trace.emit({ type: "message", data: { role: "assistant", text: result.text } });
    if (result.sessionId) this.sessionId = result.sessionId;
  }

  traceSupport(): HarnessTraceSupport {
    return {
      prompt: "full", messages: "full", reasoningSummaries: "none", modelCalls: "summary",
      toolCalls: "summary", usage: "summary", childStreams: "none", nativeArtifacts: "none",
    };
  }

  state(): HarnessSessionState {
    return this.sessionId === undefined ? {} : { claudeSessionId: this.sessionId };
  }

  private async run(
    prompt: string,
    model: string,
    graph: GraphCapability,
    access: HarnessExecutionAccess,
    signal?: AbortSignal,
  ): Promise<{ text: string; sessionId?: string }> {
    const environment = executionEnvironment(access, graph);
    const executable = access.kind === "managed-runtime"
      ? access.executable ?? this.dependencies.executable ?? "claude"
      : this.dependencies.executable ?? "claude";
    const args = ["-p", prompt, "--model", model, "--output-format", "json", "--allowedTools", "Bash"];
    const permissionMode = claudePermissionMode(this.context.permissionBinding.approvalMode);
    args.push("--permission-mode", permissionMode);
    if (permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
    if (this.sessionId) args.push("--resume", this.sessionId);
    const child = this.spawnProcess(executable, args, {
      cwd: this.context.workingDirectory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return collectClaudeResult(child, signal);
  }

  private prompt(interaction: GraphNode): string {
    return buildLayeredNavigationPrompt(interaction, this.clientModuleUrl);
  }
}

export function claudePermissionMode(value: unknown): "default" | "acceptEdits" | "bypassPermissions" {
  switch (value) {
    case "ask":
    case "default":
      return "default";
    case "auto":
    case "acceptEdits":
      return "acceptEdits";
    case "full":
    case "bypassPermissions":
      return "bypassPermissions";
    default:
      throw new Error("claude.basic requires an ask, auto, or full approval mode");
  }
}

function executionEnvironment(access: HarnessExecutionAccess, graph: GraphCapability): Record<string, string> {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  if (access.kind === "managed-runtime") {
    if (access.adapterId !== "claude-subscription") throw new Error(`claude.basic cannot consume managed runtime ${access.adapterId}`);
    Object.assign(environment, access.environment);
  } else {
    if (access.adapterId !== "anthropic-api") throw new Error(`claude.basic cannot consume secret provider ${access.adapterId}`);
    const apiKey = access.fields["api-key"];
    if (!apiKey) throw new Error("claude.basic requires the provider API key");
    environment.ANTHROPIC_API_KEY = apiKey;
    // Provider definitions store the catalog/API prefix (for example `/v1`), while
    // Claude Code appends the Anthropic API version path itself.
    environment.ANTHROPIC_BASE_URL = access.endpoint.replace(/\/v1\/?$/, "");
  }
  environment.RELAYER_GRAPH_URL = graph.url;
  environment.RELAYER_GRAPH_TOKEN = graph.token;
  environment.RELAYER_NODE_ID = String(graph.nodeId);
  return environment;
}

function collectClaudeResult(child: ChildProcess, signal?: AbortSignal): Promise<{ text: string; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    // Provider stderr can contain prompts, credentials, account identifiers, or
    // upstream response bodies. Drain it, but never surface or persist it.
    child.stderr?.on("data", () => {});
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(signal.reason ?? new Error("Claude completion was cancelled"));
      if (code !== 0) return reject(new Error("Claude CLI completion failed."));
      try {
        const parsed = JSON.parse(stdout) as { result?: unknown; session_id?: unknown };
        resolve({
          text: typeof parsed.result === "string" ? parsed.result : stdout,
          ...(typeof parsed.session_id === "string" ? { sessionId: parsed.session_id } : {}),
        });
      } catch {
        resolve({ text: stdout });
      }
    });
  });
}

export function createClaudeBasicFactory(dependencies: ClaudeBasicDependencies = {}): HarnessFactory {
  return (context) => new ClaudeBasicHarness(context, dependencies);
}
