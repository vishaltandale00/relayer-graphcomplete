import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CredentialAdapter } from "./credential-adapter.mjs";
import { terminateChildProcess } from "../services/child-process.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;

async function executableExists(path) {
  if (!path) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findCodexExecutable(environment = process.env) {
  const explicit = String(environment.RELAYER_CODEX_BINARY || "").trim();
  const pathEntries = String(environment.PATH || "").split(delimiter).filter(Boolean);
  const candidates = [
    explicit,
    ...pathEntries.map((entry) => `${entry}/codex`),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await executableExists(candidate)) return candidate;
  }
  return null;
}

export class CodexCredentialAdapter extends CredentialAdapter {
  constructor({
    environment = process.env,
    onAccountChanged = () => {},
    spawnProcess = spawn,
    shutdownTimeoutMs = 2_000,
  } = {}) {
    super("codex");
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
  }

  async start() {
    if (this.closing) throw new Error("Codex app-server is shutting down.");
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start();
    try {
      await this.startPromise;
    } catch (error) {
      const child = this.process;
      await terminateChildProcess(child, { gracePeriodMs: this.shutdownTimeoutMs });
      if (this.process === child) this.process = null;
      this.startPromise = null;
      this.activeLoginId = null;
      throw error;
    }
  }

  async #start() {
    const executable = await findCodexExecutable(this.environment);
    if (!executable) {
      throw new Error("Codex CLI is not installed. Install Codex, then try Connect Codex again.");
    }
    if (this.closing) throw new Error("Codex app-server is shutting down.");
    const child = this.spawnProcess(executable, ["app-server", "--listen", "stdio://"], {
      env: this.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.#handleLine(line));
    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) console.info(`[codex app-server] ${message}`);
    });
    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      const error = new Error(`Codex app-server stopped (${signal || code || "unknown"}).`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      this.process = null;
      this.startPromise = null;
      this.activeLoginId = null;
      if (!this.closing) this.onAccountChanged({ status: "unavailable", error: error.message });
    });
    child.once("error", (error) => {
      if (this.process === child) this.onAccountChanged({ status: "unavailable", error: error.message });
    });
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
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex request failed."));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "account/login/completed") {
      if (message.params?.loginId !== this.activeLoginId) return;
      this.activeLoginId = null;
    }
    if (message.method === "account/updated" || message.method === "account/login/completed") {
      this.onAccountChanged({ status: "changed", notification: message });
    }
  }

  request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.process?.stdin.writable) return Promise.reject(new Error("Codex app-server is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (this.process?.stdin.writable) this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async account() {
    try {
      await this.start();
      const result = await this.request("account/read", { refreshToken: false });
      return { status: result.account ? "connected" : "disconnected", account: result.account ?? null };
    } catch (error) {
      return { status: "unavailable", account: null, error: error.message };
    }
  }

  async #login() {
    await this.start();
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
  }
}

// Compatibility export for callers that used the implementation-oriented name.
export const CodexAppServerClient = CodexCredentialAdapter;
