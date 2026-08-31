import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CredentialAdapter } from "./credential-adapter.mjs";
import { terminateChildProcess } from "../services/child-process.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function waitWithSignal(operation, signal) {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function executableExists(path) {
  if (!path) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Codex app-server stopped before startup (${signal || code || "unknown"}).`));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function findCodexExecutable(environment = process.env) {
  const explicit = String(environment.RELAYER_CODEX_BINARY || "").trim();
  return await executableExists(explicit) ? explicit : null;
}

export class CodexCredentialAdapter extends CredentialAdapter {
  constructor({
    providerDefinitionId = "codex",
    environment = process.env,
    onAccountChanged = () => {},
    spawnProcess = spawn,
    shutdownTimeoutMs = 2_000,
  } = {}) {
    super(providerDefinitionId);
    this.environment = environment;
    this.onAccountChanged = onAccountChanged;
    this.spawnProcess = spawnProcess;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.process = null;
    this.startPromise = null;
    this.loginQueue = Promise.resolve();
    this.closing = false;
    this.activeLoginId = null;
    this.loginSettling = false;
  }

  async start() {
    if (this.closing) throw new Error("Codex app-server is shutting down.");
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start();
    try {
      await this.startPromise;
    } catch {
      const child = this.process;
      await terminateChildProcess(child, { gracePeriodMs: this.shutdownTimeoutMs });
      if (this.process === child) this.process = null;
      this.startPromise = null;
      this.activeLoginId = null;
      this.loginSettling = false;
      throw new Error("Codex subscription is unavailable.");
    }
  }

  async #start() {
    const executable = await findCodexExecutable(this.environment);
    if (!executable) {
      throw new Error("The managed Codex runtime is unavailable. Try Connect Codex again.");
    }
    if (this.closing) throw new Error("Codex app-server is shutting down.");
    const child = this.spawnProcess(executable, ["app-server", "--listen", "stdio://"], {
      env: this.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => this.#handleLine(line));
    child.stderr.on("data", () => {});
    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      const error = new Error(`Codex app-server stopped (${signal || code || "unknown"}).`);
      for (const id of [...this.pending.keys()]) {
        this.#takePending(id)?.reject(error);
      }
      this.process = null;
      this.startPromise = null;
      this.activeLoginId = null;
      this.loginSettling = false;
      if (!this.closing) this.onAccountChanged({ status: "unavailable", error: error.message });
    });
    child.once("error", () => {
      if (this.process === child) this.onAccountChanged({ status: "unavailable", error: "Codex subscription is unavailable." });
    });
    await waitForSpawn(child);
    await this.request("initialize", {
      clientInfo: { name: "relayer-desktop", title: "Relayer", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    this.notify("initialized", {});
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.#takePending(message.id);
      if (!pending) return;
      if (message.error) pending.reject(new Error("Codex request failed."));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "account/login/completed") {
      if (message.params?.loginId !== this.activeLoginId) return;
      this.activeLoginId = null;
      this.loginSettling = true;
    }
    if (message.method === "account/updated" || message.method === "account/login/completed") {
      this.onAccountChanged({ status: "changed", notification: message });
    }
  }

  #takePending(id) {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    return pending;
  }

  request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null) {
    if (!this.process?.stdin.writable) return Promise.reject(new Error("Codex app-server is not running."));
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const rejectPending = (error) => this.#takePending(id)?.reject(error);
      const onAbort = () => rejectPending(abortReason(signal));
      const timer = setTimeout(() => {
        rejectPending(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (this.process?.stdin.writable) this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async account({ signal } = {}) {
    try {
      await waitWithSignal(this.start(), signal);
      signal?.throwIfAborted();
      const result = await this.request(
        "account/read",
        { refreshToken: false },
        DEFAULT_TIMEOUT_MS,
        signal,
      );
      this.loginSettling = false;
      return { status: result.account ? "connected" : "disconnected", account: result.account ?? null };
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if ((this.activeLoginId || this.loginSettling) && this.process) {
        return { status: "pending", account: null };
      }
      return { status: "unavailable", account: null, error: "Codex subscription is unavailable." };
    }
  }

  async #login() {
    await this.start();
    this.loginSettling = false;
    if (this.activeLoginId) {
      await this.request("account/login/cancel", { loginId: this.activeLoginId }).catch(() => undefined);
      this.activeLoginId = null;
    }
    const result = await this.request("account/login/start", {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "codex",
    });
    this.activeLoginId = result?.loginId ?? null;
    return result;
  }

  login() {
    const operation = this.loginQueue.then(() => this.#login(), () => this.#login());
    this.loginQueue = operation.catch(() => undefined);
    return operation;
  }

  async logout() {
    await this.start();
    await this.request("account/logout", {});
    return this.account();
  }

  async close() {
    this.closing = true;
    const child = this.process;
    if (child) {
      await terminateChildProcess(child, { gracePeriodMs: this.shutdownTimeoutMs });
    }
    await this.startPromise?.catch(() => undefined);
    const lateChild = this.process;
    if (lateChild && lateChild !== child) {
      await terminateChildProcess(lateChild, { gracePeriodMs: this.shutdownTimeoutMs });
    }
    if (this.process === child) this.process = null;
    this.startPromise = null;
    this.activeLoginId = null;
    this.loginSettling = false;
  }
}

// Compatibility export for callers that used the implementation-oriented name.
export const CodexAppServerClient = CodexCredentialAdapter;
