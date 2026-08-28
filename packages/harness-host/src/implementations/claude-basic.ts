import type { GraphCapability } from "@relayer/graph-client";
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
import {
  CLAUDE_BROWSER_SERVER_NAME,
  CLAUDE_BROWSER_TOOL,
  createClaudeBasicBrowserServer,
  type ClaudeBasicBrowserDependencies,
  type ClaudeBrowserSdk,
} from "./claude-basic-browser.js";
import { personalPresentationTraceValues } from "./personal-presentation-guidance.js";

export const CLAUDE_BASIC_KEY = "claude.basic";

const SAFE_SUBPROCESS_ENVIRONMENT = new Set([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC",
  "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL",
]);
const CLAUDE_MANAGED_RUNTIME_ENVIRONMENT = new Set([
  ...SAFE_SUBPROCESS_ENVIRONMENT, "HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR",
]);

export interface ClaudeSdkQueryOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly model: string;
  readonly allowedTools: readonly string[];
  readonly mcpServers: Readonly<Record<string, unknown>>;
  readonly permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly pathToClaudeCodeExecutable: string;
  readonly resume?: string;
  readonly abortController: AbortController;
  readonly stderr: (data: string) => void;
}

export type ClaudeSdkQuery = (input: {
  readonly prompt: string;
  readonly options: ClaudeSdkQueryOptions;
}) => AsyncIterable<unknown>;

export interface ClaudeSdkModule extends ClaudeBrowserSdk {
  readonly query: ClaudeSdkQuery;
}

export interface ClaudeBasicDependencies {
  readonly query?: ClaudeSdkQuery;
  readonly browserSdk?: ClaudeBrowserSdk;
  readonly browser?: ClaudeBasicBrowserDependencies;
  readonly loadSdk?: (moduleUrl: string) => Promise<ClaudeSdkModule>;
  readonly clientModuleUrl?: string;
  readonly platform?: NodeJS.Platform;
}

interface ClaudeRuntimeDescriptor {
  readonly executable: string;
  readonly moduleUrl: string;
  readonly environment: Readonly<Record<string, string>>;
}

export class ClaudeBasicHarness implements Harness {
  private readonly clientModuleUrl: string;
  private sessionId: string | undefined;
  private sessionProviderDefinitionId: string | undefined;

  constructor(
    private readonly context: HarnessFactoryContext,
    private readonly dependencies: ClaudeBasicDependencies = {},
  ) {
    this.clientModuleUrl = dependencies.clientModuleUrl ?? import.meta.resolve("@relayer/graph-client");
    const savedSessionId = context.savedState?.claudeSessionId;
    const savedProviderDefinitionId = context.savedState?.claudeSessionProviderDefinitionId;
    // State written before provider-scoped Claude sessions cannot prove which
    // credentials created the session. Ignore it instead of risking a resume
    // through a different provider definition.
    if (typeof savedSessionId === "string" && typeof savedProviderDefinitionId === "string") {
      this.sessionId = savedSessionId;
      this.sessionProviderDefinitionId = savedProviderDefinitionId;
    }
  }

  async complete(context: HarnessRunContext, signal?: AbortSignal): Promise<void> {
    if (context.model === undefined || context.access === undefined) {
      throw new Error("claude.basic requires an exact model and execution access");
    }
    if (!new Set(["anthropic-api", "claude-subscription"]).has(context.model.adapterId ?? "")) {
      throw new Error(`claude.basic cannot run provider adapter ${context.model.adapterId ?? "unknown"}`);
    }
    if (context.model.providerId !== context.access.providerId) {
      throw new Error("claude.basic requires execution access for the selected provider definition");
    }
    const providerDefinitionId = context.model.providerId;
    if (this.sessionProviderDefinitionId !== providerDefinitionId) {
      this.sessionId = undefined;
      this.sessionProviderDefinitionId = undefined;
    }
    const graph = context.graph.acquireCapability();
    const prompt = this.prompt(context);
    await context.trace.emit({
      type: "prompt",
      data: { text: this.prompt(context, false), interactionNodeId: context.inputGraph.id },
    });
    const result = await this.run(prompt, context.model.modelId, graph, context.access, signal);
    await context.trace.emit({
      type: "message",
      data: { role: "assistant", text: redactPersonalPresentationResult(context, result.text) },
    });
    if (result.sessionId) {
      this.sessionId = result.sessionId;
      this.sessionProviderDefinitionId = providerDefinitionId;
    }
  }

  traceSupport(): HarnessTraceSupport {
    return {
      prompt: "full", messages: "full", reasoningSummaries: "none", modelCalls: "summary",
      toolCalls: "summary", usage: "summary", childStreams: "none", nativeArtifacts: "none",
    };
  }

  state(): HarnessSessionState {
    return this.sessionId === undefined || this.sessionProviderDefinitionId === undefined
      ? {}
      : {
          claudeSessionId: this.sessionId,
          claudeSessionProviderDefinitionId: this.sessionProviderDefinitionId,
        };
  }

  private async run(
    prompt: string,
    model: string,
    graph: GraphCapability,
    access: HarnessExecutionAccess,
    signal?: AbortSignal,
  ): Promise<{ text: string; sessionId?: string }> {
    const runtime = claudeRuntime(access);
    const environment = executionEnvironment(access, runtime.environment, graph, this.dependencies.platform);
    const permissionMode = claudePermissionMode(this.context.permissionBinding.approvalMode);
    const abortController = new AbortController();
    const abort = () => abortController.abort(signal?.reason ?? new Error("Claude completion was cancelled"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const loadedSdk = this.dependencies.browserSdk === undefined || this.dependencies.query === undefined
        ? await (this.dependencies.loadSdk ?? loadClaudeSdk)(runtime.moduleUrl)
        : undefined;
      const query = this.dependencies.query ?? loadedSdk!.query;
      const browserSdk = this.dependencies.browserSdk ?? loadedSdk!;
      const browserServer = createClaudeBasicBrowserServer(browserSdk, this.dependencies.browser);
      const messages = query({
        prompt,
        options: {
          cwd: this.context.workingDirectory,
          env: environment,
          model,
          allowedTools: permissionMode === "acceptEdits" ? ["Bash", CLAUDE_BROWSER_TOOL] : ["Bash"],
          mcpServers: { [CLAUDE_BROWSER_SERVER_NAME]: browserServer },
          permissionMode,
          ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
          pathToClaudeCodeExecutable: runtime.executable,
          ...(this.sessionId === undefined ? {} : { resume: this.sessionId }),
          abortController,
          // Provider stderr can contain prompts, credentials, account identifiers,
          // or upstream response bodies. Drain it, but never surface or persist it.
          stderr: () => {},
        },
      });
      return await collectClaudeResult(messages, signal);
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      throw new Error("Claude Agent SDK completion failed.");
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private prompt(context: HarnessRunContext, includePersonalPresentation = true): string {
    return buildLayeredNavigationPrompt(context, this.clientModuleUrl, undefined, includePersonalPresentation);
  }
}

function redactPersonalPresentationResult(context: HarnessRunContext, text: string): string {
  const traceValues = personalPresentationTraceValues(context);
  if (traceValues === undefined) return text;
  return [traceValues.exactBlock, ...traceValues.fragments].reduce(
    (sanitized, value) => sanitized.split(value).join("[redacted-personal-presentation]"),
    text,
  );
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

async function loadClaudeSdk(moduleUrl: string): Promise<ClaudeSdkModule> {
  const loaded: unknown = await import(moduleUrl);
  if (!isRecord(loaded)
    || typeof loaded.query !== "function"
    || typeof loaded.tool !== "function"
    || typeof loaded.createSdkMcpServer !== "function") {
    throw new Error("Managed Claude Agent SDK module does not export its query and in-process MCP boundaries.");
  }
  return {
    query: loaded.query as ClaudeSdkQuery,
    tool: loaded.tool as ClaudeSdkModule["tool"],
    createSdkMcpServer: loaded.createSdkMcpServer as ClaudeSdkModule["createSdkMcpServer"],
  };
}

function claudeRuntime(access: HarnessExecutionAccess): ClaudeRuntimeDescriptor {
  let candidate: unknown;
  if (access.kind === "managed-runtime") {
    if (access.adapterId !== "claude-subscription") {
      throw new Error(`claude.basic cannot consume managed runtime ${access.adapterId}`);
    }
    candidate = access;
  } else {
    if (access.adapterId !== "anthropic-api") {
      throw new Error(`claude.basic cannot consume secret provider ${access.adapterId}`);
    }
    candidate = (access as HarnessExecutionAccess & { readonly runtime?: unknown }).runtime;
  }
  if (!isRecord(candidate)
    || typeof candidate.executable !== "string" || candidate.executable.trim() === ""
    || typeof candidate.moduleUrl !== "string" || candidate.moduleUrl.trim() === ""
    || !isStringRecord(candidate.environment)) {
    throw new Error("claude.basic requires an explicit managed Claude runtime executable, SDK module, and environment");
  }
  return {
    executable: candidate.executable,
    moduleUrl: candidate.moduleUrl,
    environment: candidate.environment,
  };
}

function executionEnvironment(
  access: HarnessExecutionAccess,
  runtimeEnvironment: Readonly<Record<string, string>>,
  graph: GraphCapability,
  platform = process.platform,
): Record<string, string> {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => (
    entry[1] !== undefined && SAFE_SUBPROCESS_ENVIRONMENT.has(entry[0])
  )));
  const managedEnvironment = Object.fromEntries(Object.entries(runtimeEnvironment).filter(([key]) => (
    CLAUDE_MANAGED_RUNTIME_ENVIRONMENT.has(key)
  )));
  normalizePathKey(environment, platform);
  normalizePathKey(managedEnvironment, platform);
  Object.assign(environment, managedEnvironment);
  if (access.kind === "secret") {
    const apiKey = access.fields["api-key"];
    if (!apiKey) throw new Error("claude.basic requires the provider API key");
    environment.ANTHROPIC_API_KEY = apiKey;
    // Provider definitions store the catalog/API prefix (for example `/v1`), while
    // Claude Code appends the Anthropic API version path itself.
    environment.ANTHROPIC_BASE_URL = access.endpoint.replace(/\/v1\/?$/, "");
  }
  environment.DISABLE_AUTOUPDATER = "1";
  environment.RELAYER_GRAPH_URL = graph.url;
  environment.RELAYER_GRAPH_TOKEN = graph.token;
  environment.RELAYER_NODE_ID = String(graph.nodeId);
  return environment;
}

function normalizePathKey(environment: Record<string, string>, platform: NodeJS.Platform): void {
  const pathKeys = Object.keys(environment).filter((key) => key.toLowerCase() === "path");
  const conventionalKey = platform === "win32" ? "Path" : "PATH";
  const existing = environment[conventionalKey]
    ?? pathKeys.map((key) => environment[key]).find((value) => value !== undefined);
  for (const key of pathKeys) delete environment[key];
  if (existing !== undefined) environment[conventionalKey] = existing;
}

async function collectClaudeResult(
  messages: AsyncIterable<unknown>,
  signal?: AbortSignal,
): Promise<{ text: string; sessionId?: string }> {
  let sessionId: string | undefined;
  for await (const message of messages) {
    if (signal?.aborted) throw abortReason(signal);
    if (!isRecord(message)) continue;
    if (typeof message.session_id === "string" && message.session_id !== "") sessionId = message.session_id;
    if (message.type !== "result") continue;
    if (message.subtype !== "success" || typeof message.result !== "string") {
      throw new Error("Claude Agent SDK returned an unsuccessful result.");
    }
    return { text: message.result, ...(sessionId === undefined ? {} : { sessionId }) };
  }
  throw new Error("Claude Agent SDK ended without a successful result.");
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Claude completion was cancelled");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

export function createClaudeBasicFactory(dependencies: ClaudeBasicDependencies = {}): HarnessFactory {
  return (context) => new ClaudeBasicHarness(context, dependencies);
}
