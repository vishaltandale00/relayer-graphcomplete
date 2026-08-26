import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { statSync } from "node:fs";
import { delimiter, dirname, join, win32 } from "node:path";
import {
  answerCodexServerRequest,
  type CodexApprovalBridgeContext,
  type CodexServerRequest,
} from "./codex-approvals.js";
import type { HarnessApprovalChannel } from "../approval-coordinator.js";
import type { JsonObject } from "../types.js";

export type CodexAppServerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { readonly stdio: readonly ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export interface CodexAppServerTurnOptions {
  readonly codexPathOverride?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly savedThreadId?: string;
  readonly threadParams: JsonObject;
  readonly turnParams: JsonObject;
  readonly prompt: string;
  readonly approvals: HarnessApprovalChannel;
  readonly workingDirectory: string;
  readonly sandboxPolicy: JsonObject;
  readonly trustedGraphAuthoringLauncher?: string;
  readonly signal?: AbortSignal;
  readonly forceSignal?: AbortSignal;
  readonly shutdownGraceMs?: number;
  readonly spawnProcess?: CodexAppServerSpawn;
  readonly onThreadId: (threadId: string) => void;
  readonly onNotification?: (method: string, params: unknown) => void;
}

export interface CodexAppServerTurnResult {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: "completed" | "interrupted";
}

export function codexForceTerminationSignal(platform = process.platform): NodeJS.Signals {
  return platform === "darwin" ? "SIGUSR2" : "SIGKILL";
}

export function forceTerminateCodexProcessTree(
  child: Pick<ChildProcessWithoutNullStreams, "pid" | "kill">,
  platform = process.platform,
  spawnTreeKiller: typeof spawn = spawn,
  systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows",
): void {
  if (platform !== "win32" || child.pid === undefined) {
    child.kill(codexForceTerminationSignal(platform));
    return;
  }
  const fallback = () => {
    try { child.kill("SIGKILL"); } catch {}
  };
  try {
    const killer = spawnTreeKiller(win32.join(systemRoot, "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", fallback);
    killer.once("exit", (code) => { if (code !== 0) fallback(); });
  } catch {
    fallback();
  }
}

/** Run one isolated stdio app-server process for one GraphComplete call. */
export async function runCodexAppServerTurn(options: CodexAppServerTurnOptions): Promise<CodexAppServerTurnResult> {
  const executable = resolveCodexExecutable(options.codexPathOverride);
  const environment = { ...options.environment };
  if (executable.pathDirectories.length > 0) {
    environment.PATH = [
      ...executable.pathDirectories,
      ...(environment.PATH ?? "").split(delimiter).filter((entry) => entry !== "" && !executable.pathDirectories.includes(entry)),
    ].join(delimiter);
  }
  const child = (options.spawnProcess ?? spawn)(executable.path, ["app-server", "--listen", "stdio://"], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const connection = new CodexAppServerConnection(child, options);
  try {
    await connection.start();
    return await connection.run();
  } finally {
    await connection.close();
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface ActiveTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly resolve: (result: CodexAppServerTurnResult) => void;
  readonly reject: (error: Error) => void;
}

type DeferredTurnMessage =
  | { readonly type: "notification"; readonly method: string; readonly params: unknown }
  | { readonly type: "serverRequest"; readonly request: CodexServerRequest };

class CodexAppServerConnection {
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly serverRequests = new Map<string, AbortController>();
  private readonly serverRequestTasks = new Set<Promise<void>>();
  private readonly items = new Map<string, JsonObject>();
  private nextId = 1;
  private activeTurn: ActiveTurn | undefined;
  private startingTurn = false;
  private readonly deferredTurnMessages: DeferredTurnMessage[] = [];
  private lastTurnError: Error | undefined;
  private fatalError: Error | undefined;
  private started = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private readonly childExited: Promise<void>;
  private gracefulTerminationSent = false;
  private forceTerminationSent = false;
  private interruptSent = false;
  private detachAbort: () => void = () => undefined;
  private detachForceAbort: () => void = () => undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: CodexAppServerTurnOptions,
  ) {
    child.stdin.on("error", () => undefined);
    child.stderr.resume();
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.once("error", (error) => this.fail(new Error(`Codex app-server failed: ${error.message}`, { cause: error })));
    this.childExited = new Promise((resolveExit) => {
      const terminated = () => {
        child.off("exit", terminated);
        child.off("close", terminated);
        resolveExit();
      };
      child.once("exit", terminated);
      child.once("close", terminated);
    });
    child.once("exit", (code, signal) => {
      if (!this.closing) this.fail(new Error(`Codex app-server stopped (${signal ?? code ?? "unknown"})`));
    });
    const forceClose = () => this.forceClose(new Error("Codex app-server was force-closed."));
    if (options.forceSignal?.aborted) forceClose();
    else options.forceSignal?.addEventListener("abort", forceClose, { once: true });
    this.detachForceAbort = () => options.forceSignal?.removeEventListener("abort", forceClose);
  }

  async start(): Promise<void> {
    await waitForSpawn(this.child);
    await this.request("initialize", {
      clientInfo: { name: "relayer_graphcomplete", title: "Relayer GraphComplete", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.started = true;
  }

  async run(): Promise<CodexAppServerTurnResult> {
    if (!this.started) throw new Error("Codex app-server connection is not initialized");
    const threadResult = await this.request(
      this.options.savedThreadId === undefined ? "thread/start" : "thread/resume",
      this.options.savedThreadId === undefined
        ? this.options.threadParams
        : { threadId: this.options.savedThreadId, ...this.options.threadParams },
    );
    const thread = objectProperty(threadResult, "thread");
    const threadId = stringProperty(thread, "id");
    if (threadId === undefined || (this.options.savedThreadId !== undefined && threadId !== this.options.savedThreadId)) {
      throw new Error("Codex app-server returned an invalid thread identity");
    }
    this.options.onThreadId(threadId);

    this.startingTurn = true;
    let turnResult: unknown;
    try {
      turnResult = await this.request("turn/start", {
        ...this.options.turnParams,
        threadId,
        input: [{ type: "text", text: this.options.prompt }],
      });
    } catch (error) {
      this.startingTurn = false;
      throw error;
    }
    if (this.fatalError !== undefined) {
      this.startingTurn = false;
      throw this.fatalError;
    }
    const turn = objectProperty(turnResult, "turn");
    const turnId = stringProperty(turn, "id");
    if (turnId === undefined) {
      this.startingTurn = false;
      throw new Error("Codex app-server returned an invalid turn identity");
    }

    const completion = new Promise<CodexAppServerTurnResult>((resolve, reject) => {
      this.activeTurn = { threadId, turnId, resolve, reject };
    });
    this.startingTurn = false;
    this.flushDeferredTurnMessages();
    const abort = () => { void this.interrupt(); };
    if (this.options.signal?.aborted) abort();
    else this.options.signal?.addEventListener("abort", abort, { once: true });
    this.detachAbort = () => this.options.signal?.removeEventListener("abort", abort);
    return completion;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeTransport();
    return this.closePromise;
  }

  private async closeTransport(): Promise<void> {
    this.closing = true;
    this.detachAbort();
    this.abortServerRequests("Codex app-server transport closed.");
    this.lines.close();
    this.child.stdin.end();
    this.terminateGracefully();
    const graceMs = this.options.shutdownGraceMs ?? 250;
    if (!await this.waitForChildExit(graceMs)) this.forceTerminate();
    if (!await this.waitForChildExit(graceMs)) {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
      if (!await this.waitForChildExit(graceMs)) throw new Error("Codex app-server process did not exit after forced termination.");
    }
    this.detachForceAbort();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.fatalError !== undefined) return Promise.reject(this.fatalError);
    if (!this.child.stdin.writable) return Promise.reject(new Error("Codex app-server stdin is not writable"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    if (!this.child.stdin.writable) throw new Error("Codex app-server stdin is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.fail(new Error("Codex app-server emitted malformed JSON", { cause: error }));
      return;
    }
    if (!isRecord(message)) {
      this.fail(new Error("Codex app-server emitted a non-object message"));
      return;
    }
    const method = typeof message.method === "string" ? message.method : undefined;
    if (message.id !== undefined && method === undefined && ("result" in message || "error" in message)) {
      this.handleResponse(message);
      return;
    }
    if (message.id !== undefined && method !== undefined) {
      let id: string | number;
      try {
        id = requestId(message.id);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.handleServerRequest({ id, method, params: message.params });
      return;
    }
    if (message.id === undefined && method !== undefined) {
      this.handleNotification(method, message.params);
      return;
    }
    this.fail(new Error("Codex app-server emitted an invalid message envelope"));
  }

  private handleResponse(message: Record<string, unknown>): void {
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
      this.fail(new Error("Codex app-server response used an invalid client request ID"));
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      this.fail(new Error(`Codex app-server returned a duplicate or unknown response ID: ${message.id}`));
      return;
    }
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      const error = isRecord(message.error) ? message.error : {};
      pending.reject(new Error(`Codex ${pending.method} failed: ${String(error.message ?? "unknown error")}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleServerRequest(request: CodexServerRequest): void {
    if (this.startingTurn && this.activeTurn === undefined) {
      this.deferredTurnMessages.push({ type: "serverRequest", request });
      return;
    }
    const key = requestKey(request.id);
    if (this.serverRequests.has(key)) {
      this.fail(new Error(`Codex app-server repeated server request ID: ${String(request.id)}`));
      return;
    }
    const active = this.activeTurn;
    if (active === undefined) {
      this.write({ id: request.id, error: { code: -32600, message: "No active Codex turn" } });
      return;
    }
    const controller = new AbortController();
    this.serverRequests.set(key, controller);
    const context: CodexApprovalBridgeContext = {
      approvals: this.options.approvals,
      workingDirectory: this.options.workingDirectory,
      sandboxPolicy: this.options.sandboxPolicy,
      ...(this.options.trustedGraphAuthoringLauncher === undefined
        ? {}
        : { trustedGraphAuthoringLauncher: this.options.trustedGraphAuthoringLauncher }),
      threadId: active.threadId,
      turnId: active.turnId,
      items: this.items,
      signal: controller.signal,
    };
    let task!: Promise<void>;
    task = answerCodexServerRequest(request, context).then((result) => {
      if (this.serverRequests.get(key) === controller) this.write({ id: request.id, result });
    }, (error) => {
      if (this.serverRequests.get(key) === controller) {
        this.write({ id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
      }
    }).finally(() => {
      if (this.serverRequests.get(key) === controller) this.serverRequests.delete(key);
      this.serverRequestTasks.delete(task);
    });
    this.serverRequestTasks.add(task);
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.startingTurn && this.activeTurn === undefined) {
      this.deferredTurnMessages.push({ type: "notification", method, params });
      return;
    }
    this.options.onNotification?.(method, params);
    const value = isRecord(params) ? params : {};
    if (method === "item/started" || method === "item/completed") {
      const item = objectProperty(value, "item");
      const itemId = stringProperty(item, "id");
      if (item !== undefined && itemId !== undefined) this.items.set(itemId, item as JsonObject);
      return;
    }
    if (method === "serverRequest/resolved") {
      const id = value.requestId;
      if (typeof id === "string" || typeof id === "number") {
        const key = requestKey(id);
        const controller = this.serverRequests.get(key);
        if (controller !== undefined) {
          this.serverRequests.delete(key);
          controller.abort(new Error("Codex resolved the provider request."));
        }
      }
      return;
    }
    if (method === "error") {
      const error = objectProperty(value, "error");
      const message = stringProperty(error, "message") ?? "Codex turn failed";
      this.lastTurnError = new Error(message);
      return;
    }
    if (method === "turn/completed") this.completeTurn(value);
  }

  private flushDeferredTurnMessages(): void {
    const messages = this.deferredTurnMessages.splice(0);
    for (const message of messages) {
      if (this.fatalError !== undefined) return;
      if (message.type === "notification") this.handleNotification(message.method, message.params);
      else this.handleServerRequest(message.request);
    }
  }

  private completeTurn(params: Record<string, unknown>): void {
    const active = this.activeTurn;
    if (active === undefined) return;
    const threadId = stringProperty(params, "threadId");
    const turn = objectProperty(params, "turn");
    const turnId = stringProperty(turn, "id");
    const status = stringProperty(turn, "status");
    if (threadId !== active.threadId || turnId !== active.turnId) return;
    this.activeTurn = undefined;
    this.abortServerRequests("Codex turn completed before the provider request was answered.");
    void Promise.allSettled([...this.serverRequestTasks]).then(() => {
      if (status === "completed" || status === "interrupted") {
        active.resolve({ threadId, turnId, status });
      } else {
        const turnError = objectProperty(turn, "error");
        active.reject(this.lastTurnError ?? new Error(stringProperty(turnError, "message") ?? `Codex turn ${status ?? "failed"}`));
      }
    });
  }

  private async interrupt(): Promise<void> {
    const active = this.activeTurn;
    if (active === undefined || this.interruptSent || this.fatalError !== undefined) return;
    this.interruptSent = true;
    this.abortServerRequests("Codex turn was interrupted.");
    try {
      await this.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private abortServerRequests(reason: string): void {
    for (const [key, controller] of this.serverRequests) {
      this.serverRequests.delete(key);
      controller.abort(new Error(reason));
    }
  }

  private fail(error: Error): void {
    if (this.fatalError !== undefined || this.closing) return;
    this.fatalError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.activeTurn?.reject(error);
    this.activeTurn = undefined;
    this.abortServerRequests(error.message);
    this.terminateGracefully();
  }

  private forceClose(error: Error): void {
    if (this.fatalError === undefined && !this.closing) {
      this.fatalError = error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.activeTurn?.reject(error);
      this.activeTurn = undefined;
      this.abortServerRequests(error.message);
    }
    this.forceTerminate();
  }

  private forceTerminate(): void {
    if (this.forceTerminationSent || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.forceTerminationSent = true;
    try {
      forceTerminateCodexProcessTree(this.child);
    } catch {
      // AbortSignal listeners must never surface process-kill errors. Bounded close
      // observes the missing exit and reports it after exhausting escalation.
    }
  }

  private terminateGracefully(): void {
    if (this.gracefulTerminationSent || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.gracefulTerminationSent = true;
    this.child.kill("SIGTERM");
  }

  private async waitForChildExit(timeoutMs: number): Promise<boolean> {
    let timeout;
    try {
      return await Promise.race([
        this.childExited.then(() => true),
        new Promise<boolean>((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", spawned);
      child.off("error", failed);
      child.off("exit", exited);
    };
    const spawned = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Codex app-server stopped before startup (${signal ?? code ?? "unknown"})`));
    };
    child.once("spawn", spawned);
    child.once("error", failed);
    child.once("exit", exited);
  });
}

function resolveCodexExecutable(override: string | undefined): { readonly path: string; readonly pathDirectories: readonly string[] } {
  if (override !== undefined) {
    if (override.trim() === "" || !isFile(override)) throw new Error("Codex executable override is not a file");
    return { path: override, pathDirectories: [] };
  }
  const target = codexTarget();
  const packageName = CODEX_PLATFORM_PACKAGES[target];
  if (packageName === undefined) throw new Error(`Unsupported Codex target: ${target}`);
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve(`${packageName}/package.json`);
    const vendor = join(dirname(packageJson), "vendor", target);
    const binary = join(vendor, "bin", process.platform === "win32" ? "codex.exe" : "codex");
    const pathDirectory = join(vendor, "codex-path");
    if (!isFile(binary)) throw new Error("missing binary");
    return { path: binary, pathDirectories: isDirectory(pathDirectory) ? [pathDirectory] : [] };
  } catch (error) {
    throw new Error(`Unable to locate the pinned Codex 0.147 executable for ${target}`, { cause: error });
  }
}

const CODEX_PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

function codexTarget(): string {
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : undefined;
  const platform = process.platform === "darwin"
    ? "apple-darwin"
    : process.platform === "win32"
      ? "pc-windows-msvc"
      : process.platform === "linux"
        ? "unknown-linux-musl"
        : undefined;
  if (arch === undefined || platform === undefined) throw new Error(`Unsupported platform: ${process.platform} (${process.arch})`);
  return `${arch}-${platform}`;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" && value[key].trim() !== "" ? value[key] : undefined;
}

function requestId(value: unknown): string | number {
  if ((typeof value === "string" && value !== "") || (typeof value === "number" && Number.isSafeInteger(value))) return value;
  throw new Error("Codex app-server request used an invalid ID");
}

function requestKey(value: string | number): string {
  return `${typeof value}:${String(value)}`;
}
