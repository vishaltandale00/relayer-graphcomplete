import { threadIconGuidance } from "./thread-icon-guidance.js";
import { PrimeVisualAuthoring, submitPrimeLayer } from "./prime-visual-authoring.js";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type GraphCapability } from "@relayer/graph-client";
import { nativeExecutionHandle, type NativeExecutionHandle } from "../completion-execution.js";
import {
  parseNativeSessionResetReason,
  reportNativeSessionReset,
  type NativeSessionResetReason,
} from "../native-session-reset.js";
import { MAX_HARNESS_APPROVAL_TEXT_LENGTH } from "../approval.js";
import { INTERACTION_INPUT_GUIDANCE, INVOCATION_PUBLICATION_GUIDANCE, SUBCOMPLETION_INTEGRATION_GUIDANCE, renderInteractionInput } from "../interaction-input.js";
import { HarnessApprovalRequestTerminatedError } from "../approval-coordinator.js";
import { redactTraceData } from "../trace.js";
import { createPrimeWorkspaceBoundary } from "./prime-agent-workspace-boundary.js";
import type {
  Harness,
  HarnessAdmittedModelRoute,
  HarnessExecutionAccess,
  HarnessFactory,
  HarnessFactoryContext,
  HarnessRunContext,
  HarnessSessionState,
  HarnessTraceStream,
  HarnessTraceSupport,
  JsonObject,
} from "../types.js";
import { CURRENT_COMMUNICATION_GUIDANCE_PYTHON, CURRENT_WORKSPACE_GUIDANCE, GRAPH_PRESENTATION_GUIDANCE, NODE_ICON_GUIDANCE, currentCommunicationAuthoringRecipePython } from "./graph-presentation-guidance.js";
import { ARTIFACT_LAYER_GUIDANCE_PYTHON } from "./artifact-layer-guidance.js";
import { LAYER_EDGE_SHAPE_GUIDANCE } from "./layer-edge-shape-guidance.js";
import {
  personalPresentationNativeInstructions,
  personalPresentationPrompt,
  personalPresentationTraceValues,
} from "./personal-presentation-guidance.js";

export const PRIME_AGENT_KEY = "prime.agent";

function confinedDescendant(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== "" && fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function resolvedManagedSessionFile(
  privateStateRoot: string,
  managedSessionDir: string,
  savedSessionFile: unknown,
): Promise<string | undefined> {
  const privateStateDetails = await lstat(privateStateRoot).catch(() => null);
  if (!privateStateDetails?.isDirectory() || privateStateDetails.isSymbolicLink()) {
    throw new Error("Managed Prime private state is not an owned directory");
  }
  const sessionDetails = await lstat(managedSessionDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (sessionDetails !== null && (!sessionDetails.isDirectory() || sessionDetails.isSymbolicLink())) {
    throw new Error("Managed Prime session state is not an owned directory");
  }
  if (sessionDetails === null) return undefined;
  const [resolvedPrivateState, resolvedSessions] = await Promise.all([
    realpath(privateStateRoot),
    realpath(managedSessionDir),
  ]);
  if (resolvedSessions !== join(resolvedPrivateState, "sessions")) {
    throw new Error("Managed Prime session state escapes private state");
  }
  if (typeof savedSessionFile !== "string" || !confinedDescendant(managedSessionDir, savedSessionFile)) return undefined;
  try {
    const resolvedFile = await realpath(savedSessionFile);
    if (!confinedDescendant(resolvedSessions, resolvedFile)
      || !(await stat(resolvedFile)).isFile()) return undefined;
    return resolvedFile;
  } catch {
    return undefined;
  }
}

interface PrimeAgentSession {
  readonly agent: { readonly state: { thinkingLevel: string } };
  readonly sessionManager: { appendThinkingLevelChange(level: string): void };
  readonly sessionFile?: string;
  promptAndWait(text: string, options: {
    readonly runContext: PrimeAgentRunContext;
    readonly modelScope: unknown;
    readonly toolAuthorityScope?: unknown;
    readonly kernelBoundaryScope?: unknown;
  }): Promise<void>;
  waitForRlmQuiescence(): Promise<void>;
  abort(): Promise<void>;
  /** Synchronous native teardown: invalidates the session and recursively disposes child sessions. */
  dispose(): void;
  /** Graceful native teardown: drains stateful resources before calling dispose(). */
  disposeAsync?(): Promise<void>;
  subscribe?(listener: (event: unknown) => void): () => void;
  reload?(): Promise<void>;
}

interface PrimeAgentSessionManagerFactory {
  create(cwd: string, sessionDir?: string): unknown;
  open(path: string): unknown;
}

interface PrimeRootTurn {
  readonly forceSignal: AbortSignal | undefined;
  /** Set once the turn is bound to the session its conversation runs on. */
  session: PrimeAgentSession | undefined;
}

/** One native session's own presentation instructions, appended to its system prompt. */
interface PrimeSessionInstructions {
  current: string;
  /** False when the installed package gave the session no resource loader to scope them to. */
  readonly scoped: boolean;
}

interface PrimeAgentSessionHandle {
  readonly session: PrimeAgentSession;
  readonly instructions: PrimeSessionInstructions;
  /** The session holds a root conversation: it was restored from a file, or a root turn ran on it. */
  conversed: boolean;
  readonly nativeDispose: () => void;
  disposeInProgress: boolean;
  disposeCompleted: boolean;
  guardInstalled: boolean;
  disposePromise?: Promise<void>;
}

interface PrimeAgentModule {
  readonly AGENT_RUN_MODEL_SCOPE_VERSION: 1;
  readonly AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION?: 1;
  readonly AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION?: 1;
  readonly SessionManager: PrimeAgentSessionManagerFactory;
  createAgentRunModelScope(input: {
    readonly version: 1;
    readonly root: PrimeAgentModel;
    readonly models: readonly PrimeAgentModel[];
    readonly requestAccess: readonly {
      readonly model: PrimeAgentModel;
      readonly access: PrimeAgentRequestAccess;
    }[];
  }): unknown;
  createAgentRunToolAuthorityScope?(input: {
    readonly version: 1;
    readonly authorize: (request: PrimeAgentToolAuthorizationRequest) => PrimeAgentToolAuthorizationDecision | Promise<PrimeAgentToolAuthorizationDecision>;
  }): unknown;
  createAgentRunKernelBoundaryScope?(input: PrimeAgentKernelBoundaryScopeInput): unknown;
  createHostRequestHandler<RunContext>(implementation: (
    payload: Record<string, unknown>,
    context: { readonly runContext?: RunContext; readonly signal: AbortSignal; isCurrent(): boolean },
  ) => Promise<Record<string, unknown>>): unknown;
  createAgentSessionServices(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  createAgentSessionFromServices(options: Record<string, unknown>): Promise<{ readonly session: PrimeAgentSession }>;
}

export interface PrimeAgentDependencies {
  readonly loadModule?: () => Promise<PrimeAgentModule>;
  readonly resolvePrimeRuntime?: () => Promise<{
    readonly runtimeId: "prime";
    readonly executable: string;
    readonly moduleUrl: string;
    readonly installationRoot: string;
    readonly privateStateRoot: string;
  }>;
  /** Deterministic test seam; production uses the platform workspace boundary. */
  readonly createKernelBoundary?: (input: {
    readonly workspaceRoot: string;
    readonly workspaceScopeDigest: string;
  }) => PrimeAgentKernelBoundaryFactory;
}

async function validateManagedPrivateState(runtime: {
  readonly installationRoot: string;
  readonly privateStateRoot: string;
}): Promise<void> {
  const installation = basename(runtime.installationRoot);
  const managedTargetRoot = dirname(dirname(runtime.installationRoot));
  const expectedPrivateState = join(managedTargetRoot, "private-state", installation);
  const details = await lstat(runtime.privateStateRoot).catch(() => null);
  if (resolve(runtime.privateStateRoot) !== resolve(expectedPrivateState)
    || !details?.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Managed Prime private state is not an owned directory");
  }
  const [resolvedManagedTarget, resolvedPrivateState] = await Promise.all([
    realpath(managedTargetRoot),
    realpath(runtime.privateStateRoot),
  ]);
  if (resolvedPrivateState !== join(resolvedManagedTarget, "private-state", installation)) {
    throw new Error("Managed Prime private state escapes its managed runtime");
  }
  for (const child of ["agent", "sessions"] as const) {
    const childPath = join(runtime.privateStateRoot, child);
    try {
      await mkdir(childPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const childDetails = await lstat(childPath).catch(() => null);
    if (!childDetails?.isDirectory() || childDetails.isSymbolicLink()
      || await realpath(childPath) !== join(resolvedPrivateState, child)) {
      throw new Error(`Managed Prime ${child === "sessions" ? "session" : child} state is not an owned directory`);
    }
  }
}

interface PrimeAgentConfiguration {
  readonly thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly rlmMaxDepth?: number;
  readonly prewarmIpythonKernel?: boolean;
  readonly promptProfile?: "layered-navigation-v1";
}

type PrimeAgentPermission =
  | { readonly profile: "full" }
  | {
      readonly profile: "ask" | "auto";
      readonly boundary: "workspace-write@1";
      readonly reviewer: "user" | "automatic";
      readonly networkAccessEnabled: true;
    };

interface PrimeAgentToolAuthorizationRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly context: {
    readonly executionId: string;
    readonly runContext: unknown;
    readonly recursionDepth: number;
    readonly signal: AbortSignal;
  };
}

type PrimeAgentToolAuthorizationDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason?: string };

interface PrimeAgentKernelBoundaryPolicy {
  readonly filesystem: "workspace-write";
  readonly workspaceRoot: string;
  readonly workspaceScopeDigest: string;
  readonly network: "enabled";
  readonly reviewerMode: "ask" | "automatic";
}

interface PrimeAgentKernelBoundaryEvent {
  readonly phase: "initialized" | "terminal";
  readonly context: {
    readonly executionId: string;
    readonly sessionId: string;
    readonly recursionDepth: number;
    readonly cwd: string;
  };
  readonly policy: PrimeAgentKernelBoundaryPolicy;
  readonly outcome?: "completed" | "failed" | "cancelled";
  readonly cleanup?: "completed" | "failed";
}

interface PrimeAgentKernelBoundaryScopeInput {
  readonly version: 1;
  readonly policy: PrimeAgentKernelBoundaryPolicy;
  readonly prepare: PrimeAgentKernelBoundaryFactory;
  readonly observe: (event: PrimeAgentKernelBoundaryEvent) => void | Promise<void>;
}

interface PrimeAgentKernelBoundaryPrepareRequest {
  readonly executionId: string;
  readonly sessionId: string;
  readonly recursionDepth: number;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

interface PrimeAgentKernelLaunchRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdio?: unknown;
}

interface PrimeAgentKernelBoundaryLease {
  launch(request: PrimeAgentKernelLaunchRequest): unknown;
  dispose(reason: string): void | Promise<void>;
}

type PrimeAgentKernelBoundaryFactory = (
  request: PrimeAgentKernelBoundaryPrepareRequest,
) => PrimeAgentKernelBoundaryLease | Promise<PrimeAgentKernelBoundaryLease>;

interface PrimeAgentRunContext {
  readonly graph: HarnessRunContext["graph"];
  readonly completionBroker?: HarnessRunContext["completionBroker"];
}

interface PrimeAgentRequestAccess {
  readonly kind: "secret";
  readonly contract: "secret@1";
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>>;
}

interface PrimeAgentModel {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly compat?: Readonly<Record<string, unknown>>;
}

interface PrimeAdapterMapping {
  readonly api: string;
  readonly implementationVersion: string;
  readonly compat?: Readonly<Record<string, unknown>>;
}

interface PrimeAgentExecutionScope {
  readonly modelScope: unknown;
  readonly orchestrator: HarnessAdmittedModelRoute;
  readonly routeByNativeModel: ReadonlyMap<string, HarnessAdmittedModelRoute>;
  readonly sensitiveValues: readonly string[];
  readonly presentationTraceValues: ReturnType<typeof personalPresentationTraceValues>;
}

class PrimeAgentSessionLifecycle {
  private forceShutdownStarted = false;
  private gracefullyDisposed = false;
  private gracefulDisposePromise: Promise<void> | undefined;
  private nativeDisposeInProgress = false;
  private nativeDisposeCompleted = false;
  private readonly nativeSessionDispose: () => void;

  constructor(readonly session: PrimeAgentSession) {
    this.nativeSessionDispose = session.dispose.bind(session);
    session.dispose = () => this.disposeNativeOnce();
  }

  dispose(): Promise<void> {
    if (this.gracefulDisposePromise !== undefined) return this.gracefulDisposePromise;
    if (this.nativeDisposeCompleted) return Promise.resolve();
    this.gracefulDisposePromise = Promise.resolve()
      .then(async () => {
        if (this.nativeDisposeCompleted) return;
        if (this.session.disposeAsync !== undefined) await this.session.disposeAsync();
        else if (!this.nativeDisposeCompleted) this.disposeNativeOnce();
        if (!this.nativeDisposeCompleted && this.session.disposeAsync !== undefined) {
          // A conforming disposeAsync drains resources and owns native disposal.
          // Mark the lifecycle terminal even if it does not call the guarded
          // synchronous boundary itself.
          this.nativeDisposeCompleted = true;
        }
        this.gracefullyDisposed = true;
      })
      .catch((error: unknown) => {
        if (!this.nativeDisposeCompleted) throw error;
      });
    return this.gracefulDisposePromise;
  }

  forceShutdown(): void {
    if (this.forceShutdownStarted || this.gracefullyDisposed) return;
    this.forceShutdownStarted = true;
    try {
      void this.session.abort().catch(() => undefined);
    } catch {
      // Force disposal must continue if a nonconforming provider throws
      // synchronously instead of returning a rejected abort promise.
    }
    this.disposeNativeOnce();
  }

  private disposeNativeOnce(): void {
    if (this.nativeDisposeInProgress || this.nativeDisposeCompleted) return;
    this.nativeDisposeInProgress = true;
    try {
      this.nativeSessionDispose();
      this.nativeDisposeCompleted = true;
    } finally {
      this.nativeDisposeInProgress = false;
    }
  }
}

/**
 * One turn's force-stop. The turn binds the one native session it runs on; when the host's
 * force signal fires, only that session is stopped and the turn stops waiting for it.
 */
class PrimeTurnForceStop {
  private stopSession: (() => void) | undefined;
  private readonly detachStop: () => void;

  constructor(private readonly signal: AbortSignal | undefined) {
    const stop = () => this.stop();
    signal?.addEventListener("abort", stop, { once: true });
    this.detachStop = () => signal?.removeEventListener("abort", stop);
  }

  /**
   * Binds the session this turn is about to run on. A turn force-stopped before then does
   * not run. It stops a session only this turn owns (an invoked child's), so that session is
   * not left to a graceful disposal that may stall. It never stops the shared root session:
   * a later root turn may already be using it.
   */
  bind(stopSession: () => void, ownedByTurn: boolean): void {
    if (this.signal?.aborted) {
      if (ownedByTurn) {
        this.stopSession = stopSession;
        this.stop();
      }
      this.signal.throwIfAborted();
    }
    this.stopSession = stopSession;
  }

  /** Settles with the execution, or as soon as the force-stop fires; a later settlement is ignored. */
  race(execution: Promise<void>): Promise<void> {
    void execution.catch(() => undefined);
    const signal = this.signal;
    if (signal === undefined) return execution;
    let detachRace = () => {};
    const forced = new Promise<never>((_resolve, reject) => {
      const onForce = () => reject(signal.reason);
      if (signal.aborted) {
        onForce();
        return;
      }
      signal.addEventListener("abort", onForce, { once: true });
      detachRace = () => signal.removeEventListener("abort", onForce);
    });
    return Promise.race([execution, forced]).finally(() => {
      detachRace();
      this.detachStop();
    });
  }

  private stop(): void {
    const stopSession = this.stopSession;
    this.stopSession = undefined;
    try {
      stopSession?.();
    } catch {
      // Best effort: the turn still stops waiting, and the host releases its access.
    }
  }
}

const PRIME_ADAPTERS: Readonly<Record<string, PrimeAdapterMapping>> = Object.freeze({
  "openai-api": Object.freeze({ api: "openai-responses", implementationVersion: "2" }),
  "anthropic-api": Object.freeze({ api: "anthropic-messages", implementationVersion: "2" }),
  openrouter: Object.freeze({ api: "openai-completions", implementationVersion: "2", compat: Object.freeze({ thinkingFormat: "openrouter", openRouterRouting: Object.freeze({}) }) }),
  "vercel-ai-router": Object.freeze({ api: "openai-completions", implementationVersion: "2", compat: Object.freeze({ vercelGatewayRouting: Object.freeze({}) }) }),
});

export class PrimeAgentHarness implements Harness {
  readonly supportsInvokedComplete = true;
  /** An invoked child runs in its own session; a root turn's force-stop replaces the root session. */
  readonly supportsForceStop = true;
  private forceShutdownStarted = false;
  private gracefullyDisposed = false;
  private gracefulDisposePromise: Promise<void> | undefined;
  private rootHistoryAvailable = false;
  private readonly invokedSessions = new Set<PrimeAgentSessionLifecycle>();
  private readonly pendingInvokedSessions = new Set<Promise<PrimeAgentSessionLifecycle>>();
  private sessionHandle: PrimeAgentSessionHandle | undefined;
  private sessionPersonalPresentationVersionId: number | null | undefined;
  /**
   * Root turns acquire the root session one at a time. A force-stopped root turn stops
   * waiting at once, so its acquisition may still run when the next root turn starts.
   */
  private pendingRootSessionAcquisition: Promise<void> | undefined;
  /**
   * Advances when a root turn is force-stopped before it bound a session. Its acquisition may
   * never settle; a late result from an older generation is discarded rather than installed.
   */
  private rootSessionGeneration = 0;
  /**
   * Root turns in flight, with the session each one's conversation runs on once bound. Force
   * shutdown forgets the root session only when a bound turn's conversation runs on it. A turn
   * still acquiring its session wrote nothing, and a turn already force-stopped dropped its
   * session then, even while its native work has not settled.
   */
  private readonly activeRootTurns = new Set<PrimeRootTurn>();

  private constructor(
    private readonly context: HarnessFactoryContext,
    private readonly primeAgent: PrimeAgentModule,
    private readonly permission: PrimeAgentPermission,
    private readonly workspaceRoot: string,
    private readonly createKernelBoundary: PrimeAgentDependencies["createKernelBoundary"],
    private readonly createSession: (sessionManager: unknown, instructions: string) => Promise<PrimeAgentSessionHandle>,
    private readonly createSessionManager: () => unknown,
    private resumableSessionFile: string | undefined,
    savedPresentationVersionId: number | null | undefined,
    private pendingRootReset: NativeSessionResetReason | undefined,
    sessionHandle?: PrimeAgentSessionHandle,
  ) {
    this.sessionHandle = sessionHandle;
    this.rootHistoryAvailable = resumableSessionFile !== undefined;
    this.sessionPersonalPresentationVersionId = savedPresentationVersionId;
  }

  static async create(context: HarnessFactoryContext, dependencies: PrimeAgentDependencies = {}): Promise<PrimeAgentHarness> {
    const configuration = parsePrimeAgentConfiguration(context);
    const permission = parsePrimeAgentPermission(context);
    const managedRuntime = await dependencies.resolvePrimeRuntime?.();
    if (managedRuntime) await validateManagedPrivateState(managedRuntime);
    const primeAgent = await (dependencies.loadModule
      ?? (managedRuntime ? () => import(managedRuntime.moduleUrl) as Promise<PrimeAgentModule> : loadPrimeAgentModule))();
    requirePrimePermissionRuntime(permission, primeAgent);
    const workspaceRoot = permission.profile === "full"
      ? context.workingDirectory
      : await realpath(context.workingDirectory);
    const graphCurrent = primeAgent.createHostRequestHandler<PrimeAgentRunContext>(async (_payload, invocation) => {
      if (!invocation.isCurrent() || invocation.signal.aborted) throw new Error("The graph run is no longer active");
      const run = invocation.runContext;
      if (run === undefined) throw new Error("relayer.graph.current requires an active GraphComplete run");
      return capabilityResponse(run.graph.acquireCapability());
    });
    const visualRuns = new WeakMap<PrimeAgentRunContext, PrimeVisualAuthoring>();
    const visualAuthoring = primeAgent.createHostRequestHandler<PrimeAgentRunContext>(async (payload, invocation) => {
      const active = () => {
        if (!invocation.isCurrent() || invocation.signal.aborted) throw new Error("The graph run is no longer active");
        if (invocation.runContext === undefined) throw new Error("Visual authoring requires an active GraphComplete run");
        invocation.runContext.graph.acquireCapability();
      };
      active();
      const run = invocation.runContext!;
      let authoring = visualRuns.get(run);
      if (authoring === undefined) {
        authoring = new PrimeVisualAuthoring();
        visualRuns.set(run, authoring);
      }
      // Prime adds transport metadata to every IPython host request. Keep the
      // authoring schema strict after removing only these native envelope fields.
      const { type: _requestType, cellSourceCode: _cellSourceCode, ...program } = payload;
      return authoring.execute(program, run.graph.acquireCapability(), active, invocation.signal);
    });
    const completeCurrent = primeAgent.createHostRequestHandler<PrimeAgentRunContext>(async (_payload, invocation) => {
      if (!invocation.isCurrent() || invocation.signal.aborted) throw new Error("The completion run is no longer active");
      const broker = invocation.runContext?.completionBroker;
      if (broker === undefined) throw new Error("relayer.complete.current requires an active completion broker");
      return Object.freeze({ url: broker.url, token: broker.token });
    });
    const submitLayer = primeAgent.createHostRequestHandler<PrimeAgentRunContext>(async (payload, invocation) => {
      const active = () => {
        if (!invocation.isCurrent() || invocation.signal.aborted) throw new Error("The graph run is no longer active");
        if (invocation.runContext === undefined) throw new Error("Layer submission requires an active GraphComplete run");
        invocation.runContext.graph.acquireCapability();
      };
      active();
      const run = invocation.runContext!;
      const { type: _requestType, cellSourceCode: _cellSourceCode, ...program } = payload;
      return submitPrimeLayer(program, run.graph.acquireCapability(), active, invocation.signal);
    });
    const savedSessionFile = context.savedState?.primeAgentSessionFile;
    const savedPresentationVersionId = context.savedState?.primeAgentSessionPersonalPresentationVersionId;
    const validSavedPresentationVersion = savedPresentationVersionId === undefined
      || savedPresentationVersionId === null
      || (typeof savedPresentationVersionId === "number"
        && Number.isSafeInteger(savedPresentationVersionId)
        && savedPresentationVersionId > 0);
    const parsedSavedPresentationVersionId: number | null | undefined = validSavedPresentationVersion
      && (savedPresentationVersionId === null || typeof savedPresentationVersionId === "number")
      ? savedPresentationVersionId
      : undefined;
    const managedAgentDir = managedRuntime ? join(managedRuntime.privateStateRoot, "agent") : undefined;
    const managedSessionDir = managedRuntime ? join(managedRuntime.privateStateRoot, "sessions") : undefined;
    const services = await primeAgent.createAgentSessionServices({
      cwd: workspaceRoot,
      telemetryDisabled: true,
      ...(managedRuntime ? {
        agentDir: managedAgentDir,
        managedKernel: { version: 1, pythonExecutable: managedRuntime.executable },
      } : {}),
      resourceLoaderOptions: {
        // Native discovery walks to filesystem root. A selected workspace must
        // not inherit instructions from the app's storage/development ancestors.
        agentsFilesOverride: (input: { agentsFiles: { path: string; content: string }[] }) => ({
          agentsFiles: input.agentsFiles.filter((file) => {
            try {
              const canonicalFile = realpathSync(file.path);
              return confinedDescendant(realpathSync(workspaceRoot), canonicalFile)
                || (managedAgentDir !== undefined
                  && confinedDescendant(realpathSync(managedAgentDir), canonicalFile));
            } catch { return false; }
          }),
        }),
      },
    });
    const prewarmIpythonKernel = permission.profile === "full"
      ? configuration.prewarmIpythonKernel
      : false;
    // The services, and so their resource loader, are shared by every session. Each session
    // reads its own presentation instructions through its own view of that loader, so a root
    // rotation or an invoked child never builds from another interaction's instructions.
    const createSession = async (sessionManager: unknown, initialInstructions: string): Promise<PrimeAgentSessionHandle> => {
      const scoped = sessionScopedServices(services, initialInstructions);
      const { session } = await primeAgent.createAgentSessionFromServices({
        services: scoped.services,
        sessionManager,
        tools: ["ipython"],
        hostRequestHandlers: {
          "relayer.graph.current": graphCurrent,
          "relayer.graph.visual-authoring": visualAuthoring,
          "relayer.graph.submit-layer": submitLayer,
          "relayer.complete.current": completeCurrent,
        },
        telemetryDisabled: true,
        ...(configuration.thinkingLevel === undefined ? {} : { thinkingLevel: configuration.thinkingLevel }),
        ...(configuration.rlmMaxDepth === undefined ? {} : { rlmMaxDepth: configuration.rlmMaxDepth }),
        ...(prewarmIpythonKernel === undefined ? {} : { prewarmIpythonKernel }),
      });
      // The SDK clamps this setting against its absent ambient model during
      // construction. Restore the harness preference only; each run still owns
      // its selected model, whose capability gates the outgoing provider payload.
      if (configuration.thinkingLevel !== undefined) {
        if (session.agent?.state === undefined || typeof session.sessionManager?.appendThinkingLevelChange !== "function") {
          session.dispose();
          throw new Error("Installed Prime Agent package does not expose thinking configuration");
        }
        if (session.agent.state.thinkingLevel !== configuration.thinkingLevel) {
          session.agent.state.thinkingLevel = configuration.thinkingLevel;
          session.sessionManager.appendThinkingLevelChange(configuration.thinkingLevel);
        }
      }
      if (typeof session.waitForRlmQuiescence !== "function") {
        session.dispose();
        throw new Error("Installed Prime Agent package does not expose recursive quiescence");
      }
      return primeSessionHandle(session, scoped.instructions);
    };
    const confinedSavedSessionFile = managedSessionDir === undefined
      ? (typeof savedSessionFile === "string" ? savedSessionFile : undefined)
      : (typeof savedSessionFile === "string"
        ? await resolvedManagedSessionFile(managedRuntime!.privateStateRoot, managedSessionDir, savedSessionFile)
        : undefined);
    const restorableSessionFile = parsedSavedPresentationVersionId !== undefined
      ? confinedSavedSessionFile
      : undefined;
    if (typeof savedSessionFile === "string" && restorableSessionFile === undefined) throw new Error("Legacy native history cannot be safely restored; its saved state was preserved.");
    const createSessionManager = () => managedSessionDir === undefined
      ? primeAgent.SessionManager.create(workspaceRoot)
      : primeAgent.SessionManager.create(workspaceRoot, managedSessionDir);
    const initialSessionManager = restorableSessionFile === undefined
      ? createSessionManager()
      : primeAgent.SessionManager.open(restorableSessionFile);
    // A restored session learns its instructions from its first root turn, which reloads it.
    const initialSession = await createSession(initialSessionManager, "");
    initialSession.conversed = restorableSessionFile !== undefined;
    const pendingRootReset = typeof savedSessionFile === "string" && restorableSessionFile === undefined
      ? "session_unavailable"
      : parseNativeSessionResetReason(context.savedState?.primeRootResetReason);
    return new PrimeAgentHarness(
      context,
      primeAgent,
      permission,
      workspaceRoot,
      dependencies.createKernelBoundary,
      createSession,
      createSessionManager,
      restorableSessionFile,
      restorableSessionFile === undefined ? undefined : parsedSavedPresentationVersionId,
      pendingRootReset,
      initialSession,
    );
  }

  complete(context: HarnessRunContext, signal?: AbortSignal): NativeExecutionHandle {
    if (signal?.aborted) return nativeExecutionHandle(Promise.reject(signal.reason));
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new Error("Prime Agent completion was cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    const forceStop = new PrimeTurnForceStop(context.forceSignal);
    if (context.origin.kind === "root") {
      const execution = forceStop.race(this.executeRoot(context, controller.signal, forceStop))
        .finally(() => signal?.removeEventListener("abort", abort));
      return nativeExecutionHandle(execution, (reason) => controller.abort(new Error(reason)));
    }
    let resolveAttached!: (identity: JsonObject) => void;
    let rejectAttached!: (error: unknown) => void;
    const attached = new Promise<JsonObject>((resolve, reject) => {
      resolveAttached = resolve;
      rejectAttached = reject;
    });
    const execution = forceStop.race(this.executeInvoked(context, resolveAttached, controller.signal, forceStop))
      .finally(() => signal?.removeEventListener("abort", abort));
    void execution.catch(rejectAttached);
    return nativeExecutionHandle(
      execution,
      (reason) => controller.abort(new Error(reason)),
      attached,
    );
  }

  private async executeRoot(context: HarnessRunContext, signal: AbortSignal, forceStop: PrimeTurnForceStop): Promise<void> {
    const turn: PrimeRootTurn = { forceSignal: context.forceSignal, session: undefined };
    this.activeRootTurns.add(turn);
    try {
      await this.executeRootTurn(context, signal, forceStop, turn);
    } finally {
      this.activeRootTurns.delete(turn);
    }
  }

  private async executeRootTurn(
    context: HarnessRunContext,
    signal: AbortSignal,
    forceStop: PrimeTurnForceStop,
    turn: PrimeRootTurn,
  ): Promise<void> {
    // Until this turn binds a session, a force-stop abandons its acquisition, which may hang in
    // reload(), disposeAsync() or session creation. A turn already force-stopped starts none.
    const generation = this.rootSessionGeneration;
    forceStop.bind(() => this.abandonRootSessionAcquisition(generation), false);
    const previous = this.pendingRootSessionAcquisition;
    const candidate = previous === undefined
      ? this.sessionFor(context)
      : previous.then(() => this.sessionFor(context));
    if (candidate instanceof Promise) {
      const acquired = candidate.then(() => undefined, () => undefined);
      this.pendingRootSessionAcquisition = acquired;
      void acquired.then(() => {
        if (this.pendingRootSessionAcquisition === acquired) this.pendingRootSessionAcquisition = undefined;
      });
    }
    const session = candidate instanceof Promise ? await candidate : candidate;
    const handle = this.sessionHandle?.session === session ? this.sessionHandle : undefined;
    turn.session = session;
    if (handle !== undefined) {
      // A new session that replaces a previous root conversation says so before it runs.
      if (!handle.conversed && this.pendingRootReset !== undefined) {
        reportNativeSessionReset(context, "Prime Agent", this.context.threadId, this.pendingRootReset);
      }
      this.pendingRootReset = undefined;
      handle.conversed = true;
    }
    forceStop.bind(() => {
      if (handle !== undefined) this.forceStopRootSession(handle);
      else void session.abort().catch(() => undefined);
    }, false);
    if (signal.aborted) {
      await session.abort();
      signal.throwIfAborted();
    }
    await this.executeOn(session, context, signal);
    this.rootHistoryAvailable = true;
  }

  private async executeInvoked(
    context: HarnessRunContext,
    attach: (identity: JsonObject) => void,
    signal: AbortSignal,
    forceStop: PrimeTurnForceStop,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.forceShutdownStarted) throw new Error("Prime Agent harness is shutting down");
    // A child session gets its own interaction's instructions, never the root session's.
    const instructions = personalPresentationNativeInstructions(context);
    const pending = this.createSession(this.createSessionManager(), instructions).then(({ session }) => {
      const lifecycle = new PrimeAgentSessionLifecycle(session);
      this.invokedSessions.add(lifecycle);
      if (this.forceShutdownStarted) lifecycle.forceShutdown();
      return lifecycle;
    });
    this.pendingInvokedSessions.add(pending);
    let lifecycle: PrimeAgentSessionLifecycle;
    try {
      lifecycle = await pending;
      attach(primeSessionAttachment(lifecycle.session));
    } finally {
      this.pendingInvokedSessions.delete(pending);
    }
    let executionOutcome: OperationOutcome<void> | undefined;
    let disposalOutcome: OperationOutcome<void> | undefined;
    try {
      executionOutcome = this.forceShutdownStarted
        ? { ok: false, error: new Error("Prime Agent harness is shutting down") }
        : await operationOutcome(() => {
          // A force-stop ends this child's own session only: never the root or a sibling.
          forceStop.bind(() => lifecycle.forceShutdown(), true);
          return this.executeOn(lifecycle.session, context, signal);
        });
    } finally {
      disposalOutcome = await operationOutcome(() => lifecycle.dispose());
      this.invokedSessions.delete(lifecycle);
    }
    const failures = [executionOutcome, disposalOutcome]
      .flatMap((outcome) => outcome !== undefined && !outcome.ok ? [outcome.error] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Prime Agent invoked execution or disposal failed");
  }

  private async executeOn(session: PrimeAgentSession, context: HarnessRunContext, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.throwIfShuttingDown();
    const execution = createPrimeAgentModelScope(context, this.primeAgent);
    const runContext: PrimeAgentRunContext = Object.freeze({
      graph: context.graph,
      ...(context.completionBroker === undefined ? {} : { completionBroker: context.completionBroker }),
    });
    const permissions = createPrimeAgentPermissionScopes({
      context,
      runContext,
      primeAgent: this.primeAgent,
      permission: this.permission,
      workspaceRoot: this.workspaceRoot,
      createKernelBoundary: this.createKernelBoundary,
    });
    const childStreams = new Map<string, HarnessTraceStream>();
    const unsubscribe = session.subscribe?.((event) => tracePrimeEvent(context, event, childStreams, execution));
    const runtimeProvenance = primeRuntimeProvenance(process.env.RELAYER_PRIME_RUNTIME_PROVENANCE);
    if (runtimeProvenance) context.trace.emit({
      type: "provider.event",
      data: { provider: "prime-agent", event: { type: "runtime.provenance", ...runtimeProvenance } },
    });
    const prompt = this.prompt(context);
    context.trace.emit({
      type: "prompt",
      data: { text: this.prompt(context, false), interactionNodeId: context.inputGraph.id },
    });
    let abortOutcome: Promise<OperationOutcome<void>> | undefined;
    const abort = () => {
      if (abortOutcome !== undefined) return;
      abortOutcome = operationOutcome(() => session.abort());
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let promptOutcome: OperationOutcome<void> | undefined;
    let quiescenceOutcome: OperationOutcome<void> | undefined;
    let settledAbort: OperationOutcome<void> | undefined;
    try {
      if (signal?.aborted) {
        settledAbort = await abortOutcome;
        if (settledAbort !== undefined && !settledAbort.ok) throw settledAbort.error;
        signal.throwIfAborted();
      }
      promptOutcome = await operationOutcome(() => session.promptAndWait(prompt, {
        runContext,
        modelScope: execution.modelScope,
        ...permissions,
      }));
      quiescenceOutcome = await operationOutcome(() => session.waitForRlmQuiescence());
      signal?.removeEventListener("abort", abort);
      settledAbort = await abortOutcome;
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe?.();
      for (const stream of childStreams.values()) stream.close("partial", { reason: "Prime Agent stopped reporting this child" });
    }
    const failures = [promptOutcome, quiescenceOutcome, settledAbort]
      .flatMap((outcome) => outcome !== undefined && !outcome.ok ? [outcome.error] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Prime Agent prompt, quiescence, or abort failed");
  }

  traceSupport(): HarnessTraceSupport {
    return {
      prompt: "full",
      messages: "full",
      reasoningSummaries: "none",
      modelCalls: "summary",
      toolCalls: "full",
      usage: "full",
      childStreams: "summary",
      nativeArtifacts: "none",
    };
  }

  state(): HarnessSessionState {
    const sessionFile = this.sessionHandle?.session.sessionFile;
    const reset = this.pendingRootReset === undefined ? {} : { primeRootResetReason: this.pendingRootReset };
    return sessionFile === undefined || this.sessionPersonalPresentationVersionId === undefined
      ? reset
      : {
          primeAgentSessionFile: sessionFile,
          primeAgentSessionPersonalPresentationVersionId: this.sessionPersonalPresentationVersionId,
          ...reset,
        };
  }

  dispose(): Promise<void> {
    if (this.gracefulDisposePromise !== undefined) return this.gracefulDisposePromise;
    this.gracefulDisposePromise = Promise.resolve()
      .then(async () => {
        await Promise.allSettled([...this.pendingInvokedSessions]);
        const childOutcomes = await Promise.allSettled(
          [...this.invokedSessions].map((lifecycle) => lifecycle.dispose()),
        );
        const childFailures = childOutcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
        const rootOutcome = await operationOutcome(async () => {
          if (this.sessionHandle !== undefined) await this.disposeSession(this.sessionHandle);
        });
        const failures = [
          ...childFailures,
          ...(rootOutcome.ok ? [] : [rootOutcome.error]),
        ];
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Prime Agent session disposal failed");
        this.gracefullyDisposed = true;
      });
    return this.gracefulDisposePromise;
  }

  forceShutdown(): void {
    if (this.forceShutdownStarted || this.gracefullyDisposed) return;
    this.forceShutdownStarted = true;
    for (const lifecycle of this.invokedSessions) lifecycle.forceShutdown();
    for (const pending of this.pendingInvokedSessions) {
      void pending.then((lifecycle) => lifecycle.forceShutdown(), () => undefined);
    }
    const handle = this.sessionHandle;
    if (handle !== undefined && [...this.activeRootTurns].some((turn) => (
      turn.session === handle.session && turn.forceSignal?.aborted !== true
    ))) {
      // A root turn's conversation is killed mid-run, as by a per-turn force-stop: the host
      // records that the next root turn, after a restart, starts a fresh session.
      this.sessionHandle = undefined;
      this.sessionPersonalPresentationVersionId = undefined;
      this.resumableSessionFile = undefined;
      this.pendingRootReset = "force_stopped";
    }
    if (handle === undefined) return;
    this.installNativeDisposeGuard(handle);
    try {
      void handle.session.abort().catch(() => undefined);
    } catch {
      // Force disposal must continue even if a nonconforming provider throws
      // synchronously instead of returning a rejected abort promise.
    }
    this.disposeNativeOnce(handle);
  }

  /**
   * Force-stops the root session a cancelled root turn is stuck in. Invoked children run in
   * their own sessions and keep running. The stopped session may still write its session
   * file, so the next root turn starts a fresh native session instead of resuming it.
   */
  private forceStopRootSession(handle: PrimeAgentSessionHandle): void {
    if (this.sessionHandle === handle) {
      this.sessionHandle = undefined;
      this.sessionPersonalPresentationVersionId = undefined;
      this.resumableSessionFile = undefined;
      if (handle.conversed) this.pendingRootReset = "force_stopped";
    }
    this.installNativeDisposeGuard(handle);
    try {
      void handle.session.abort().catch(() => undefined);
    } catch {
      // Force disposal continues if a nonconforming provider throws synchronously.
    }
    this.disposeNativeOnce(handle);
  }

  /**
   * Abandons a root session acquisition a force-stopped turn left behind. Successors no longer
   * wait for it. The root session it was working on may be half-reloaded or half-disposed, so
   * it is force-disposed and the next root turn starts a fresh native session.
   */
  private abandonRootSessionAcquisition(generation: number): void {
    if (this.rootSessionGeneration !== generation) return;
    this.rootSessionGeneration += 1;
    this.pendingRootSessionAcquisition = undefined;
    const handle = this.sessionHandle;
    if (handle !== undefined) this.forceStopRootSession(handle);
    if (this.resumableSessionFile !== undefined) this.pendingRootReset = "force_stopped";
    this.sessionPersonalPresentationVersionId = undefined;
    this.resumableSessionFile = undefined;
  }

  private throwIfRootAcquisitionAbandoned(generation: number): void {
    if (this.rootSessionGeneration !== generation) throw new Error("Prime Agent root session acquisition was abandoned");
  }

  private sessionFor(context: HarnessRunContext): PrimeAgentSession | Promise<PrimeAgentSession> {
    this.throwIfShuttingDown();
    const versionId = context.personalPresentation?.attachment.versionInteractionNodeId ?? null;
    if (context.requireNativeContinuity && (!this.rootHistoryAvailable || (this.sessionPersonalPresentationVersionId !== undefined && this.sessionPersonalPresentationVersionId !== versionId))) {
      throw new Error("This conversation's native history is unavailable or incompatible. Its saved history was preserved; a fresh session was not started.");
    }
    const instructions = personalPresentationNativeInstructions(context);
    if (this.sessionHandle !== undefined
      && this.sessionPersonalPresentationVersionId === versionId) {
      if (instructions === this.sessionHandle.instructions.current) return this.sessionHandle.session;
      return this.reloadPresentationInstructions(this.sessionHandle, versionId, instructions);
    }
    if (this.sessionHandle !== undefined
      && this.sessionPersonalPresentationVersionId === undefined) {
      if (instructions === this.sessionHandle.instructions.current) {
        this.sessionPersonalPresentationVersionId = versionId;
        return this.sessionHandle.session;
      }
      return this.reloadPresentationInstructions(this.sessionHandle, versionId, instructions);
    }
    if (context.requireNativeContinuity && this.resumableSessionFile === undefined) throw new Error("This conversation has no resumable native history. Its saved history was preserved.");
    return this.rotateSession(context, versionId);
  }

  private reloadPresentationInstructions(
    handle: PrimeAgentSessionHandle,
    versionId: number | null,
    instructions: string,
  ): Promise<PrimeAgentSession> {
    const { session } = handle;
    const reload = session.reload;
    if (reload === undefined || (!handle.instructions.scoped && instructions !== "")) {
      throw new Error("Installed Prime Agent package cannot refresh interaction-scoped presentation instructions");
    }
    const generation = this.rootSessionGeneration;
    const previousInstructions = handle.instructions.current;
    handle.instructions.current = instructions;
    return reload.call(session).then(() => {
      this.throwIfRootAcquisitionAbandoned(generation);
      this.sessionPersonalPresentationVersionId = versionId;
      return session;
    }, (error: unknown) => {
      this.throwIfRootAcquisitionAbandoned(generation);
      handle.instructions.current = previousInstructions;
      throw error;
    });
  }

  private async rotateSession(
    context: HarnessRunContext,
    versionId: number | null,
  ): Promise<PrimeAgentSession> {
    this.throwIfShuttingDown();
    const generation = this.rootSessionGeneration;
    const previousHandle = this.sessionHandle;
    if (previousHandle !== undefined) await this.disposeSession(previousHandle);
    this.throwIfShuttingDown();
    this.throwIfRootAcquisitionAbandoned(generation);
    if (this.sessionHandle === previousHandle) this.sessionHandle = undefined;
    const resumeSavedSession = this.resumableSessionFile !== undefined
      && this.sessionPersonalPresentationVersionId === versionId;
    // Rotating away from a root conversation cannot continue it; the new session reports why.
    const reset: NativeSessionResetReason | undefined = resumeSavedSession
      ? undefined
      : this.pendingRootReset
        ?? (previousHandle?.conversed === true || this.resumableSessionFile !== undefined ? "presentation_changed" : undefined);
    const sessionManager = resumeSavedSession
      ? this.primeAgent.SessionManager.open(this.resumableSessionFile!)
      : this.createSessionManager();
    const replacement = await this.createSession(sessionManager, personalPresentationNativeInstructions(context));
    const { session } = replacement;
    if (this.rootSessionGeneration !== generation) {
      // A successor already runs on its own fresh session; never install or reuse this one.
      this.installNativeDisposeGuard(replacement);
      this.disposeNativeOnce(replacement);
      throw new Error("Prime Agent root session acquisition was abandoned");
    }
    if (this.isShuttingDown()) {
      await this.disposeSession(replacement);
      throw new Error("Prime Agent harness is shutting down");
    }
    this.sessionHandle = replacement;
    this.sessionPersonalPresentationVersionId = versionId;
    replacement.conversed = resumeSavedSession;
    this.pendingRootReset = reset;
    return session;
  }

  private async disposeSession(handle: PrimeAgentSessionHandle): Promise<void> {
    if (handle.disposePromise !== undefined) return handle.disposePromise;
    handle.disposePromise = Promise.resolve().then(async () => {
      if (handle.disposeCompleted) return;
      this.installNativeDisposeGuard(handle);
      if (handle.session.disposeAsync !== undefined) await handle.session.disposeAsync();
      else this.disposeNativeOnce(handle);
      if (!handle.disposeCompleted) handle.disposeCompleted = true;
    }).catch((error: unknown) => {
      if (!handle.disposeCompleted) throw error;
    });
    return handle.disposePromise;
  }

  private isShuttingDown(): boolean {
    return this.forceShutdownStarted || this.gracefulDisposePromise !== undefined;
  }

  private throwIfShuttingDown(): void {
    if (this.isShuttingDown()) throw new Error("Prime Agent harness is shutting down");
  }

  private installNativeDisposeGuard(handle: PrimeAgentSessionHandle): void {
    if (handle.guardInstalled) return;
    handle.guardInstalled = true;
    handle.session.dispose = () => this.disposeNativeOnce(handle);
  }

  private disposeNativeOnce(handle: PrimeAgentSessionHandle): void {
    if (handle.disposeInProgress || handle.disposeCompleted) return;
    handle.disposeInProgress = true;
    try {
      handle.nativeDispose();
      handle.disposeCompleted = true;
    } finally {
      handle.disposeInProgress = false;
    }
  }

  private prompt(context: HarnessRunContext, includePersonalPresentation = true): string {
    const interaction = context.inputGraph;
    if (this.context.configuration.settings.promptProfile === "layered-navigation-v1") {
      return this.layeredNavigationPrompt(context, includePersonalPresentation);
    }
    return `While doing the underlying work, publish useful findings through current; finally answer the current Relayer interaction by using Python in IPython to author a useful graph response.

${GRAPH_PRESENTATION_GUIDANCE}
${threadIconGuidance(context, "python")}
${PRIME_VISUAL_GUIDANCE}
For Input plus Invoke, declare field = ActionObject("input", ..., control="text", prompt="...") and invoke = ActionObject("invoke", ..., interaction_text="...", input_actions=(field,)). Mount these exact objects on the same Node. After submitting Node and Layer, await graph.add_action(node, invoke) writes or recovers the referenced Input first and stores canonical IDs. Never guess IDs or infer connections from proximity. Standalone Input feeds chat; Invoke consumes explicit bindings. One call is the default; set reusable=True only for meaningful repeat use.
${primeVisualExample(interaction.id)}
${CURRENT_WORKSPACE_GUIDANCE}\n${CURRENT_COMMUNICATION_GUIDANCE_PYTHON}${includePersonalPresentation ? personalPresentationPrompt(context) : ""}

Current interaction node: ${interaction.id}
Normalized interaction input:
${renderInteractionInput(context.interactionInput)}

${INTERACTION_INPUT_GUIDANCE} In Python, call await graph.get_interaction_input() to re-read it.
${context.interactionInput.completionContract?.input.invocationReferences.length ? SUBCOMPLETION_INTEGRATION_GUIDANCE : ""}
${context.completionBroker ? INVOCATION_PUBLICATION_GUIDANCE : ""}

Use this entry point. Top-level cell code starts at column 0; never indent it.

\`\`\`python
from relayer_graph import GraphSession
graph = await GraphSession.current()
\`\`\`

${PYTHON_GRAPH_API_REFERENCE}

${currentWorkspaceMechanicsPython()}
${semanticChildGuidancePython(context)}${graphSearchGuidancePython(this.context.configuration.graphCapabilityProfile?.search === "query-v1")}${draftPreviewGuidancePython(context)}

The graph scope is supplied by the host for this complete() execution and is inherited by your RLM children. Do not read graph credentials from environment variables or files. Use the scoped recipe above for new drafts; final acceptance requires await graph.submit(${interaction.id}).

Author nodes, edges, layers, and useful expand, reference, or invoke actions. For supporting evidence or reusable context, use await graph.add_navigate_action(node, "View evidence", evidence_layer, relation="reference", source_layer=response_layer, client_key="node-evidence") after submitting the referenced layer. The visible response layer must contain 1 to 8 connected nodes. The interaction node needs exactly one new root navigate action, relation="expand" with no source_layer; on a rerun, reuse its client_key rather than adding another.

${PYTHON_GRAPH_AUTHORING_RULES}

Import NodePlacementObject and LayerLayoutObject from relayer_graph. Every new layer requires a version-1 LayerLayoutObject(placements, edge_shape, edge_routes=()) with exactly one NodePlacementObject(node, x, y) per member node. Coordinates are normalized numbers from 0 through 1 and express semantic relative position independently of the viewport. Place a one-node layer at (0.5, 0.5). Keep flow or time moving consistently, anchor hierarchy with a parent or summary, group related nodes, align comparisons, and avoid accidental overlap or edge crossings. Do not derive coordinates from pixels, window size, or inspector state.
${LAYER_EDGE_SHAPE_GUIDANCE}

${ARTIFACT_LAYER_GUIDANCE_PYTHON}

Finish the root execution only by calling:

await graph.submit(${interaction.id})

If a graph call fails, edit and rerun the same authoring code with the same client_key values so it updates the same drafts instead of creating duplicates. Do not add fake navigation merely to make abandoned drafts reachable. Only when graph.submit identifies a genuinely abandoned orphan draft, recover with await graph.discard_layer(layer); this preserves that layer as stopped history without discarding its graph objects. A model turn ending is not completion. If graph.submit() has not succeeded, continue working or report the blocking graph error.`;
  }

  private layeredNavigationPrompt(context: HarnessRunContext, includePersonalPresentation: boolean): string {
    const interaction = context.inputGraph;
    return `While doing the underlying work, publish useful findings through current; finally answer the current Relayer interaction by using Python in IPython to author a useful graph response. A flat answer is valid. Add navigation only when opening it would materially improve understanding or support; apply that same test again inside every layer you author.

${GRAPH_PRESENTATION_GUIDANCE}
${threadIconGuidance(context, "python")}
${PRIME_VISUAL_GUIDANCE}
For Input plus Invoke, declare field = ActionObject("input", ..., control="text", prompt="...") and invoke = ActionObject("invoke", ..., interaction_text="...", input_actions=(field,)). Mount these exact objects on the same Node. After submitting Node and Layer, await graph.add_action(node, invoke) writes or recovers the referenced Input first and stores canonical IDs. Never guess IDs or infer connections from proximity. Standalone Input feeds chat; Invoke consumes explicit bindings. One call is the default; set reusable=True only for meaningful repeat use.
${primeVisualExample(interaction.id)}
${CURRENT_WORKSPACE_GUIDANCE}\n${CURRENT_COMMUNICATION_GUIDANCE_PYTHON}${includePersonalPresentation ? personalPresentationPrompt(context) : ""}

Current interaction node: ${interaction.id}
Normalized interaction input:
${renderInteractionInput(context.interactionInput)}

${INTERACTION_INPUT_GUIDANCE} In Python, call await graph.get_interaction_input() to re-read it.
${context.interactionInput.completionContract?.input.invocationReferences.length ? SUBCOMPLETION_INTEGRATION_GUIDANCE : ""}
${context.completionBroker ? INVOCATION_PUBLICATION_GUIDANCE : ""}

Use this entry point. Top-level cell code starts at column 0; never indent it.

\`\`\`python
from relayer_graph import GraphSession
graph = await GraphSession.current()
\`\`\`

${PYTHON_GRAPH_API_REFERENCE}

${currentWorkspaceMechanicsPython()}
${semanticChildGuidancePython(context)}${graphSearchGuidancePython(this.context.configuration.graphCapabilityProfile?.search === "query-v1")}${draftPreviewGuidancePython(context)}

The graph scope is supplied by the host for this complete() execution and is inherited by your RLM children. Do not read graph credentials from environment variables or files. Use the scoped recipe above for new drafts; final acceptance requires await graph.submit(${interaction.id}).

The current interaction may carry an invoke lease created by the product. Before authoring, use await graph.get_node(${interaction.id}) and await graph.get_neighbors(${interaction.id}) to inspect the current node and any relevant source context exposed by the graph. Treat that context as input to your answer; do not copy, forge, or manage lease metadata. Author the response normally. A successful ordinary graph.submit(${interaction.id}) automatically fulfills any lease held by this interaction. There is no separate resolve_action call.

Navigation has two meanings:
- relation="expand" continues the explanation with a more detailed layer. Expansion must not point back to an expansion ancestor.
- relation="reference" opens supporting evidence or context. References may reuse an accepted layer, may point to other reference layers, and may revisit a layer.

The interaction node must have one root navigate action with relation="expand" and no source_layer. Every action on a response node must include source_layer: the LayerObject in which you are authoring that action. Expansion layers may author expand, reference, or invoke actions. A layer reached as a reference may author only reference actions. Do not create both expand and reference actions to the same new target layer.

Examples:
await graph.add_navigate_action(${interaction.id}, "Key findings", root_layer, relation="expand", client_key="root-response", icon="search")
await graph.add_navigate_action(node, "Explain further", detail_layer, relation="expand", source_layer=root_layer, client_key="node-detail")
await graph.add_navigate_action(node, "View evidence", evidence_layer, relation="reference", source_layer=root_layer, client_key="node-evidence")
await graph.add_invoke_action(node, "Follow up", "Ask a useful follow-up", source_layer=root_layer, client_key="node-follow-up")

For every layer, choose the member whose detail should open first. Set layer.default_node to that NodeObject before submit_layer. Make this choice intentionally for the task; it does not change graph position or node order. The UI uses it only when there is no remembered user selection.

Layers normally contain 1 to 5 nodes. A layer may contain 6 to 8 nodes only when keeping them together is important; pass that private reason as await graph.submit_layer(layer, size_justification="..."). Never mention or expose the size justification in user-facing node text. More than 8 nodes must be split into useful layers.

Import NodePlacementObject and LayerLayoutObject from relayer_graph. Every new root, expansion, and reference layer requires a version-1 LayerLayoutObject(placements, edge_shape, edge_routes=()) with exactly one NodePlacementObject(node, x, y) per member node. Coordinates are normalized numbers from 0 through 1 and express semantic relative position independently of the viewport. Place a one-node layer at (0.5, 0.5). Keep flow or time moving consistently, use a parent or summary node to anchor hierarchy, group related nodes spatially, align comparisons deliberately, and avoid accidental overlap or edge crossings where a clearer arrangement is available. Do not use pixels, window size, or inspector state. Example: layout = LayerLayoutObject((NodePlacementObject(first, 0.25, 0.5), NodePlacementObject(second, 0.75, 0.5)), "elbow-horizontal"); layer = LayerObject((first, second), (edge,), layout, client_key="response-layer"). A routed loop-back: LayerLayoutObject(placements, "elbow-horizontal", (EdgeRouteObject(loop_back, ends=(EdgeEndObject(last, "top"), EdgeEndObject(first, "top")), waypoints=((0.9, 0.1), (0.1, 0.1))),)); import EdgeRouteObject and EdgeEndObject from relayer_graph.
${LAYER_EDGE_SHAPE_GUIDANCE}

${ARTIFACT_LAYER_GUIDANCE_PYTHON}

Layer edges are exactly what the user sees and are undirected. Give every node useful markdown detail.

${PYTHON_GRAPH_AUTHORING_RULES}

At any layer, add expand, reference, or invoke actions only when they materially improve the response.

The graph service enforces exact provenance, target visibility, layer size, expansion cycles, and accepted closure. If a call fails, read every natural-language issue, edit the same authoring code, and rerun it with the same client_key values; stable keys make the whole-program rerun update the same drafts instead of creating duplicates. Do not add fake navigate or reference actions merely to make abandoned draft layers reachable. Only when graph.submit identifies a genuinely abandoned orphan draft, recover with await graph.discard_layer(layer); this preserves that layer as stopped history without discarding its nodes, edges, actions, or child layers. A model turn ending is not completion. The task is complete only when the final graph.submit call succeeds.`;
  }
}

function primeSessionHandle(session: PrimeAgentSession, instructions: PrimeSessionInstructions): PrimeAgentSessionHandle {
  return {
    session,
    instructions,
    conversed: false,
    nativeDispose: session.dispose.bind(session),
    disposeInProgress: false,
    disposeCompleted: false,
    guardInstalled: false,
  };
}

/**
 * Gives one session a view of the shared services whose resource loader appends that
 * session's own presentation instructions. Everything else reads and writes the shared loader.
 */
function sessionScopedServices(
  services: Record<string, unknown>,
  initialInstructions: string,
): { readonly services: Record<string, unknown>; readonly instructions: PrimeSessionInstructions } {
  const loader = services.resourceLoader;
  if (typeof loader !== "object" || loader === null
    || typeof (loader as { getAppendSystemPrompt?: unknown }).getAppendSystemPrompt !== "function") {
    if (initialInstructions !== "") {
      throw new Error("Installed Prime Agent package cannot scope presentation instructions to a session");
    }
    return { services, instructions: { current: "", scoped: false } };
  }
  const instructions: PrimeSessionInstructions = { current: initialInstructions, scoped: true };
  const resourceLoader = new Proxy(loader, {
    get(target, property) {
      if (property === "getAppendSystemPrompt") {
        return () => {
          const base = (target as { getAppendSystemPrompt(): string[] }).getAppendSystemPrompt();
          return instructions.current === "" ? [...base] : [...base, instructions.current];
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { services: { ...services, resourceLoader }, instructions };
}

function primeSessionAttachment(session: PrimeAgentSession): JsonObject {
  if (typeof session.sessionFile !== "string" || session.sessionFile === "") {
    throw new Error("Prime Agent did not expose a durable native session identity");
  }
  return Object.freeze({
    schemaVersion: 1,
    provider: "prime-agent",
    sessionDigest: `sha256:${createHash("sha256").update(session.sessionFile).digest("hex")}`,
  });
}

function currentWorkspaceMechanicsPython(): string {
  return `Read current with current = await graph.get_current(). The first current layer may contain visible accepted nodes; when no prior current exists, it needs no new draft carrier. When a prior current exists, every later current layer and the root of your final graph.submit must retain a navigation path back to that prior current. Reuse an existing valid path when one already exists; otherwise, after submitting the new layer and before publishing it, add await graph.add_navigate_action(node, "Earlier view", current["currentLayerId"], relation="reference", source_layer=new_layer, client_key="back-to-earlier-view") from one of its draft nodes created for this interaction. Reuse alone grants no action authority; only an exact frozen attached-node navigation grant can permit an addition through supported client operations. Give each distinct logical advance_current transition its own stable operation key. Save that transition's exact layer, expected headRevision, and operation key together. Before every Advance, author or retarget the interaction\'s one root navigate/expand action to that candidate layer using its same stable client_key. All CompletionContract returnRequirements must already be satisfied, including staged attached-node links to that exact response layer. After submitting the complete closure and registering all its actions, publish it with await graph.advance_current(layer, expected_revision=expected_revision, operation_key=operation_key). An exact retry reuses all three unchanged. After a successful nonterminal advance_current, refresh with current = await graph.get_current() before building the next logical transition, so its revision and backreference use the new current. Use a different stable key for that next transition. A successful terminal graph.submit ends graph access: do not call get_current or perform any further graph reads or writes afterward.`;
}

/** The graph client calls a Prime cell uses, as the Python client declares them. Every method is async. */
export const PYTHON_GRAPH_API_REFERENCE = `Graph client reference (every graph method is async; always await it):
- await graph.get_node_presentation(node): authorized current node, revision and existing actions.
- await graph.replace_node_presentation(node, expected_revision, presentation): GraphSession compiles and stages a full attached-node presentation replacement.
- (await graph.get_interaction_input()).interaction_permissions: frozen read-only version, enabled flag and exact permission entries; None for absent legacy snapshots.
- NodeObject(icon, title, detail, kind="concept", client_key=...), EdgeObject((left_node, right_node), client_key=...), LayerObject(nodes, edges, layout, client_key=...), LayerLayoutObject(placements, edge_shape, edge_routes=()), EdgeRouteObject(edge, shape=None, ends=None, waypoints=()), EdgeEndObject(node, side=None), NodePlacementObject(node, x, y); import them from relayer_graph.
- await graph.submit_node(node) -> node; await graph.create_edge(left, right, client_key=...) -> edge; await graph.submit_layer(layer, size_justification=None) -> layer.
- await graph.add_navigate_action(source_node, label, target_layer, relation="expand" | "reference", client_key=..., source_layer=None, variant="pill", icon=None, description=None).
- await graph.add_invoke_action(source_node, label, interaction_text, source_layer=..., client_key=..., variant="pill", icon=None, description=None).
- await graph.get_current(); await graph.advance_current(layer, expected_revision=..., operation_key=...); await graph.get_interaction_input(); await graph.discard_layer(layer); await graph.submit(interaction_node).
- Graph objects do not expose client_key after submission; keep your own references to the objects you submitted.`;

/** Rules the graph service enforces on authored objects, stated so the first attempt passes. */
const PYTHON_GRAPH_AUTHORING_RULES = `${NODE_ICON_GUIDANCE} Action variants are "chip", "pill", "wide", or "card". Only a card accepts description, and a card requires one. Apart from the interaction node's one root expand action or an exact frozen attached-node navigation grant, add actions only on draft nodes created for this interaction. Reuse alone grants no action authority. Preserve existing accepted-node actions and semantic content. Use only supported client operations; if a required full presentation replacement is unavailable, do not add an unbound action or bypass the client boundary.`;

// Present only when the product granted this completion a broker, as in codex.basic.
function semanticChildGuidancePython(context: HarnessRunContext): string {
  if (context.completionBroker === undefined) return "";
  return `For explicit semantic child work, author an ordinary single-call invoke action with a stable client_key (reusable defaults to False). Set reusable=True only for an explicit repeat-use case, such as comparing different destination inputs; use a separate ordinary action for each independent one-time child. Submit the action and its source Node, then prepare each distinct call with input_graph = await graph.prepare_complete(invoke_action, "stable-call-key"); reusing the same call key recovers that call; another key creates an independent Invocation only when the action explicitly permits reuse. One input graph starts exactly one child. Before launching or waiting for this child, author the ordinary response root and Advance your enclosing source Layer so the source Node is accepted; preparation alone does not publish it. Import with from relayer_graph import complete, CompletionWatch. Start with children = [] and launch each child from its own input graph with children.append(complete(input_graph)). Each handle returns immediately with completion_id, current, and result; launch every independent child before watching them. Every change to a child's current is an event you may act on. Create watch = CompletionWatch(children) once. Then run changes = await watch.changes() in its own cell; it returns as soon as any child's current moves or ends, even when that takes minutes. Each change is a (child, current) pair, or (child, error) with the exception in place of the current once the watch can no longer observe that child, for example because its start was refused; check isinstance(current, Exception) before reading it. The watch then stops watching that child. After each event, decide whether the user now needs a better view, for example when a workstream reaches a finding or finishes. Only then submit a later improved layer that presents the work itself and advance your current to it; otherwise keep waiting. You may watch until watch.settled is true and integrate the results, or Return your full response while children remain active. Returning the parent does not stop the children; their graph-owned Invocations and results remain durable. await child.result gives a succeeded child's final layer. A stopped or failed child raises CompletionTerminalError there instead, also importable from relayer_graph; catch it and integrate the work its error.current still retains. If child.result raises any other exception, as it may for a child reported with an error, you cannot read that child's work; present that part as not done, without quoting the error or inventing findings. Prime RLM children and subagents remain inside this completion and do not create semantic children by themselves.
`;
}

/**
 * Present only when the host granted this completion a preview folder (PRD §11.10).
 * attach_image is Prime's native skill; it works only when the selected model accepts images.
 */
function draftPreviewGuidancePython(context: HarnessRunContext): string {
  if (context.graph.acquireCapability().previewDirectory === undefined) return "";
  return `

Draft previews are on for this run. A successful await graph.submit_layer(layer) returns an image of the layer as the user will see it, and await graph.submit_node(node) returns one for a node with authored detail. The returned record's preview field has a status of rendered, cached, failed, or limit_reached; a rendered or cached preview also has path, width, and height. To look at one, run print(await attach_image(submitted.preview.path)) in IPython; attach_image is already imported. If attach_image reports that the model cannot see images, stop using previews and continue without them. Look before your final graph.submit, because graph access ends when it succeeds. If you see overlaps, cramped or unreadable nodes, or a layout that doesn't show the real relationships, edit your code and rerun it with the same client_key values; a changed object returns a fresh image. Controls for actions you have not added yet appear unavailable in a preview; that is expected. The image is advisory: a failed or limit_reached preview never blocks your work.`;
}

function graphSearchGuidancePython(enabled: boolean): string {
  if (!enabled) return "";
  return `Graph search is available through the same Python graph session as await graph.search(GraphSearchRequest(...)). It is not a provider-native tool. Import GraphSearchRequest from relayer_graph. The request accepts query, optional tagged parameters, optional budget, query_contract_version=1, and an optional target. Omit target for the current interaction's thread. Supply it only when the product or user already provided the exact canonical ID, using target={"scope": "thread", "id": known_thread_id} or target={"scope": "project", "id": known_project_id}. Never invent, guess, or discover a target ID. The selector chooses a dataset; it is not authority, and Rust intersects it with the completion-bound read permit. Never add raw permit, credential, token, database, or other authority fields. Search sees accepted published graph records only, never drafts, and never falls back to SQLite when Ladybug is unavailable.

The read-only query profile supports whole-target Content or Layer scans and bounded one- or two-relationship MATCH patterns over CONNECTED, CONTAINS, EXPANDS, and REFERENCES. It rejects mutations, procedures, arbitrary-length paths, and more than two hops. Put values in tagged parameters. Results are tagged dictionaries; the default row cap is 5, the hard cap is 8, and the complete encoded result is bounded to 16 KiB.

Example:
import re
from relayer_graph import GraphSearchRequest
search = await graph.search(GraphSearchRequest(
    query="MATCH (l:Layer)-[:CONTAINS]->(n:Content) WHERE n.title = $title RETURN l AS layer ORDER BY layer ASC",
    parameters={"title": {"type": "string", "value": "Queue"}},
))
if search.get("truncated") is True:
    raise ValueError("Graph search results are truncated; narrow the query before selecting a layer.")
rows = search.get("rows")
if not isinstance(rows, list) or not rows:
    raise ValueError("Graph search returned no rows; no layer is available to reference.")
first_row = rows[0]
if not isinstance(first_row, list) or not first_row:
    raise ValueError("The first graph search row has no result cell to reference.")
result = first_row[0]
if not isinstance(result, dict) or result.get("type") != "layer":
    raise ValueError("The first graph search result is not a tagged layer.")
identity = result.get("id")
match = re.fullmatch(r"layer:([1-9][0-9]*)", identity) if isinstance(identity, str) else None
if match is None:
    raise ValueError("The tagged layer has an invalid public identity.")
layer_id = int(match.group(1))

Graph query contract failures raise GraphQueryError with stable status, code, phase, and path fields; branch on code or phase, never message text. Transport or index unavailability raises APIError instead of returning stale data. A returned graph value is data, not authority. To reuse a searched layer as supporting context, require result["type"] == "layer", validate its public identity with a full match for layer:([1-9][0-9]*), convert that suffix to an integer, and pass it to await graph.add_navigate_action(..., relation="reference", source_layer=current_layer, client_key="stable-reference-key"). Never turn another tagged value or arbitrary string into an action target. Search is optional; use it only when prior accepted context materially improves the answer.`;
}

function primeRuntimeProvenance(serialized: string | undefined): JsonObject | undefined {
  if (!serialized) return undefined;
  try {
    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value)
      || typeof value.sourceCommit !== "string"
      || !/^[a-f0-9]{40}$/.test(value.sourceCommit)
      || !Array.isArray(value.packages)
      || value.packages.length !== 4) return undefined;
    const packages = value.packages.flatMap((entry) => (
      isRecord(entry)
      && typeof entry.name === "string"
      && /^@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui)$/.test(entry.name)
      && typeof entry.version === "string"
      && /^\d+\.\d+\.\d+$/.test(entry.version)
        ? [{ name: entry.name, version: entry.version }]
        : []
    ));
    const expectedNames = [
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
    ];
    packages.sort((left, right) => left.name.localeCompare(right.name));
    if (packages.length !== expectedNames.length
      || packages.some((entry, index) => entry.name !== expectedNames[index])) return undefined;
    return { sourceCommit: value.sourceCommit, packages };
  } catch {
    return undefined;
  }
}

function tracePrimeEvent(
  context: HarnessRunContext,
  value: unknown,
  childStreams: Map<string, HarnessTraceStream>,
  execution: PrimeAgentExecutionScope,
): void {
  if (!isRecord(value) || typeof value.type !== "string") return;
  const event = value as Record<string, unknown>;
  context.trace.emit({ type: "provider.event", data: { provider: "prime-agent", event: safePrimeEvent(event, execution.routeByNativeModel, execution.sensitiveValues, execution.presentationTraceValues) } });
  if (event.type === "turn_start") {
    context.trace.emit({ type: "model.call.started", data: { provider: "prime-agent", eventType: event.type, ...traceRoute(execution.orchestrator) } });
  } else if (event.type === "turn_end") {
    context.trace.emit({ type: "model.call.completed", data: { provider: "prime-agent", eventType: event.type, status: "completed", ...traceRoute(execution.orchestrator) } });
  } else if (event.type === "tool_execution_start") {
    context.trace.emit({ type: "tool.call.started", data: safePrimeToolEvent(event, execution.sensitiveValues, execution.presentationTraceValues) });
  } else if (event.type === "tool_execution_end") {
    context.trace.emit({ type: "tool.call.completed", data: safePrimeToolEvent(event, execution.sensitiveValues, execution.presentationTraceValues) });
  } else if (event.type === "message_end") {
    tracePrimeMessage(context, event.message, execution.routeByNativeModel, execution.sensitiveValues, execution.presentationTraceValues);
  } else if (event.type === "rlm_child_update") {
    tracePrimeChild(context, event.child, childStreams, execution.routeByNativeModel, execution.sensitiveValues, execution.presentationTraceValues);
  }
}

function tracePrimeMessage(
  context: HarnessRunContext,
  value: unknown,
  routes: ReadonlyMap<string, HarnessAdmittedModelRoute>,
  sensitiveValues: readonly string[],
  presentationTraceValues: ReturnType<typeof personalPresentationTraceValues>,
): void {
  if (!isRecord(value)) return;
  const role = typeof value.role === "string" ? value.role : "unknown";
  if (role === "assistant" && Array.isArray(value.content)) {
    const text = value.content.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []);
    const route = traceRouteForValue(value, routes);
    if (text.length > 0) context.trace.emit({
      type: "message",
      data: {
        role,
        text: sanitizePrimeTraceValue(text.join("\n"), sensitiveValues, presentationTraceValues, true) as string,
        ...(route === undefined ? {} : traceRoute(route)),
      },
    });
  }
  if (isRecord(value.usage)) context.trace.emit({
    type: "usage",
    data: redactTraceData(sanitizePrimeTraceValue(value.usage, sensitiveValues)) as JsonObject,
  });
}

function tracePrimeChild(
  context: HarnessRunContext,
  value: unknown,
  childStreams: Map<string, HarnessTraceStream>,
  routes: ReadonlyMap<string, HarnessAdmittedModelRoute>,
  sensitiveValues: readonly string[],
  presentationTraceValues: ReturnType<typeof personalPresentationTraceValues>,
): void {
  if (!isRecord(value) || typeof value.id !== "string") return;
  let stream = childStreams.get(value.id);
  if (stream === undefined) {
    const parentId = typeof value.parentId === "string" ? value.parentId : undefined;
    stream = context.trace.openStream({
      name: typeof value.label === "string" ? value.label : typeof value.sessionName === "string" ? value.sessionName : "Prime Agent child",
      kind: "worker",
      providerStreamId: value.id,
      ...(parentId === undefined || childStreams.get(parentId) === undefined ? {} : { parentStreamId: childStreams.get(parentId)!.id }),
    });
    childStreams.set(value.id, stream);
  }
  stream.emit({
    type: "provider.event",
    data: {
      provider: "prime-agent",
      eventType: "rlm_child_update",
      child: redactTraceData(safePrimeChild(value, routes, sensitiveValues, presentationTraceValues)),
    },
  });
  const status = typeof value.status === "string" ? value.status : "";
  if (["completed", "failed", "cancelled"].includes(status)) {
    stream.close(status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed", { status });
    childStreams.delete(value.id);
  }
}

function safePrimeEvent(
  event: Record<string, unknown>,
  routes: ReadonlyMap<string, HarnessAdmittedModelRoute>,
  sensitiveValues: readonly string[],
  presentationTraceValues: ReturnType<typeof personalPresentationTraceValues>,
): JsonObject {
  const type = typeof event.type === "string" ? event.type : "unknown";
  if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
    return redactTraceData({ type, message: safePrimeMessage(event.message, routes, sensitiveValues, presentationTraceValues) }) as JsonObject;
  }
  if (event.type === "rlm_child_update") {
    return redactTraceData({ type, child: safePrimeChild(event.child, routes, sensitiveValues, presentationTraceValues) }) as JsonObject;
  }
  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
    return { type, ...safePrimeToolEvent(event, sensitiveValues, presentationTraceValues) };
  }
  return { type };
}

function safePrimeMessage(
  value: unknown,
  routes: ReadonlyMap<string, HarnessAdmittedModelRoute>,
  sensitiveValues: readonly string[],
  presentationTraceValues: ReturnType<typeof personalPresentationTraceValues>,
): unknown {
  if (!isRecord(value)) return value;
  const content = Array.isArray(value.content)
    ? value.content.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [{ type: "text", text: block.text }] : [])
    : undefined;
  const route = traceRouteForValue(value, routes);
  return sanitizePrimeTraceValue({
    role: value.role,
    stopReason: value.stopReason,
    usage: value.usage,
    content,
    ...(route === undefined ? {} : traceRoute(route)),
  }, sensitiveValues, presentationTraceValues, true);
}

function safePrimeToolEvent(
  event: Record<string, unknown>,
  sensitiveValues: readonly string[],
  presentationTraceValues: ReturnType<typeof personalPresentationTraceValues>,
): JsonObject {
  return redactTraceData(sanitizePrimeTraceValue({
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    args: event.args,
    result: redactPrimeImages(event.result),
    isError: event.isError,
  }, sensitiveValues, presentationTraceValues, false)) as JsonObject;
}

/**
 * attach_image puts base64 images in the ipython result's content and attachments.
 * The trace keeps each image's MIME type and size, never the image (PRD §11.10).
 */
function redactPrimeImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPrimeImages);
  if (!isRecord(value)) return value;
  if (typeof value.data === "string" && typeof value.mimeType === "string" && value.mimeType.startsWith("image/")) {
    const { data, ...rest } = value;
    return { ...rest, byteLength: Buffer.byteLength(data, "base64") };
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactPrimeImages(child)]));
}

function sanitizePrimeTraceValue(
  value: unknown,
  sensitiveValues: readonly string[],
  presentationTraceValues?: ReturnType<typeof personalPresentationTraceValues>,
  includePresentationFragments = false,
): unknown {
  if (typeof value === "string") {
    const accessRedacted = sensitiveValues.reduce(
      (sanitized, secret) => sanitized.split(secret).join("[redacted-provider-access]"),
      value,
    );
    if (presentationTraceValues === undefined) return accessRedacted;
    const presentationValues = includePresentationFragments
      ? [presentationTraceValues.exactBlock, ...presentationTraceValues.legacyBlocks, ...presentationTraceValues.fragments]
      : [presentationTraceValues.exactBlock, ...presentationTraceValues.legacyBlocks];
    return presentationValues.reduce(
      (sanitized, traceValue) => sanitized.split(traceValue).join("[redacted-personal-presentation]"),
      accessRedacted,
    );
  }
  if (Array.isArray(value)) return value.map((child) => sanitizePrimeTraceValue(
    child, sensitiveValues, presentationTraceValues, includePresentationFragments,
  ));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => (
    /^(?:endpoint|base[_-]?url)$/i.test(key) ? [] : [[key, sanitizePrimeTraceValue(
      child, sensitiveValues, presentationTraceValues, includePresentationFragments,
    )]]
  )));
}

function safePrimeChild(
  value: unknown,
  routes: ReadonlyMap<string, HarnessAdmittedModelRoute>,
  sensitiveValues: readonly string[],
  presentationTraceValues: ReturnType<typeof personalPresentationTraceValues>,
): unknown {
  if (!isRecord(value)) return value;
  const allowed = ["id", "parentId", "sessionName", "label", "status", "durationMs", "answerPreview", "toolUseCount", "tokenCount", "recap", "activity", "error"];
  const safe = Object.fromEntries(allowed.flatMap((key) => value[key] === undefined ? [] : [[key, value[key]]]));
  const route = traceRouteForValue(value, routes);
  return sanitizePrimeTraceValue(
    { ...safe, ...(route === undefined ? {} : traceRoute(route)) },
    sensitiveValues,
    presentationTraceValues,
    true,
  );
}

function traceRouteForValue(value: Record<string, unknown>, routes: ReadonlyMap<string, HarnessAdmittedModelRoute>): HarnessAdmittedModelRoute | undefined {
  const provider = typeof value.provider === "string" ? value.provider : undefined;
  const model = typeof value.model === "string" ? value.model : undefined;
  if (provider !== undefined && model !== undefined) return routes.get(nativeModelIdentity(provider, model));
  if (model !== undefined) {
    for (const [identity, route] of routes) {
      const separator = identity.indexOf("\0");
      if (separator >= 0 && `${identity.slice(0, separator)}/${identity.slice(separator + 1)}` === model) return route;
    }
  }
  if (isRecord(value.model) && typeof value.model.provider === "string" && typeof value.model.id === "string") {
    return routes.get(nativeModelIdentity(value.model.provider, value.model.id));
  }
  return undefined;
}

function traceRoute(route: HarnessAdmittedModelRoute): JsonObject {
  return {
    providerDefinitionId: route.providerId,
    adapterId: route.adapterId,
    modelId: route.modelId,
    adapterImplementationVersion: route.adapterImplementationVersion,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type OperationOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

async function operationOutcome<T>(operation: () => Promise<T>): Promise<OperationOutcome<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

export function createPrimeAgentFactory(dependencies: PrimeAgentDependencies = {}): HarnessFactory {
  return (context) => PrimeAgentHarness.create(context, dependencies);
}

function parsePrimeAgentConfiguration(context: HarnessFactoryContext): PrimeAgentConfiguration {
  const selected = context.configuration;
  if (selected.implementation !== PRIME_AGENT_KEY) throw new Error(`prime.agent cannot run implementation ${selected.implementation}`);
  if (selected.implementationVersion !== 1) throw new Error(`Unsupported prime.agent implementation version: ${selected.implementationVersion}`);
  const settings = selected.settings;
  const allowed = new Set(["thinkingLevel", "rlmMaxDepth", "prewarmIpythonKernel", "promptProfile", "personalPresentationVersion"]);
  const unknown = Object.keys(settings).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown prime.agent configuration field: ${unknown.join(", ")}`);
  optionalEnum(settings.personalPresentationVersion, ["personal-presentation-v0", "personal-presentation-v1", "personal-presentation-v2", "personal-presentation-v3", "personal-presentation-v4"] as const, "personalPresentationVersion");
  const thinkingLevel = optionalEnum(settings.thinkingLevel, ["minimal", "low", "medium", "high", "xhigh", "max"] as const, "thinkingLevel");
  const rlmMaxDepth = optionalPositiveInteger(settings.rlmMaxDepth, "rlmMaxDepth");
  const prewarmIpythonKernel = optionalBoolean(settings.prewarmIpythonKernel, "prewarmIpythonKernel");
  const promptProfile = optionalEnum(settings.promptProfile, ["layered-navigation-v1"] as const, "promptProfile");
  return {
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(rlmMaxDepth === undefined ? {} : { rlmMaxDepth }),
    ...(prewarmIpythonKernel === undefined ? {} : { prewarmIpythonKernel }),
    ...(promptProfile === undefined ? {} : { promptProfile }),
  };
}

function parsePrimeAgentPermission(context: HarnessFactoryContext): PrimeAgentPermission {
  const binding = context.permissionBinding;
  if (context.permissionProfileId === "full") {
    if (Object.keys(binding).length !== 0) {
      throw new Error("prime.agent Full access permission binding must be empty");
    }
    return Object.freeze({ profile: "full" });
  }
  if (context.permissionProfileId !== "ask" && context.permissionProfileId !== "auto") {
    throw new Error(`prime.agent does not support permission profile ${context.permissionProfileId}`);
  }
  const unknown = Object.keys(binding).filter((key) => !["boundary", "reviewer", "networkAccessEnabled"].includes(key));
  if (unknown.length > 0) throw new Error(`Unknown prime.agent permission binding field: ${unknown.join(", ")}`);
  const expectedReviewer = context.permissionProfileId === "ask" ? "user" : "automatic";
  if (binding.boundary !== "workspace-write@1"
    || binding.reviewer !== expectedReviewer
    || binding.networkAccessEnabled !== true) {
    throw new Error(`prime.agent ${context.permissionProfileId} requires workspace-write@1, ${expectedReviewer} review, and enabled network access`);
  }
  return Object.freeze({
    profile: context.permissionProfileId,
    boundary: "workspace-write@1",
    reviewer: expectedReviewer,
    networkAccessEnabled: true,
  });
}

function requirePrimePermissionRuntime(permission: PrimeAgentPermission, primeAgent: PrimeAgentModule): void {
  if (permission.profile === "full") return;
  if (primeAgent.AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION !== 1
    || primeAgent.AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION !== 1
    || typeof primeAgent.createAgentRunToolAuthorityScope !== "function"
    || typeof primeAgent.createAgentRunKernelBoundaryScope !== "function") {
    throw new Error("Installed Prime Agent package does not support version-1 bounded tool and kernel authority");
  }
}

function createPrimeAgentPermissionScopes(input: {
  readonly context: HarnessRunContext;
  readonly runContext: PrimeAgentRunContext;
  readonly primeAgent: PrimeAgentModule;
  readonly permission: PrimeAgentPermission;
  readonly workspaceRoot: string;
  readonly createKernelBoundary: PrimeAgentDependencies["createKernelBoundary"];
}): { readonly toolAuthorityScope?: unknown; readonly kernelBoundaryScope?: unknown } {
  if (input.permission.profile === "full") return Object.freeze({});
  const permission = input.permission;
  const createToolScope = input.primeAgent.createAgentRunToolAuthorityScope;
  const createBoundaryScope = input.primeAgent.createAgentRunKernelBoundaryScope;
  if (createToolScope === undefined || createBoundaryScope === undefined) {
    throw new Error("Prime bounded permission runtime became unavailable");
  }
  const workspaceScopeDigest = `sha256:${createHash("sha256")
    .update("relayer.prime.workspace-scope.v1\0")
    .update(input.workspaceRoot)
    .digest("hex")}`;
  const policy: PrimeAgentKernelBoundaryPolicy = Object.freeze({
    filesystem: "workspace-write",
    workspaceRoot: input.workspaceRoot,
    workspaceScopeDigest,
    network: "enabled",
    reviewerMode: permission.reviewer === "user" ? "ask" : "automatic",
  });
  const initializedExecutions = new Set<string>();
  const boundaryFactory = input.createKernelBoundary?.({
    workspaceRoot: input.workspaceRoot,
    workspaceScopeDigest,
  }) ?? createPrimeWorkspaceBoundary(input.workspaceRoot);
  const kernelBoundaryScope = createBoundaryScope({
    version: input.primeAgent.AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION!,
    policy,
    prepare: boundaryFactory,
    observe: (event) => {
      if (event.phase === "terminal") initializedExecutions.delete(event.context.executionId);
      emitPrimeBoundaryReceipt(input.context, event, policy);
      if (event.phase === "initialized") initializedExecutions.add(event.context.executionId);
    },
  });
  const toolAuthorityScope = createToolScope({
    version: input.primeAgent.AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION!,
    authorize: async (request) => authorizePrimeTool({
      request,
      context: input.context,
      runContext: input.runContext,
      permission,
      workspaceRoot: input.workspaceRoot,
      workspaceScopeDigest,
      initialized: initializedExecutions.has(request.context.executionId),
    }),
  });
  return Object.freeze({ toolAuthorityScope, kernelBoundaryScope });
}

async function authorizePrimeTool(input: {
  readonly request: PrimeAgentToolAuthorizationRequest;
  readonly context: HarnessRunContext;
  readonly runContext: PrimeAgentRunContext;
  readonly permission: Exclude<PrimeAgentPermission, { readonly profile: "full" }>;
  readonly workspaceRoot: string;
  readonly workspaceScopeDigest: string;
  readonly initialized: boolean;
}): Promise<PrimeAgentToolAuthorizationDecision> {
  const request = input.request;
  if (!input.initialized) return { decision: "deny", reason: "The workspace boundary is not initialized" };
  if (request.context.runContext !== input.runContext
    || typeof request.context.executionId !== "string"
    || request.context.executionId.trim() === ""
    || !Number.isSafeInteger(request.context.recursionDepth)
    || request.context.recursionDepth < 0) {
    return { decision: "deny", reason: "Prime tool request has mismatched run authority" };
  }
  if (request.toolName !== "ipython" || !isRecord(request.args) || Object.keys(request.args).length !== 1
    || typeof request.args.code !== "string" || request.args.code.trim() === "") {
    return { decision: "deny", reason: "Relayer does not recognize this Prime tool request" };
  }
  if (typeof request.toolCallId !== "string" || request.toolCallId.trim() === "") {
    return { decision: "deny", reason: "Prime tool request has no stable call identity" };
  }
  if (input.permission.profile === "auto") return { decision: "allow" };
  const approvalDisplay = primeCodeApprovalDisplay(request.args.code);
  if (approvalDisplay === null) {
    return { decision: "deny", reason: "Prime IPython code exceeds the approval display limit" };
  }

  const argsDigest = `sha256:${createHash("sha256")
    .update("relayer.prime.tool-args.v1\0")
    .update(JSON.stringify({ code: request.args.code }))
    .digest("hex")}`;
  try {
    const decision = await input.context.approvals.request({
      providerItemId: request.toolCallId,
      title: "Run Prime Agent code",
      reason: "Prime Agent needs approval before executing this IPython cell.",
      action: {
        kind: "command",
        command: approvalDisplay,
        workingDirectory: input.workspaceRoot,
      },
      scopeKeys: [
        "prime.tool:ipython",
        `cwd:${input.workspaceRoot}`,
        `args:${argsDigest}`,
        "boundary:workspace-write@1",
        `boundary-scope:${input.workspaceScopeDigest}`,
        "network:enabled",
      ],
      scopeDescription: `Run this exact IPython cell in ${input.workspaceRoot} inside the admitted workspace-write boundary.`,
    }, {
      signal: request.context.signal,
      terminationOutcome: "aborted",
      terminationRationale: "Prime Agent cleared the tool request.",
    });
    return decision.decision === "deny"
      ? { decision: "deny", reason: decision.rationale ?? "The user denied this tool request" }
      : { decision: "allow" };
  } catch (error) {
    if (error instanceof HarnessApprovalRequestTerminatedError) {
      return { decision: "deny", reason: `The approval request was ${error.resolution.outcome}` };
    }
    throw error;
  }
}

function primeCodeApprovalDisplay(code: string): string | null {
  const display = JSON.stringify(code);
  return display.length <= MAX_HARNESS_APPROVAL_TEXT_LENGTH ? display : null;
}

function emitPrimeBoundaryReceipt(
  context: HarnessRunContext,
  event: PrimeAgentKernelBoundaryEvent,
  expectedPolicy: PrimeAgentKernelBoundaryPolicy,
): void {
  if (event.policy.workspaceRoot !== expectedPolicy.workspaceRoot
    || event.policy.workspaceScopeDigest !== expectedPolicy.workspaceScopeDigest
    || event.policy.filesystem !== expectedPolicy.filesystem
    || event.policy.network !== expectedPolicy.network
    || event.policy.reviewerMode !== expectedPolicy.reviewerMode) {
    throw new Error("Prime Agent reported a mismatched workspace boundary");
  }
  context.trace.emit({
    type: "provider.event",
    data: {
      provider: "prime-agent",
      event: {
        type: "permission.boundary",
        phase: event.phase,
        boundaryVersion: 1,
        workspaceScopeIdentity: `workspace:${expectedPolicy.workspaceScopeDigest}`,
        workspaceScopeDigest: expectedPolicy.workspaceScopeDigest,
        networkEnabled: true,
        reviewerMode: event.policy.reviewerMode,
        recursionDepth: event.context.recursionDepth,
        ...(event.phase === "terminal" ? {
          outcome: event.outcome ?? "failed",
          cleanupOutcome: event.cleanup ?? "failed",
        } : {}),
      },
    },
  });
}

function createPrimeAgentModelScope(context: HarnessRunContext, primeAgent: PrimeAgentModule): PrimeAgentExecutionScope {
  const plan = context.modelPlan;
  const bundle = context.accessBundle;
  if (plan === undefined || bundle === undefined) {
    throw new Error("prime.agent requires an admitted model family and complete upfront provider access");
  }
  if (context.model === undefined
    || context.model.providerId !== plan.orchestrator.providerId
    || context.model.adapterId !== plan.orchestrator.adapterId
    || context.model.modelId !== plan.orchestrator.modelId) {
    throw new Error("prime.agent selected model does not match the admitted family orchestrator");
  }
  const orchestratorIdentity = admittedRouteIdentity(plan.orchestrator);
  if (!plan.roster.some((route) => admittedRouteIdentity(route) === orchestratorIdentity)) {
    throw new Error("prime.agent family orchestrator is not present in its ordered roster");
  }

  const requiredProviderIds = new Set(plan.roster.map((route) => route.providerId));
  const suppliedProviderIds = Object.keys(bundle.byProviderId);
  if (suppliedProviderIds.length !== requiredProviderIds.size
    || suppliedProviderIds.some((providerId) => !requiredProviderIds.has(providerId))) {
    throw new Error("prime.agent provider access bundle must exactly cover the admitted family");
  }

  const providerRoutes = new Map<string, HarnessAdmittedModelRoute>();
  const allowedNativeModels = new Set<string>();
  const routeByNativeModel = new Map<string, HarnessAdmittedModelRoute>();
  const requestAccessByNativeModel = new Map<string, PrimeAgentRequestAccess>();
  const sensitiveValues = new Set<string>();
  const presentationTraceValues = personalPresentationTraceValues(context);
  const models = plan.roster.map((route) => {
    const access = bundle.byProviderId[route.providerId];
    if (access === undefined) throw new Error(`prime.agent is missing upfront access for provider ${route.providerId}`);
    validatePrimeAgentAccess(route, access);
    sensitiveValues.add(access.endpoint);
    sensitiveValues.add(requiredApiKey(access));
    const previous = providerRoutes.get(route.providerId);
    if (previous !== undefined
      && (previous.adapterId !== route.adapterId
        || previous.accessContract !== route.accessContract
        || previous.adapterImplementationVersion !== route.adapterImplementationVersion)) {
      throw new Error(`prime.agent provider ${route.providerId} has conflicting admitted routes`);
    }
    providerRoutes.set(route.providerId, route);
    const model = primeAgentModel(route, access);
    const nativeIdentity = nativeModelIdentity(model.provider, model.id);
    if (allowedNativeModels.has(nativeIdentity)) throw new Error("prime.agent family maps to a duplicate native model");
    allowedNativeModels.add(nativeIdentity);
    routeByNativeModel.set(nativeIdentity, route);
    requestAccessByNativeModel.set(nativeIdentity, Object.freeze({
      kind: "secret",
      contract: "secret@1",
      apiKey: requiredApiKey(access),
    }));
    return model;
  });
  const rootIndex = plan.roster.findIndex((route) => admittedRouteIdentity(route) === orchestratorIdentity);
  const root = models[rootIndex];
  if (root === undefined) throw new Error("prime.agent could not resolve the admitted family orchestrator");

  const modelScope = primeAgent.createAgentRunModelScope({
    version: primeAgent.AGENT_RUN_MODEL_SCOPE_VERSION,
    root,
    models: Object.freeze(models),
    requestAccess: Object.freeze(models.map((model) => Object.freeze({
      model,
      access: requestAccessByNativeModel.get(nativeModelIdentity(model.provider, model.id))!,
    }))),
  });
  return Object.freeze({
    modelScope,
    orchestrator: plan.orchestrator,
    routeByNativeModel,
    sensitiveValues: Object.freeze([...sensitiveValues].filter((value) => value !== "")),
    presentationTraceValues,
  });
}

function validatePrimeAgentAccess(route: HarnessAdmittedModelRoute, access: HarnessExecutionAccess): asserts access is Extract<HarnessExecutionAccess, { kind: "secret" }> {
  const mapping = PRIME_ADAPTERS[route.adapterId];
  if (mapping === undefined) {
    throw new Error(`prime.agent does not support provider adapter ${route.adapterId}`);
  }
  if (route.accessContract !== "secret@1" || access.kind !== "secret" || access.contract !== "secret@1") {
    throw new Error(`prime.agent adapter ${route.adapterId} requires secret@1 access`);
  }
  if (route.adapterImplementationVersion !== mapping.implementationVersion) {
    throw new Error(`prime.agent does not support ${route.adapterId} implementation ${route.adapterImplementationVersion}`);
  }
  if (access.providerId !== route.providerId
    || access.adapterId !== route.adapterId
    || access.adapterImplementationVersion !== route.adapterImplementationVersion) {
    throw new Error(`prime.agent access does not match admitted provider ${route.providerId}`);
  }
  const fields = Object.keys(access.fields);
  if (fields.length !== 1 || fields[0] !== "api-key") {
    throw new Error(`prime.agent adapter ${route.adapterId} requires exactly the api-key secret field`);
  }
  validatePrimeEndpoint(access.endpoint, route.adapterId);
  requiredApiKey(access);
}

function primeAgentModel(route: HarnessAdmittedModelRoute, access: Extract<HarnessExecutionAccess, { kind: "secret" }>): PrimeAgentModel {
  const mapping = PRIME_ADAPTERS[route.adapterId];
  if (mapping === undefined) throw new Error(`prime.agent does not support provider adapter ${route.adapterId}`);
  const capabilities = access.modelCapabilities !== undefined
    && Object.hasOwn(access.modelCapabilities, route.modelId)
    ? access.modelCapabilities[route.modelId]
    : undefined;
  const hasDiscoveredTokenCapabilities = capabilities !== undefined
    && Number.isSafeInteger(capabilities.contextWindow)
    && capabilities.contextWindow > 0
    && Number.isSafeInteger(capabilities.maxOutputTokens)
    && capabilities.maxOutputTokens > 0;
  const primeCompactionReserveTokens = 16_384;
  if (hasDiscoveredTokenCapabilities && capabilities.contextWindow <= primeCompactionReserveTokens) {
    throw new Error(`prime.agent model ${route.modelId} context window cannot satisfy Prime's ${primeCompactionReserveTokens}-token compaction reserve`);
  }
  return Object.freeze({
    id: route.modelId,
    name: route.modelId,
    api: mapping.api,
    provider: nativePrimeProviderId(route),
    baseUrl: primeAgentExecutionBaseUrl(route.adapterId, access.endpoint),
    // Use exact provider-discovered limits when the execution lease carries
    // them. Keep the legacy conservative values when discovery has no limits;
    // model IDs are never used to infer capabilities.
    reasoning: capabilities?.reasoning === true,
    input: Object.freeze(capabilities?.imageInput === true ? ["text", "image"] as const : ["text"] as const),
    // Prime requires numeric prices; zero is an unknown-cost sentinel here.
    // Relayer billing never treats this transport metadata as authoritative.
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    contextWindow: hasDiscoveredTokenCapabilities ? capabilities.contextWindow : 32_768,
    maxTokens: hasDiscoveredTokenCapabilities
      ? Math.min(capabilities.maxOutputTokens, capabilities.contextWindow)
      : 4_096,
    ...(mapping.compat === undefined ? {} : { compat: {
      ...mapping.compat,
      ...(capabilities?.reasoningEffort === undefined ? {} : { supportsReasoningEffort: capabilities.reasoningEffort }),
    } }),
  });
}

function primeAgentExecutionBaseUrl(adapterId: string, endpoint: string): string {
  if (adapterId !== "anthropic-api") return endpoint;
  const url = new URL(endpoint);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/v1")) return endpoint;
  url.pathname = pathname.slice(0, -3) || "/";
  return url.toString().replace(/\/$/, "");
}

function nativePrimeProviderId(route: HarnessAdmittedModelRoute): string {
  return `relayer-${route.adapterId}-${Buffer.from(route.providerId, "utf8").toString("base64url")}`;
}

function admittedRouteIdentity(route: HarnessAdmittedModelRoute): string {
  return `${route.providerId}\0${route.adapterId}\0${route.accessContract}\0${route.modelId}\0${route.adapterImplementationVersion}`;
}

function nativeModelIdentity(provider: string, modelId: string): string {
  return `${provider}\0${modelId}`;
}

function requiredApiKey(access: Extract<HarnessExecutionAccess, { kind: "secret" }>): string {
  const apiKey = access.fields["api-key"];
  if (typeof apiKey !== "string" || apiKey.trim() === "") throw new Error(`prime.agent adapter ${access.adapterId} requires an api-key`);
  return apiKey;
}

function validatePrimeEndpoint(value: string, adapterId: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`prime.agent adapter ${adapterId} requires a valid endpoint`);
  }
  if ((endpoint.protocol !== "https:" && endpoint.protocol !== "http:")
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.hash !== "") {
    throw new Error(`prime.agent adapter ${adapterId} requires a safe HTTP endpoint`);
  }
}

function capabilityResponse(capability: GraphCapability): JsonObject {
  return { url: capability.url, token: capability.token, nodeId: capability.nodeId };
}

async function loadPrimeAgentModule(): Promise<PrimeAgentModule> {
  const packageName = "@earendil-works/pi-coding-agent";
  try {
    const loaded = await import(packageName) as unknown as Partial<PrimeAgentModule>;
    if (loaded.AGENT_RUN_MODEL_SCOPE_VERSION !== 1
      || typeof loaded.createAgentRunModelScope !== "function"
      || typeof loaded.createHostRequestHandler !== "function"
      || typeof loaded.createAgentSessionServices !== "function"
      || typeof loaded.createAgentSessionFromServices !== "function"
      || typeof loaded.SessionManager?.create !== "function"
      || typeof loaded.SessionManager?.open !== "function") {
      throw new Error("Installed Prime Agent package does not support version-1 run-scoped model authority");
    }
    return loaded as PrimeAgentModule;
  } catch (error) {
    throw new Error("The Prime Agent harness requires a build of @earendil-works/pi-coding-agent with version-1 run-scoped model authority", { cause: error });
  }
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`prime.agent ${field} must be a boolean`);
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`prime.agent ${field} must be a positive integer`);
  return value;
}

function optionalEnum<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`prime.agent ${field} must be one of: ${allowed.join(", ")}`);
  return value as T[number];
}

const PRIME_VISUAL_GUIDANCE = `For visual Node Details, import html, asset_ref, external_link, action_capability, ActionObject, and VisualAssetFile from relayer_graph. node.detail_authoring.set_component("main", html("<h2>Answer</h2>"), "h2 { color: blue; }") authors a component; node.detail remains the Markdown fallback. Each node’s detail must explain that node’s title and purpose. Reuse styles and layout helpers, but do not copy a whole explanation across siblings. If several nodes would have the same explanation, consolidate them. HTML binds permanently on first attachment, including fragments; copies retain ownership. Only node.detail_authoring authors components. For same-node repair reusing an existing template, call graph.bind_node(original) and graph.bind_node(replacement) before attachment; both must have the same stable client_key in this interaction. Use html(["<button gc=", ">Continue</button>"], action_capability("continue", action)) for a declared ActionObject. When present, source_layer must be the exact LayerObject containing that node; authorized node-owned navigate additions may use source_layer=None. Reuse the same action in await graph.add_action(node, action) after submitting nodes and layers. Navigate actions use kind="navigate", relation="expand" or "reference", and target=layer; invoke actions use interaction_text; input actions use control, prompt, and options. Checkpoint with await graph.checkpoint_node_detail(node). submit_node freezes the local object's detail; while the record remains a draft, use a fresh NodeObject with the same client_key for repairs. Accepted node identity and semantic content remain immutable; for an authorized attached-node replacement, read await graph.get_node_presentation(node_id). Use its node.clientKey for a fresh NodeObject, preserve all existing action clientKey, kind and sourceLayer provenance, and bind every new action. Reconstruct retained source layers with their sourceLayerClientKey and the exact presentation NodeObject as a member; omitted source provenance must stay omitted in its binding. Call await graph.replace_node_presentation(node_id, snapshot["revision"], presentation) to stage the full compiled detail without editing title or semantic text. On stale_presentation_revision, reread and repair the full replacement. Read the frozen policy through (await graph.get_interaction_input()).interaction_permissions; do not infer version-2 obligations from old or disabled preparations. Untouched detail retains its prior package; detail_authoring.clear() explicitly removes it.
Discover assets with graph.visual_assets.scope(), list_assets(scope=scope), list_tags(scope=scope), and inspect(asset_id, scope). Add caller-read bytes with VisualAssetFile(name, media_type, bytes) and await graph.visual_assets.add(file=file, scope=scope, name=name). Bind logical asset IDs with html(['<img asset=', ' alt="Description">'], asset_ref(asset_id)); the host resolves and pins content. Never supply compiled packages, mounts, hashes, raw image URLs, or executable JavaScript.`;

function primeVisualExample(interactionNodeId: number): string {
  return currentCommunicationAuthoringRecipePython(interactionNodeId);
}
