import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { GraphCapability } from "@relayer/graph-client";
import { MAX_HARNESS_APPROVAL_TEXT_LENGTH } from "../approval.js";
import { INTERACTION_INPUT_GUIDANCE, renderInteractionInput } from "../interaction-input.js";
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

export const PRIME_AGENT_KEY = "prime.agent";

interface PrimeAgentSession {
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
}

interface PrimeAgentSessionManagerFactory {
  create(cwd: string): unknown;
  open(path: string): unknown;
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
  /** Deterministic test seam; production uses the platform workspace boundary. */
  readonly createKernelBoundary?: (input: {
    readonly workspaceRoot: string;
    readonly workspaceScopeDigest: string;
  }) => PrimeAgentKernelBoundaryFactory;
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
  readonly compat?: Readonly<Record<string, unknown>>;
}

interface PrimeAgentExecutionScope {
  readonly modelScope: unknown;
  readonly orchestrator: HarnessAdmittedModelRoute;
  readonly routeByNativeModel: ReadonlyMap<string, HarnessAdmittedModelRoute>;
  readonly sensitiveValues: readonly string[];
}

const PRIME_ADAPTERS: Readonly<Record<string, PrimeAdapterMapping>> = Object.freeze({
  "openai-api": Object.freeze({ api: "openai-responses" }),
  "anthropic-api": Object.freeze({ api: "anthropic-messages" }),
  openrouter: Object.freeze({ api: "openai-completions", compat: Object.freeze({ thinkingFormat: "openrouter", openRouterRouting: Object.freeze({}) }) }),
  "vercel-ai-router": Object.freeze({ api: "openai-completions", compat: Object.freeze({ vercelGatewayRouting: Object.freeze({}) }) }),
});

export class PrimeAgentHarness implements Harness {
  private forceShutdownStarted = false;
  private gracefullyDisposed = false;
  private gracefulDisposePromise: Promise<void> | undefined;
  private nativeDisposeInProgress = false;
  private nativeDisposeCompleted = false;
  private disposeGuardInstalled = false;
  private readonly nativeSessionDispose: () => void;

  private constructor(
    private readonly context: HarnessFactoryContext,
    private readonly session: PrimeAgentSession,
    private readonly primeAgent: PrimeAgentModule,
    private readonly permission: PrimeAgentPermission,
    private readonly workspaceRoot: string,
    private readonly createKernelBoundary: PrimeAgentDependencies["createKernelBoundary"],
  ) {
    this.nativeSessionDispose = session.dispose.bind(session);
  }

  static async create(context: HarnessFactoryContext, dependencies: PrimeAgentDependencies = {}): Promise<PrimeAgentHarness> {
    const configuration = parsePrimeAgentConfiguration(context);
    const permission = parsePrimeAgentPermission(context);
    const primeAgent = await (dependencies.loadModule ?? loadPrimeAgentModule)();
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
    const savedSessionFile = context.savedState?.primeAgentSessionFile;
    const sessionManager = typeof savedSessionFile === "string"
      ? primeAgent.SessionManager.open(savedSessionFile)
      : primeAgent.SessionManager.create(workspaceRoot);
    const services = await primeAgent.createAgentSessionServices({ cwd: workspaceRoot, telemetryDisabled: true });
    const prewarmIpythonKernel = permission.profile === "full"
      ? configuration.prewarmIpythonKernel
      : false;
    const { session } = await primeAgent.createAgentSessionFromServices({
      services,
      sessionManager,
      tools: ["ipython"],
      hostRequestHandlers: { "relayer.graph.current": graphCurrent },
      telemetryDisabled: true,
      ...(configuration.thinkingLevel === undefined ? {} : { thinkingLevel: configuration.thinkingLevel }),
      ...(configuration.rlmMaxDepth === undefined ? {} : { rlmMaxDepth: configuration.rlmMaxDepth }),
      ...(prewarmIpythonKernel === undefined ? {} : { prewarmIpythonKernel }),
    });
    if (typeof session.waitForRlmQuiescence !== "function") {
      await session.dispose();
      throw new Error("Installed Prime Agent package does not expose recursive quiescence");
    }
    return new PrimeAgentHarness(
      context,
      session,
      primeAgent,
      permission,
      workspaceRoot,
      dependencies.createKernelBoundary,
    );
  }

  async complete(context: HarnessRunContext, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const execution = createPrimeAgentModelScope(context, this.primeAgent);
    const runContext: PrimeAgentRunContext = Object.freeze({ graph: context.graph });
    const permissions = createPrimeAgentPermissionScopes({
      context,
      runContext,
      primeAgent: this.primeAgent,
      permission: this.permission,
      workspaceRoot: this.workspaceRoot,
      createKernelBoundary: this.createKernelBoundary,
    });
    const childStreams = new Map<string, HarnessTraceStream>();
    const unsubscribe = this.session.subscribe?.((event) => tracePrimeEvent(context, event, childStreams, execution));
    const runtimeProvenance = primeRuntimeProvenance(process.env.RELAYER_PRIME_RUNTIME_PROVENANCE);
    if (runtimeProvenance) context.trace.emit({
      type: "provider.event",
      data: { provider: "prime-agent", event: { type: "runtime.provenance", ...runtimeProvenance } },
    });
    const prompt = this.prompt(context);
    context.trace.emit({ type: "prompt", data: { text: prompt, interactionNodeId: context.inputGraph.id } });
    let abortOutcome: Promise<OperationOutcome<void>> | undefined;
    const abort = () => {
      if (abortOutcome !== undefined) return;
      abortOutcome = operationOutcome(() => this.session.abort());
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
      promptOutcome = await operationOutcome(() => this.session.promptAndWait(prompt, {
        runContext,
        modelScope: execution.modelScope,
        ...permissions,
      }));
      quiescenceOutcome = await operationOutcome(() => this.session.waitForRlmQuiescence());
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
    return this.session.sessionFile === undefined ? {} : { primeAgentSessionFile: this.session.sessionFile };
  }

  dispose(): Promise<void> {
    if (this.gracefulDisposePromise !== undefined) return this.gracefulDisposePromise;
    if (this.nativeDisposeCompleted) return Promise.resolve();
    this.installNativeDisposeGuard();
    this.gracefulDisposePromise = Promise.resolve()
      .then(async () => {
        if (this.nativeDisposeCompleted) return;
        if (this.session.disposeAsync !== undefined) await this.session.disposeAsync();
        else if (!this.nativeDisposeCompleted) this.disposeNativeOnce();
        if (!this.nativeDisposeCompleted && this.session.disposeAsync !== undefined) {
          // A conforming disposeAsync drains resources and owns native disposal.
          // Mark the harness terminal even if it does not call the guarded
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
    this.installNativeDisposeGuard();
    try {
      void this.session.abort().catch(() => undefined);
    } catch {
      // Force disposal must continue even if a nonconforming provider throws
      // synchronously instead of returning a rejected abort promise.
    }
    this.disposeNativeOnce();
  }

  private installNativeDisposeGuard(): void {
    if (this.disposeGuardInstalled) return;
    this.disposeGuardInstalled = true;
    this.session.dispose = () => this.disposeNativeOnce();
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

  private prompt(context: HarnessRunContext): string {
    const interaction = context.inputGraph;
    if (this.context.configuration.settings.promptProfile === "layered-navigation-v1") {
      return this.layeredNavigationPrompt(context);
    }
    return `Complete the current Relayer interaction by using Python in IPython to author a useful graph response.

Current interaction node: ${interaction.id}
Normalized interaction input:
${renderInteractionInput(context.interactionInput)}

${INTERACTION_INPUT_GUIDANCE} In Python, call await graph.get_interaction_input() to re-read it.

Use this entry point:

from relayer_graph import GraphSession
graph = await GraphSession.current()

The graph scope is supplied by the host for this complete() execution and is inherited by your RLM children. Do not read graph credentials from environment variables or files. Give every persisted NodeObject, EdgeObject, LayerObject, navigate action, and invoke action an explicit descriptive client_key that is unique within this interaction and stable across edits and reruns. Never rely on generated client keys in authored code.

Author nodes, edges, layers, and useful navigate or invoke actions. The visible response layer must contain 1 to 8 connected nodes. Finish the root execution only by calling:

Import NodePlacementObject and LayerLayoutObject from relayer_graph. Every new layer requires a version-1 LayerLayoutObject with exactly one NodePlacementObject(node, x, y) per member node. Coordinates are normalized numbers from 0 through 1 and express semantic relative position independently of the viewport. Place a one-node layer at (0.5, 0.5). Keep flow or time moving consistently, anchor hierarchy with a parent or summary, group related nodes, align comparisons, and avoid accidental overlap or edge crossings. Do not derive coordinates from pixels, window size, or inspector state.

await graph.submit(${interaction.id})

If a graph call fails, edit and rerun the same authoring code with the same client_key values so it updates the same drafts instead of creating duplicates. Do not add fake navigation merely to make abandoned drafts reachable. Only when graph.submit identifies a genuinely abandoned orphan draft, recover with await graph.discard_layer(layer); this preserves that layer as stopped history without discarding its graph objects. A model turn ending is not completion. If graph.submit() has not succeeded, continue working or report the blocking graph error.`;
  }

  private layeredNavigationPrompt(context: HarnessRunContext): string {
    const interaction = context.inputGraph;
    return `Complete the current Relayer interaction by using Python in IPython to author a useful graph response. A flat answer is valid. Add navigation only when opening it would materially improve understanding or support; apply that same test again inside every layer you author.

Current interaction node: ${interaction.id}
Normalized interaction input:
${renderInteractionInput(context.interactionInput)}

${INTERACTION_INPUT_GUIDANCE} In Python, call await graph.get_interaction_input() to re-read it.

Use this entry point:

from relayer_graph import GraphSession
graph = await GraphSession.current()

The graph scope is supplied by the host for this complete() execution and is inherited by your RLM children. Do not read graph credentials from environment variables or files. Give every persisted NodeObject, EdgeObject, LayerObject, navigate action, and invoke action an explicit descriptive client_key that is unique within this interaction and stable across edits and reruns. For example, use NodeObject("info", "Summary", "...", client_key="summary-node"), EdgeObject((summary_node, detail_node), client_key="summary-detail-edge"), and LayerObject(nodes, edges, layout, client_key="response-layer"). Never rely on generated client keys in authored code. Author in whatever order fits the task, while submitting each referenced object before using it. The final graph call must be await graph.submit(${interaction.id}); call it only after the full response has been authored.

The current interaction may carry an invoke lease created by the product. Before authoring, use await graph.get_node(${interaction.id}) and await graph.get_neighbors(${interaction.id}) to inspect the current node and any relevant source context exposed by the graph. Treat that context as input to your answer; do not copy, forge, or manage lease metadata. Author the response normally. A successful ordinary graph.submit(${interaction.id}) automatically fulfills any lease held by this interaction. There is no separate resolve_action call.

Navigation has two meanings:
- relation="expand" continues the explanation with a more detailed layer. Expansion must not point back to an expansion ancestor.
- relation="reference" opens supporting evidence or context. References may reuse an accepted layer, may point to other reference layers, and may revisit a layer.

The interaction node must have one root navigate action with relation="expand" and no source_layer. Every action on a response node must include source_layer: the LayerObject in which you are authoring that action. Expansion layers may author expand, reference, or invoke actions. A layer reached as a reference may author only reference actions. Do not create both expand and reference actions to the same new target layer.

Examples:
await graph.add_navigate_action(${interaction.id}, "Response", root_layer, relation="expand", client_key="root-response")
await graph.add_navigate_action(node, "Explain further", detail_layer, relation="expand", source_layer=root_layer, client_key="node-detail")
await graph.add_navigate_action(node, "View evidence", evidence_layer, relation="reference", source_layer=root_layer, client_key="node-evidence")
await graph.add_invoke_action(node, "Follow up", "Ask a useful follow-up", source_layer=root_layer, client_key="node-follow-up")

Layers normally contain 1 to 5 nodes. A layer may contain 6 to 8 nodes only when keeping them together is important; pass that private reason as await graph.submit_layer(layer, size_justification="..."). Never mention or expose the size justification in user-facing node text. More than 8 nodes must be split into useful layers.

Import NodePlacementObject and LayerLayoutObject from relayer_graph. Every new root, expansion, and reference layer requires a version-1 LayerLayoutObject with exactly one NodePlacementObject(node, x, y) per member node. Coordinates are normalized numbers from 0 through 1 and express semantic relative position independently of the viewport. Place a one-node layer at (0.5, 0.5). Keep flow or time moving consistently, use a parent or summary node to anchor hierarchy, group related nodes spatially, align comparisons deliberately, and avoid accidental overlap or edge crossings where a clearer arrangement is available. Do not use pixels, window size, or inspector state. Example: layout = LayerLayoutObject((NodePlacementObject(first, 0.25, 0.5), NodePlacementObject(second, 0.75, 0.5))); layer = LayerObject((first, second), (edge,), layout, client_key="response-layer").

Layer edges are exactly what the user sees and are undirected. Use supported Relayer icons and useful markdown detail. At any layer, add expand, reference, or invoke actions only when they materially improve the response.

The graph service enforces exact provenance, target visibility, layer size, expansion cycles, and accepted closure. If a call fails, read every natural-language issue, edit the same authoring code, and rerun it with the same client_key values; stable keys make the whole-program rerun update the same drafts instead of creating duplicates. Do not add fake navigate or reference actions merely to make abandoned draft layers reachable. Only when graph.submit identifies a genuinely abandoned orphan draft, recover with await graph.discard_layer(layer); this preserves that layer as stopped history without discarding its nodes, edges, actions, or child layers. A model turn ending is not completion. The task is complete only when the final graph.submit call succeeds.`;
  }
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
  context.trace.emit({ type: "provider.event", data: { provider: "prime-agent", event: safePrimeEvent(event, execution.routeByNativeModel, execution.sensitiveValues) } });
  if (event.type === "turn_start") {
    context.trace.emit({ type: "model.call.started", data: { provider: "prime-agent", eventType: event.type, ...traceRoute(execution.orchestrator) } });
  } else if (event.type === "turn_end") {
    context.trace.emit({ type: "model.call.completed", data: { provider: "prime-agent", eventType: event.type, status: "completed", ...traceRoute(execution.orchestrator) } });
  } else if (event.type === "tool_execution_start") {
    context.trace.emit({ type: "tool.call.started", data: safePrimeToolEvent(event, execution.sensitiveValues) });
  } else if (event.type === "tool_execution_end") {
    context.trace.emit({ type: "tool.call.completed", data: safePrimeToolEvent(event, execution.sensitiveValues) });
  } else if (event.type === "message_end") {
    tracePrimeMessage(context, event.message, execution.routeByNativeModel, execution.sensitiveValues);
  } else if (event.type === "rlm_child_update") {
    tracePrimeChild(context, event.child, childStreams, execution.routeByNativeModel, execution.sensitiveValues);
  }
}

function tracePrimeMessage(
  context: HarnessRunContext,
  value: unknown,
  routes: ReadonlyMap<string, HarnessAdmittedModelRoute>,
  sensitiveValues: readonly string[],
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
        text: sanitizePrimeTraceValue(text.join("\n"), sensitiveValues) as string,
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
      child: redactTraceData(safePrimeChild(value, routes, sensitiveValues)),
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
): JsonObject {
  const type = typeof event.type === "string" ? event.type : "unknown";
  if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
    return redactTraceData({ type, message: safePrimeMessage(event.message, routes, sensitiveValues) }) as JsonObject;
  }
  if (event.type === "rlm_child_update") {
    return redactTraceData({ type, child: safePrimeChild(event.child, routes, sensitiveValues) }) as JsonObject;
  }
  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
    return { type, ...safePrimeToolEvent(event, sensitiveValues) };
  }
  return { type };
}

function safePrimeMessage(
  value: unknown,
  routes: ReadonlyMap<string, HarnessAdmittedModelRoute>,
  sensitiveValues: readonly string[],
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
  }, sensitiveValues);
}

function safePrimeToolEvent(event: Record<string, unknown>, sensitiveValues: readonly string[]): JsonObject {
  return redactTraceData(sanitizePrimeTraceValue({
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    args: event.args,
    result: event.result,
    isError: event.isError,
  }, sensitiveValues)) as JsonObject;
}

function sanitizePrimeTraceValue(value: unknown, sensitiveValues: readonly string[]): unknown {
  if (typeof value === "string") {
    return sensitiveValues.reduce((sanitized, secret) => sanitized.split(secret).join("[redacted-provider-access]"), value);
  }
  if (Array.isArray(value)) return value.map((child) => sanitizePrimeTraceValue(child, sensitiveValues));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => (
    /^(?:endpoint|base[_-]?url)$/i.test(key) ? [] : [[key, sanitizePrimeTraceValue(child, sensitiveValues)]]
  )));
}

function safePrimeChild(
  value: unknown,
  routes: ReadonlyMap<string, HarnessAdmittedModelRoute>,
  sensitiveValues: readonly string[],
): unknown {
  if (!isRecord(value)) return value;
  const allowed = ["id", "parentId", "sessionName", "label", "status", "durationMs", "answerPreview", "toolUseCount", "tokenCount", "recap", "activity", "error"];
  const safe = Object.fromEntries(allowed.flatMap((key) => value[key] === undefined ? [] : [[key, value[key]]]));
  const route = traceRouteForValue(value, routes);
  return sanitizePrimeTraceValue({ ...safe, ...(route === undefined ? {} : traceRoute(route)) }, sensitiveValues);
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
  const allowed = new Set(["thinkingLevel", "rlmMaxDepth", "prewarmIpythonKernel", "promptProfile"]);
  const unknown = Object.keys(settings).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown prime.agent configuration field: ${unknown.join(", ")}`);
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
  });
}

function validatePrimeAgentAccess(route: HarnessAdmittedModelRoute, access: HarnessExecutionAccess): asserts access is Extract<HarnessExecutionAccess, { kind: "secret" }> {
  if (PRIME_ADAPTERS[route.adapterId] === undefined) {
    throw new Error(`prime.agent does not support provider adapter ${route.adapterId}`);
  }
  if (route.accessContract !== "secret@1" || access.kind !== "secret" || access.contract !== "secret@1") {
    throw new Error(`prime.agent adapter ${route.adapterId} requires secret@1 access`);
  }
  if (route.adapterImplementationVersion !== "1") {
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
  return Object.freeze({
    id: route.modelId,
    name: route.modelId,
    api: mapping.api,
    provider: nativePrimeProviderId(route),
    baseUrl: access.endpoint,
    // The v1 Relayer route does not carry capability or pricing metadata. Keep
    // the transport model deliberately conservative and never infer from IDs.
    reasoning: false,
    input: Object.freeze(["text"] as const),
    // Prime requires numeric prices; zero is an unknown-cost sentinel here.
    // Relayer billing never treats this transport metadata as authoritative.
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    contextWindow: 32_768,
    maxTokens: 4_096,
    ...(mapping.compat === undefined ? {} : { compat: mapping.compat }),
  });
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
