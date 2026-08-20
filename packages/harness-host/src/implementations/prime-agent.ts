import type { GraphCapability, GraphNode } from "@relayer/graph-client";
import type { Harness, HarnessFactory, HarnessFactoryContext, HarnessRunContext, HarnessSessionState, JsonObject } from "../types.js";

export const PRIME_AGENT_KEY = "prime.agent";

interface PrimeAgentSession {
  readonly sessionFile?: string;
  promptAndWait(text: string, options: { readonly runContext: HarnessRunContext }): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
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
    let abortOutcome: Promise<OperationOutcome<void>> | undefined;
    const abort = () => {
      if (abortOutcome !== undefined) return;
      abortOutcome = operationOutcome(() => this.session.abort());
    };
    signal?.addEventListener("abort", abort, { once: true });
    let promptOutcome: OperationOutcome<void>;
    try {
      promptOutcome = await operationOutcome(() => this.session.promptAndWait(this.prompt(context.inputGraph), { runContext: context }));
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    const settledAbort = await abortOutcome;
    if (!promptOutcome.ok && settledAbort !== undefined && !settledAbort.ok) {
      throw new AggregateError([promptOutcome.error, settledAbort.error], "Prime Agent prompt and abort failed");
    }
    if (!promptOutcome.ok) throw promptOutcome.error;
    if (settledAbort !== undefined && !settledAbort.ok) throw settledAbort.error;
  }

  state(): HarnessSessionState {
    return this.session.sessionFile === undefined ? {} : { primeAgentSessionFile: this.session.sessionFile };
  }

  async dispose(): Promise<void> {
    await this.session.dispose();
  }

  private prompt(interaction: GraphNode): string {
    return `Complete the current Relayer interaction by using Python in IPython to author a useful graph response.

Current interaction node: ${interaction.id}
User text: ${interaction.detail}

Use this entry point:

from relayer_graph import GraphSession
graph = await GraphSession.current()

The graph scope is supplied by the host for this complete() execution and is inherited by your RLM children. Do not read graph credentials from environment variables or files.

Author nodes, edges, layers, and useful navigate or invoke actions. The visible response layer must contain 1 to 8 connected nodes. Finish the root execution only by calling:

await graph.submit(${interaction.id})

A model turn ending is not completion. If graph.submit() has not succeeded, continue working or report the blocking graph error.`;
  }
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
  const allowed = new Set(["model", "thinkingLevel", "rlmMaxDepth", "prewarmIpythonKernel"]);
  const unknown = Object.keys(settings).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown prime.agent configuration field: ${unknown.join(", ")}`);
  const model = optionalModel(settings.model);
  const thinkingLevel = optionalEnum(settings.thinkingLevel, ["minimal", "low", "medium", "high", "xhigh", "max"] as const, "thinkingLevel");
  const rlmMaxDepth = optionalPositiveInteger(settings.rlmMaxDepth, "rlmMaxDepth");
  const prewarmIpythonKernel = optionalBoolean(settings.prewarmIpythonKernel, "prewarmIpythonKernel");
  return {
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(rlmMaxDepth === undefined ? {} : { rlmMaxDepth }),
    ...(prewarmIpythonKernel === undefined ? {} : { prewarmIpythonKernel }),
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
