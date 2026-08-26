import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  digestHarnessConfiguration,
  createCodexBasicFactory,
  loadHarnessConfigurations,
  productHarnessImplementations,
  startHarnessHost,
} from "@relayer/harness-host";
import { terminateChildProcess } from "./child-process.mjs";

function validateGraphReady(message) {
  if (message?.ready !== true) return null;
  let url;
  try {
    url = new URL(message.url);
  } catch {
    throw new Error("Relayer graph server returned an invalid URL.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error("Relayer graph server must use a 127.0.0.1 loopback URL.");
  }
  return url.origin;
}

export class GraphCompleteRuntimeService {
  constructor({
    userDataDirectory,
    graphServerBinary,
    configurationPaths,
    additionalImplementations = {},
    codexBasicClientModuleUrl,
    codexPathOverride,
    candidateTrace,
    acquireProviderExecution,
    spawnProcess = spawn,
    startupTimeoutMs = 10_000,
    shutdownTimeoutMs = 2_000,
    onUnexpectedStop = () => {},
  }) {
    this.userDataDirectory = userDataDirectory;
    this.graphServerBinary = graphServerBinary;
    this.configurationPaths = configurationPaths;
    this.additionalImplementations = additionalImplementations;
    this.codexBasicClientModuleUrl = codexBasicClientModuleUrl;
    this.codexPathOverride = codexPathOverride;
    this.candidateTrace = candidateTrace;
    this.acquireProviderExecution = acquireProviderExecution;
    this.spawnProcess = spawnProcess;
    this.startupTimeoutMs = startupTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.onUnexpectedStop = onUnexpectedStop;
    this.graphProcess = null;
    this.harnessHost = null;
    this.session = null;
    this.closing = false;
  }

  async start() {
    if (this.session) return this.session;
    if (this.closing) throw new Error("GraphComplete runtime is shutting down.");
    const runtimeDirectory = join(this.userDataDirectory, "graphcomplete-runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    await chmod(runtimeDirectory, 0o700);
    const configurations = await loadHarnessConfigurations(this.configurationPaths);
    const catalogPath = join(runtimeDirectory, "harness-configurations.json");
    await writeFile(catalogPath, `${JSON.stringify({
      schemaVersion: 1,
      configurations: [...configurations.values()].map((configuration) => ({
        configuration,
        digest: digestHarnessConfiguration(configuration),
      })),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    const graphControlToken = randomBytes(32).toString("hex");
    const harnessControlToken = randomBytes(32).toString("hex");
    const graphProcess = this.spawnProcess(this.graphServerBinary, [
      "--database", join(runtimeDirectory, "graph.sqlite3"),
      "--port", "0",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.graphProcess = graphProcess;
    try {
      graphProcess.stdin?.on("error", () => {});
      graphProcess.stdin?.write(`${graphControlToken}\n`);
      const graphUrl = await this.#waitForGraph(graphProcess);
      this.#superviseGraph(graphProcess);
      if (graphProcess.exitCode !== null || graphProcess.signalCode !== null) {
        throw new Error(`Relayer graph server stopped after readiness (${graphProcess.signalCode || graphProcess.exitCode || "unknown"}).`);
      }
      this.harnessHost = await startHarnessHost({
        implementations: productHarnessImplementations({
          ...(this.codexBasicClientModuleUrl || this.codexPathOverride ? {
            "codex.basic": createCodexBasicFactory({
              ...(this.codexBasicClientModuleUrl ? { clientModuleUrl: this.codexBasicClientModuleUrl } : {}),
              ...(this.codexPathOverride ? { codexPathOverride: this.codexPathOverride } : {}),
            }),
          } : {}),
          ...this.additionalImplementations,
        }),
        stateFile: join(runtimeDirectory, "harness-sessions.json"),
        controlToken: harnessControlToken,
        ...(this.candidateTrace ? { trace: this.candidateTrace } : {}),
        ...(this.acquireProviderExecution ? {
          accessBroker: {
            acquire: async (selection, acceptedContracts, signal) => {
              const lease = await this.acquireProviderExecution(selection.providerId);
              try {
                const { definition, descriptor, runtime } = lease;
                if (definition.adapterId !== selection.adapterId || !acceptedContracts.includes(definition.accessContract)) {
                  throw new Error("Selected provider does not satisfy the harness execution contract.");
                }
                const resolved = await runtime.executionAccess?.({ signal });
                if (!resolved) throw new Error("Provider adapter does not expose executable access.");
                return Object.freeze({
                  access: Object.freeze({
                    ...resolved,
                    contract: definition.accessContract,
                    providerId: definition.id,
                    adapterId: definition.adapterId,
                    adapterImplementationVersion: descriptor.implementationVersion,
                  }),
                  release: lease.release,
                });
              } catch (error) {
                await lease.release();
                throw error;
              }
            },
          },
        } : {}),
      });
      this.session = Object.freeze({
        graphUrl,
        harnessUrl: this.harnessHost.url,
        graphControlToken,
        harnessControlToken,
        catalogPath,
        configurationNames: Object.freeze([...configurations.keys()]),
      });
      return this.session;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async exportCandidateTrace(productInteractionId, targetDirectory, correlation) {
    if (!this.harnessHost) throw new Error("GraphComplete runtime is not running.");
    return this.harnessHost.host.exportCandidateTrace(productInteractionId, targetDirectory, correlation);
  }

  async close() {
    this.closing = true;
    const errors = [];
    if (this.harnessHost) {
      try { await this.harnessHost.close(); } catch (error) { errors.push(error); }
    }
    this.harnessHost = null;
    if (this.graphProcess) {
      try {
        await terminateChildProcess(this.graphProcess, { gracePeriodMs: this.shutdownTimeoutMs });
      } catch (error) {
        errors.push(error);
      }
    }
    this.graphProcess = null;
    this.session = null;
    if (errors.length) throw new AggregateError(errors, "GraphComplete runtime did not close cleanly.");
  }

  #waitForGraph(child) {
    return new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      const stderr = [];
      child.stderr.on("data", (chunk) => {
        stderr.push(String(chunk));
        if (stderr.join("").length > 8_000) stderr.shift();
      });
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Relayer graph server did not become ready in time."));
      }, this.startupTimeoutMs);
      const onExit = (code, signal) => {
        cleanup();
        const detail = stderr.join("").trim();
        reject(new Error(`Relayer graph server stopped before readiness (${signal || code || "unknown"})${detail ? `: ${detail}` : "."}`));
      };
      const onError = (error) => {
        cleanup();
        reject(new Error(`Relayer graph server could not start: ${error.message}`));
      };
      const onLine = (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        try {
          const url = validateGraphReady(message);
          if (!url) return;
          cleanup();
          resolve(url);
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

  #superviseGraph(child) {
    const onStopped = (code, signal) => {
      const expected = this.closing || this.graphProcess !== child;
      if (this.graphProcess === child) {
        this.graphProcess = null;
        this.session = null;
      }
      if (!expected) {
        console.error(`Relayer graph server stopped (${signal || code || "unknown"}).`);
        Promise.resolve(this.onUnexpectedStop({ code, signal })).catch((error) => {
          console.error("Relayer graph-server stop handler failed:", error);
        });
      }
    };
    child.once("exit", onStopped);
  }
}
