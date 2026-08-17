import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export class RelayerAppServerService {
  constructor({
    userDataDirectory,
    binaryPath,
    webDirectory,
    spawnProcess = spawn,
    startupTimeoutMs = 10_000,
  }) {
    this.userDataDirectory = userDataDirectory;
    this.binaryPath = binaryPath;
    this.webDirectory = webDirectory;
    this.spawnProcess = spawnProcess;
    this.startupTimeoutMs = startupTimeoutMs;
    this.child = null;
    this.listening = null;
    this.closing = false;
  }

  async start() {
    if (this.listening) return this.listening;
    if (this.child) throw new Error("Relayer app server is already starting.");

    const dataDirectory = join(this.userDataDirectory, "product-data");
    await mkdir(dataDirectory, { recursive: true });
    const controlToken = randomBytes(32).toString("hex");
    const child = this.spawnProcess(this.binaryPath, [
      "--data-dir", dataDirectory,
      "--web-dir", this.webDirectory,
      "--control-token", controlToken,
      "--port", "0",
    ], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.closing = false;

    const stderr = [];
    child.stderr?.on("data", (chunk) => {
      stderr.push(String(chunk));
      if (stderr.join("").length > 8_000) stderr.shift();
    });

    try {
      const ready = await this.#waitForReady(child, stderr);
      this.listening = {
        origin: ready.origin,
        cookie: {
          name: ready.cookieName,
          value: controlToken,
        },
      };
      const onStopped = (code, signal) => {
        const expected = this.closing;
        this.child = null;
        this.listening = null;
        if (!expected) {
          console.error(`Relayer app server stopped (${signal || code || "unknown"}).`);
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
      if (!child.killed && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      this.child = null;
      throw error;
    }
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.closing = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      child.kill("SIGTERM");
    });
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
        try {
          const message = JSON.parse(line);
          if (message.ready === true && typeof message.origin === "string" && typeof message.cookieName === "string") {
            cleanup();
            resolve(message);
          }
        } catch {
          // Non-protocol output is ignored until the readiness timeout.
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
