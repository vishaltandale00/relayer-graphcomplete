import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { terminateChildProcess } from "./child-process.mjs";
import { toProductCatalogSnapshot } from "../models/model-catalog-adapter.mjs";

export const RELAYER_CONTROL_COOKIE = "relayer_control";

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
    defaultHarnessConfiguration = "codex",
    allowHarnessOverride = false,
    allowConversationImport = false,
    enableReadOnlySession = false,
    exportProducer = {
      desktopVersion: "development",
      buildCommit: "development",
      platform: process.platform,
      architecture: process.arch,
    },
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
    this.defaultHarnessConfiguration = defaultHarnessConfiguration;
    this.allowHarnessOverride = allowHarnessOverride;
    this.allowConversationImport = allowConversationImport;
    this.enableReadOnlySession = enableReadOnlySession;
    for (const [field, value] of Object.entries(exportProducer)) {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Conversation export producer ${field} must be a non-empty string.`);
      }
    }
    this.exportProducer = Object.freeze({ ...exportProducer });
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
    const excludedTokens = new Set();
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
      "--producer-desktop-version", this.exportProducer.desktopVersion,
      "--producer-build-commit", this.exportProducer.buildCommit,
      "--producer-platform", this.exportProducer.platform,
      "--producer-architecture", this.exportProducer.architecture,
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
      if (this.allowConversationImport) serverArguments.push("--allow-conversation-import");
    }
    if (readOnlyControlToken) serverArguments.push("--read-only-control-token-stdin");
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

  async validateProviderOnboarding({ signal } = {}) {
    const session = await this.start();
    const response = await fetch(new URL("/api/provider-onboarding/status", session.origin), {
      headers: { Cookie: `${session.cookie.name}=${session.cookie.value}` },
      signal,
    });
    if (!response.ok) return false;
    const status = await response.json();
    return status?.complete === true;
  }

  async providerStatuses({ signal } = {}) {
    const session = await this.start();
    const response = await fetch(new URL("/api/model-settings", session.origin), {
      headers: { Cookie: `${session.cookie.name}=${session.cookie.value}` },
      signal,
    });
    if (!response.ok) throw new Error(`Provider status read failed (${response.status}).`);
    const settings = await response.json();
    return new Map((settings.providers ?? []).map((provider) => [provider.id, {
      connected: provider.connected === true,
      unavailableReason: provider.unavailableReason ?? null,
    }]));
  }

  providerDefinitionStore() {
    return Object.freeze({
      load: async () => {
        const session = await this.start();
        const response = await fetch(new URL("/api/internal/provider-definitions", session.origin), {
          headers: { Authorization: `Bearer ${session.cookie.value}` },
        });
        if (!response.ok) throw new Error(`Provider definition read failed (${response.status}).`);
        return response.json();
      },
      save: async (definitions) => {
        const session = await this.start();
        const response = await fetch(new URL("/api/internal/provider-definitions", session.origin), {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${session.cookie.value}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(definitions),
        });
        if (response.ok) return;
        let detail = null;
        try { detail = await response.json(); } catch { /* use status fallback */ }
        throw new Error(detail?.error?.message || detail?.error || `Provider definition write failed (${response.status}).`);
      },
      createWithCatalog: async (definition, catalog, { signal } = {}) => {
        const session = await this.start();
        const response = await fetch(new URL("/api/internal/provider-definitions/staged", session.origin), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.cookie.value}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ definition, catalog: toProductCatalogSnapshot(catalog) }),
          signal,
        });
        if (response.ok) return;
        let detail = null;
        try { detail = await response.json(); } catch { /* use status fallback */ }
        throw new Error(detail?.error?.message || detail?.error || `Provider creation failed (${response.status}).`);
      },
    });
  }

  async exportConversation(threadId, { signal } = {}) {
    if (!Number.isSafeInteger(threadId) || threadId <= 0) {
      throw new Error("Conversation export requires a positive thread ID.");
    }
    const session = await this.start();
    signal?.throwIfAborted();
    const response = await fetch(new URL(`/api/threads/${threadId}/export`, session.origin), {
      headers: { Cookie: `${session.cookie.name}=${session.cookie.value}` },
      signal,
    });
    if (response.ok) {
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/x-ndjson") {
        throw new Error("Conversation export returned an unexpected content type.");
      }
      return new Uint8Array(await response.arrayBuffer());
    }
    let detail;
    try {
      detail = await response.json();
    } catch {
      detail = null;
    }
    throw new Error(detail?.error || `Conversation export failed (${response.status}).`);
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
