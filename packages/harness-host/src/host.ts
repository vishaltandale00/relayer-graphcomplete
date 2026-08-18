import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { GraphApiError, RelayerGraphClient } from "@relayer/graph-client";
import { resolveHarnessFactory } from "./registry.js";
import type {
  Harness,
  HarnessCompleteResult,
  HarnessMap,
  HarnessSessionDescriptor,
  HarnessSessionRegistration,
  HarnessSessionState,
  JsonValue,
} from "./types.js";

interface LiveSession {
  descriptor: HarnessSessionDescriptor;
  harness: Harness;
  tail: Promise<void>;
  activeCompletion?: AbortController;
}

interface PersistedHarnessSessionDescriptor {
  readonly threadId: number;
  readonly harnessKey: string;
  readonly workingDirectory: string;
  readonly state?: HarnessSessionState;
}

export interface HarnessHostOptions {
  readonly harnesses: HarnessMap;
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
  private persistTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: HarnessHostOptions) {}

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.stateFile, "utf8")) as { sessions?: unknown[] };
      const sessions = (parsed.sessions ?? []).map(readPersistedSession);
      this.saved = new Map(sessions.map((session) => [session.threadId, session]));
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async createSession(descriptor: HarnessSessionRegistration): Promise<void> {
    if (this.closed) throw new Error("Harness host is closed");
    return this.withRegistrationLock(descriptor.threadId, () => this.registerSession(descriptor));
  }

  private async registerSession(descriptor: HarnessSessionRegistration): Promise<void> {
    if (this.closed) throw new Error("Harness host is closed");
    const live = this.sessions.get(descriptor.threadId);
    if (live !== undefined) {
      await this.withSessionLock(live, async () => {
        if (live.descriptor.harnessKey !== descriptor.harnessKey || live.descriptor.workingDirectory !== descriptor.workingDirectory) {
          throw new Error(`Thread ${descriptor.threadId} is already pinned to ${live.descriptor.harnessKey}`);
        }
        await live.harness.setGraphCapability(descriptor.graph);
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
    if (prior !== undefined && (prior.harnessKey !== descriptor.harnessKey || prior.workingDirectory !== descriptor.workingDirectory)) {
      throw new Error(`Thread ${descriptor.threadId} is already pinned to ${prior.harnessKey}`);
    }
    const harness = await resolveHarnessFactory(this.options.harnesses, descriptor.harnessKey)({
      threadId: descriptor.threadId,
      workingDirectory: descriptor.workingDirectory,
      graph: descriptor.graph,
      ...(prior?.state === undefined ? {} : { savedState: prior.state }),
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
    await this.persist();
  }

  async complete(threadId: number, nodeId?: number, signal?: AbortSignal): Promise<HarnessCompleteResult> {
    if (this.closed) throw new Error("Harness host is closed");
    const session = await this.liveSession(threadId);
    return this.withSessionLock(session, async () => {
      const controller = new AbortController();
      const detachSignal = forwardAbort(signal, controller);
      session.activeCompletion = controller;
      try {
        const graph = new RelayerGraphClient(session.descriptor.graph);
        const interactionNodeId = nodeId ?? session.descriptor.graph.nodeId;
        try {
          const output = await graph.getCompletionOutput(interactionNodeId);
          return { threadId, harnessKey: session.descriptor.harnessKey, output };
        } catch (error) {
          if (!(error instanceof GraphApiError && error.status === 404 && error.code === "completion_not_found")) throw error;
        }
        const interaction = await graph.getNode(interactionNodeId);
        const output = await session.harness.complete(interaction, controller.signal);
        return { threadId, harnessKey: session.descriptor.harnessKey, output };
      } finally {
        if (session.activeCompletion === controller) delete session.activeCompletion;
        detachSignal();
        session.descriptor = { ...session.descriptor, state: captureHarnessState(session.harness) };
        this.saved.set(threadId, persistedDescriptor(session.descriptor));
        await this.persist();
      }
    });
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

  private async liveSession(threadId: number): Promise<LiveSession> {
    const live = this.sessions.get(threadId);
    if (live !== undefined) return live;
    const saved = this.saved.get(threadId);
    if (saved === undefined) throw new Error(`Unknown harness thread: ${threadId}`);
    throw new Error(`Thread ${threadId} requires a fresh graph capability before its harness can resume`);
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
    const serialized = `${JSON.stringify({ schemaVersion: 2, sessions: [...this.saved.values()] }, null, 2)}\n`;
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
      const input = await body(request) as { nodeId?: number };
      const controller = new AbortController();
      const abort = () => controller.abort(new Error("Harness completion request disconnected"));
      request.once("aborted", abort);
      try {
        return reply(response, 200, await host.complete(threadId, input.nodeId, controller.signal));
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
    harnessKey: descriptor.harnessKey,
    workingDirectory: descriptor.workingDirectory,
    ...(descriptor.state === undefined ? {} : { state: descriptor.state }),
  };
}

function readPersistedSession(value: unknown): PersistedHarnessSessionDescriptor {
  if (!isRecord(value)) throw new Error("Harness state contains an invalid session descriptor");
  const { threadId, harnessKey, workingDirectory } = value;
  if (typeof threadId !== "number" || !Number.isSafeInteger(threadId) || threadId < 1 || typeof harnessKey !== "string" || !harnessKey || typeof workingDirectory !== "string") {
    throw new Error("Harness state contains an invalid session descriptor");
  }
  const state = readHarnessState(value.state);
  return {
    threadId,
    harnessKey,
    workingDirectory,
    ...(state === undefined ? {} : { state }),
  };
}

function readHarnessState(value: unknown): HarnessSessionState | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Harness state contains invalid implementation state");
  if ("schemaVersion" in value || "values" in value) {
    if (typeof value.schemaVersion === "number" && Number.isSafeInteger(value.schemaVersion) && value.schemaVersion >= 1 && isJsonRecord(value.values)) {
      return { schemaVersion: value.schemaVersion, values: value.values };
    }
    throw new Error("Harness state contains invalid versioned implementation state");
  }
  if (isJsonRecord(value)) return { schemaVersion: 1, values: value };
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

function isJsonRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonRecord(value);
}
