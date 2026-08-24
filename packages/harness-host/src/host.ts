import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { GraphApiError, RelayerGraphClient, type GraphCapability } from "@relayer/graph-client";
import {
  HarnessApprovalCoordinator,
  HarnessApprovalCoordinatorError,
  type HarnessApprovalChannel,
  type HarnessApprovalResolution,
  type HarnessApprovalSnapshot,
} from "./approval-coordinator.js";
import {
  isJsonObject,
  parseHarnessConfiguration,
  sameHarnessExecutionConfiguration,
} from "./configuration.js";
import { resolveHarnessFactory } from "./registry.js";
import {
  HarnessTraceStore,
  NO_HARNESS_TRACE_SUPPORT,
  createNoopHarnessTraceSink,
  type HarnessTraceExportCorrelation,
  type HarnessTraceStoreOptions,
} from "./trace.js";
import type {
  Harness,
  HarnessCompleteResult,
  HarnessConfiguration,
  HarnessImplementationMap,
  InteractionModelSelection,
  HarnessGraphScope,
  HarnessSessionDescriptor,
  HarnessSessionRegistration,
  HarnessSessionState,
  HarnessCompletionTraceContext,
  HarnessTraceDescriptor,
} from "./types.js";

interface LiveSession {
  descriptor: HarnessSessionDescriptor;
  harness: Harness;
  approvals: HarnessApprovalCoordinator;
  tail: Promise<void>;
  activeCompletion?: {
    readonly completeCallId: string;
    readonly interactionId: number;
    readonly controller: AbortController;
  };
}

interface PersistedHarnessSessionDescriptor {
  readonly threadId: number;
  readonly configuration: HarnessConfiguration;
  readonly permissionProfileId: string;
  readonly workingDirectory: string;
  readonly state?: HarnessSessionState;
}

interface LegacyPersistedHarnessSessionDescriptor {
  readonly threadId: number;
  readonly configuration: Omit<HarnessConfiguration, "permissionBindings">;
  readonly workingDirectory: string;
  readonly state?: HarnessSessionState;
}

export interface HarnessHostOptions {
  readonly implementations: HarnessImplementationMap;
  readonly stateFile: string;
  readonly controlToken: string;
  readonly host?: string;
  readonly port?: number;
  readonly trace?: HarnessTraceStoreOptions;
}

export interface RunningHarnessHost {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly host: HarnessHost;
}

export class HarnessHost {
  private readonly sessions = new Map<number, LiveSession>();
  private readonly registrationTails = new Map<number, Promise<void>>();
  private saved = new Map<number, PersistedHarnessSessionDescriptor>();
  private legacySaved = new Map<number, LegacyPersistedHarnessSessionDescriptor>();
  private persistTail: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly traceStore: HarnessTraceStore | undefined;

  constructor(private readonly options: HarnessHostOptions) {
    this.traceStore = options.trace === undefined ? undefined : new HarnessTraceStore(options.trace);
  }

  async initialize(): Promise<void> {
    try {
      const serialized = await readFile(this.options.stateFile, "utf8");
      const parsed = JSON.parse(serialized) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) {
        throw new Error("Unsupported harness host state; expected schema version 3 or 4");
      }
      if (parsed.schemaVersion === 3) {
        await this.backupLegacyState(serialized);
        this.legacySaved = readLegacySessions(parsed.sessions);
        await this.persist();
        return;
      }
      if (parsed.schemaVersion !== 4) {
        throw new Error("Unsupported harness host state; expected schema version 3 or 4");
      }
      const sessions = uniqueSessions(parsed.sessions.map(readPersistedSession));
      this.saved = new Map(sessions.map((session) => [session.threadId, session]));
      if (parsed.legacySessions !== undefined && !Array.isArray(parsed.legacySessions)) {
        throw new Error("Harness state contains invalid legacy sessions");
      }
      this.legacySaved = readLegacySessions(parsed.legacySessions ?? []);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async createSession(descriptor: HarnessSessionRegistration): Promise<void> {
    if (this.closed) throw new Error("Harness host is closed");
    const normalized = { ...descriptor, configuration: parseHarnessConfiguration(descriptor.configuration) };
    permissionBinding(normalized.configuration, normalized.permissionProfileId);
    return this.withRegistrationLock(normalized.threadId, () => this.registerSession(normalized));
  }

  private async registerSession(descriptor: HarnessSessionRegistration): Promise<void> {
    if (this.closed) throw new Error("Harness host is closed");
    const live = this.sessions.get(descriptor.threadId);
    if (live !== undefined) {
      await this.withSessionLock(live, async () => {
        if (!sameHarnessExecutionConfiguration(live.descriptor.configuration, descriptor.configuration)
          || live.descriptor.permissionProfileId !== descriptor.permissionProfileId
          || live.descriptor.workingDirectory !== descriptor.workingDirectory) {
          throw new Error(`Thread ${descriptor.threadId} is already pinned to harness configuration ${live.descriptor.configuration.name}`);
        }
        live.descriptor = {
          ...descriptor,
          state: captureHarnessState(live.harness),
        };
        this.saved.set(descriptor.threadId, persistedDescriptor(live.descriptor));
        await this.persist();
      });
      return;
    }
    const prior = this.saved.get(descriptor.threadId);
    if (prior !== undefined && (!sameHarnessExecutionConfiguration(prior.configuration, descriptor.configuration)
      || prior.permissionProfileId !== descriptor.permissionProfileId
      || prior.workingDirectory !== descriptor.workingDirectory)) {
      throw new Error(`Thread ${descriptor.threadId} is already pinned to harness configuration ${prior.configuration.name}`);
    }
    const legacy = this.legacySaved.get(descriptor.threadId);
    const legacyState = legacy !== undefined
      && descriptor.permissionProfileId === legacyPermissionProfileId(descriptor.configuration)
      && sameLegacyHarnessConfiguration(legacy.configuration, descriptor.configuration)
      && legacy.workingDirectory === descriptor.workingDirectory
      ? legacy.state
      : undefined;
    const savedState = prior?.state ?? legacyState;
    const harness = await resolveHarnessFactory(this.options.implementations, descriptor.configuration.implementation)({
      threadId: descriptor.threadId,
      workingDirectory: descriptor.workingDirectory,
      configuration: descriptor.configuration,
      permissionProfileId: descriptor.permissionProfileId,
      permissionBinding: permissionBinding(descriptor.configuration, descriptor.permissionProfileId),
      ...(savedState === undefined ? {} : { savedState }),
    });
    if (this.closed) {
      await harness.dispose?.();
      throw new Error("Harness host closed while the session was starting");
    }
    let state: HarnessSessionState;
    try {
      state = captureHarnessState(harness);
    } catch (error) {
      try {
        await harness.dispose?.();
      } catch (disposeError) {
        throw new AggregateError([error, disposeError], "Harness session initialization and cleanup failed");
      }
      throw error;
    }
    const persisted: HarnessSessionDescriptor = { ...descriptor, state };
    this.sessions.set(descriptor.threadId, {
      descriptor: persisted,
      harness,
      approvals: new HarnessApprovalCoordinator({ threadId: descriptor.threadId }),
      tail: Promise.resolve(),
    });
    this.saved.set(descriptor.threadId, persistedDescriptor(persisted));
    this.legacySaved.delete(descriptor.threadId);
    await this.persist();
  }

  async complete(
    threadId: number,
    interactionId: number,
    capability: GraphCapability,
    signal?: AbortSignal,
  ): Promise<HarnessCompleteResult>;
  async complete(
    threadId: number,
    interactionId: number,
    capability: GraphCapability,
    model: InteractionModelSelection | undefined,
    signal?: AbortSignal,
    traceContext?: HarnessCompletionTraceContext,
  ): Promise<HarnessCompleteResult>;
  async complete(
    threadId: number,
    interactionId: number,
    capability: GraphCapability,
    modelOrSignal?: InteractionModelSelection | AbortSignal,
    trailingSignal?: AbortSignal,
    traceContext?: HarnessCompletionTraceContext,
  ): Promise<HarnessCompleteResult> {
    if (this.closed) throw new Error("Harness host is closed");
    if (!Number.isSafeInteger(interactionId) || interactionId < 1) throw new Error("Harness interactionId must be a positive integer");
    validateGraphCapability(capability);
    const model = isAbortSignal(modelOrSignal) ? undefined : modelOrSignal;
    const signal = isAbortSignal(modelOrSignal) ? modelOrSignal : trailingSignal;
    if (model !== undefined) validateInteractionModelSelection(model);
    const session = this.liveSession(threadId);
    if (model !== undefined) validateConfiguredModelSelection(session.descriptor.configuration, model);
    return this.withSessionLock(session, async () => {
      const controller = new AbortController();
      const detachSignal = forwardAbort(signal, controller);
      const completeCallId = randomUUID();
      const approvals = session.approvals.beginCompletion({ interactionId, completeCallId });
      session.activeCompletion = { completeCallId, interactionId, controller };
      const abortApprovals = () => session.approvals.endCompletion(
        completeCallId,
        "aborted",
        "Harness completion ended before the approval was resolved.",
      );
      controller.signal.addEventListener("abort", abortApprovals, { once: true });
      let result: HarnessCompleteResult | undefined;
      let operationError: unknown;
      try {
        if (this.closed) throw new Error("Harness host is closed");
        controller.signal.throwIfAborted();
        result = await this.executeCompletion(
          threadId,
          session,
          capability,
          model,
          approvals,
          controller.signal,
          traceContext,
        );
      } catch (error) {
        operationError = error;
      }
      session.approvals.endCompletion(
        completeCallId,
        "aborted",
        "Harness completion ended before the approval was resolved.",
      );
      controller.signal.removeEventListener("abort", abortApprovals);
      if (session.activeCompletion?.controller === controller) delete session.activeCompletion;
      detachSignal();
      const errors: unknown[] = operationError === undefined ? [] : [operationError];
      try {
        session.descriptor = { ...session.descriptor, state: captureHarnessState(session.harness) };
        this.saved.set(threadId, persistedDescriptor(session.descriptor));
        await this.persist();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Harness completion and cleanup failed");
      return result!;
    });
  }

  private async executeCompletion(
    threadId: number,
    session: LiveSession,
    capability: GraphCapability,
    model: InteractionModelSelection | undefined,
    approvals: HarnessApprovalChannel,
    signal: AbortSignal,
    traceContext?: HarnessCompletionTraceContext,
  ): Promise<HarnessCompleteResult> {
    const graph = new RelayerGraphClient(capability);
    const interactionNodeId = capability.nodeId;
    try {
      const output = await graph.getCompletionOutput(interactionNodeId);
      return { threadId, configurationName: session.descriptor.configuration.name, output, trace: disabledTraceDescriptor() };
    } catch (error) {
      if (!(error instanceof GraphApiError && error.status === 404 && error.code === "completion_not_found")) throw error;
    }
    const interaction = await graph.getNode(interactionNodeId);
    const scope = new ActiveHarnessGraphScope(capability);
    const support = session.harness.traceSupport?.() ?? NO_HARNESS_TRACE_SUPPORT;
    const trace = this.traceStore?.start({
      threadId,
      interactionNodeId,
      ...(traceContext === undefined ? {} : { productInteractionId: traceContext.productInteractionId }),
      implementation: session.descriptor.configuration.implementation,
      configurationName: session.descriptor.configuration.name,
      support,
    });
    const traceSink = trace?.sink ?? createNoopHarnessTraceSink();
    let completionError: unknown;
    try {
      await session.harness.complete({
        inputGraph: interaction,
        graph: scope,
        approvals,
        trace: traceSink,
        ...(model === undefined ? {} : { model }),
      }, signal);
    } catch (error) {
      completionError = error;
    } finally {
      scope.close();
    }
    if (completionError !== undefined) {
      traceSink.emit({
        type: signal.aborted ? "cancelled" : "error",
        data: { message: errorMessage(completionError) },
      });
      await sealTrace(trace, signal.aborted ? "partial" : "failed", errorMessage(completionError));
      throw completionError;
    }
    try {
      const output = await graph.getCompletionOutput(interactionNodeId);
      const traceDescriptor = await sealTrace(trace, "complete");
      return { threadId, configurationName: session.descriptor.configuration.name, output, trace: traceDescriptor };
    } catch (error) {
      if (error instanceof GraphApiError && error.status === 404 && error.code === "completion_not_found") {
        const completionMissing = new Error("Harness ended its turn without accepting a graph completion.", { cause: error });
        await sealTrace(trace, "partial", completionMissing.message);
        throw completionMissing;
      }
      await sealTrace(trace, "failed", errorMessage(error));
      throw error;
    }
  }

  exportCandidateTrace(
    productInteractionId: number,
    targetDirectory: string,
    correlation: HarnessTraceExportCorrelation,
  ): Promise<HarnessTraceDescriptor> {
    if (this.traceStore === undefined) throw new Error("Candidate trace capture is disabled for this harness host");
    return this.traceStore.export(productInteractionId, targetDirectory, correlation);
  }

  cancel(threadId: number): boolean {
    const session = this.sessions.get(threadId);
    const active = session?.activeCompletion;
    if (session === undefined || active === undefined || active.controller.signal.aborted) return false;
    session.approvals.endCompletion(
      active.completeCallId,
      "cancelled",
      `Harness completion cancelled for thread ${threadId}`,
    );
    active.controller.abort(new Error(`Harness completion cancelled for thread ${threadId}`));
    return true;
  }

  approvalEvents(threadId: number, after = 0): HarnessApprovalSnapshot {
    return this.approvalSession(threadId).snapshot(after);
  }

  decideApproval(threadId: number, requestId: string, input: unknown): HarnessApprovalResolution {
    if (requestId.trim() === "") {
      throw new HarnessApprovalCoordinatorError("invalid_approval_request", "Harness approval request ID must be non-empty");
    }
    return this.approvalSession(threadId).decide(requestId, input);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions.values()) {
      session.approvals.close("Harness host closed before the approval was resolved.");
      session.activeCompletion?.controller.abort(new Error("Harness host closed"));
    }
    const errors: unknown[] = [];
    await Promise.all([...this.sessions.entries()].map(async ([threadId, session]) => {
      await session.tail;
      try {
        session.descriptor = { ...session.descriptor, state: captureHarnessState(session.harness) };
        this.saved.set(threadId, persistedDescriptor(session.descriptor));
      } catch (error) {
        errors.push(error);
      }
      try {
        await session.harness.dispose?.();
      } catch (error) {
        errors.push(error);
      }
    }));
    this.sessions.clear();
    try {
      await this.persist();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "Harness host did not close cleanly");
  }

  sessionCount(): number { return this.sessions.size; }

  private liveSession(threadId: number): LiveSession {
    const live = this.sessions.get(threadId);
    if (live !== undefined) return live;
    const saved = this.saved.get(threadId);
    if (saved === undefined) throw new Error(`Unknown harness thread: ${threadId}`);
    throw new Error(`Thread ${threadId} must be registered before its harness can resume`);
  }

  private approvalSession(threadId: number): HarnessApprovalCoordinator {
    const session = this.sessions.get(threadId);
    if (session !== undefined) return session.approvals;
    throw new HarnessApprovalCoordinatorError("approval_request_not_found", `Unknown live harness thread: ${threadId}`);
  }

  private async withSessionLock<T>(session: LiveSession, operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = session.tail;
    session.tail = new Promise<void>((resolveTail) => { release = resolveTail; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withRegistrationLock<T>(threadId: number, operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.registrationTails.get(threadId) ?? Promise.resolve();
    const tail = new Promise<void>((resolveTail) => { release = resolveTail; });
    this.registrationTails.set(threadId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.registrationTails.get(threadId) === tail) this.registrationTails.delete(threadId);
    }
  }

  private persist(): Promise<void> {
    const legacySessions = [...this.legacySaved.values()];
    const serialized = `${JSON.stringify({
      schemaVersion: 4,
      sessions: [...this.saved.values()],
      ...(legacySessions.length === 0 ? {} : { legacySessions }),
    }, null, 2)}\n`;
    const operation = this.persistTail.then(() => this.writeState(serialized));
    this.persistTail = operation.catch(() => undefined);
    return operation;
  }

  private async writeState(serialized: string): Promise<void> {
    const stateFile = resolve(this.options.stateFile);
    await mkdir(dirname(stateFile), { recursive: true });
    const temporaryFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryFile, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryFile, stateFile);
    } finally {
      await rm(temporaryFile, { force: true });
    }
  }

  private async backupLegacyState(serialized: string): Promise<void> {
    const stateFile = resolve(this.options.stateFile);
    await mkdir(dirname(stateFile), { recursive: true });
    try {
      await writeFile(`${stateFile}.v3.backup`, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export async function startHarnessHost(options: HarnessHostOptions): Promise<RunningHarnessHost> {
  const host = new HarnessHost(options);
  await host.initialize();
  const server = createServer((request, response) => void route(host, options.controlToken, request, response));
  await listen(server, options.port ?? 0, options.host ?? "127.0.0.1");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Harness host did not bind a TCP address");
  const boundHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${boundHost}:${address.port}`,
    host,
    close: async () => {
      const closingServer = close(server);
      try {
        await host.close();
      } finally {
        await closingServer;
      }
    },
  };
}

async function route(host: HarnessHost, token: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (request.headers.authorization !== `Bearer ${token}`) return reply(response, 401, { error: "unauthorized" });
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/sessions") {
      await host.createSession(await body(request) as HarnessSessionRegistration);
      return reply(response, 201, { ok: true });
    }
    const cancelMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(url.pathname);
    if (request.method === "POST" && cancelMatch?.[1] !== undefined) {
      const threadId = Number(decodeURIComponent(cancelMatch[1]));
      if (!Number.isSafeInteger(threadId) || threadId < 1) return reply(response, 400, { error: "invalid_thread_id" });
      return reply(response, 200, { cancelled: host.cancel(threadId) });
    }
    const approvalDecisionMatch = /^\/sessions\/([^/]+)\/approvals\/([^/]+)\/decision$/.exec(url.pathname);
    if (request.method === "POST" && approvalDecisionMatch?.[1] !== undefined && approvalDecisionMatch[2] !== undefined) {
      const threadId = readThreadId(approvalDecisionMatch[1]);
      if (threadId === undefined) return reply(response, 400, { error: "invalid_thread_id" });
      const requestId = decodeURIComponent(approvalDecisionMatch[2]);
      return reply(response, 200, host.decideApproval(threadId, requestId, await body(request)));
    }
    const approvalEventsMatch = /^\/sessions\/([^/]+)\/approval-events$/.exec(url.pathname);
    if (request.method === "GET" && approvalEventsMatch?.[1] !== undefined) {
      const threadId = readThreadId(approvalEventsMatch[1]);
      if (threadId === undefined) return reply(response, 400, { error: "invalid_thread_id" });
      const cursor = url.searchParams.get("after");
      const after = cursor === null ? 0 : Number(cursor);
      return reply(response, 200, host.approvalEvents(threadId, after));
    }
    const match = /^\/sessions\/([^/]+)\/complete$/.exec(url.pathname);
    if (request.method === "POST" && match?.[1] !== undefined) {
      const threadId = Number(decodeURIComponent(match[1]));
      if (!Number.isSafeInteger(threadId) || threadId < 1) return reply(response, 400, { error: "invalid_thread_id" });
      const input = readCompleteInput(await body(request));
      const controller = new AbortController();
      const abort = () => controller.abort(new Error("Harness completion request disconnected"));
      const abortOnResponseClose = () => {
        if (!response.writableEnded) abort();
      };
      request.once("aborted", abort);
      response.once("close", abortOnResponseClose);
      try {
        const completed = await host.complete(
          threadId,
          input.interactionId,
          input.graph,
          input.model,
          controller.signal,
          input.traceContext,
        );
        return reply(response, 200, completed);
      } finally {
        request.off("aborted", abort);
        response.off("close", abortOnResponseClose);
      }
    }
    if (request.method === "GET" && url.pathname === "/health") return reply(response, 200, { ok: true });
    return reply(response, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof HarnessApprovalCoordinatorError) {
      const status = error.code === "invalid_approval_request"
        ? 400
        : error.code === "approval_request_not_found"
          ? 404
          : 409;
      return reply(response, status, { error: error.code, message: error.message });
    }
    return reply(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function reply(response: ServerResponse, status: number, value: unknown): void { const data = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) }); response.end(data); }
function listen(server: Server, port: number, host: string): Promise<void> { return new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolveListen(); }); }); }
function close(server: Server): Promise<void> { return new Promise((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error))); }

function persistedDescriptor(descriptor: HarnessSessionDescriptor): PersistedHarnessSessionDescriptor {
  return {
    threadId: descriptor.threadId,
    configuration: descriptor.configuration,
    permissionProfileId: descriptor.permissionProfileId,
    workingDirectory: descriptor.workingDirectory,
    ...(descriptor.state === undefined ? {} : { state: descriptor.state }),
  };
}

function legacyPermissionProfileId(configuration: HarnessConfiguration): string | undefined {
  const profiles = Object.keys(configuration.permissionBindings);
  if (profiles.includes("auto")) return "auto";
  return profiles.length === 1 ? profiles[0] : undefined;
}

function sameLegacyHarnessConfiguration(
  legacy: Omit<HarnessConfiguration, "permissionBindings">,
  current: HarnessConfiguration,
): boolean {
  return sameHarnessExecutionConfiguration(
    { ...legacy, permissionBindings: current.permissionBindings },
    current,
  );
}

function readPersistedSession(value: unknown): PersistedHarnessSessionDescriptor {
  if (!isRecord(value)) throw new Error("Harness state contains an invalid session descriptor");
  const { threadId, permissionProfileId, workingDirectory } = value;
  if (typeof threadId !== "number" || !Number.isSafeInteger(threadId) || threadId < 1
    || typeof permissionProfileId !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(permissionProfileId)
    || typeof workingDirectory !== "string") {
    throw new Error("Harness state contains an invalid session descriptor");
  }
  const configuration = parseHarnessConfiguration(value.configuration);
  permissionBinding(configuration, permissionProfileId);
  const state = readHarnessState(value.state);
  return {
    threadId,
    configuration,
    permissionProfileId,
    workingDirectory,
    ...(state === undefined ? {} : { state }),
  };
}

function readLegacyPersistedSession(value: unknown): LegacyPersistedHarnessSessionDescriptor {
  if (!isRecord(value) || !isRecord(value.configuration)) {
    throw new Error("Harness state contains an invalid legacy session descriptor");
  }
  const { threadId, workingDirectory } = value;
  const { schemaVersion, name, implementation, implementationVersion, settings } = value.configuration;
  if (typeof threadId !== "number" || !Number.isSafeInteger(threadId) || threadId < 1
    || schemaVersion !== 1
    || typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)
    || typeof implementation !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(implementation)
    || typeof implementationVersion !== "number" || !Number.isSafeInteger(implementationVersion) || implementationVersion < 1
    || !isJsonObject(settings)
    || typeof workingDirectory !== "string") {
    throw new Error("Harness state contains an invalid legacy session descriptor");
  }
  const state = readHarnessState(value.state);
  return {
    threadId,
    configuration: { schemaVersion, name, implementation, implementationVersion, settings },
    workingDirectory,
    ...(state === undefined ? {} : { state }),
  };
}

function uniqueSessions<T extends { readonly threadId: number }>(sessions: readonly T[]): readonly T[] {
  if (new Set(sessions.map((session) => session.threadId)).size !== sessions.length) {
    throw new Error("Harness state contains duplicate thread sessions");
  }
  return sessions;
}

function readLegacySessions(values: readonly unknown[]): Map<number, LegacyPersistedHarnessSessionDescriptor> {
  const sessions = new Map<number, LegacyPersistedHarnessSessionDescriptor>();
  for (const value of values) {
    try {
      const session = readLegacyPersistedSession(value);
      if (sessions.has(session.threadId)) throw new Error(`duplicate thread ${session.threadId}`);
      sessions.set(session.threadId, session);
    } catch (error) {
      console.warn("Skipping invalid legacy harness session during schema v3 migration", error);
    }
  }
  return sessions;
}

function permissionBinding(configuration: HarnessConfiguration, profileId: string) {
  const binding = configuration.permissionBindings[profileId];
  if (binding === undefined) throw new Error(`Harness configuration ${configuration.name} does not bind permission profile ${profileId}`);
  return binding;
}

function readHarnessState(value: unknown): HarnessSessionState | undefined {
  if (value === undefined) return undefined;
  if (isJsonObject(value)) return value;
  throw new Error("Harness state contains invalid implementation state");
}

function captureHarnessState(harness: Harness): HarnessSessionState {
  const state = readHarnessState(harness.state());
  if (state === undefined) throw new Error("Harness did not return implementation state");
  return state;
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readThreadId(value: string): number | undefined {
  const threadId = Number(decodeURIComponent(value));
  return Number.isSafeInteger(threadId) && threadId > 0 ? threadId : undefined;
}

function readCompleteInput(value: unknown): {
  readonly interactionId: number;
  readonly graph: GraphCapability;
  readonly model?: InteractionModelSelection;
  readonly traceContext?: HarnessCompletionTraceContext;
} {
  if (!isRecord(value)) throw new Error("Harness completion input must be an object");
  const unknown = Object.keys(value).filter((key) => !["interactionId", "graph", "model", "traceContext"].includes(key));
  if (unknown.length > 0) throw new Error(`Harness completion contains unsupported fields: ${unknown.join(", ")}`);
  if (!Number.isSafeInteger(value.interactionId) || (value.interactionId as number) < 1) {
    throw new Error("Harness completion requires a positive interactionId");
  }
  const model = readInteractionModelSelection(value);
  const traceContext = readTraceContext(value);
  return {
    interactionId: value.interactionId as number,
    graph: readGraphCapability(value),
    ...(model === undefined ? {} : { model }),
    ...(traceContext === undefined ? {} : { traceContext }),
  };
}

function readGraphCapability(value: unknown): GraphCapability {
  if (!isRecord(value) || !isRecord(value.graph)) throw new Error("Harness completion requires a graph capability");
  const { url, token, nodeId } = value.graph;
  if (typeof url !== "string" || url.trim() === "" || typeof token !== "string" || token === "" || typeof nodeId !== "number" || !Number.isSafeInteger(nodeId) || nodeId < 1) {
    throw new Error("Harness completion contains an invalid graph capability");
  }
  const capability = { url, token, nodeId };
  validateGraphCapability(capability);
  return capability;
}

function readInteractionModelSelection(value: unknown): InteractionModelSelection | undefined {
  if (!isRecord(value) || value.model === undefined) return undefined;
  if (!isRecord(value.model)) throw new Error("Harness completion contains an invalid model selection");
  const { providerId, modelId } = value.model;
  const selection = { providerId, modelId };
  validateInteractionModelSelection(selection);
  return selection;
}

function validateInteractionModelSelection(value: unknown): asserts value is InteractionModelSelection {
  if (!isRecord(value)
    || !isStableId(value.providerId)
    || !isStableId(value.modelId)) {
    throw new Error("Harness completion contains an invalid model selection");
  }
}

function validateConfiguredModelSelection(
  configuration: HarnessConfiguration,
  selection: InteractionModelSelection,
): void {
  const compatibility = configuration.modelCompatibility;
  if (compatibility === undefined) return;
  const provider = compatibility.find((entry) => entry.providerId === selection.providerId);
  if (!provider || (provider.modelIds !== undefined && !provider.modelIds.includes(selection.modelId))) {
    throw new Error("Harness completion model is not compatible with this configuration");
  }
}

function isStableId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const characters = [...value];
  return characters.length > 0
    && characters.length <= 200
    && !/\p{White_Space}/u.test(characters[0]!)
    && !/\p{White_Space}/u.test(characters.at(-1)!)
    && !characters.some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character))
    && !characters.some((character) => /\p{Cc}/u.test(character));
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isRecord(value)
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

function readTraceContext(value: unknown): HarnessCompletionTraceContext | undefined {
  if (!isRecord(value) || value.traceContext === undefined) return undefined;
  if (!isRecord(value.traceContext)) throw new Error("Harness completion contains an invalid trace context");
  const { productInteractionId } = value.traceContext;
  if (typeof productInteractionId !== "number" || !Number.isSafeInteger(productInteractionId) || productInteractionId < 1) {
    throw new Error("Harness completion trace context requires a positive product interaction id");
  }
  return { productInteractionId };
}

function disabledTraceDescriptor(): HarnessTraceDescriptor {
  return { status: "disabled", format: "relayer-harness-trace-v1", coverage: NO_HARNESS_TRACE_SUPPORT };
}

async function sealTrace(
  trace: ReturnType<HarnessTraceStore["start"]> | undefined,
  status: "complete" | "partial" | "failed",
  reason?: string,
): Promise<HarnessTraceDescriptor> {
  if (trace === undefined) return disabledTraceDescriptor();
  try {
    return await trace.seal(status, reason);
  } catch (error) {
    return {
      status: "failed",
      format: "relayer-harness-trace-v1",
      coverage: NO_HARNESS_TRACE_SUPPORT,
      error: `Candidate trace could not be sealed: ${errorMessage(error)}`,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateGraphCapability(capability: GraphCapability): void {
  if (capability.token === "" || !Number.isSafeInteger(capability.nodeId) || capability.nodeId < 1) {
    throw new Error("Harness completion contains an invalid graph capability");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(capability.url);
  } catch {
    throw new Error("Harness completion contains an invalid graph capability URL");
  }
  if (parsedUrl.protocol !== "http:" || parsedUrl.hostname !== "127.0.0.1" || parsedUrl.port === "" || parsedUrl.username !== "" || parsedUrl.password !== "" || parsedUrl.pathname !== "/" || parsedUrl.search !== "" || parsedUrl.hash !== "") {
    throw new Error("Harness graph capability URL must use authenticated 127.0.0.1 HTTP");
  }
}

class ActiveHarnessGraphScope implements HarnessGraphScope {
  readonly interactionNodeId: number;
  private active = true;

  constructor(private readonly capability: GraphCapability) {
    this.interactionNodeId = capability.nodeId;
  }

  acquireCapability(): GraphCapability {
    if (!this.active) throw new Error("The graph scope is no longer active");
    return { ...this.capability };
  }

  close(): void {
    this.active = false;
  }
}
