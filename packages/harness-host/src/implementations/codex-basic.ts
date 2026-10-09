import { appOwnedNodeCommand, appOwnedNodeInstructions } from "./graph-authoring-command.js";
import { threadIconGuidance } from "./thread-icon-guidance.js";
import { type GraphCapability, type GraphNode } from "@relayer/graph-client";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { nativeExecutionHandle, type NativeExecutionHandle } from "../completion-execution.js";
import { INTERACTION_INPUT_GUIDANCE, INVOCATION_PUBLICATION_GUIDANCE, SUBCOMPLETION_INTEGRATION_GUIDANCE, renderInteractionInput } from "../interaction-input.js";
import {
  parseNativeSessionResetReason,
  reportNativeSessionReset,
  type NativeSessionResetReason,
} from "../native-session-reset.js";
import { redactTraceData } from "../trace.js";
import { CURRENT_COMMUNICATION_GUIDANCE_JS, CURRENT_WORKSPACE_GUIDANCE, currentCommunicationAuthoringRecipeJs, GRAPH_PRESENTATION_GUIDANCE, NODE_ICON_GUIDANCE } from "./graph-presentation-guidance.js";
import { ARTIFACT_LAYER_GUIDANCE } from "./artifact-layer-guidance.js";
import { LAYER_EDGE_SHAPE_GUIDANCE } from "./layer-edge-shape-guidance.js";
import {
  personalPresentationNativeInstructions,
  personalPresentationPrompt,
  personalPresentationTraceValues,
} from "./personal-presentation-guidance.js";
import {
  runCodexAppServerTurn,
  type CodexAppServerSpawn,
  type CodexAppServerTurnOptions,
} from "./codex-app-server.js";
import type {
  CodexApprovalMode,
  CodexModelReasoningEffort,
  CodexSandboxMode,
  CodexWebSearchMode,
} from "./codex-option-types.js";
import type {
  Harness,
  HarnessExecutionAccess,
  HarnessFactory,
  HarnessFactoryContext,
  HarnessRunContext,
  HarnessSessionState,
  HarnessTraceSpan,
  HarnessTraceSupport,
  HarnessTraceTerminalStatus,
  JsonObject,
  JsonValue,
} from "../types.js";

const ATTACHED_NAVIGATION_GUIDANCE = "Gated attached navigation: the server may authorize new navigate actions on the exact native accepted nodes attached to this input. This does not authorize invoke/input additions, title/detail edits, topology edits, or changes to other nodes. Use a stable clientKey and omit sourceLayer for a new node-owned action; target an accepted visible layer or a layer you authored in this interaction. A denied write is not permission to copy or broaden the attachment. These additions become visible only after terminal graph.submit, never after Advance. For an enabled frozen version-2 description, every distinct attached native node must receive a NEW navigate action targeting this interaction's exact response root, exposed by a usable button. Repeated occurrences of one persistent node need one addition; background attachments count too. Missing links reject terminal submission with node IDs for repair. For rich details, read the current presentation and preserve existing controls while binding the new action in a full replacement. Version-1 descriptions grant ability only; absent or disabled descriptions impose no such obligation. Advance does not enforce this terminal requirement. The server's frozen grant is authoritative; do not infer grants from mere mention, reuse, or imported/shared context. Keep the ordinary response root as well; its response action does not substitute for the required link on each attached source.";

export const CODEX_BASIC_KEY = "codex.basic";

const SAFE_SUBPROCESS_ENVIRONMENT = new Set([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC",
  "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL",
]);
const CODEX_MANAGED_RUNTIME_ENVIRONMENT = new Set([
  ...SAFE_SUBPROCESS_ENVIRONMENT, "HOME", "USERPROFILE", "CODEX_HOME", "RELAYER_CODEX_BINARY",
]);
const CODEX_BASIC_SECRET_ADAPTERS = new Set(["openai-api", "openrouter", "vercel-ai-router"]);
const CODEX_BASIC_ADAPTERS = new Set(["codex-subscription", ...CODEX_BASIC_SECRET_ADAPTERS]);
/** The stable name recorded for Codex's default home, used when a turn sets no CODEX_HOME. */
const CODEX_DEFAULT_HOME = "codex-default-home";

/**
 * The Codex home a turn's app-server reads and writes rollouts in. A thread resumes only in the
 * home holding its rollout. The configured path is recorded as given, so it stays the same
 * across restarts; a turn without CODEX_HOME uses Codex's default home.
 */
function codexHomeOf(environment: Readonly<Record<string, string>>): string {
  const home = environment.CODEX_HOME;
  return home === undefined || home === "" ? CODEX_DEFAULT_HOME : home;
}

// Codex authenticates an API-key provider from CODEX_HOME/auth.json. The
// OPENAI_API_KEY environment variable alone is not honored by the managed Codex
// runtime (requests go out with no bearer). Write the selected provider's key
// into its isolated per-provider CODEX_HOME only for the turn, then delete the
// file so the durable copy stays in the OS credential store (PRD AGT-007).
async function writeCodexApiKeyAuthFile(codexHome: string, apiKey: string): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  // Replace atomically: another turn's Codex process may be reading the current file.
  const temporary = join(codexHome, `.auth.json.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: apiKey })}\n`, { mode: 0o600 });
    await rename(temporary, join(codexHome, "auth.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeCodexApiKeyAuthFile(codexHome: string): Promise<void> {
  try {
    await unlink(join(codexHome, "auth.json"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

const CODEX_API_KEY_AUTH_USERS = new Map<string, number>();
/**
 * Writes and removals of one CODEX_HOME's auth.json run one at a time. A turn whose cleanup
 * outlives it (a force-stopped turn the host stopped waiting for) therefore cannot delete the
 * file a later turn on that home has since written.
 */
const CODEX_API_KEY_AUTH_FILE_OPERATIONS = new Map<string, Promise<void>>();

function serializedCodexApiKeyAuthFileOperation(codexHome: string, operation: () => Promise<void>): Promise<void> {
  const previous = CODEX_API_KEY_AUTH_FILE_OPERATIONS.get(codexHome) ?? Promise.resolve();
  const current = previous.then(operation);
  const tail = current.catch(() => undefined);
  CODEX_API_KEY_AUTH_FILE_OPERATIONS.set(codexHome, tail);
  void tail.then(() => {
    if (CODEX_API_KEY_AUTH_FILE_OPERATIONS.get(codexHome) === tail) CODEX_API_KEY_AUTH_FILE_OPERATIONS.delete(codexHome);
  });
  return current;
}

function retainCodexApiKeyAuth(codexHome: string): void {
  CODEX_API_KEY_AUTH_USERS.set(codexHome, (CODEX_API_KEY_AUTH_USERS.get(codexHome) ?? 0) + 1);
}

async function releaseCodexApiKeyAuth(
  codexHome: string,
  remove: (codexHome: string) => Promise<void>,
): Promise<void> {
  const users = CODEX_API_KEY_AUTH_USERS.get(codexHome) ?? 0;
  if (users <= 1) {
    CODEX_API_KEY_AUTH_USERS.delete(codexHome);
    await serializedCodexApiKeyAuthFileOperation(codexHome, async () => {
      // A later turn retained this home meanwhile; the file it writes after this must survive.
      if ((CODEX_API_KEY_AUTH_USERS.get(codexHome) ?? 0) > 0) return;
      await remove(codexHome);
    });
    return;
  }
  CODEX_API_KEY_AUTH_USERS.set(codexHome, users - 1);
}
const UNDERLYING_TASK_GUIDANCE = `Complete the underlying user task in the working directory. Use the harness's ordinary workspace tools and reasoning as needed; the graph is the presentation of the work, not a substitute for doing it. Author graph content from the work you actually performed and the evidence you actually observed. If you reach a genuine blocker that you cannot resolve, present that blocker and its evidence instead of presenting planned work as completed.`;

export interface CodexBasicDependencies {
  readonly runAppServerTurn?: (options: CodexAppServerTurnOptions) => ReturnType<typeof runCodexAppServerTurn>;
  readonly spawnProcess?: CodexAppServerSpawn;
  readonly clientModuleUrl?: string;
  readonly completeModuleUrl?: string;
  readonly graphAuthoringLauncherPath?: string;
  readonly graphAuthoringNodePath?: string;
  readonly codexPathOverride?: string;
  readonly browserMcpRuntime?: {
    readonly executable: string;
    readonly script: string;
    readonly connectionArgs: readonly string[];
  };
  readonly resolveCodexRuntime?: () => Promise<{
    readonly executable: string;
    readonly environment: Readonly<Record<string, string>>;
  }>;
  readonly writeCodexApiKeyAuthFile?: (codexHome: string, apiKey: string) => Promise<void>;
  readonly removeCodexApiKeyAuthFile?: (codexHome: string) => Promise<void>;
}

interface CodexBasicConfiguration {
  readonly model?: string;
  readonly modelReasoningEffort?: CodexModelReasoningEffort;
  readonly sandboxMode?: CodexSandboxMode;
  readonly approvalPolicy?: CodexApprovalMode;
  readonly networkAccessEnabled?: boolean;
  readonly webSearchMode?: CodexWebSearchMode;
  readonly skipGitRepoCheck?: boolean;
  readonly additionalDirectories?: readonly string[];
  readonly rootSessionMode?: "resume" | "fresh";
}

interface ResolvedCodexConfiguration {
  readonly settings: CodexBasicConfiguration;
  readonly permission: ResolvedCodexPermission;
  readonly promptProfile?: "layered-navigation-v1" | "layered-navigation-multi-agent-v1";
}

interface ResolvedCodexPermission {
  readonly sandboxMode: CodexSandboxMode;
  readonly approvalPolicy: CodexApprovalMode;
  readonly approvalsReviewer?: "user" | "auto_review";
  readonly networkAccessEnabled?: boolean;
}

interface CodexTraceState {
  readonly collaborationSpans: Map<string, HarnessTraceSpan>;
  readonly graphAuthoringCommandIds: Set<string>;
  readonly graphAuthoringNodePath?: string;
  readonly fallbackGraphAuthoringEnabled: boolean;
}

interface NormalizedCollaborationItem {
  readonly providerItemId?: string;
  readonly operation: "spawn_agent" | "send_input" | "resume_agent" | "wait" | "close_agent" | "unknown";
  readonly providerOperation?: string;
  readonly senderThreadId?: string;
  readonly receiverThreadIds?: readonly string[];
  readonly delegationPrompt?: string;
  readonly model?: string;
  readonly reasoningEffort?: JsonValue;
  readonly agentStates?: JsonObject;
  readonly status?: "in_progress" | "completed" | "failed";
}

export class CodexBasicHarness implements Harness {
  readonly supportsInvokedComplete = true;
  /** Each turn runs in its own app-server process group, so a force-stop ends only that turn. */
  readonly supportsForceStop = true;
  private readonly clientModuleUrl: string;
  private readonly completeModuleUrl: string;
  private readonly resolved: ResolvedCodexConfiguration;
  private codexThreadId: string | undefined;
  private codexSessionIdentity: string | undefined;
  private codexThreadPersonalPresentationVersionId: number | null | undefined;
  /**
   * The Codex home holding the thread's rollout. Undefined only for a thread saved by an earlier
   * release: it is still offered for resume, binds to the home it resumes in, and a missing
   * rollout starts a fresh thread instead.
   */
  private codexThreadHome: string | undefined;
  /**
   * Why the root thread was dropped, until the next root turn that starts fresh reports it.
   * It is saved with the state, so the notice survives a restart.
   */
  private pendingRootReset: NativeSessionResetReason | undefined;
  /** Each running turn's force controller, with the step that forgets its root thread. */
  private readonly activeForceShutdowns = new Map<AbortController, () => void>();

  constructor(private readonly context: HarnessFactoryContext, private readonly dependencies: CodexBasicDependencies = {}) {
    const resolved = parseCodexBasicConfiguration(context);
    this.resolved = resolved;
    this.clientModuleUrl = dependencies.clientModuleUrl ?? import.meta.resolve("@relayer/graph-client");
    this.completeModuleUrl = dependencies.completeModuleUrl ?? new URL("../../../../dist/index.js", import.meta.url).href;
    validateBrowserMcpRuntime(dependencies.browserMcpRuntime);
    const codexThreadId = context.savedState?.codexThreadId;
    const savedPresentationVersionId = context.savedState?.codexThreadPersonalPresentationVersionId;
    const savedHome = context.savedState?.codexThreadHome;
    const validSavedPresentationVersion = savedPresentationVersionId === undefined
      || savedPresentationVersionId === null
      || (typeof savedPresentationVersionId === "number"
        && Number.isSafeInteger(savedPresentationVersionId)
        && savedPresentationVersionId > 0);
    if (typeof codexThreadId === "string" && !validSavedPresentationVersion) throw new Error("Legacy native history has an invalid presentation pin; its saved state was preserved.");
    const validSavedHome = savedHome === undefined || (typeof savedHome === "string" && savedHome !== "");
    if (typeof codexThreadId === "string" && !validSavedHome) throw new Error("Legacy native history has an invalid storage identity; its saved state was preserved.");
    if (resolved.settings.rootSessionMode === "fresh") return;
    this.pendingRootReset = parseNativeSessionResetReason(context.savedState?.codexRootResetReason);
    if (typeof codexThreadId === "string" && validSavedPresentationVersion && validSavedHome) {
      this.codexThreadId = codexThreadId;
      if (typeof context.savedState?.codexSessionIdentity === "string") this.codexSessionIdentity = context.savedState.codexSessionIdentity;
      this.codexThreadPersonalPresentationVersionId = savedPresentationVersionId;
      this.codexThreadHome = savedHome;
    } else if (typeof codexThreadId === "string") {
      this.pendingRootReset = "session_unavailable";
    }
  }

  complete(context: HarnessRunContext, signal?: AbortSignal): NativeExecutionHandle {
    if (context.origin.kind === "invoke" && (context.model === undefined || context.access === undefined)) {
      return nativeExecutionHandle(Promise.reject(new Error(
        "codex.basic invoked completion requires an explicitly admitted model and execution-scoped access",
      )));
    }
    return this.executionHandle(context, context.origin.kind, signal);
  }

  private executionHandle(
    context: HarnessRunContext,
    kind: "root" | "invoke",
    signal?: AbortSignal,
  ): NativeExecutionHandle {
    let resolveAttached!: (identity: JsonObject) => void;
    let rejectAttached!: (error: unknown) => void;
    const attached = new Promise<JsonObject>((resolve, reject) => {
      resolveAttached = resolve;
      rejectAttached = reject;
    });
    const execution = this.execute(context, kind, resolveAttached, signal);
    void execution.catch(rejectAttached);
    return nativeExecutionHandle(execution, undefined, attached);
  }

  private async execute(
    context: HarnessRunContext,
    kind: "root" | "invoke",
    attach: (identity: JsonObject) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const personalPresentationVersionId = context.personalPresentation?.attachment.versionInteractionNodeId ?? null;
    const persistentRootSession = kind === "root" && this.resolved.settings.rootSessionMode !== "fresh";
    if (kind === "root" && context.requireNativeContinuity && (!persistentRootSession || this.codexThreadId === undefined)) {
      throw new Error("This conversation's native history is unavailable. Continuing with a fresh session would lose context; its saved history was preserved.");
    }
    if (persistentRootSession && this.codexThreadId !== undefined
      && this.codexThreadPersonalPresentationVersionId !== personalPresentationVersionId
      && !(context.requireNativeContinuity && this.codexThreadPersonalPresentationVersionId === undefined)) {
      if (context.requireNativeContinuity) throw new Error("This conversation's native history cannot be reused with the changed presentation settings. Its history was preserved.");
      this.forgetRootThread("presentation_changed");
    }
    this.selectedModel(context);
    if (context.model !== undefined && context.access === undefined) {
      throw new Error("codex.basic requires execution-scoped access for the selected provider");
    }
    const capability = context.graph.acquireCapability();
    const resolvedRuntime = await this.codexRuntime(context.access);
    // A turn force-stopped while resolving its runtime no longer holds access: write nothing.
    context.forceSignal?.throwIfAborted();
    const environment = this.graphEnvironment(capability, context.completionBroker, context.access, resolvedRuntime.environment);
    const sessionIdentity = createHash("sha256").update(JSON.stringify({
      providerId: context.access?.providerId ?? null,
      adapterId: context.access?.adapterId ?? null,
      kind: context.access?.kind ?? null,
      endpoint: context.access?.kind === "secret" ? context.access.endpoint : null,
      home: resolve(environment.CODEX_HOME || join(environment.HOME || process.env.HOME || this.context.workingDirectory, ".codex")),
    })).digest("hex");
    if (context.requireNativeContinuity && persistentRootSession && this.codexThreadId !== undefined && this.codexSessionIdentity !== undefined && this.codexSessionIdentity !== sessionIdentity) {
      throw new Error("This conversation's provider or native session location changed. Its original history was preserved; this route cannot continue it.");
    }
    const codexHome = codexHomeOf(environment);
    // A thread resumes only in the Codex home holding its rollout. Providers that share a home,
    // such as API-key providers in Codex's default home, keep resuming it. This decides only
    // resumption for the provider the product selected, never which providers it may select.
    if (persistentRootSession && this.codexThreadId !== undefined
      && this.codexThreadHome !== undefined && this.codexThreadHome !== codexHome) {
      if (context.requireNativeContinuity) throw new Error("This conversation's native session location changed. Its saved history was preserved.");
      this.forgetRootThread("home_changed");
    }
    let authHome: string | undefined;
    try {
      if (context.access?.kind === "secret") {
        const apiKey = context.access.fields["api-key"];
        const codexHome = environment.CODEX_HOME;
        if (apiKey !== undefined && apiKey !== "" && codexHome !== undefined && codexHome !== "") {
          retainCodexApiKeyAuth(codexHome);
          authHome = codexHome;
          const write = this.dependencies.writeCodexApiKeyAuthFile ?? writeCodexApiKeyAuthFile;
          await serializedCodexApiKeyAuthFileOperation(codexHome, async () => {
            // The turn may have been force-stopped while it waited behind another turn's
            // removal; it no longer holds access, so it must not write credentials.
            context.forceSignal?.throwIfAborted();
            await write(codexHome, apiKey);
          });
        }
      }
      await this.runCodexTurn(context, attach, signal, environment, resolvedRuntime.executable, {
        persistentRootSession,
        personalPresentationVersionId,
        codexHome,
        sessionIdentity,
      });
    } finally {
      if (authHome !== undefined) {
        await releaseCodexApiKeyAuth(
          authHome,
          this.dependencies.removeCodexApiKeyAuthFile ?? removeCodexApiKeyAuthFile,
        );
      }
    }
  }

  private async runCodexTurn(
    context: HarnessRunContext,
    attach: (identity: JsonObject) => void,
    signal: AbortSignal | undefined,
    environment: Record<string, string>,
    executable: string,
    rootThread: {
      readonly persistentRootSession: boolean;
      readonly personalPresentationVersionId: number | null;
      readonly codexHome: string;
      readonly sessionIdentity: string;
    },
  ): Promise<void> {
    const { persistentRootSession } = rootThread;
    const sandboxPolicy = this.sandboxPolicy();
    const run = this.dependencies.runAppServerTurn ?? runCodexAppServerTurn;
    const model = this.selectedModel(context);
    const prompt = this.prompt(context);
    context.trace.emit({
      type: "prompt",
      data: { text: this.prompt(context, false), interactionNodeId: context.inputGraph.id },
    });
    const traceState: CodexTraceState = {
      collaborationSpans: new Map(),
      graphAuthoringCommandIds: new Set(),
      ...(this.dependencies.graphAuthoringNodePath ? { graphAuthoringNodePath: this.dependencies.graphAuthoringNodePath.replaceAll("\\", "/") } : {}),
      fallbackGraphAuthoringEnabled: this.dependencies.graphAuthoringLauncherPath === undefined,
    };
    // The host's per-turn force-stop kills this turn's app-server process group, exactly as a
    // harness force shutdown does, and no other turn's. A turn force-stopped before it spawns
    // never spawns. A root turn killed either way after it sent turn/start also drops its
    // native thread: the killed process may have left it mid-write, so the next root turn
    // starts a fresh one. Killed before turn/start, it wrote nothing, so the thread is kept.
    context.forceSignal?.throwIfAborted();
    const forceShutdown = new AbortController();
    let conversationStarted = false;
    const forgetForcedRootThread = () => {
      if (persistentRootSession && conversationStarted) this.forgetRootThread("force_stopped");
    };
    const forceTurn = () => {
      forgetForcedRootThread();
      forceShutdown.abort(context.forceSignal?.reason);
    };
    context.forceSignal?.addEventListener("abort", forceTurn, { once: true });
    this.activeForceShutdowns.set(forceShutdown, forgetForcedRootThread);
    if (persistentRootSession && this.codexThreadId === undefined && this.pendingRootReset !== undefined) {
      reportNativeSessionReset(context, "Codex", this.context.threadId, this.pendingRootReset);
      this.pendingRootReset = undefined;
    }
    try {
      await run({
        environment,
        codexPathOverride: executable,
        requireNativeContinuity: persistentRootSession && context.requireNativeContinuity === true,
        ...this.codexConfigOverrides(context.access),
        ...(persistentRootSession && this.codexThreadId !== undefined
          ? { savedThreadId: this.codexThreadId }
          : {}),
        ...(persistentRootSession && context.requireNativeContinuity && this.codexSessionIdentity === undefined
          ? { legacyHistoryAnchor: context.nativeHistoryAnchor ?? { interactionNodeId: -1, message: "" } } : {}),
        threadParams: this.threadParams(model, context, context.access),
        turnParams: this.turnParams(sandboxPolicy, model),
        prompt,
        approvals: context.approvals,
        workingDirectory: this.context.workingDirectory,
        sandboxPolicy,
        ...(this.dependencies.graphAuthoringLauncherPath === undefined
          ? {}
          : { trustedGraphAuthoringLauncher: this.dependencies.graphAuthoringLauncherPath }),
        ...(signal === undefined ? {} : { signal }),
        forceSignal: forceShutdown.signal,
        ...(this.dependencies.spawnProcess === undefined ? {} : { spawnProcess: this.dependencies.spawnProcess }),
        // A thread gets its rollout only once turn/start is accepted. Until then, a stopped
        // turn leaves nothing that Codex could resume, so the thread is not kept.
        onThreadId: (threadId) => {
          if (context.requireNativeContinuity && persistentRootSession && this.codexThreadId !== threadId) throw new Error("Native resume returned a different conversation. The original history was preserved.");
        },
        onTurnStarting: () => { conversationStarted = true; },
        onSavedThreadUnavailable: (threadId) => {
          if (!persistentRootSession || this.codexThreadId !== threadId) return;
          if (context.requireNativeContinuity) throw new Error("The saved native conversation is unavailable. Its original history was preserved; no fresh turn was started.");
          this.forgetRootThread("no_rollout");
          reportNativeSessionReset(context, "Codex", this.context.threadId, "no_rollout");
          this.pendingRootReset = undefined;
        },
        // A Stop that lands while turn/start is pending kills the app-server, which may have
        // left the thread mid-write, as a force-stop does.
        onTurnStartAbandoned: () => {
          if (persistentRootSession && !forceShutdown.signal.aborted) this.forgetRootThread("stopped_during_start");
        },
        onTurnId: (threadId, turnId) => {
          if (persistentRootSession && !forceShutdown.signal.aborted) {
            this.codexThreadId = threadId;
            this.codexThreadPersonalPresentationVersionId = rootThread.personalPresentationVersionId;
            this.codexThreadHome = rootThread.codexHome;
            this.codexSessionIdentity = rootThread.sessionIdentity;
            this.pendingRootReset = undefined;
          }
          attach(Object.freeze({
            schemaVersion: 1,
            provider: "codex",
            threadId,
            turnId,
          }));
        },
        onNotification: (method, params) => traceCodexAppServerNotification(context, method, params, traceState),
        onServerRequest: (method, params) => traceCodexAppServerNotification(context, method, params, traceState),
      });
    } finally {
      // Nothing is forgotten here: forceTurn already did, and a later root turn may have
      // stored its own thread by the time this killed turn settles.
      context.forceSignal?.removeEventListener("abort", forceTurn);
      this.activeForceShutdowns.delete(forceShutdown);
      closeIncompleteCollaborationSpans(traceState);
    }
  }

  traceSupport(): HarnessTraceSupport {
    return {
      prompt: "full",
      messages: "full",
      reasoningSummaries: "full",
      modelCalls: "full",
      toolCalls: "full",
      usage: "full",
      childStreams: "none",
      nativeArtifacts: "none",
    };
  }

  state(): HarnessSessionState {
    const reset = this.pendingRootReset === undefined ? {} : { codexRootResetReason: this.pendingRootReset };
    return this.codexThreadId === undefined
      ? reset
      : {
          codexThreadId: this.codexThreadId,
          ...(this.codexSessionIdentity === undefined ? {} : { codexSessionIdentity: this.codexSessionIdentity }),
          ...(this.codexThreadHome === undefined ? {} : { codexThreadHome: this.codexThreadHome }),
          ...reset,
          ...(this.codexThreadPersonalPresentationVersionId === undefined ? {} : { codexThreadPersonalPresentationVersionId: this.codexThreadPersonalPresentationVersionId }),
        };
  }

  forceShutdown(): void {
    for (const [shutdown, forgetForcedRootThread] of this.activeForceShutdowns) {
      // A turn already force-stopped forgot its thread then; a later root turn may own one now.
      if (shutdown.signal.aborted) continue;
      forgetForcedRootThread();
      shutdown.abort(new Error("Codex harness force-disposed"));
    }
  }

  private forgetRootThread(reason: NativeSessionResetReason): void {
    this.codexSessionIdentity = undefined;
    this.codexThreadId = undefined;
    this.codexThreadPersonalPresentationVersionId = undefined;
    this.codexThreadHome = undefined;
    this.pendingRootReset = reason;
  }

  private graphEnvironment(
    graph: GraphCapability,
    completionBroker: HarnessRunContext["completionBroker"],
    access: HarnessExecutionAccess | undefined,
    resolvedRuntimeEnvironment: Readonly<Record<string, string>>,
  ): Record<string, string> {
    const ambient = Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined);
    const environment = Object.fromEntries(access === undefined
      ? ambient
      : ambient.filter(([key]) => SAFE_SUBPROCESS_ENVIRONMENT.has(key)));
    if (access?.kind === "managed-runtime") {
      if (access.adapterId !== "codex-subscription") throw new Error(`codex.basic cannot consume managed runtime ${access.adapterId}`);
      Object.assign(environment, Object.fromEntries(Object.entries(access.environment).filter(([key]) => (
        CODEX_MANAGED_RUNTIME_ENVIRONMENT.has(key)
      ))));
    } else if (access?.kind === "secret") {
      if (!CODEX_BASIC_SECRET_ADAPTERS.has(access.adapterId)) {
        throw new Error(`codex.basic cannot consume secret provider ${access.adapterId}`);
      }
      const apiKey = access.fields["api-key"];
      if (!apiKey) throw new Error("codex.basic requires the provider API key");
      if (access.runtime && access.runtime.runtimeId !== "codex") {
        throw new Error("codex.basic cannot consume a non-Codex managed runtime");
      }
      Object.assign(environment, Object.fromEntries(Object.entries(resolvedRuntimeEnvironment).filter(([key]) => (
        CODEX_MANAGED_RUNTIME_ENVIRONMENT.has(key)
      ))));
      environment.OPENAI_API_KEY = apiKey;
      environment.OPENAI_BASE_URL = access.endpoint;
    } else {
      Object.assign(environment, Object.fromEntries(Object.entries(resolvedRuntimeEnvironment).filter(([key]) => (
        CODEX_MANAGED_RUNTIME_ENVIRONMENT.has(key)
      ))));
    }
    // Older Relayer builds exposed the raw Node executable through this name.
    // Never let a stale parent environment silently restore that broader
    // authoring path now that graph execution uses the zero-argument launcher.
    delete environment.RELAYER_GRAPH_AUTHORING_NODE;
    // Windows environment keys are case-insensitive; keep only one PATH alias.
    if (environment.Path !== undefined) { environment.PATH = environment.Path; delete environment.Path; }
    environment.RELAYER_GRAPH_URL = graph.url;
    delete environment.RELAYER_GRAPH_AUTHORING_ERRORS;
    if (graph.authoringErrors) environment.RELAYER_GRAPH_AUTHORING_ERRORS = "1";
    environment.RELAYER_GRAPH_TOKEN = graph.token;
    environment.RELAYER_NODE_ID = String(graph.nodeId);
    delete environment.RELAYER_GRAPH_PREVIEW_DIR;
    if (graph.previewDirectory !== undefined) environment.RELAYER_GRAPH_PREVIEW_DIR = graph.previewDirectory;
    delete environment.RELAYER_GRAPH_PROGRAM_DIR;
    // The pinned launcher strips the environment and reads no files, so only the fallback heredoc gets it.
    if (graph.programDirectory !== undefined && this.dependencies.graphAuthoringLauncherPath === undefined) {
      environment.RELAYER_GRAPH_PROGRAM_DIR = graph.programDirectory;
    }
    if (completionBroker !== undefined) {
      environment.RELAYER_COMPLETE_URL = completionBroker.url;
      environment.RELAYER_COMPLETE_TOKEN = completionBroker.token;
    }
    return environment;
  }

  private async codexRuntime(access: HarnessExecutionAccess | undefined): Promise<{
    executable: string;
    environment: Readonly<Record<string, string>>;
  }> {
    let executable = access?.kind === "managed-runtime"
      ? access.executable ?? this.dependencies.codexPathOverride
      : access?.kind === "secret"
        ? access.runtime?.executable ?? this.dependencies.codexPathOverride
        : this.dependencies.codexPathOverride;
    const accessEnvironment = access?.kind === "managed-runtime"
      ? access.environment
      : access?.kind === "secret"
        ? access.runtime?.environment ?? {}
        : {};
    if ((executable === undefined || executable.trim() === "") && this.dependencies.resolveCodexRuntime) {
      const runtime = await this.dependencies.resolveCodexRuntime();
      executable = runtime.executable;
      if (executable.trim() === "") throw new Error("codex.basic requires an explicit managed Codex executable");
      return { executable, environment: runtime.environment };
    }
    if (executable === undefined || executable.trim() === "") {
      throw new Error("codex.basic requires an explicit managed Codex executable");
    }
    return { executable, environment: accessEnvironment };
  }

  private selectedModel(context: HarnessRunContext): string | undefined {
    if (context.model === undefined) return this.resolved.settings.model;
    const adapterId = context.model.adapterId ?? (context.model.providerId === "codex" ? "codex-subscription" : undefined);
    if (!adapterId) throw new Error(`codex.basic cannot run provider ${context.model.providerId}`);
    if (!CODEX_BASIC_ADAPTERS.has(adapterId)) {
      throw new Error(`codex.basic cannot run provider adapter ${adapterId}`);
    }
    return context.model.modelId;
  }

  private codexConfigOverrides(access: HarnessExecutionAccess | undefined): {
    readonly codexConfigOverrides?: readonly string[];
  } {
    if (access?.kind !== "secret") return {};
    return {
      codexConfigOverrides: [
        'model_provider="relayer_execution_provider"',
        'model_providers.relayer_execution_provider.name="Relayer execution provider"',
        `model_providers.relayer_execution_provider.base_url=${JSON.stringify(access.endpoint)}`,
        'model_providers.relayer_execution_provider.env_key="OPENAI_API_KEY"',
        'model_providers.relayer_execution_provider.wire_api="responses"',
        "model_providers.relayer_execution_provider.requires_openai_auth=false",
        "model_providers.relayer_execution_provider.supports_websockets=false",
        // Codex 0.147 snapshots capture the app-server environment and source
        // those exports after shell filtering. Disable that path for API-key
        // access so snapshots cannot persist or reintroduce provider secrets.
        "features.shell_snapshot=false",
        'shell_environment_policy.inherit="all"',
        "shell_environment_policy.ignore_default_excludes=true",
        'shell_environment_policy.filters.OPENAI_API_KEY="exclude"',
        'shell_environment_policy.filters.OPENAI_BASE_URL="exclude"',
      ],
    };
  }

  private threadParams(
    model: string | undefined,
    context: HarnessRunContext,
    access: HarnessExecutionAccess | undefined,
  ): JsonObject {
    const { settings, permission } = this.resolved;
    const presentationInstructions = personalPresentationNativeInstructions(context);
    const config: Record<string, JsonObject[keyof JsonObject]> = {};
    if (settings.skipGitRepoCheck !== undefined) config.skip_git_repo_check = settings.skipGitRepoCheck;
    if (settings.webSearchMode !== undefined) config.web_search = settings.webSearchMode;
    const executionModelProvider = access?.kind === "secret"
      ? {
          name: "Relayer execution provider",
          base_url: access.endpoint,
          env_key: "OPENAI_API_KEY",
          wire_api: "responses",
          requires_openai_auth: false,
          supports_websockets: false,
        }
      : undefined;
    if (executionModelProvider !== undefined) {
      config.model_providers = { relayer_execution_provider: executionModelProvider };
    }
    const browserMcpRuntime = this.dependencies.browserMcpRuntime;
    if (browserMcpRuntime !== undefined) {
      config.features = { tool_call_mcp_elicitation: false };
      config.mcp_servers = {
        "chrome-devtools": {
          command: browserMcpRuntime.executable,
          args: [browserMcpRuntime.script, ...browserMcpRuntime.connectionArgs],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          enabled: true,
          required: false,
          startup_timeout_sec: 20,
          tool_timeout_sec: 20,
          // In pinned Codex 0.147, `prompt` marks the MCP tool as requiring
          // approval; the thread policy then routes that approval. Ask emits
          // item/tool/requestUserInput, Auto uses its native auto_review
          // reviewer, and unrestricted Full with approvalPolicy=never is
          // approved before a server request. Using `approve` here for Auto or
          // Full would bypass that native policy instead of preserving it.
          default_tools_approval_mode: "prompt",
        },
      };
    }
    return {
      cwd: this.context.workingDirectory,
      approvalPolicy: permission.approvalPolicy,
      sandbox: permission.sandboxMode,
      ...(permission.approvalsReviewer === undefined ? {} : { approvalsReviewer: permission.approvalsReviewer }),
      ...(model === undefined ? {} : { model }),
      ...(executionModelProvider === undefined ? {} : { modelProvider: "relayer_execution_provider" }),
      ...(Object.keys(config).length === 0 ? {} : { config }),
      developerInstructions: presentationInstructions === "" ? null : presentationInstructions,
      serviceName: "relayer_graphcomplete",
    };
  }

  private turnParams(sandboxPolicy: JsonObject, model: string | undefined): JsonObject {
    const { settings, permission } = this.resolved;
    return {
      cwd: this.context.workingDirectory,
      approvalPolicy: permission.approvalPolicy,
      ...(permission.approvalsReviewer === undefined ? {} : { approvalsReviewer: permission.approvalsReviewer }),
      sandboxPolicy,
      ...(model === undefined ? {} : { model }),
      ...(settings.modelReasoningEffort === undefined ? {} : { effort: settings.modelReasoningEffort }),
    };
  }

  private sandboxPolicy(): JsonObject {
    const { settings, permission } = this.resolved;
    if (permission.sandboxMode === "danger-full-access") return { type: "dangerFullAccess" };
    if (permission.sandboxMode === "read-only") {
      return { type: "readOnly", networkAccess: permission.networkAccessEnabled ?? false };
    }
    return {
      type: "workspaceWrite",
      writableRoots: [this.context.workingDirectory, ...(settings.additionalDirectories ?? [])],
      networkAccess: permission.networkAccessEnabled ?? false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  private prompt(context: HarnessRunContext, includePersonalPresentation = true): string {
    const interactionNode = context.inputGraph;
    if (this.resolved.promptProfile === "layered-navigation-v1") {
      return this.layeredNavigationPrompt(context, includePersonalPresentation);
    }
    if (this.resolved.promptProfile === "layered-navigation-multi-agent-v1") {
      return `${this.layeredNavigationPrompt(context, includePersonalPresentation)}

Codex native subagents are available when useful. Subagents may directly author, revise, and submit graph objects using the available graph capability. Use the configured model family as appropriate; coordination remains native to Codex.`;
    }
    const launcher = this.graphAuthoringCommand();
    const launcherClause = this.dependencies.graphAuthoringLauncherPath ? " do not resolve the launcher or Node.js from PATH," : "";
    const launcherArgumentsClause = this.dependencies.graphAuthoringLauncherPath ? " with no arguments" : "";
    const pinnedExecutionClause = this.pinnedExecutionClause();
    return `You are the basic Relayer graph harness. ${UNDERLYING_TASK_GUIDANCE}

Answer the current user interaction by authoring and accepting a useful graph layer that truthfully presents the completed work or genuine blocker.

${GRAPH_PRESENTATION_GUIDANCE}
${threadIconGuidance(context, "javascript")}
${CODEX_VISUAL_GUIDANCE}
For Input plus Invoke, declare one InputActionObject field, then set the Invoke's inputActions: [field]. Mount these exact objects on the same Node. After submitting Node and Layer, graph.addAction(node, invoke) writes or recovers the referenced Input first and stores canonical IDs; no ID guessing or proximity inference. Input alone feeds chat; Invoke consumes only its explicit bindings. New Invokes allow one call unless reusable: true is explicitly appropriate.
${CODEX_ASSET_GUIDANCE}
${CURRENT_WORKSPACE_GUIDANCE}\n${CURRENT_COMMUNICATION_GUIDANCE_JS}${includePersonalPresentation ? personalPresentationPrompt(context) : ""}

Current interaction node: ${interactionNode.id}
Normalized interaction input:
${renderInteractionInput(context.interactionInput)}

${INTERACTION_INPUT_GUIDANCE} In JavaScript, call graph.getInteractionInput() to re-read it.
${context?.interactionInput.completionContract?.input.invocationReferences.length ? SUBCOMPLETION_INTEGRATION_GUIDANCE : ""}
${context?.completionBroker ? INVOCATION_PUBLICATION_GUIDANCE : ""}

${ATTACHED_NAVIGATION_GUIDANCE}
For a full Node Detail replacement accompanying an authorized addition, first call await graph.getNodePresentation(nodeId) to read the current node, revision, and actions. Author a complete compiled NodeObject presentation with the persistent node's existing clientKey, preserving every existing action binding and adding usable controls for the new actions. Call await graph.replaceNodePresentation(nodeId, revision, presentationBuilder); this stages presentation only, not the builder's title/detail. Retain original action clientKey, kind, and sourceLayer provenance when rebuilding controls; new actions with omitted provenance must omit it in their bindings too. On stale_presentation_revision, reread and repair the full presentation against the current actions. Do not synthesize supplemental controls. If retained rich HTML cannot expose a new action, provide an explicit full replacement before submitting.


Use executable JavaScript and the Relayer graph client. Do not return a JSON graph in chat. ${this.dependencies.graphAuthoringNodePath ? appOwnedNodeInstructions(this.dependencies.graphAuthoringNodePath) + " Import from:" : `Run exactly ${launcher}${launcherArgumentsClause}, including the displayed double quotes, and pass the program through standard input using a shell-native single-quoted here-document delimited by exactly RELAYER_GRAPH_PROGRAM;${launcherClause} never place authored graph code in a --eval argument, and do not create a script in either the project checkout or a temporary directory. ${this.dependencies.graphAuthoringLauncherPath ? "Request Codex sandbox escalation for this exact launcher command; Relayer preauthorizes only this pinned internal launcher, which applies its own narrower graph sandbox." : ""} The quoted here-document must prevent the provider shell from expanding environment variables in the program. Import from:`}
${this.clientModuleUrl}
${pinnedExecutionClause}

${currentCommunicationAuthoringRecipeJs(interactionNode.id, this.clientModuleUrl)}

${semanticCompletionGuidanceJs(context, this.completeModuleUrl, "Codex")}

${currentWorkspaceMechanicsJs()}

The visible layer must contain 1 to 8 nodes and must be connected. Layer edges are exactly what the user sees.

${LAYER_EDGE_SHAPE_GUIDANCE}

${ARTIFACT_LAYER_GUIDANCE}

Every new layer, including every child layer, requires an intentional authored layout. Coordinates are normalized numbers from 0 through 1 and describe semantic relative position independently of the viewport. Place a one-node layer at (0.5, 0.5). Keep flow or time moving consistently, use a parent or summary node to anchor hierarchy, group related nodes spatially, align comparisons deliberately, and avoid accidental overlap or edge crossings where a clearer arrangement is available. The renderer changes the camera for the viewport; do not derive coordinates from pixels, window size, or inspector state.

Node and action icons accept supported symbol names or registered image references. Invalid draft references are repairable.
${NODE_ICON_GUIDANCE}

Relayer graph affordances:
- A node can be a complete explanation in the current layer.
- A node can open a more detailed child layer. Submit the stable-keyed child LayerObject, then attach it with await graph.addAction(node, { kind: "navigate", relation: "expand", sourceLayer: layer, label: "Useful label", target: childLayer, variant: "pill", clientKey: "node-detail" }).
- A node can open supporting evidence or reusable context. Submit the stable-keyed target LayerObject, then attach it with await graph.addAction(node, { kind: "navigate", relation: "reference", sourceLayer: layer, label: "View evidence", target: evidenceLayer, variant: "pill", clientKey: "node-evidence" }).
- A node can offer a useful follow-up interaction with await graph.addAction(node, { kind: "invoke", sourceLayer: layer, label: "Useful label", interactionText: "A useful follow-up", variant: "chip", clientKey: "node-follow-up" }).

Every action uses Relayer's renderer-independent presentation grammar. You author its order, kind and payload, label, optional supported icon, and one of these variants:
- "chip": the most compact inline action;
- "pill": the standard rounded action and the default when variant is omitted;
- "wide": a full-width action for a prominent next step;
- "card": a full-width action with both label and a required supporting description, for example { variant: "card", label: "Compare approaches", description: "Lay out the tradeoffs before choosing.", icon: "git-compare" }.

Choose variants with the available inspector space in mind: chips and pills suit several concise choices, while wide actions and cards consume more vertical space. This footprint guidance is advisory, not a limit. You may freely mix variants, author multiple cards, and let a useful action list scroll. Description is supported only by card actions.

Navigate and invoke actions are first-class options, not requirements for every node. Use them where they materially improve the answer, and submit every referenced node, edge, and layer before adding its action.

${graphProgramRepairGuidance(programEditsAvailable(context, this.dependencies.graphAuthoringLauncherPath), "If a graph call rejects an object or graph.submit reports a repairable issue")} Stable keys make a rerun, whole or edited, update the same drafts instead of creating duplicates when each object's identity-owning context stays unchanged. An action's clientKey is scoped to its source node: keep every draft action on the same source node during repair, because moving it creates a different action and leaves the original draft behind. Do not add fake navigate or reference actions merely to make abandoned draft layers reachable. Only when graph.submit identifies a genuinely abandoned orphan draft, recover with graph.discardLayer(layer); this preserves that layer as stopped history without discarding its nodes, edges, actions, or child layers. The graph is complete only after graph.submit succeeds.`;
  }

  private layeredNavigationPrompt(context: HarnessRunContext, includePersonalPresentation: boolean): string {
    return buildLayeredNavigationPrompt(
      context,
      this.clientModuleUrl,
      this.dependencies.graphAuthoringLauncherPath,
      this.completeModuleUrl,
      "Codex",
      includePersonalPresentation,
      this.context.configuration.graphCapabilityProfile?.search === "query-v1",
      this.dependencies.graphAuthoringNodePath,
    );
  }

  private graphAuthoringCommand(): string {
    if (this.dependencies.graphAuthoringNodePath !== undefined) {
      if (this.dependencies.graphAuthoringLauncherPath !== undefined) throw new Error("Graph authoring cannot use both Node and the restricted launcher.");
      return appOwnedNodeCommand(this.dependencies.graphAuthoringNodePath);
    }
    return graphAuthoringCommand(this.dependencies.graphAuthoringLauncherPath);
  }

  private pinnedExecutionClause(): string {
    return pinnedExecutionClause(this.dependencies.graphAuthoringLauncherPath);
  }
}

function validateBrowserMcpRuntime(runtime: CodexBasicDependencies["browserMcpRuntime"]): void {
  if (runtime === undefined) return;
  if (!isAbsolute(runtime.executable) || !isAbsolute(runtime.script)) {
    throw new Error("codex.basic browser MCP runtime requires absolute executable and script paths");
  }
  if (!Array.isArray(runtime.connectionArgs)
    || runtime.connectionArgs.length === 0
    || runtime.connectionArgs.some((argument) => typeof argument !== "string" || argument.trim() === "")) {
    throw new Error("codex.basic browser MCP runtime requires non-empty connection arguments");
  }
}

export function buildLayeredNavigationPrompt(
  input: HarnessRunContext | GraphNode,
  clientModuleUrl: string,
  graphAuthoringLauncherPath?: string,
  completeModuleUrlOrIncludePersonalPresentation: string | boolean = new URL("../../../../dist/index.js", import.meta.url).href,
  nativeAgentLabelOrGraphSearchEnabled: string | boolean = "Codex",
  explicitIncludePersonalPresentation = true,
  explicitGraphSearchEnabled = false,
  graphAuthoringNodePath?: string,
): string {
  const completeModuleUrl = typeof completeModuleUrlOrIncludePersonalPresentation === "string"
    ? completeModuleUrlOrIncludePersonalPresentation
    : new URL("../../../../dist/index.js", import.meta.url).href;
  const includePersonalPresentation = typeof completeModuleUrlOrIncludePersonalPresentation === "boolean"
    ? completeModuleUrlOrIncludePersonalPresentation
    : explicitIncludePersonalPresentation;
  const nativeAgentLabel = typeof nativeAgentLabelOrGraphSearchEnabled === "string"
    ? nativeAgentLabelOrGraphSearchEnabled
    : "Codex";
  const graphSearchEnabled = typeof nativeAgentLabelOrGraphSearchEnabled === "boolean"
    ? nativeAgentLabelOrGraphSearchEnabled
    : explicitGraphSearchEnabled;
  const context = "inputGraph" in input ? input as HarnessRunContext : undefined;
  const interactionNode = context ? context.inputGraph : input as GraphNode;
  const normalizedInput = context
    ? renderInteractionInput(context.interactionInput)
    : `Interaction:\n- id: ${interactionNode.id}\n- title: ${interactionNode.title}\n- detail: ${interactionNode.detail}`;
  if (graphAuthoringNodePath !== undefined && graphAuthoringLauncherPath !== undefined) throw new Error("Graph authoring cannot use both Node and the restricted launcher.");
  const authoringInstructions = graphAuthoringNodePath !== undefined
    ? `${appOwnedNodeInstructions(graphAuthoringNodePath, nativeAgentLabel === "Claude" ? "bash" : "powershell")} Import RelayerGraphClient, NodeObject, EdgeObject, and LayerObject from:\n${clientModuleUrl}\nThen use RelayerGraphClient.fromEnv(). Submit each referenced object before using it. Keep clientKey values stable when repairing rejected submissions. The final call must be await graph.submit(${interactionNode.id}); call it only after the full response has been authored.`
    : graphAuthoringLauncherPath === undefined
    ? `Run exactly node --input-type=module with no additional arguments and pass the program through standard input using a shell-native single-quoted here-document delimited by exactly RELAYER_GRAPH_PROGRAM; never place authored graph code in a --eval argument, and do not create a script in either the project checkout or a temporary directory. The quoted here-document must prevent the provider shell from expanding environment variables in the program. Import RelayerGraphClient, NodeObject, EdgeObject, and LayerObject from:\n${clientModuleUrl}\nThen use RelayerGraphClient.fromEnv(). Author in whatever order fits the task. Keep the scoped snapshot and local keys stable when repairing a rejected draft. Submit each referenced object before using it. The final graph call must be await graph.submit(${interactionNode.id}); call it only after the full response has been authored.`
    : `Run exactly ${graphAuthoringCommand(graphAuthoringLauncherPath)} with no arguments, including the displayed double quotes, and pass the program through standard input using a shell-native single-quoted here-document delimited by exactly RELAYER_GRAPH_PROGRAM; do not resolve the launcher or Node.js from PATH, never place authored graph code in a --eval argument, and do not create a script in either the project checkout or a temporary directory. Request Codex sandbox escalation for this exact launcher command; Relayer preauthorizes only this pinned internal launcher, which applies its own narrower graph sandbox. The quoted here-document must prevent the provider shell from expanding environment variables in the program. Import from:\n${clientModuleUrl}\n${pinnedExecutionClause(graphAuthoringLauncherPath)}`;
  const graphSearchGuidance = graphSearchEnabled ? `
Graph search is available through the same executable JavaScript client as await graph.search(request, options). It is not a provider-native tool or MCP function. The public request accepts queryContractVersion, query, optional tagged parameters, optional budget, and an optional target: { scope: "thread" | "project", id: positiveInteger }. Omit target to search the current interaction's thread. Supply target only when the product or user has already provided the exact canonical ID, for example target: { scope: "project", id: knownProjectId }. Never invent, guess, or discover a target ID. The selector chooses a dataset; it is not authority, and Rust still intersects it with the completion-bound read permit. Never add raw permit, credential, token, database, candidate-source, or other authority fields. Search sees accepted published graph records only; it never exposes drafts and never falls back to SQLite when the Ladybug index is unavailable.

Use queryContractVersion: 1. The admitted read-only query profile supports whole-target Content or Layer scans and bounded one- or two-relationship MATCH patterns over CONNECTED, CONTAINS, EXPANDS, and REFERENCES. It does not support mutation, procedures, arbitrary-length paths, or more than two hops. Put values in tagged parameters instead of query literals, for example parameters: { anchor: { type: "string", value: "Queue" }, count: { type: "integer", value: "2" } }. Integers are signed 64-bit decimal strings, not JavaScript numbers. Results also use tagged values: null, boolean, integer, float, string, node, layer, relationship, path, homogeneous list, or ordered record. Without a smaller LIMIT, search returns at most 5 rows; LIMIT above the hard maximum of 8 is rejected, and the complete encoded result is bounded to 16 KiB. A successful prefix reports truncated: true when another whole row exists beyond a row or byte bound.

For example:
const search = await graph.search({ queryContractVersion: 1, query: "MATCH (l:Layer)-[:CONTAINS]->(n:Content) WHERE n.title = $anchor RETURN l AS layer ORDER BY layer ASC", parameters: { anchor: { type: "string", value: "Queue" } } });

Graph search contract failures are GraphQueryError values with stable status, code, phase, and path fields; message wording is explanatory and may change. Branch on code or phase, never on message text. Transport or index unavailability is a GraphApiError rather than a stale successful result. Pass { signal } as the second graph.search argument when cancellation matters.

A returned graph value is data, not authority. When search finds accepted context that materially supports the current response, add a typed reference action from a node in the new layer. Require a tagged layer value, validate its public identity, convert only its positive safe numeric suffix, and let graph.addAction revalidate visibility:
const priorLayer = search.rows[0]?.[0];
if (priorLayer?.type !== "layer") throw new Error("Expected a tagged layer search result");
const priorLayerMatch = /^layer:([1-9][0-9]*)$/.exec(priorLayer.id);
const priorLayerId = priorLayerMatch === null ? NaN : Number(priorLayerMatch[1]);
if (!Number.isSafeInteger(priorLayerId)) throw new Error("Expected a safe accepted layer identity");
await graph.addAction(summaryNode, { kind: "navigate", relation: "reference", sourceLayer: currentLayer, label: "View prior context", target: priorLayerId, clientKey: "summary-prior-context" });
Do not turn a node, relationship, path, list, record, or arbitrary string into an action target. Search is optional: use it when prior accepted graph context can improve the answer, not as a substitute for inspecting the workspace or completing the underlying task.
` : "";
  const previewGuidance = context !== undefined && draftPreviewsAvailable(context)
    ? `\n${draftPreviewGuidance(nativeAgentLabel === "Claude" ? CLAUDE_PREVIEW_VIEWING : CODEX_PREVIEW_VIEWING)}\n`
    : "";
  return `You are the Relayer layered-navigation harness. ${UNDERLYING_TASK_GUIDANCE}

While doing the underlying work, publish useful findings through current; finally answer the current user interaction with a useful graph that truthfully presents the result, evidence, and limitations. A flat answer is valid. Add navigation only when opening it would materially improve understanding or support; apply that same test again inside every layer you author.

${GRAPH_PRESENTATION_GUIDANCE}
${threadIconGuidance(context, "javascript")}
${CODEX_VISUAL_GUIDANCE}
For Input plus Invoke, declare one InputActionObject field, then set the Invoke's inputActions: [field]. Mount these exact objects on the same Node. After submitting Node and Layer, graph.addAction(node, invoke) writes or recovers the referenced Input first and stores canonical IDs; no ID guessing or proximity inference. Input alone feeds chat; Invoke consumes only its explicit bindings. New Invokes allow one call unless reusable: true is explicitly appropriate.
${CODEX_ASSET_GUIDANCE}
${CURRENT_WORKSPACE_GUIDANCE}\n${CURRENT_COMMUNICATION_GUIDANCE_JS}${includePersonalPresentation && context !== undefined ? personalPresentationPrompt(context) : ""}

Current interaction node: ${interactionNode.id}
Normalized interaction input:
${normalizedInput}

${INTERACTION_INPUT_GUIDANCE} In JavaScript, call graph.getInteractionInput() to re-read it.
${context?.interactionInput.completionContract?.input.invocationReferences.length ? SUBCOMPLETION_INTEGRATION_GUIDANCE : ""}
${context?.completionBroker ? INVOCATION_PUBLICATION_GUIDANCE : ""}

${ATTACHED_NAVIGATION_GUIDANCE}
For a full Node Detail replacement accompanying an authorized addition, first call await graph.getNodePresentation(nodeId) to read the current node, revision, and actions. Author a complete compiled NodeObject presentation with the persistent node's existing clientKey, preserving every existing action binding and adding usable controls for the new actions. Call await graph.replaceNodePresentation(nodeId, revision, presentationBuilder); this stages presentation only, not the builder's title/detail. Retain original action clientKey, kind, and sourceLayer provenance when rebuilding controls; new actions with omitted provenance must omit it in their bindings too. On stale_presentation_revision, reread and repair the full presentation against the current actions. Do not synthesize supplemental controls. If retained rich HTML cannot expose a new action, provide an explicit full replacement before submitting.


Use executable JavaScript and the Relayer graph client. Do not return a JSON graph in chat. ${authoringInstructions}

${currentCommunicationAuthoringRecipeJs(interactionNode.id, clientModuleUrl)}

${currentWorkspaceMechanicsJs()}
${semanticCompletionGuidanceJs(context, completeModuleUrl, nativeAgentLabel)}

The current interaction may carry an invoke lease created by the product. Before authoring, use graph.getNode(${interactionNode.id}) and graph.getNeighbors(${interactionNode.id}) to inspect the current node and any relevant source context exposed by the graph. Treat that context as input to your answer; do not copy, forge, or manage lease metadata. Author the response normally. A successful ordinary graph.submit(${interactionNode.id}) automatically fulfills any lease held by this interaction. There is no separate resolveAction call.

${graphSearchGuidance}${previewGuidance}

Navigation has two meanings:
- "expand" continues the explanation with a more detailed layer. Expansion must not point back to an expansion ancestor.
- "reference" opens supporting evidence or context. References may reuse an accepted layer, may point to other reference layers, and may revisit a layer.

The interaction node must have one root navigate action with relation: "expand" and no sourceLayer. Every action on a response node must include sourceLayer: the LayerObject in which you are authoring that action. Expansion layers may author expand, reference, or invoke actions. A layer reached as a reference may author only reference actions. Do not create both expand and reference actions to the same new target layer.

Examples:
await graph.addAction(${interactionNode.id}, { kind: "navigate", relation: "expand", label: "Key findings", icon: "search", target: rootLayer, clientKey: "root-response" });
await graph.addAction(node, { kind: "navigate", relation: "expand", sourceLayer: rootLayer, label: "Explain further", target: detailLayer, clientKey: "node-detail" });
await graph.addAction(node, { kind: "navigate", relation: "reference", sourceLayer: rootLayer, label: "View evidence", target: evidenceLayer, clientKey: "node-evidence" });
await graph.addAction(node, { kind: "invoke", sourceLayer: rootLayer, label: "Follow up", interactionText: "Ask a useful follow-up", clientKey: "node-follow-up" });

For every layer, choose the member whose detail should open first. Set layer.defaultNode to that NodeObject before submitLayer. Make this choice intentionally for the task; it does not change graph position or node order. The UI uses it only when there is no remembered user selection.

Layers normally contain 1 to 5 nodes. A layer may contain 6 to 8 nodes only when keeping them together matters; pass a private sizeJustification to submitLayer. Never mention or expose the size justification in user-facing node text. More than 8 nodes must be split. Layer edges are visible and undirected. Every node needs a supported icon, short title, and useful markdown detail. ${NODE_ICON_GUIDANCE}

Every new root, expansion, and reference layer requires a version-1 LayerLayoutObject(placements, edgeShape, edgeRoutes?) with exactly one NodePlacementObject(node, x, y) per member node. Coordinates are normalized numbers from 0 through 1 and express semantic relative position independently of the viewport. Place a one-node layer at (0.5, 0.5). Keep flow or time moving consistently, use a parent or summary node to anchor hierarchy, group related nodes spatially, align comparisons deliberately, and avoid accidental overlap or edge crossings where a clearer arrangement is available. Do not use pixels, window size, or inspector state. Example: const layout = new LayerLayoutObject([new NodePlacementObject(first, 0.25, 0.5), new NodePlacementObject(second, 0.75, 0.5)], "elbow-horizontal"); const layer = new LayerObject([first, second], [edge], layout); a routed loop-back: new LayerLayoutObject(placements, "elbow-horizontal", [{ edge: loopBack, ends: [{ node: last, side: "top" }, { node: first, side: "top" }], waypoints: [{ x: 0.9, y: 0.1 }, { x: 0.1, y: 0.1 }] }]);
${LAYER_EDGE_SHAPE_GUIDANCE}

${ARTIFACT_LAYER_GUIDANCE}

Layer edges are exactly what the user sees and are undirected. Every node needs a supported icon, a short title, and useful markdown detail. Optional action icons must also use a supported Relayer icon name:
${NODE_ICON_GUIDANCE}

Action variants are "chip", "pill", "wide", or "card". A card requires description; other variants do not accept one.

The graph service enforces exact provenance, target visibility, layer size, expansion cycles, and accepted closure. ${graphProgramRepairGuidance(programEditsAvailable(context, graphAuthoringLauncherPath), "If a call fails, read every natural-language issue")} Stable keys make a rerun, whole or edited, update the same drafts instead of creating duplicates when each object's identity-owning context stays unchanged. An action's clientKey is scoped to its source node: keep every draft action on the same source node during repair, because moving it creates a different action and leaves the original draft behind. Do not add fake navigate or reference actions merely to make abandoned draft layers reachable. Only when graph.submit identifies a genuinely abandoned orphan draft, recover with graph.discardLayer(layer); this preserves that layer as stopped history without discarding its nodes, edges, actions, or child layers. A model turn ending is not completion. A successful graph.submit call is required to complete the GraphComplete response, but it does not by itself complete the underlying user task. Do not submit a plan as though it were completed work. Before final submission, verify that requested workspace effects have actually occurred and represent their real results in the graph.`;
}

/** How each harness looks at a preview PNG (PRD §11.10). */
export const CODEX_PREVIEW_VIEWING = "open that PNG with your image viewing tool";
export const CLAUDE_PREVIEW_VIEWING = "call the view_graph_preview tool with that path";

/** Present only when the run supports previews and the host has a renderer (PRD §11.10). */
export function draftPreviewGuidance(howToView: string): string {
  return `Draft previews are on for this run. A successful graph.submitLayer returns an image of the layer as the user will see it, and graph.submitNode returns one for a node with authored detail. The returned object's preview field has a status of rendered, cached, failed, or limit_reached; a rendered or cached preview also has path, width, and height. Print preview.path from your program, then ${howToView} and look at it. Look before your final graph.submit, because graph access ends when it succeeds: run the program without graph.submit first, check the images, then rerun it with the same clientKey values and submit. If you see overlaps, cramped or unreadable nodes, or a layout that doesn't show the real relationships, edit the program and rerun it with the same clientKey values; a changed object returns a fresh image. Controls for actions you have not added yet appear unavailable in a preview; that is expected. The image is advisory: a failed or limit_reached preview never blocks your work.`;
}

/** The host grants a preview folder only when previews are supported and a renderer exists. */
export function draftPreviewsAvailable(context: HarnessRunContext): boolean {
  return context.graph.acquireCapability().previewDirectory !== undefined;
}

function currentWorkspaceMechanicsJs(): string {
  return `Read current with let current = await graph.getCurrent(). The first current layer may contain visible accepted nodes; when no prior current exists, it needs no new draft carrier. When a prior current exists, every later current layer and the root of your final graph.submit must retain a navigation path back to that prior current. Reuse an existing valid path when one already exists; otherwise, after submitting the new layer and before publishing it, add a reference navigate action from one of its draft nodes created for this interaction to current.currentLayerId. Reuse alone grants no action authority; the exact frozen attached-node navigation exception is described above. Give each distinct logical advanceCurrent transition its own stable operation key. Save that transition's exact layer, expected headRevision, and operation key together. Before every Advance, author or retarget the interaction\'s one root navigate/expand action to that candidate layer using its same stable clientKey. All CompletionContract returnRequirements must already be satisfied, including staged attached-node links to that exact response layer. After submitting the complete closure and registering all its actions, publish it with await graph.advanceCurrent(layer, expectedHeadRevision, operationKey). An exact retry reuses all three unchanged. After a successful nonterminal advanceCurrent, refresh with current = await graph.getCurrent() before building the next logical transition, so its revision and backreference use the new current. Use a different stable key for that next transition. A successful terminal graph.submit ends graph access: do not call getCurrent or perform any further graph reads or writes afterward.`;
}

function semanticCompletionGuidanceJs(
  context: HarnessRunContext | undefined,
  completeModuleUrl: string,
  nativeAgentLabel: string,
): string {
  if (context?.completionBroker === undefined) return "";
  return `For explicit semantic child work, author an ordinary single-call invoke action with a stable client key (reusable defaults to false). Set reusable: true only for an explicit repeat-use case, such as comparing different destination inputs; use a separate ordinary action for each independent one-time child. Submit the action and its source Node, then prepare each distinct call with const inputGraph = await graph.prepareComplete(invokeAction, "stable-call-key"); reusing the same call key recovers that call; another key creates an independent Invocation only when the action explicitly permits reuse. One input graph starts exactly one child. Before launching or waiting for this child, author the ordinary response root and Advance your enclosing source Layer so the source Node is accepted; preparation alone does not publish it. Import complete and watchCompletions from ${completeModuleUrl}. Start with const children = [] and launch each child from its own input graph with children.push(complete(inputGraph)). Each handle returns immediately with completionId, current, and result; launch every independent child before watching them. Every change to a child's current is an event you may act on. Create const watch = watchCompletions(children) once. Then run const changes = await watch.changes(); it resolves as soon as any child's current moves or ends, even when that takes minutes. Each change is { child, current }, or { child, error } once the watch can no longer observe that child, for example because its start was refused; the watch then stops watching it. After each event, decide whether the user now needs a better view, for example when a workstream reaches a finding or finishes. Only then submit a later improved layer that presents the work itself and advance your current to it; otherwise keep waiting. You may watch until watch.settled is true and integrate the results, or Return your full response while children remain active. Returning the parent does not stop the children; their graph-owned Invocations and results remain durable. await child.result gives a succeeded child's final layer. A stopped or failed child rejects it with CompletionTerminalError, also exported by that module; catch it and integrate the work its error.current still retains. If child.result rejects with any other error, as it may for a child reported with an error, you cannot read that child's work; present that part as not done, without quoting the error or inventing findings. Native ${nativeAgentLabel} subagents remain inside this completion and do not create semantic children by themselves.\n`;
}

function graphAuthoringCommand(launcher: string | undefined): string {
  if (launcher === undefined) return "node --input-type=module";
  if (!/^\/[A-Za-z0-9._/@+-]+$/.test(launcher)) {
    throw new Error("The graph-authoring launcher must be a shell-safe absolute path.");
  }
  return JSON.stringify(launcher);
}

/** Program edits need the host's folder and the fallback heredoc; the pinned launcher strips the environment and reads no files. */
export function programEditsAvailable(context: HarnessRunContext | undefined, launcher: string | undefined): boolean {
  return launcher === undefined && context?.graph.acquireCapability().programDirectory !== undefined;
}

/** How to repair a failed program: by sending edits to a saved program when the run supports it, else by retyping it. */
export function graphProgramRepairGuidance(editsAvailable: boolean, lead: string): string {
  if (!editsAvailable) return `${lead}, edit the same program and rerun it with the same clientKey values. Preserve the supplied import URL byte for byte and use a single-quoted shell heredoc. For a rejected draft, rebuild fresh objects with the same scoped snapshot/local keys. Rerun graph authoring only after an explicit repairable graph rejection, without repeating completed workspace effects. If submission succeeded, or its response was lost and the outcome is unknown, let the host recover the persisted outcome.`;
  return `${lead}, fix the program and rerun it with the same clientKey values. Prefer a unique exact-match edit for a small fix. Every program prints "graph program id: <id>" when it starts. Through the same heredoc, run a short program that imports rerunGraphProgram from the same module and calls await rerunGraphProgram("<id>", [{ find: "exact text from that program", replace: "fixed text" }]). In that patch heredoc, call rerunGraphProgram directly; do not call RelayerGraphClient.fromEnv(), which would save the patch wrapper under its own id. Each find must match exactly one place in that program; edits apply in order; the edited program runs and prints its own id, which is the one to edit next. A program that crashed before printing an id has no saved copy: rerun it in full. Copy the printed id exactly. Preserve the supplied import URL byte for byte in repairs; use it rather than reconstructing a package or filesystem path. Use a single-quoted shell heredoc so template literals stay intact. If an id or a find does not match, nothing runs and the error says so. Include unique surrounding source context once; if an exact-match patch still cannot apply after a known graph rejection, reconstruct a fresh graph-only draft with the same scoped snapshot/local keys and the supplied import URL. Replay graph authoring only, without repeating completed workspace effects. Rerun only for an explicit repairable graph rejection. If submission succeeded, or its response was lost and the outcome is unknown, do not rerun the program or repeat workspace effects; let the host recover the persisted outcome.`;
}

function pinnedExecutionClause(launcher: string | undefined): string {
  if (launcher === undefined) return "";
  return `In this pinned mode, the launcher heredoc is the only permitted shell action for graph authoring. Do not run sed, rg, cat, find, or any other inspection command through the launcher or from the authored graph program. If the authored program fails, repair it only from the returned error and rerun the same launcher heredoc. This restriction applies only to the graph-authoring path: complete the underlying user task with ordinary Codex workspace tools under the configured permission policy. LayerLayoutObject takes the placements array, the edge shape and an optional array of edge routes, for example new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)], "default"). Its version is already fixed at 1; never pass a version argument and never assign layout.version.`;
}

function traceCodexAppServerNotification(context: HarnessRunContext, method: string, params: unknown, state: CodexTraceState): void {
  rememberGraphAuthoringCommand(state, params);
  const redactedParams = attachCommandExecutableAuthority(
    redactTraceData(redactPersonalPresentationTraceData(
      context,
      params,
      isPersonalPresentationEchoEvent(method, params, state),
    ) as JsonValue),
    params,
  );
  const data = isRecord(redactedParams) ? redactedParams : {};
  const item = isRecord(data.item) ? data.item : undefined;
  const providerEventId = optionalNonemptyString(item?.id);
  context.trace.emit({
    type: "provider.event",
    ...(providerEventId === undefined ? {} : { providerEventId }),
    data: { provider: "codex", method, params: redactedParams },
  });
  try {
    const phase = collaborationNotificationPhase(method);
    if (phase !== undefined && item !== undefined && traceCodexCollaborationItem(context, phase, item, state.collaborationSpans)) return;
  } catch {
    // The raw provider event remains authoritative when a future or malformed shape cannot be normalized.
  }
  if (method === "turn/started") {
    context.trace.emit({ type: "model.call.started", data: { provider: "codex" } });
    return;
  }
  if (method === "turn/completed") {
    closeIncompleteCollaborationSpans(state);
    const turn = isRecord(data.turn) ? data.turn : {};
    const status = turn.status === "completed" ? "completed" : "failed";
    const usage = isRecord(turn.usage) ? turn.usage : isRecord(data.usage) ? data.usage : undefined;
    if (usage !== undefined) context.trace.emit({ type: "usage", data: { provider: "codex", ...usage } });
    context.trace.emit({ type: "model.call.completed", data: { provider: "codex", status } });
    return;
  }
  if (method === "error") {
    const error = isRecord(data.error) ? data.error : {};
    context.trace.emit({ type: "error", data: { provider: "codex", message: String(error.message ?? "Codex turn failed") } });
    return;
  }
  if (method !== "item/completed" || item === undefined) return;
  if (item.type === "agentMessage" && typeof item.text === "string") {
    context.trace.emit({ type: "message", data: { role: "assistant", text: item.text } });
  } else if (item.type === "reasoning" && typeof item.text === "string") {
    context.trace.emit({ type: "reasoning.summary", data: { text: item.text } });
  }
}

function redactPersonalPresentationTraceData(
  context: HarnessRunContext,
  value: unknown,
  includeFragments: boolean,
): unknown {
  const traceValues = personalPresentationTraceValues(context);
  if (traceValues === undefined) return value;
  if (typeof value === "string") {
    const values = includeFragments
      ? [traceValues.exactBlock, ...traceValues.legacyBlocks, ...traceValues.fragments]
      : [traceValues.exactBlock, ...traceValues.legacyBlocks];
    return values.reduce(
      (sanitized, traceValue) => sanitized.split(traceValue).join("[redacted-personal-presentation]"),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((child) => redactPersonalPresentationTraceData(context, child, includeFragments));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    redactPersonalPresentationTraceData(context, child, includeFragments),
  ]));
}

function rememberGraphAuthoringCommand(state: CodexTraceState, params: unknown): void {
  if (!isRecord(params) || !isRecord(params.item)) return;
  const item = params.item;
  const id = optionalNonemptyString(item.id);
  if (id === undefined) return;
  const commands = [
    item.command,
    ...(Array.isArray(item.commandActions)
      ? item.commandActions.flatMap((action) => isRecord(action) ? [action.command] : [])
      : []),
  ];
  if (commands.some((command) => (typeof command === "string" && state.graphAuthoringNodePath !== undefined && command.replaceAll("\\", "/").replaceAll("''", "'").toLowerCase().includes(state.graphAuthoringNodePath.toLowerCase()) && command.includes("--input-type=module"))
    || pinnedGraphAuthoringLauncher(command) !== undefined
    || (state.fallbackGraphAuthoringEnabled && isFallbackGraphAuthoringCommand(command)))) {
    state.graphAuthoringCommandIds.add(id);
  }
}

/** The one fallback command form: a stdin heredoc, whether it carries a full program or edits. */
export function isFallbackGraphAuthoringCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const input = command.trim();
  return /^node[ \t]+--input-type=module[ \t]+<<'RELAYER_GRAPH_PROGRAM'[ \t]*\r?\n/.test(input);
}

function isPersonalPresentationEchoEvent(
  method: string,
  params: unknown,
  state: CodexTraceState,
): boolean {
  const normalizedMethod = normalizeName(method);
  if (normalizedMethod.includes("delta")
    && (normalizedMethod.includes("agentmessage") || normalizedMethod.includes("reasoning"))) {
    return true;
  }
  if (!isRecord(params)) return false;
  const itemId = optionalNonemptyString(params.itemId);
  if (itemId !== undefined && state.graphAuthoringCommandIds.has(itemId)) return true;
  if (!isRecord(params.item) || typeof params.item.type !== "string") return false;
  const providerItemId = optionalNonemptyString(params.item.id);
  if (providerItemId !== undefined && state.graphAuthoringCommandIds.has(providerItemId)) return true;
  return ["agentmessage", "reasoning", "collabtoolcall", "collabagenttoolcall"]
    .includes(normalizeName(params.item.type));
}

function attachCommandExecutableAuthority(redactedParams: JsonValue, rawParams: unknown): JsonValue {
  if (!isRecord(redactedParams) || !isRecord(rawParams)) return redactedParams;
  const redactedItem = isRecord(redactedParams.item) ? redactedParams.item : undefined;
  const rawItem = isRecord(rawParams.item) ? rawParams.item : undefined;
  if (redactedItem?.type !== "commandExecution" || rawItem?.type !== "commandExecution") return redactedParams;
  const redactedActions = Array.isArray(redactedItem.commandActions) ? redactedItem.commandActions : undefined;
  const rawActions = Array.isArray(rawItem.commandActions) ? rawItem.commandActions : undefined;
  if (redactedActions === undefined || rawActions === undefined || redactedActions.length !== rawActions.length) return redactedParams;
  const commandActions = redactedActions.map((redactedAction, index) => {
    if (!isRecord(redactedAction) || !isRecord(rawActions[index])) return redactedAction;
    const {
      relayerExecutableAuthoritySha256: _untrustedExecutable,
      relayerCommandWordAuthoritySha256: _untrustedWords,
      relayerGraphAuthoringLauncherSha256: _untrustedGraphLauncher,
      ...safeAction
    } = redactedAction;
    const graphAuthoringLauncher = pinnedGraphAuthoringLauncher(rawActions[index].command);
    const words = shellCommandWords(rawActions[index].command);
    if (words === undefined) {
      return graphAuthoringLauncher === undefined ? safeAction : {
        ...safeAction,
        relayerGraphAuthoringLauncherSha256: createHash("sha256").update(graphAuthoringLauncher).digest("hex"),
      };
    }
    return {
      ...safeAction,
      ...(words[0]?.startsWith("/") ? {
        relayerExecutableAuthoritySha256: createHash("sha256").update(words[0]).digest("hex"),
      } : {}),
      relayerCommandWordAuthoritySha256: words.map((word) => (
        word.startsWith("/") ? createHash("sha256").update(word).digest("hex") : null
      )),
    };
  });
  return { ...redactedParams, item: { ...redactedItem, commandActions } };
}

function pinnedGraphAuthoringLauncher(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const match = /^("[^"\r\n]+"|\/[A-Za-z0-9._/@+-]+) <<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*\r?\n/.exec(command.trim());
  if (!match) return undefined;
  try {
    const encodedLauncher = match[1] ?? "";
    const launcher = encodedLauncher.startsWith('"') ? JSON.parse(encodedLauncher) : encodedLauncher;
    return typeof launcher === "string" && /^\/[A-Za-z0-9._/@+-]+$/.test(launcher) ? launcher : undefined;
  } catch {
    return undefined;
  }
}

function shellCommandWords(command: unknown): string[] | undefined {
  if (typeof command !== "string" || /[\r\n\0]/.test(command)) return undefined;
  const input = command.trim();
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) return undefined;
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"') {
        index += 1;
        if (index >= input.length) return undefined;
        word += input[index];
      } else {
        word += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else if (character === "\\") {
      index += 1;
      if (index >= input.length) return undefined;
      word += input[index];
      started = true;
    } else if (/[;|&<>(){}!$`*?\[\]#]/.test(character)) {
      return undefined;
    } else {
      word += character;
      started = true;
    }
  }
  if (quote !== undefined) return undefined;
  if (started) words.push(word);
  return words.length > 0 ? words : undefined;
}

function traceCodexCollaborationItem(
  context: HarnessRunContext,
  phase: "started" | "completed",
  itemValue: JsonObject,
  spans: Map<string, HarnessTraceSpan>,
): boolean {
  const item = normalizeCollaborationItem(itemValue);
  if (item === undefined) return false;
  const data = collaborationItemData(item);
  const providerItemId = item.providerItemId;
  if (providerItemId === undefined) {
    context.trace.emit({
      type: phase === "started" ? "tool.call.started" : "tool.call.completed",
      data: { ...data, missingProviderItemId: true },
    });
    return true;
  }
  if (phase === "started") {
    if (spans.has(providerItemId)) return true;
    const span = context.trace.openSpan({
      name: collaborationItemLabel(item.operation),
      kind: "tool",
      providerSpanId: providerItemId,
    });
    spans.set(providerItemId, span);
    span.emit({ type: "tool.call.started", providerEventId: providerItemId, data });
    return true;
  }
  const missingStart = !spans.has(providerItemId);
  const span = spans.get(providerItemId) ?? context.trace.openSpan({
    name: collaborationItemLabel(item.operation),
    kind: "tool",
    providerSpanId: providerItemId,
  });
  if (missingStart) {
    span.emit({
      type: "tool.call.started",
      providerEventId: providerItemId,
      data: { ...data, missingStart: true },
    });
  }
  const terminalStatus: HarnessTraceTerminalStatus = item.status === "failed" ? "failed" : "completed";
  span.emit({
    type: "tool.call.completed",
    providerEventId: providerItemId,
    data: { ...data, ...(missingStart ? { missingStart: true } : {}) },
  });
  span.end(terminalStatus, missingStart ? { missingStart: true } : undefined);
  spans.delete(providerItemId);
  return true;
}

function closeIncompleteCollaborationSpans(state: CodexTraceState): void {
  for (const [providerItemId, span] of state.collaborationSpans) {
    try {
      span.end("partial", { providerItemId, reason: "Codex collaboration operation did not report completion" });
    } catch {
      // Trace finalization is best effort and must not change completion behavior.
    }
  }
  state.collaborationSpans.clear();
}

function normalizeCollaborationItem(value: JsonObject): NormalizedCollaborationItem | undefined {
  const itemType = normalizeName(value.type);
  if (itemType !== "collabtoolcall" && itemType !== "collabagenttoolcall") return undefined;
  const rawOperation = optionalNonemptyString(firstDefined(value, "tool", "operation"));
  if (rawOperation === undefined) return undefined;
  const operation = normalizeCollaborationOperation(rawOperation);
  const providerItemId = optionalNonemptyString(value.id);
  const senderThreadId = optionalNonemptyString(firstDefined(value, "sender_thread_id", "senderThreadId"));
  const receiverThreadIds = optionalStringList(firstDefined(value, "receiver_thread_ids", "receiverThreadIds"));
  const delegationPrompt = optionalPlainString(firstDefined(value, "prompt", "delegation_prompt", "delegationPrompt"));
  const model = optionalNonemptyString(value.model);
  const reasoningEffort = optionalJsonValue(firstDefined(value, "reasoning_effort", "reasoningEffort"));
  const agentStates = optionalAgentStates(firstDefined(value, "agents_states", "agentsStates"));
  const status = normalizeCollaborationStatus(value.status);
  return {
    ...(providerItemId === undefined ? {} : { providerItemId }),
    operation,
    ...(operation === "unknown" ? { providerOperation: rawOperation } : {}),
    ...(senderThreadId === undefined ? {} : { senderThreadId }),
    ...(receiverThreadIds === undefined ? {} : { receiverThreadIds }),
    ...(delegationPrompt === undefined ? {} : { delegationPrompt }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(agentStates === undefined ? {} : { agentStates }),
    ...(status === undefined ? {} : { status }),
  };
}

function collaborationItemData(item: NormalizedCollaborationItem): JsonObject {
  return redactTraceData({
    provider: "codex",
    coordinationOperation: true,
    itemType: "collaboration_operation",
    providerItemId: item.providerItemId,
    operation: item.operation,
    providerOperation: item.providerOperation,
    senderThreadId: item.senderThreadId,
    receiverThreadIds: item.receiverThreadIds,
    delegationPrompt: item.delegationPrompt,
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    agentStates: item.agentStates,
    status: item.status,
  }) as JsonObject;
}

function collaborationNotificationPhase(method: string): "started" | "completed" | undefined {
  const normalized = normalizeName(method);
  if (normalized === "itemstarted") return "started";
  if (normalized === "itemcompleted") return "completed";
  return undefined;
}

function collaborationItemLabel(operation: NormalizedCollaborationItem["operation"]): string {
  return operation === "unknown" ? "Codex collaboration operation" : `Codex ${operation}`;
}

function normalizeCollaborationOperation(value: string): NormalizedCollaborationItem["operation"] {
  const normalized = normalizeName(value);
  if (normalized === "spawnagent") return "spawn_agent";
  if (normalized === "sendinput") return "send_input";
  if (normalized === "resumeagent") return "resume_agent";
  if (normalized === "wait") return "wait";
  if (normalized === "closeagent") return "close_agent";
  return "unknown";
}

function normalizeCollaborationStatus(value: JsonValue | undefined): NormalizedCollaborationItem["status"] | undefined {
  const normalized = normalizeName(value);
  if (normalized === "inprogress") return "in_progress";
  if (normalized === "completed") return "completed";
  if (normalized === "failed") return "failed";
  return undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDefined(value: JsonObject, ...keys: readonly string[]): JsonValue | undefined {
  for (const key of keys) if (value[key] !== undefined) return value[key];
  return undefined;
}

function normalizeName(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() : "";
}

function optionalNonemptyString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalPlainString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalStringList(value: JsonValue | undefined): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function optionalAgentStates(value: JsonValue | undefined): JsonObject | undefined {
  if (!isRecord(value)) return undefined;
  const states: Record<string, JsonValue> = {};
  for (const [agentId, agentState] of Object.entries(value)) {
    if (typeof agentState === "string") {
      states[agentId] = agentState;
      continue;
    }
    if (!isRecord(agentState)) continue;
    const status = optionalNonemptyString(firstDefined(agentState, "status", "state"));
    if (status !== undefined) states[agentId] = { status };
  }
  return states;
}

function optionalJsonValue(value: JsonValue | undefined): JsonValue | undefined {
  return value;
}

function parseCodexBasicConfiguration(context: HarnessFactoryContext): ResolvedCodexConfiguration {
  const selected = context.configuration;
  if (selected.implementation !== CODEX_BASIC_KEY) {
    throw new Error(`codex.basic cannot run implementation ${selected.implementation}`);
  }
  if (selected.implementationVersion !== 1) {
    throw new Error(`Unsupported codex.basic implementation version: ${selected.implementationVersion}`);
  }
  const configuration = selected.settings;
  const allowed = new Set(["model", "modelReasoningEffort", "webSearchMode", "skipGitRepoCheck", "additionalDirectories", "promptProfile", "personalPresentationVersion", "rootSessionMode"]);
  const unknown = Object.keys(configuration).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown codex.basic configuration field: ${unknown.join(", ")}`);

  const model = optionalString(configuration.model, "model");
  const modelReasoningEffort = optionalEnum(configuration.modelReasoningEffort, ["minimal", "low", "medium", "high", "xhigh"] as const, "modelReasoningEffort");
  const webSearchMode = optionalEnum(configuration.webSearchMode, ["disabled", "cached", "live"] as const, "webSearchMode");
  const skipGitRepoCheck = optionalBoolean(configuration.skipGitRepoCheck, "skipGitRepoCheck");
  const additionalDirectories = optionalStringArray(configuration.additionalDirectories, "additionalDirectories");
  const promptProfile = optionalEnum(configuration.promptProfile, ["layered-navigation-v1", "layered-navigation-multi-agent-v1"] as const, "promptProfile");
  const rootSessionMode = optionalEnum(configuration.rootSessionMode, ["resume", "fresh"] as const, "rootSessionMode");
  optionalEnum(configuration.personalPresentationVersion, ["personal-presentation-v0", "personal-presentation-v1", "personal-presentation-v2", "personal-presentation-v3", "personal-presentation-v4"] as const, "personalPresentationVersion");
  const permission = parseCodexPermissionBinding(context.permissionProfileId, context.permissionBinding);

  return {
    settings: {
      ...(model === undefined ? {} : { model }),
      ...(modelReasoningEffort === undefined ? {} : { modelReasoningEffort }),
      ...(webSearchMode === undefined ? {} : { webSearchMode }),
      ...(skipGitRepoCheck === undefined ? {} : { skipGitRepoCheck }),
      ...(additionalDirectories === undefined ? {} : { additionalDirectories }),
      ...(rootSessionMode === undefined ? {} : { rootSessionMode }),
    },
    permission,
    ...(promptProfile === undefined ? {} : { promptProfile }),
  };
}

function parseCodexPermissionBinding(profileId: string, binding: JsonObject): ResolvedCodexPermission {
  const allowed = new Set(["sandboxMode", "approvalPolicy", "approvalsReviewer", "networkAccessEnabled"]);
  const unknown = Object.keys(binding).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown codex.basic permission binding field: ${unknown.join(", ")}`);
  const sandboxMode = optionalEnum(binding.sandboxMode, ["read-only", "workspace-write", "danger-full-access"] as const, "permission sandboxMode");
  const approvalPolicy = optionalEnum(binding.approvalPolicy, ["never", "on-request", "on-failure", "untrusted"] as const, "permission approvalPolicy");
  const approvalsReviewer = optionalEnum(binding.approvalsReviewer, ["user", "auto_review"] as const, "permission approvalsReviewer");
  const networkAccessEnabled = optionalBoolean(binding.networkAccessEnabled, "permission networkAccessEnabled");
  const expected = profileId === "ask"
    ? { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user" } as const
    : profileId === "auto"
      ? { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review" } as const
      : profileId === "full"
        ? { sandboxMode: "danger-full-access", approvalPolicy: "never" } as const
        : undefined;
  if (expected === undefined) throw new Error(`codex.basic does not support permission profile ${profileId}`);
  if (sandboxMode !== expected.sandboxMode || approvalPolicy !== expected.approvalPolicy) {
    throw new Error(`codex.basic permission binding ${profileId} does not match the product profile contract`);
  }
  if (profileId === "full") {
    if (approvalsReviewer !== undefined) throw new Error("codex.basic full permission binding must not configure an approvals reviewer");
    if (networkAccessEnabled !== undefined) throw new Error("codex.basic full permission binding must not claim sandbox network control");
    return { sandboxMode, approvalPolicy };
  }
  const expectedReviewer = profileId === "ask" ? "user" : "auto_review";
  if (approvalsReviewer !== expectedReviewer || networkAccessEnabled === undefined) {
    throw new Error(`codex.basic permission binding ${profileId} does not match the product profile contract`);
  }
  return { sandboxMode, approvalPolicy, approvalsReviewer, networkAccessEnabled };
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`codex.basic ${field} must be a non-empty string`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`codex.basic ${field} must be a boolean`);
  return value;
}

function optionalEnum<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`codex.basic ${field} must be one of: ${allowed.join(", ")}`);
  return value as T[number];
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`codex.basic ${field} must be an array of non-empty strings`);
  }
  return value;
}

export function createCodexBasicFactory(dependencies: CodexBasicDependencies = {}): HarnessFactory {
  return (context) => new CodexBasicHarness(context, dependencies);
}

const CODEX_VISUAL_GUIDANCE = "The following public API recipe demonstrates authoring mechanics only; its placeholder content and layout are not a recommended response design. For visual Node Details: Import the exported html, css, and detailCapability helpers. Before styling, import detailAuthoringReference from the exact supplied module and inspect detailAuthoringReference(); it is generated from the compiler constraints. CSS must be complete rules with braces. Use allowed properties from that reference. Author node.detailAuthoring.setComponent(\"main\", html`<section><h2>Summary</h2><p>Details</p></section>`, css`section { display: grid; gap: 0.75rem; }`); author.write(layer) performs canonical compilation and submission. Use graph.checkpointNodeDetail(node) only for an explicit advisory checkpoint. Each node’s detail must explain that node’s title and purpose. Reuse styles and layout helpers, but do not copy a whole explanation across siblings. If several nodes would have the same explanation, consolidate them. HTML binds permanently on first attachment, including fragments. Create fresh html for each node; wrapping or copying an owned template cannot transfer it. Only node.detailAuthoring authors components. For same-node repair reusing an existing template, call graph.bindNode(original) and graph.bindNode(replacement) before attachment; both must have the same stable client key in this interaction. When a node has actions, create each stable action object with its sourceLayer before checkpointing, bind that same object in the page with the matching detailCapability helper, and let author.write persist the scoped action after its dependencies; use graph.addAction only for specialized low-level declarations. Example with shared styles and distinct content: const common = css`section { padding: 1rem; }`; answer.detailAuthoring.setComponent(\"main\", html`<section><h2>Answer</h2><p>Explain the conclusion.</p></section>`, common); evidence.detailAuthoring.setComponent(\"main\", html`<section><h2>Supporting evidence</h2><p>Explain what supports the conclusion.</p></section>`, common).";

const CODEX_ASSET_GUIDANCE = `For image assets, import assetRef from the supplied clientModuleUrl. Use const scope = await graph.visualAssets.scope(); await graph.visualAssets.listAssets({ scope }); await graph.visualAssets.listTags({ scope }); await graph.visualAssets.inspect(assetId, scope). Register caller-read bytes with await graph.visualAssets.add({ scope, name, file: { name, mediaType, async read() { return bytes; } } }); bind the returned asset.id with html\`<img asset=\${assetRef(asset.id)} alt="Description">\`. The host resolves and pins content. Never supply compiled packages, mounts, hashes, raw image URLs, or executable JavaScript.`;
