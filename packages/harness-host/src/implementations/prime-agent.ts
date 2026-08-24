import type { GraphCapability, GraphNode } from "@relayer/graph-client";
import { redactTraceData } from "../trace.js";
import type { Harness, HarnessFactory, HarnessFactoryContext, HarnessRunContext, HarnessSessionState, HarnessTraceStream, HarnessTraceSupport, JsonObject } from "../types.js";

export const PRIME_AGENT_KEY = "prime.agent";

interface PrimeAgentSession {
  readonly sessionFile?: string;
  promptAndWait(text: string, options: { readonly runContext: HarnessRunContext }): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  subscribe?(listener: (event: unknown) => void): () => void;
}

interface PrimeAgentSessionManagerFactory {
  create(cwd: string): unknown;
  open(path: string): unknown;
}

interface PrimeAgentModule {
  readonly SessionManager: PrimeAgentSessionManagerFactory;
  createHostRequestHandler<RunContext>(implementation: (
    payload: Record<string, unknown>,
    context: { readonly runContext?: RunContext; readonly signal: AbortSignal; isCurrent(): boolean },
  ) => Promise<Record<string, unknown>>): unknown;
  createAgentSessionServices(options: Record<string, unknown>): Promise<{
    readonly modelRegistry: { find(provider: string, modelId: string): unknown };
    readonly [key: string]: unknown;
  }>;
  createAgentSessionFromServices(options: Record<string, unknown>): Promise<{ readonly session: PrimeAgentSession }>;
}

export interface PrimeAgentDependencies {
  readonly loadModule?: () => Promise<PrimeAgentModule>;
}

interface PrimeAgentConfiguration {
  readonly model?: { readonly provider: string; readonly id: string };
  readonly thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly rlmMaxDepth?: number;
  readonly prewarmIpythonKernel?: boolean;
  readonly promptProfile?: "layered-navigation-v1";
}

export class PrimeAgentHarness implements Harness {
  private constructor(
    private readonly context: HarnessFactoryContext,
    private readonly session: PrimeAgentSession,
  ) {}

  static async create(context: HarnessFactoryContext, dependencies: PrimeAgentDependencies = {}): Promise<PrimeAgentHarness> {
    const configuration = parsePrimeAgentConfiguration(context);
    const primeAgent = await (dependencies.loadModule ?? loadPrimeAgentModule)();
    const graphCurrent = primeAgent.createHostRequestHandler<HarnessRunContext>(async (_payload, invocation) => {
      if (!invocation.isCurrent() || invocation.signal.aborted) throw new Error("The graph run is no longer active");
      const run = invocation.runContext;
      if (run === undefined) throw new Error("relayer.graph.current requires an active GraphComplete run");
      return capabilityResponse(run.graph.acquireCapability());
    });
    const savedSessionFile = context.savedState?.primeAgentSessionFile;
    const sessionManager = typeof savedSessionFile === "string"
      ? primeAgent.SessionManager.open(savedSessionFile)
      : primeAgent.SessionManager.create(context.workingDirectory);
    const services = await primeAgent.createAgentSessionServices({ cwd: context.workingDirectory, telemetryDisabled: true });
    const model = configuration.model === undefined ? undefined : services.modelRegistry.find(configuration.model.provider, configuration.model.id);
    if (configuration.model !== undefined && model === undefined) {
      throw new Error(`Prime Agent model is not available: ${configuration.model.provider}/${configuration.model.id}`);
    }
    const { session } = await primeAgent.createAgentSessionFromServices({
      services,
      sessionManager,
      tools: ["ipython"],
      hostRequestHandlers: { "relayer.graph.current": graphCurrent },
      telemetryDisabled: true,
      ...(model === undefined ? {} : { model }),
      ...(configuration.thinkingLevel === undefined ? {} : { thinkingLevel: configuration.thinkingLevel }),
      ...(configuration.rlmMaxDepth === undefined ? {} : { rlmMaxDepth: configuration.rlmMaxDepth }),
      ...(configuration.prewarmIpythonKernel === undefined ? {} : { prewarmIpythonKernel: configuration.prewarmIpythonKernel }),
    });
    return new PrimeAgentHarness(context, session);
  }

  async complete(context: HarnessRunContext, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const childStreams = new Map<string, HarnessTraceStream>();
    const unsubscribe = this.session.subscribe?.((event) => tracePrimeEvent(context, event, childStreams));
    const prompt = this.prompt(context.inputGraph);
    context.trace.emit({ type: "prompt", data: { text: prompt, interactionNodeId: context.inputGraph.id } });
    let abortOutcome: Promise<OperationOutcome<void>> | undefined;
    const abort = () => {
      if (abortOutcome !== undefined) return;
      abortOutcome = operationOutcome(() => this.session.abort());
    };
    signal?.addEventListener("abort", abort, { once: true });
    let promptOutcome: OperationOutcome<void>;
    try {
      promptOutcome = await operationOutcome(() => this.session.promptAndWait(prompt, { runContext: context }));
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe?.();
      for (const stream of childStreams.values()) stream.close("partial", { reason: "Prime Agent stopped reporting this child" });
    }
    const settledAbort = await abortOutcome;
    if (!promptOutcome.ok && settledAbort !== undefined && !settledAbort.ok) {
      throw new AggregateError([promptOutcome.error, settledAbort.error], "Prime Agent prompt and abort failed");
    }
    if (!promptOutcome.ok) throw promptOutcome.error;
    if (settledAbort !== undefined && !settledAbort.ok) throw settledAbort.error;
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

  async dispose(): Promise<void> {
    await this.session.dispose();
  }

  private prompt(interaction: GraphNode): string {
    if (this.context.configuration.settings.promptProfile === "layered-navigation-v1") {
      return this.layeredNavigationPrompt(interaction);
    }
    return `Complete the current Relayer interaction by using Python in IPython to author a useful graph response.

Current interaction node: ${interaction.id}
User text: ${interaction.detail}

Use this entry point:

from relayer_graph import GraphSession
graph = await GraphSession.current()

The graph scope is supplied by the host for this complete() execution and is inherited by your RLM children. Do not read graph credentials from environment variables or files.

Author nodes, edges, layers, and useful navigate or invoke actions. The visible response layer must contain 1 to 8 connected nodes. Finish the root execution only by calling:

Import NodePlacementObject and LayerLayoutObject from relayer_graph. Every new layer requires a version-1 LayerLayoutObject with exactly one NodePlacementObject(node, x, y) per member node. Coordinates are normalized numbers from 0 through 1 and express semantic relative position independently of the viewport. Place a one-node layer at (0.5, 0.5). Keep flow or time moving consistently, anchor hierarchy with a parent or summary, group related nodes, align comparisons, and avoid accidental overlap or edge crossings. Do not derive coordinates from pixels, window size, or inspector state.

await graph.submit(${interaction.id})

A model turn ending is not completion. If graph.submit() has not succeeded, continue working or report the blocking graph error.`;
  }

  private layeredNavigationPrompt(interaction: GraphNode): string {
    return `Complete the current Relayer interaction by using Python in IPython to author a useful graph response. A flat answer is valid. Add navigation only when opening it would materially improve understanding or support; apply that same test again inside every layer you author.

Current interaction node: ${interaction.id}
User text: ${interaction.detail}

Use this entry point:

from relayer_graph import GraphSession
graph = await GraphSession.current()

The graph scope is supplied by the host for this complete() execution and is inherited by your RLM children. Do not read graph credentials from environment variables or files. Author in whatever order fits the task, while submitting each referenced object before using it. The final graph call must be await graph.submit(${interaction.id}); call it only after the full response has been authored.

Navigation has two meanings:
- relation="expand" continues the explanation with a more detailed layer. Expansion must not point back to an expansion ancestor.
- relation="reference" opens supporting evidence or context. References may reuse an accepted layer, may point to other reference layers, and may revisit a layer.

The interaction node must have one root navigate action with relation="expand" and no source_layer. Every action on a response node must include source_layer: the LayerObject in which you are authoring that action. Expansion layers may author expand, reference, or invoke actions. A layer reached as a reference may author only reference actions. Do not create both expand and reference actions to the same new target layer.

Layers normally contain 1 to 5 nodes. A layer may contain 6 to 8 nodes only when keeping them together is important; pass that private reason as await graph.submit_layer(layer, size_justification="..."). Never mention or expose the size justification in user-facing node text. More than 8 nodes must be split into useful layers.

Import NodePlacementObject and LayerLayoutObject from relayer_graph. Every new root, expansion, and reference layer requires a version-1 LayerLayoutObject with exactly one NodePlacementObject(node, x, y) per member node. Coordinates are normalized numbers from 0 through 1 and express semantic relative position independently of the viewport. Place a one-node layer at (0.5, 0.5). Keep flow or time moving consistently, use a parent or summary node to anchor hierarchy, group related nodes spatially, align comparisons deliberately, and avoid accidental overlap or edge crossings where a clearer arrangement is available. Do not use pixels, window size, or inspector state. Example: layout = LayerLayoutObject((NodePlacementObject(first, 0.25, 0.5), NodePlacementObject(second, 0.75, 0.5))); layer = LayerObject((first, second), (edge,), layout).

Layer edges are exactly what the user sees and are undirected. Use supported Relayer icons and useful markdown detail. At any layer, add expand, reference, or invoke actions only when they materially improve the response.

The graph service enforces exact provenance, target visibility, layer size, expansion cycles, and accepted closure. If a call fails, read every natural-language issue, repair the rejected object or missing closure, and retry. A model turn ending is not completion. The task is complete only when the final graph.submit call succeeds.`;
  }
}

function tracePrimeEvent(context: HarnessRunContext, value: unknown, childStreams: Map<string, HarnessTraceStream>): void {
  if (!isRecord(value) || typeof value.type !== "string") return;
  const event = value as Record<string, unknown>;
  context.trace.emit({ type: "provider.event", data: { provider: "prime-agent", event: safePrimeEvent(event) } });
  if (event.type === "turn_start") {
    context.trace.emit({ type: "model.call.started", data: { provider: "prime-agent", eventType: event.type } });
  } else if (event.type === "turn_end") {
    context.trace.emit({ type: "model.call.completed", data: { provider: "prime-agent", eventType: event.type, status: "completed" } });
  } else if (event.type === "tool_execution_start") {
    context.trace.emit({ type: "tool.call.started", data: safePrimeToolEvent(event) });
  } else if (event.type === "tool_execution_end") {
    context.trace.emit({ type: "tool.call.completed", data: safePrimeToolEvent(event) });
  } else if (event.type === "message_end") {
    tracePrimeMessage(context, event.message);
  } else if (event.type === "rlm_child_update") {
    tracePrimeChild(context, event.child, childStreams);
  }
}

function tracePrimeMessage(context: HarnessRunContext, value: unknown): void {
  if (!isRecord(value)) return;
  const role = typeof value.role === "string" ? value.role : "unknown";
  if (role === "assistant" && Array.isArray(value.content)) {
    const text = value.content.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []);
    if (text.length > 0) context.trace.emit({ type: "message", data: { role, text: text.join("\n") } });
  }
  if (isRecord(value.usage)) context.trace.emit({ type: "usage", data: redactTraceData(value.usage) as JsonObject });
}

function tracePrimeChild(context: HarnessRunContext, value: unknown, childStreams: Map<string, HarnessTraceStream>): void {
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
  stream.emit({ type: "provider.event", data: { provider: "prime-agent", eventType: "rlm_child_update", child: redactTraceData(safePrimeChild(value)) } });
  const status = typeof value.status === "string" ? value.status : "";
  if (["completed", "failed", "cancelled"].includes(status)) {
    stream.close(status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed", { status });
    childStreams.delete(value.id);
  }
}

function safePrimeEvent(event: Record<string, unknown>) {
  if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
    return redactTraceData({ type: event.type, message: safePrimeMessage(event.message) });
  }
  if (event.type === "rlm_child_update") return redactTraceData({ type: event.type, child: safePrimeChild(event.child) });
  return redactTraceData(event);
}

function safePrimeMessage(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const content = Array.isArray(value.content)
    ? value.content.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [{ type: "text", text: block.text }] : [])
    : undefined;
  return { role: value.role, provider: value.provider, model: value.model, stopReason: value.stopReason, usage: value.usage, content };
}

function safePrimeToolEvent(event: Record<string, unknown>): JsonObject {
  return redactTraceData({
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    args: event.args,
    result: event.result,
    isError: event.isError,
  }) as JsonObject;
}

function safePrimeChild(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const allowed = ["id", "parentId", "sessionName", "model", "label", "status", "durationMs", "answerPreview", "toolUseCount", "tokenCount", "recap", "activity", "error"];
  return Object.fromEntries(allowed.flatMap((key) => value[key] === undefined ? [] : [[key, value[key]]]));
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
  if (context.permissionProfileId !== "full" || Object.keys(context.permissionBinding).length !== 0) {
    throw new Error("prime.agent currently supports only the Full access permission profile");
  }
  const settings = selected.settings;
  const allowed = new Set(["model", "thinkingLevel", "rlmMaxDepth", "prewarmIpythonKernel", "promptProfile"]);
  const unknown = Object.keys(settings).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown prime.agent configuration field: ${unknown.join(", ")}`);
  const model = optionalModel(settings.model);
  const thinkingLevel = optionalEnum(settings.thinkingLevel, ["minimal", "low", "medium", "high", "xhigh", "max"] as const, "thinkingLevel");
  const rlmMaxDepth = optionalPositiveInteger(settings.rlmMaxDepth, "rlmMaxDepth");
  const prewarmIpythonKernel = optionalBoolean(settings.prewarmIpythonKernel, "prewarmIpythonKernel");
  const promptProfile = optionalEnum(settings.promptProfile, ["layered-navigation-v1"] as const, "promptProfile");
  return {
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(rlmMaxDepth === undefined ? {} : { rlmMaxDepth }),
    ...(prewarmIpythonKernel === undefined ? {} : { prewarmIpythonKernel }),
    ...(promptProfile === undefined ? {} : { promptProfile }),
  };
}

function capabilityResponse(capability: GraphCapability): JsonObject {
  return { url: capability.url, token: capability.token, nodeId: capability.nodeId };
}

async function loadPrimeAgentModule(): Promise<PrimeAgentModule> {
  const packageName = "@earendil-works/pi-coding-agent";
  try {
    const loaded = await import(packageName) as unknown as Partial<PrimeAgentModule>;
    if (typeof loaded.createHostRequestHandler !== "function" || typeof loaded.createAgentSessionServices !== "function" || typeof loaded.createAgentSessionFromServices !== "function" || typeof loaded.SessionManager?.create !== "function" || typeof loaded.SessionManager?.open !== "function") {
      throw new Error("Installed Prime Agent package does not support run-scoped host context");
    }
    return loaded as PrimeAgentModule;
  } catch (error) {
    throw new Error("The Prime Agent harness requires a build of @earendil-works/pi-coding-agent with run-scoped host context support", { cause: error });
  }
}

function optionalModel(value: unknown): PrimeAgentConfiguration["model"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("prime.agent model must contain provider and id");
  const { provider, id } = value as Record<string, unknown>;
  if (typeof provider !== "string" || provider.trim() === "" || typeof id !== "string" || id.trim() === "" || Object.keys(value).some((key) => key !== "provider" && key !== "id")) {
    throw new Error("prime.agent model must contain only non-empty provider and id strings");
  }
  return { provider, id };
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
