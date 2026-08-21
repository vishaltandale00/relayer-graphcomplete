import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { terminateChildProcess } from "./child-process.mjs";

export const RELAYER_CONTROL_COOKIE = "relayer_control";

function validateProviderCatalogRefreshSession(session) {
  if (session === null) return null;
  let origin;
  try {
    origin = new URL(session?.origin);
  } catch {
    throw new Error("Provider catalog refresh server returned an invalid origin.");
  }
  if (
    origin.protocol !== "http:"
    || origin.hostname !== "127.0.0.1"
    || !origin.port
    || origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
  ) {
    throw new Error("Provider catalog refresh server must use an authenticated 127.0.0.1 origin.");
  }
  if (!/^[a-f0-9]{64}$/.test(session?.token)) {
    throw new Error("Provider catalog refresh server returned an invalid bearer token.");
  }
  return Object.freeze({ origin: origin.origin, token: session.token });
}

function distinctToken(excludedTokens) {
  let token;
  do token = randomBytes(32).toString("hex"); while (excludedTokens.has(token));
  return token;
}

function validateReadyMessage(message) {
  if (message?.ready !== true) return null;
  if (message.cookieName !== RELAYER_CONTROL_COOKIE) {
    throw new Error("Relayer app server returned an unexpected control cookie.");
  }
  let origin;
  try {
    origin = new URL(message.origin);
  } catch {
    throw new Error("Relayer app server returned an invalid origin.");
  }
  if (
    origin.protocol !== "http:"
    || origin.hostname !== "127.0.0.1"
    || !origin.port
    || origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
  ) {
    throw new Error("Relayer app server must use an authenticated 127.0.0.1 origin.");
  }
  return { origin: origin.origin, cookieName: message.cookieName };
}

export class RelayerAppServerService {
  constructor({
    userDataDirectory,
    binaryPath,
    webDirectory,
    permissionCatalogPath,
    runtimeSession = null,
    providerCatalogRefreshSession = null,
    defaultHarnessConfiguration = "codex-basic",
    allowHarnessOverride = false,
    enableReadOnlySession = false,
    spawnProcess = spawn,
    startupTimeoutMs = 10_000,
    shutdownTimeoutMs = 2_000,
    onUnexpectedStop = () => {},
  }) {
    this.userDataDirectory = userDataDirectory;
    this.binaryPath = binaryPath;
    this.webDirectory = webDirectory;
    this.permissionCatalogPath = permissionCatalogPath;
    this.runtimeSession = runtimeSession;
    this.providerCatalogRefreshSession = validateProviderCatalogRefreshSession(providerCatalogRefreshSession);
    this.defaultHarnessConfiguration = defaultHarnessConfiguration;
    this.allowHarnessOverride = allowHarnessOverride;
    this.enableReadOnlySession = enableReadOnlySession;
    this.spawnProcess = spawnProcess;
    this.startupTimeoutMs = startupTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.onUnexpectedStop = onUnexpectedStop;
    this.child = null;
    this.listening = null;
    this.startPromise = null;
    this.closing = false;
  }

  async start() {
    if (this.closing) throw new Error("Relayer app server is shutting down.");
    if (this.listening) return this.listening;
    if (this.startPromise) return this.startPromise;
    const operation = this.#start();
    this.startPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.startPromise === operation) this.startPromise = null;
    }
  }

  async #start() {
    const dataDirectory = join(this.userDataDirectory, "product-data");
    await mkdir(dataDirectory, { recursive: true });
    await chmod(dataDirectory, 0o700);
    if (this.closing) throw new Error("Relayer app server is shutting down.");
    const excludedTokens = new Set(this.providerCatalogRefreshSession ? [this.providerCatalogRefreshSession.token] : []);
    const controlToken = distinctToken(excludedTokens);
    excludedTokens.add(controlToken);
    const readOnlyControlToken = this.enableReadOnlySession
      ? distinctToken(excludedTokens)
      : null;
    const serverArguments = [
      "--data-dir", dataDirectory,
      "--web-dir", this.webDirectory,
      "--permission-catalog", this.permissionCatalogPath,
      "--port", "0",
    ];
    if (this.runtimeSession) {
      serverArguments.push(
        "--graph-url", this.runtimeSession.graphUrl,
        "--harness-url", this.runtimeSession.harnessUrl,
        "--graph-control-token", this.runtimeSession.graphControlToken,
        "--harness-control-token", this.runtimeSession.harnessControlToken,
        "--harness-configurations", this.runtimeSession.catalogPath,
        "--default-harness-configuration", this.defaultHarnessConfiguration,
      );
      if (this.allowHarnessOverride) serverArguments.push("--allow-harness-override");
    }
    if (readOnlyControlToken) serverArguments.push("--read-only-control-token-stdin");
    if (this.providerCatalogRefreshSession) {
      serverArguments.push(
        "--provider-catalog-refresh-url", this.providerCatalogRefreshSession.origin,
        "--provider-catalog-refresh-token-stdin",
      );
    }
    const child = this.spawnProcess(this.binaryPath, serverArguments, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const stderr = [];
    try {
      child.stdin?.on("error", () => {});
      child.stdin?.write([
        controlToken,
        ...(readOnlyControlToken ? [readOnlyControlToken] : []),
        ...(this.providerCatalogRefreshSession ? [this.providerCatalogRefreshSession.token] : []),
      ].map((value) => `${value}\n`).join(""));
      child.stderr?.on("data", (chunk) => {
        stderr.push(String(chunk));
        if (stderr.join("").length > 8_000) stderr.shift();
      });
      const ready = await this.#waitForReady(child, stderr);
      this.listening = {
        origin: ready.origin,
        cookie: {
          name: ready.cookieName,
          value: controlToken,
        },
        ...(readOnlyControlToken ? {
          readOnlyCookie: {
            name: ready.cookieName,
            value: readOnlyControlToken,
          },
        } : {}),
      };
      const onStopped = (code, signal) => {
        const expected = this.closing;
        this.child = null;
        this.listening = null;
        if (!expected) {
          console.error(`Relayer app server stopped (${signal || code || "unknown"}).`);
          Promise.resolve(this.onUnexpectedStop({ code, signal })).catch((error) => {
            console.error("Relayer app-server stop handler failed:", error);
          });
        }
      };
      child.once("exit", onStopped);
      if (child.exitCode !== null || child.signalCode !== null) {
        child.off("exit", onStopped);
        onStopped(child.exitCode, child.signalCode);
        throw new Error(`Relayer app server stopped after readiness (${child.signalCode || child.exitCode || "unknown"}).`);
      }
      return this.listening;
    } catch (error) {
      await terminateChildProcess(child, { gracePeriodMs: this.shutdownTimeoutMs });
      if (this.child === child) this.child = null;
      this.listening = null;
      throw error;
    }
  }

  async close() {
    this.closing = true;
    const child = this.child;
    if (child) {
      await terminateChildProcess(child, { gracePeriodMs: this.shutdownTimeoutMs });
    }
    await this.startPromise?.catch(() => undefined);
    const lateChild = this.child;
    if (lateChild && lateChild !== child) {
      await terminateChildProcess(lateChild, { gracePeriodMs: this.shutdownTimeoutMs });
    }
    if (this.child === child) this.child = null;
    this.listening = null;
  }

  async publishProviderCatalog(snapshot, { signal } = {}) {
    const session = await this.start();
    signal?.throwIfAborted();
    const response = await fetch(new URL("/api/internal/provider-catalog", session.origin), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${session.cookie.value}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(snapshot),
      signal,
    });
    if (response.ok) return;
    let detail;
    try {
      detail = await response.json();
    } catch {
      detail = null;
    }
    throw new Error(detail?.error?.message || detail?.error || `Provider catalog publish failed (${response.status}).`);
  }

  #waitForReady(child, stderr) {
    return new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Relayer app server did not become ready in time."));
      }, this.startupTimeoutMs);
      const onExit = (code, signal) => {
        cleanup();
        const detail = stderr.join("").trim();
        reject(new Error(`Relayer app server stopped before readiness (${signal || code || "unknown"})${detail ? `: ${detail}` : "."}`));
      };
      const onError = (error) => {
        cleanup();
        reject(new Error(`Relayer app server could not start: ${error.message}`));
      };
      const onLine = (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          // Non-protocol output is ignored until the readiness timeout.
          return;
        }
        try {
          const ready = validateReadyMessage(message);
          if (!ready) return;
          cleanup();
          resolve(ready);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const cleanup = () => {
        clearTimeout(timeout);
        lines.off("line", onLine);
        child.off("exit", onExit);
        child.off("error", onError);
        lines.close();
      };
      lines.on("line", onLine);
      child.once("exit", onExit);
      child.once("error", onError);
    });
  }
}
