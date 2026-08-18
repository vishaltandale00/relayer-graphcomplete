import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { GraphApiError, RelayerGraphClient } from "@relayer/graph-client";
import { resolveHarnessFactory } from "./registry.js";
import type { Harness, HarnessCompleteResult, HarnessMap, HarnessSessionDescriptor } from "./types.js";

interface LiveSession {
  descriptor: HarnessSessionDescriptor;
  harness: Harness;
  tail: Promise<void>;
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
  private saved = new Map<number, HarnessSessionDescriptor>();
  private persistTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: HarnessHostOptions) {}

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.stateFile, "utf8")) as { sessions?: HarnessSessionDescriptor[] };
      this.saved = new Map((parsed.sessions ?? []).map((session) => [session.threadId, session]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async createSession(descriptor: Omit<HarnessSessionDescriptor, "state">): Promise<void> {
    const live = this.sessions.get(descriptor.threadId);
    if (live !== undefined) {
      await this.withSessionLock(live, async () => {
        if (live.descriptor.harnessKey !== descriptor.harnessKey || live.descriptor.workingDirectory !== descriptor.workingDirectory) {
          throw new Error(`Thread ${descriptor.threadId} is already pinned to ${live.descriptor.harnessKey}`);
        }
        await live.harness.setGraphCapability(descriptor.graph);
        live.descriptor = {
          ...descriptor,
          ...(live.descriptor.state === undefined ? {} : { state: live.descriptor.state }),
        };
        this.saved.set(descriptor.threadId, live.descriptor);
        await this.persist();
      });
      return;
    }
    const prior = this.saved.get(descriptor.threadId);
    if (prior !== undefined && (prior.harnessKey !== descriptor.harnessKey || prior.workingDirectory !== descriptor.workingDirectory)) {
      throw new Error(`Thread ${descriptor.threadId} is already pinned to ${prior.harnessKey}`);
    }
    const persisted: HarnessSessionDescriptor = { ...descriptor, ...(prior?.state === undefined ? {} : { state: prior.state }) };
    const harness = resolveHarnessFactory(this.options.harnesses, descriptor.harnessKey)({
      threadId: descriptor.threadId,
      workingDirectory: descriptor.workingDirectory,
      graph: descriptor.graph,
      ...(persisted.state === undefined ? {} : { savedState: persisted.state }),
    });
    this.sessions.set(descriptor.threadId, { descriptor: persisted, harness, tail: Promise.resolve() });
    this.saved.set(descriptor.threadId, persisted);
    await this.persist();
  }

  async complete(threadId: number, nodeId?: number): Promise<HarnessCompleteResult> {
    const session = await this.liveSession(threadId);
    return this.withSessionLock(session, async () => {
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
        const output = await session.harness.complete(interaction);
        return { threadId, harnessKey: session.descriptor.harnessKey, output };
      } finally {
        session.descriptor = { ...session.descriptor, state: session.harness.state() };
        this.saved.set(threadId, session.descriptor);
        await this.persist();
      }
    });
  }

  sessionCount(): number { return this.sessions.size; }

  private async liveSession(threadId: number): Promise<LiveSession> {
    const live = this.sessions.get(threadId);
    if (live !== undefined) return live;
    const saved = this.saved.get(threadId);
    if (saved === undefined) throw new Error(`Unknown harness thread: ${threadId}`);
    await this.createSession(saved);
    return this.sessions.get(threadId)!;
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

  private persist(): Promise<void> {
    const serialized = `${JSON.stringify({ schemaVersion: 1, sessions: [...this.saved.values()] }, null, 2)}\n`;
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
  return { url: `http://${boundHost}:${address.port}`, host, close: () => close(server) };
}

async function route(host: HarnessHost, token: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (request.headers.authorization !== `Bearer ${token}`) return reply(response, 401, { error: "unauthorized" });
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/sessions") {
      await host.createSession(await body(request) as Omit<HarnessSessionDescriptor, "state">);
      return reply(response, 201, { ok: true });
    }
    const match = /^\/sessions\/([^/]+)\/complete$/.exec(url.pathname);
    if (request.method === "POST" && match?.[1] !== undefined) {
      const threadId = Number(decodeURIComponent(match[1]));
      if (!Number.isSafeInteger(threadId) || threadId < 1) return reply(response, 400, { error: "invalid_thread_id" });
      const input = await body(request) as { nodeId?: number };
      return reply(response, 200, await host.complete(threadId, input.nodeId));
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
