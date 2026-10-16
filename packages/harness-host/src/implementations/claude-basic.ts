import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { z } from "zod";
import type { GraphCapability } from "@relayer/graph-client";
import { nativeExecutionHandle, type NativeExecutionHandle } from "../completion-execution.js";
import {
  parseNativeSessionResetReason,
  reportNativeSessionReset,
  type NativeSessionResetReason,
} from "../native-session-reset.js";
import type {
  Harness,
  HarnessExecutionAccess,
  HarnessFactory,
  HarnessFactoryContext,
  HarnessRunContext,
  HarnessSessionState,
  HarnessTraceSink,
  HarnessTraceSupport,
  JsonObject,
} from "../types.js";
import { buildLayeredNavigationPrompt } from "./codex-basic.js";
import {
  CLAUDE_BROWSER_SERVER_NAME,
  CLAUDE_BROWSER_TOOL,
  createClaudeBasicBrowserServer,
  type ClaudeBasicBrowserDependencies,
  type ClaudeBrowserSdk,
  type ClaudeSdkToolResult,
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
  readonly completeModuleUrl?: string;
  readonly graphAuthoringNodePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly resolveClaudeRuntime?: () => Promise<ClaudeRuntimeDescriptor>;
}

interface ClaudeRuntimeDescriptor {
  readonly executable: string;
  readonly moduleUrl: string;
  readonly environment: Readonly<Record<string, string>>;
}

export class ClaudeBasicHarness implements Harness {
  readonly supportsInvokedComplete = true;
  private readonly clientModuleUrl: string;
  private readonly completeModuleUrl: string;
  private sessionId: string | undefined;
  private sessionLocationIdentity: string | undefined;
  private sessionProviderDefinitionId: string | undefined;
  private sessionPersonalPresentationVersionId: number | null | undefined;
  /** Why the root session was dropped, until the next root turn reports it. Saved with the state. */
  private pendingRootReset: NativeSessionResetReason | undefined;

  constructor(
    private readonly context: HarnessFactoryContext,
    private readonly dependencies: ClaudeBasicDependencies = {},
  ) {
    this.clientModuleUrl = dependencies.clientModuleUrl ?? import.meta.resolve("@relayer/graph-client");
    this.completeModuleUrl = dependencies.completeModuleUrl ?? new URL("../../../../dist/index.js", import.meta.url).href;
    const savedSessionId = context.savedState?.claudeSessionId;
    const savedProviderDefinitionId = context.savedState?.claudeSessionProviderDefinitionId;
    const savedPresentationVersionId = context.savedState?.claudeSessionPersonalPresentationVersionId;
    const validSavedPresentationVersion = savedPresentationVersionId === undefined
      || savedPresentationVersionId === null
      || (typeof savedPresentationVersionId === "number"
        && Number.isSafeInteger(savedPresentationVersionId)
        && savedPresentationVersionId > 0);
    if (typeof savedSessionId === "string" && (typeof savedProviderDefinitionId !== "string" || !validSavedPresentationVersion)) throw new Error("Legacy native history has unverified ownership; its saved state was preserved.");
    // State without a provider definition cannot prove which credentials created
    // the session. Provider-scoped legacy state is loaded only so the first turn
    // can detect its unknown presentation version and rotate the native session.
    this.pendingRootReset = parseNativeSessionResetReason(context.savedState?.claudeRootResetReason);
    if (typeof savedSessionId === "string"
      && typeof savedProviderDefinitionId === "string"
      && validSavedPresentationVersion) {
      this.sessionId = savedSessionId;
      if (typeof context.savedState?.claudeSessionLocationIdentity === "string") this.sessionLocationIdentity = context.savedState.claudeSessionLocationIdentity;
      this.sessionProviderDefinitionId = savedProviderDefinitionId;
      this.sessionPersonalPresentationVersionId = savedPresentationVersionId;
    } else if (typeof savedSessionId === "string") {
      this.pendingRootReset = "session_unavailable";
    }
  }

  complete(context: HarnessRunContext, signal?: AbortSignal): NativeExecutionHandle {
    let resolveAttached!: (identity: JsonObject) => void;
    let rejectAttached!: (error: unknown) => void;
    const attached = new Promise<JsonObject>((resolve, reject) => {
      resolveAttached = resolve;
      rejectAttached = reject;
    });
    const execution = this.execute(context, resolveAttached, signal);
    void execution.catch(rejectAttached);
    return nativeExecutionHandle(execution, undefined, attached);
  }

  private async execute(
    context: HarnessRunContext,
    attach: (identity: JsonObject) => void,
    signal?: AbortSignal,
  ): Promise<void> {
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
    // A fresh root run starts its own Claude session and leaves the thread's root session alone.
    const isRoot = context.origin.kind === "root" && context.nativeSession !== "fresh";
    const personalPresentationVersionId = context.personalPresentation?.attachment.versionInteractionNodeId ?? null;
    if (isRoot && context.requireNativeContinuity && (this.sessionId === undefined || this.sessionProviderDefinitionId !== providerDefinitionId || (this.sessionPersonalPresentationVersionId !== undefined && this.sessionPersonalPresentationVersionId !== personalPresentationVersionId))) {
      throw new Error("This conversation's native history cannot be verified for the selected route. Its saved history was preserved; a fresh session was not started.");
    }
    if (isRoot && context.requireNativeContinuity && this.sessionPersonalPresentationVersionId === undefined) this.sessionPersonalPresentationVersionId = personalPresentationVersionId;
    // Each provider definition has its own Claude configuration directory, so another
    // definition's session cannot be resumed. This decides only resumption for the provider the
    // product selected, never which providers it may select.
    if (isRoot && this.sessionId !== undefined && this.sessionProviderDefinitionId !== providerDefinitionId) {
      this.forgetRootSession("provider_changed");
    }
    if (isRoot && this.sessionId !== undefined
      && this.sessionPersonalPresentationVersionId !== personalPresentationVersionId) {
      this.forgetRootSession("presentation_changed");
    }
    const resumeSessionId = isRoot ? this.sessionId : undefined;
    if (isRoot && resumeSessionId === undefined && this.pendingRootReset !== undefined) {
      reportNativeSessionReset(context, "Claude", this.context.threadId, this.pendingRootReset);
      this.pendingRootReset = undefined;
    }
    const graph = context.graph.acquireCapability();
    const prompt = this.prompt(context);
    await context.trace.emit({
      type: "prompt",
      data: { text: this.prompt(context, false), interactionNodeId: context.inputGraph.id },
    });
    const result = await this.run(
      prompt,
      context.model.modelId,
      graph,
      context.access,
      context.completionBroker,
      context.trace,
      resumeSessionId,
      attach,
      signal,
      isRoot,
    );
    if (!isRoot && result.sessionId === undefined) {
      throw new Error("Claude fresh or invoked completion did not expose a durable native session identity");
    }
    await context.trace.emit({
      type: "message",
      data: { role: "assistant", text: redactPersonalPresentationResult(context, result.text) },
    });
    if (isRoot && result.sessionId) {
      this.sessionId = result.sessionId;
      this.sessionProviderDefinitionId = providerDefinitionId;
      this.sessionPersonalPresentationVersionId = personalPresentationVersionId;
    }
  }

  traceSupport(): HarnessTraceSupport {
    return {
      prompt: "full", messages: "full", reasoningSummaries: "none", modelCalls: "summary",
      toolCalls: "summary", usage: "summary", childStreams: "none", nativeArtifacts: "none",
    };
  }

  private forgetRootSession(reason: NativeSessionResetReason): void {
    this.sessionId = undefined;
    this.sessionProviderDefinitionId = undefined;
    this.sessionPersonalPresentationVersionId = undefined;
    this.pendingRootReset = reason;
  }

  state(): HarnessSessionState {
    return this.sessionId === undefined
      || this.sessionProviderDefinitionId === undefined
      ? (this.pendingRootReset === undefined ? {} : { claudeRootResetReason: this.pendingRootReset })
      : {
          claudeSessionId: this.sessionId,
          ...(this.sessionLocationIdentity === undefined ? {} : { claudeSessionLocationIdentity: this.sessionLocationIdentity }),
          claudeSessionProviderDefinitionId: this.sessionProviderDefinitionId,
          ...(this.sessionPersonalPresentationVersionId === undefined ? {} : { claudeSessionPersonalPresentationVersionId: this.sessionPersonalPresentationVersionId }),
        };
  }

  private async run(
    prompt: string,
    model: string,
    graph: GraphCapability,
    access: HarnessExecutionAccess,
    completionBroker: HarnessRunContext["completionBroker"],
    trace: HarnessRunContext["trace"],
    resumeSessionId?: string,
    attach?: (identity: JsonObject) => void,
    signal?: AbortSignal,
    isRoot = false,
  ): Promise<{ text: string; sessionId?: string }> {
    const runtime = await claudeRuntime(access, this.dependencies.resolveClaudeRuntime);
    const environment = executionEnvironment(access, runtime.environment, graph, completionBroker, this.dependencies.platform);
    const locationIdentity = createHash("sha256").update(JSON.stringify({
      providerId: access.providerId, adapterId: access.adapterId, kind: access.kind,
      endpoint: access.kind === "secret" ? access.endpoint : null,
      home: environment.CLAUDE_CONFIG_DIR ?? environment.HOME ?? null,
    })).digest("hex");
    if (isRoot && resumeSessionId !== undefined && this.sessionLocationIdentity !== undefined && this.sessionLocationIdentity !== locationIdentity) throw new Error("This conversation's native session location changed. Its saved history was preserved.");
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
      // The host grants a preview folder only when previews are on (PRD §11.10).
      // The preview tool reads nothing else, so every mode pre-approves it (PRD §11.6).
      const previewServer = graph.previewDirectory === undefined
        ? undefined
        : createClaudeBasicPreviewServer(browserSdk, graph.previewDirectory, trace);
      const messages = query({
        prompt,
        options: {
          cwd: this.context.workingDirectory,
          env: environment,
          model,
          allowedTools: [
            "Bash",
            ...(permissionMode === "acceptEdits" ? [CLAUDE_BROWSER_TOOL] : []),
            ...(previewServer === undefined ? [] : [CLAUDE_PREVIEW_TOOL]),
          ],
          mcpServers: {
            [CLAUDE_BROWSER_SERVER_NAME]: browserServer,
            ...(previewServer === undefined ? {} : { [CLAUDE_PREVIEW_SERVER_NAME]: previewServer }),
          },
          permissionMode,
          ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
          pathToClaudeCodeExecutable: runtime.executable,
          ...(resumeSessionId === undefined ? {} : { resume: resumeSessionId }),
          abortController,
          // Provider stderr can contain prompts, credentials, account identifiers,
          // or upstream response bodies. Drain it, but never surface or persist it.
          stderr: () => {},
        },
      });
      const result = await collectClaudeResult(messages, attach, signal);
      if (isRoot && resumeSessionId !== undefined && result.sessionId !== resumeSessionId) throw new Error("Native conversation identity changed during resume");
      if (isRoot && result.sessionId !== undefined) this.sessionLocationIdentity = locationIdentity;
      return result;
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      throw new Error("Claude Agent SDK completion failed.");
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private prompt(context: HarnessRunContext, includePersonalPresentation = true): string {
    return buildLayeredNavigationPrompt(
      context,
      this.clientModuleUrl,
      undefined,
      this.completeModuleUrl,
      "Claude",
      includePersonalPresentation,
      this.context.configuration.graphCapabilityProfile?.search === "query-v1",
      this.dependencies.graphAuthoringNodePath,
    );
  }
}

function redactPersonalPresentationResult(context: HarnessRunContext, text: string): string {
  const traceValues = personalPresentationTraceValues(context);
  if (traceValues === undefined) return text;
  return [traceValues.exactBlock, ...traceValues.legacyBlocks, ...traceValues.fragments].reduce(
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

async function claudeRuntime(
  access: HarnessExecutionAccess,
  resolveClaudeRuntime?: () => Promise<ClaudeRuntimeDescriptor>,
): Promise<ClaudeRuntimeDescriptor> {
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
    candidate = (access as HarnessExecutionAccess & { readonly runtime?: unknown }).runtime
      ?? await resolveClaudeRuntime?.();
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
  completionBroker: HarnessRunContext["completionBroker"],
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
  delete environment.RELAYER_GRAPH_AUTHORING_ERRORS;
  if (graph.authoringErrors) environment.RELAYER_GRAPH_AUTHORING_ERRORS = "1";
  environment.RELAYER_GRAPH_TOKEN = graph.token;
  environment.RELAYER_NODE_ID = String(graph.nodeId);
  if (graph.previewDirectory !== undefined) environment.RELAYER_GRAPH_PREVIEW_DIR = graph.previewDirectory;
  if (graph.programDirectory !== undefined) environment.RELAYER_GRAPH_PROGRAM_DIR = graph.programDirectory;
  if (completionBroker !== undefined) {
    environment.RELAYER_COMPLETE_URL = completionBroker.url;
    environment.RELAYER_COMPLETE_TOKEN = completionBroker.token;
  }
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
  attach?: (identity: JsonObject) => void,
  signal?: AbortSignal,
): Promise<{ text: string; sessionId?: string }> {
  let sessionId: string | undefined;
  let attached = false;
  for await (const message of messages) {
    if (signal?.aborted) throw abortReason(signal);
    if (!isRecord(message)) continue;
    if (typeof message.session_id === "string" && message.session_id.trim() !== "") {
      sessionId = message.session_id;
      if (!attached) {
        attached = true;
        attach?.(Object.freeze({ schemaVersion: 1, provider: "claude", sessionId }));
      }
    }
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

export const CLAUDE_PREVIEW_SERVER_NAME = "relayer_graph_preview";
export const CLAUDE_PREVIEW_TOOL_NAME = "view_graph_preview";
export const CLAUDE_PREVIEW_TOOL = `mcp__${CLAUDE_PREVIEW_SERVER_NAME}__${CLAUDE_PREVIEW_TOOL_NAME}`;

/** Keeps the base64 image within the Anthropic API's 5 MiB per-image limit. */
const MAX_PREVIEW_BYTES = 3_932_160;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const requestSchema = { path: z.string().min(1).max(4_096) };

/**
 * The code-owned tool that shows Claude its draft previews (PRD §11.6, §11.10).
 * It reads only PNGs directly inside the running turn's preview folder and
 * grants no other file access. The trace records metadata, never the image.
 */
export function createClaudeBasicPreviewServer(
  sdk: ClaudeBrowserSdk,
  previewDirectory: string,
  trace: HarnessTraceSink,
): unknown {
  const tool = sdk.tool(
    CLAUDE_PREVIEW_TOOL_NAME,
    "Look at a draft preview image. Pass the preview.path that graph.submitLayer or graph.submitNode returned. Only PNG previews from this turn's preview folder can be opened.",
    requestSchema,
    async (input): Promise<ClaudeSdkToolResult> => {
      try {
        const png = await readPreview(previewDirectory, input.path);
        await trace.emit({
          type: "tool.call.completed",
          data: { tool: CLAUDE_PREVIEW_TOOL_NAME, outcome: "viewed", file: basename(input.path), byteLength: png.byteLength },
        });
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
      } catch {
        // A refused path is model input, not a preview; the trace does not record it.
        await trace.emit({ type: "tool.call.completed", data: { tool: CLAUDE_PREVIEW_TOOL_NAME, outcome: "refused" } });
        return {
          content: [{ type: "text", text: "That file is not a draft preview from this turn. Pass the preview.path a graph write returned." }],
          isError: true,
        };
      }
    },
  );
  return sdk.createSdkMcpServer({
    name: CLAUDE_PREVIEW_SERVER_NAME,
    version: "1.0.0",
    instructions: "This server opens only PNG draft previews from the running turn's preview folder.",
    tools: [tool],
  });
}

async function readPreview(previewDirectory: string, requested: string): Promise<Buffer> {
  const folder = await realpath(previewDirectory);
  const target = await realpath(resolve(folder, requested));
  if (dirname(target) !== folder || extname(target).toLowerCase() !== ".png") throw new Error("outside preview folder");
  const checked = await lstat(target);
  // Open without following a final symlink, and without blocking on a FIFO, then
  // require the opened file to be the one checked and still inside the folder.
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_PREVIEW_BYTES
      || opened.dev !== checked.dev || opened.ino !== checked.ino) throw new Error("not the checked preview file");
    if (await realpath(previewDirectory) !== folder || await realpath(target) !== target) throw new Error("preview folder changed");
    const png = await handle.readFile();
    if (png.byteLength > MAX_PREVIEW_BYTES || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
    return png;
  } finally {
    await handle.close();
  }
}
