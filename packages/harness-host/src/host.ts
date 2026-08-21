import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { GraphApiError, RelayerGraphClient, type GraphCapability } from "@relayer/graph-client";
import {
  isJsonObject,
  parseHarnessConfiguration,
  sameHarnessExecutionConfiguration,
} from "./configuration.js";
import { resolveHarnessFactory } from "./registry.js";
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
} from "./types.js";

interface LiveSession {
  descriptor: HarnessSessionDescriptor;
  harness: Harness;
  tail: Promise<void>;
  activeCompletion?: AbortController;
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

  constructor(private readonly options: HarnessHostOptions) {}

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
    this.sessions.set(descriptor.threadId, { descriptor: persisted, harness, tail: Promise.resolve() });
    this.saved.set(descriptor.threadId, persistedDescriptor(persisted));
    this.legacySaved.delete(descriptor.threadId);
    await this.persist();
  }

  async complete(threadId: number, capability: GraphCapability, signal?: AbortSignal): Promise<HarnessCompleteResult>;
  async complete(
    threadId: number,
    capability: GraphCapability,
    model: InteractionModelSelection,
    signal?: AbortSignal,
  ): Promise<HarnessCompleteResult>;
  async complete(
    threadId: number,
    capability: GraphCapability,
    model: undefined,
    signal: AbortSignal,
  ): Promise<HarnessCompleteResult>;
  async complete(
    threadId: number,
    capability: GraphCapability,
    modelOrSignal?: InteractionModelSelection | AbortSignal,
    trailingSignal?: AbortSignal,
  ): Promise<HarnessCompleteResult> {
    if (this.closed) throw new Error("Harness host is closed");
    validateGraphCapability(capability);
    const model = isAbortSignal(modelOrSignal) ? undefined : modelOrSignal;
    const signal = isAbortSignal(modelOrSignal) ? modelOrSignal : trailingSignal;
    if (model !== undefined) validateInteractionModelSelection(model);
    const session = this.liveSession(threadId);
    if (model !== undefined) validateConfiguredModelSelection(session.descriptor.configuration, model);
    return this.withSessionLock(session, async () => {
      const controller = new AbortController();
      const detachSignal = forwardAbort(signal, controller);
      session.activeCompletion = controller;
      let result: HarnessCompleteResult | undefined;
      let operationError: unknown;
      try {
        if (this.closed) throw new Error("Harness host is closed");
        controller.signal.throwIfAborted();
        result = await this.executeCompletion(threadId, session, capability, model, controller.signal);
      } catch (error) {
        operationError = error;
      }
      if (session.activeCompletion === controller) delete session.activeCompletion;
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
    signal: AbortSignal,
  ): Promise<HarnessCompleteResult> {
    const graph = new RelayerGraphClient(capability);
    const interactionNodeId = capability.nodeId;
    try {
      const output = await graph.getCompletionOutput(interactionNodeId);
      return { threadId, configurationName: session.descriptor.configuration.name, output };
    } catch (error) {
      if (!(error instanceof GraphApiError && error.status === 404 && error.code === "completion_not_found")) throw error;
    }
    const interaction = await graph.getNode(interactionNodeId);
    const scope = new ActiveHarnessGraphScope(capability);
    try {
      await session.harness.complete({ inputGraph: interaction, graph: scope, ...(model === undefined ? {} : { model }) }, signal);
    } finally {
      scope.close();
    }
    try {
      const output = await graph.getCompletionOutput(interactionNodeId);
      return { threadId, configurationName: session.descriptor.configuration.name, output };
    } catch (error) {
      if (error instanceof GraphApiError && error.status === 404 && error.code === "completion_not_found") {
        throw new Error("Harness ended its turn without accepting a graph completion.", { cause: error });
      }
      throw error;
    }
  }

  cancel(threadId: number): boolean {
    const controller = this.sessions.get(threadId)?.activeCompletion;
    if (controller === undefined || controller.signal.aborted) return false;
    controller.abort(new Error(`Harness completion cancelled for thread ${threadId}`));
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions.values()) session.activeCompletion?.abort(new Error("Harness host closed"));
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
    const match = /^\/sessions\/([^/]+)\/complete$/.exec(url.pathname);
    if (request.method === "POST" && match?.[1] !== undefined) {
      const threadId = Number(decodeURIComponent(match[1]));
      if (!Number.isSafeInteger(threadId) || threadId < 1) return reply(response, 400, { error: "invalid_thread_id" });
      const input = await body(request);
      const capability = readGraphCapability(input);
      const model = readInteractionModelSelection(input);
      const controller = new AbortController();
      const abort = () => controller.abort(new Error("Harness completion request disconnected"));
      request.once("aborted", abort);
      try {
        const completed = model === undefined
          ? await host.complete(threadId, capability, controller.signal)
          : await host.complete(threadId, capability, model, controller.signal);
        return reply(response, 200, completed);
      } finally {
        request.off("aborted", abort);
      }
    }
    if (request.method === "GET" && url.pathname === "/health") return reply(response, 200, { ok: true });
    return reply(response, 404, { error: "not_found" });
  } catch (error) {
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
  return typeof value === "string"
    && value.length > 0
    && [...value].length <= 200
    && value.trim() === value
    && ![...value].some((character) => /\p{Cc}/u.test(character));
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isRecord(value)
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
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
