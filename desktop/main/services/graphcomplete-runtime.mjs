import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { terminateChildProcess } from "./child-process.mjs";
import {
  acquireAuthenticatedErrorCapability,
  authenticatedErrorCapabilityBootstrap,
  revokeAuthenticatedErrorCapability,
} from "./authenticated-error-capability-bootstrap.mjs";

const RUNTIME_CLOSING_ERROR = "RELAYER_RUNTIME_CLOSING";
const ALLOWED_EXCEPTION_CLASSES = new Set([
  "AggregateError", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
]);

function sanitizedExceptionClass(error) {
  try {
    return ALLOWED_EXCEPTION_CLASSES.has(error?.name) ? error.name : null;
  } catch {
    return null;
  }
}

function runtimeClosingError(cause) {
  if (cause?.code === RUNTIME_CLOSING_ERROR) return cause;
  const error = new Error("GraphComplete runtime is shutting down.", cause === undefined ? undefined : { cause });
  error.code = RUNTIME_CLOSING_ERROR;
  return error;
}

function startupCleanupTimeoutError(timeoutMs) {
  const error = new Error(`GraphComplete runtime startup cleanup exceeded its ${timeoutMs}ms shutdown deadline.`);
  error.code = "RELAYER_RUNTIME_STARTUP_CLEANUP_TIMEOUT";
  return error;
}

function harnessCloseTimeoutError(timeoutMs) {
  const error = new Error(`GraphComplete runtime harness host close exceeded its ${timeoutMs}ms shutdown deadline.`);
  error.code = "RELAYER_RUNTIME_HARNESS_CLOSE_TIMEOUT";
  return error;
}

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

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function stringRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}

function validatedModelCapabilities(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider adapter returned invalid model capabilities.");
  }
  const entries = [];
  for (const [modelId, entry] of Object.entries(value)) {
    if (!nonEmptyString(modelId)
      || entry === null
      || typeof entry !== "object"
      || Array.isArray(entry)
      || !Number.isSafeInteger(entry.contextWindow)
      || entry.contextWindow < 1
      || !Number.isSafeInteger(entry.maxOutputTokens)
      || entry.maxOutputTokens < 1) {
      throw new Error("Provider adapter returned invalid model capabilities.");
    }
    entries.push([modelId, Object.freeze({
      contextWindow: entry.contextWindow,
      maxOutputTokens: entry.maxOutputTokens,
    })]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function validatedManagedRuntime(value) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || !nonEmptyString(value.runtimeId)
    || !nonEmptyString(value.version)
    || !nonEmptyString(value.executable)
    || !stringRecord(value.environment)
    || (value.moduleUrl !== undefined && !nonEmptyString(value.moduleUrl))
    || (value.runtimeId === "claude" && !nonEmptyString(value.moduleUrl))) {
    throw new Error("Provider adapter returned an invalid managed runtime descriptor.");
  }
  return Object.freeze({
    runtimeId: value.runtimeId,
    version: value.version,
    executable: value.executable,
    ...(value.moduleUrl === undefined ? {} : { moduleUrl: value.moduleUrl }),
    environment: Object.freeze({ ...value.environment }),
  });
}

function validatedExecutionAccess(resolved, definition, descriptor) {
  if (definition.accessContract === "secret@1") {
    if (resolved?.kind !== "secret"
      || !nonEmptyString(resolved.endpoint)
      || resolved.endpoint !== definition.endpoint
      || !stringRecord(resolved.fields)) {
      throw new Error("Provider adapter returned invalid secret execution access.");
    }
    const runtime = resolved.runtime === undefined
      ? undefined
      : validatedManagedRuntime(resolved.runtime);
    const modelCapabilities = validatedModelCapabilities(resolved.modelCapabilities);
    return Object.freeze({
      kind: "secret",
      contract: definition.accessContract,
      providerId: definition.id,
      adapterId: definition.adapterId,
      adapterImplementationVersion: descriptor.implementationVersion,
      endpoint: resolved.endpoint,
      fields: Object.freeze({ ...resolved.fields }),
      ...(modelCapabilities === undefined ? {} : { modelCapabilities }),
      ...(runtime === undefined ? {} : { runtime }),
    });
  }
  if (definition.accessContract === "managed-runtime@1") {
    if (resolved?.kind !== "managed-runtime" || !stringRecord(resolved.environment)) {
      throw new Error("Provider adapter returned invalid managed-runtime execution access.");
    }
    const hasRuntimeDescriptor = [
      resolved.runtimeId,
      resolved.version,
      resolved.executable,
      resolved.moduleUrl,
    ].some((value) => value !== undefined);
    const runtime = hasRuntimeDescriptor
      ? validatedManagedRuntime(resolved)
      : Object.freeze({ environment: Object.freeze({ ...resolved.environment }) });
    return Object.freeze({
      kind: "managed-runtime",
      contract: definition.accessContract,
      providerId: definition.id,
      adapterId: definition.adapterId,
      adapterImplementationVersion: descriptor.implementationVersion,
      ...runtime,
    });
  }
  throw new Error("Provider definition declares an unsupported execution contract.");
}

function onceRelease(release) {
  let releasePromise;
  return () => {
    if (!releasePromise) {
      const attempt = Promise.resolve().then(() => release());
      releasePromise = attempt;
      void attempt.catch(() => {
        if (releasePromise === attempt) releasePromise = undefined;
      });
    }
    return releasePromise;
  };
}

export function createProviderExecutionAccessBroker(acquireProviderExecution) {
  if (typeof acquireProviderExecution !== "function") {
    throw new TypeError("Provider execution acquisition must be a function.");
  }
  return Object.freeze({
    async acquire(selection, acceptedContracts, signal) {
      if (!nonEmptyString(selection?.providerId) || !nonEmptyString(selection?.adapterId)) {
        throw new Error("Execution selection must identify an exact provider definition and adapter.");
      }
      if (!Array.isArray(acceptedContracts)
        || acceptedContracts.length === 0
        || acceptedContracts.some((contract) => !nonEmptyString(contract))) {
        throw new Error("Harness execution contracts must be a non-empty string list.");
      }
      signal?.throwIfAborted();
      const lease = await acquireProviderExecution(selection.providerId);
      if (!lease || typeof lease.release !== "function") {
        throw new Error("Provider execution acquisition returned an invalid lease.");
      }
      const release = onceRelease(lease.release);
      try {
        const { definition, descriptor, runtime } = lease;
        if (definition?.id !== selection.providerId
          || definition?.adapterId !== selection.adapterId
          || descriptor?.adapterId !== selection.adapterId
          || descriptor?.accessContract !== definition?.accessContract
          || !acceptedContracts.includes(definition?.accessContract)
          || !nonEmptyString(descriptor?.implementationVersion)) {
          throw new Error("Selected provider does not satisfy the harness execution contract.");
        }
        if (typeof runtime?.executionAccess !== "function") {
          throw new Error("Provider adapter does not expose executable access.");
        }
        signal?.throwIfAborted();
        const resolved = await runtime.executionAccess({ signal });
        const access = validatedExecutionAccess(resolved, definition, descriptor);
        return Object.freeze({ access, release });
      } catch (error) {
        try {
          await release();
        } catch (releaseError) {
          throw new AggregateError(
            [error, releaseError],
            "Provider execution admission failed and lease rollback failed.",
          );
        }
        throw error;
      }
    },
  });
}

export class GraphCompleteRuntimeService {
  constructor({
    userDataDirectory,
    graphServerBinary,
    configurationPaths,
    unavailableConfigurations = [],
    additionalImplementations = {},
    codexBasicClientModuleUrl,
    codexBrowserMcpRuntime,
    graphAuthoringLauncherPath,
    codexPathOverride,
    resolveCodexRuntime,
    harnessHostModuleUrl,
    candidateTrace,
    acquireProviderExecution,
    spawnProcess = spawn,
    startupTimeoutMs = 10_000,
    shutdownTimeoutMs = 2_000,
    onUnexpectedStop = () => {},
    issueErrorReporter = () => null,
    issueErrorCapability = () => null,
  }) {
    this.userDataDirectory = userDataDirectory;
    this.graphServerBinary = graphServerBinary;
    this.configurationPaths = configurationPaths;
    this.unavailableConfigurations = unavailableConfigurations;
    this.additionalImplementations = additionalImplementations;
    this.codexBasicClientModuleUrl = codexBasicClientModuleUrl;
    this.codexBrowserMcpRuntime = codexBrowserMcpRuntime;
    this.graphAuthoringLauncherPath = graphAuthoringLauncherPath;
    this.codexPathOverride = codexPathOverride;
    this.resolveCodexRuntime = resolveCodexRuntime;
    this.harnessHostModuleUrl = harnessHostModuleUrl;
    this.candidateTrace = candidateTrace;
    this.acquireProviderExecution = acquireProviderExecution;
    this.spawnProcess = spawnProcess;
    this.startupTimeoutMs = startupTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.onUnexpectedStop = onUnexpectedStop;
    this.issueErrorReporter = issueErrorReporter;
    this.issueErrorCapability = issueErrorCapability;
    this.graphReporterGeneration = 0;
    this.graphErrorReporter = null;
    this.graphErrorCapability = null;
    this.graphProcess = null;
    this.harnessHost = null;
    this.session = null;
    this.closing = false;
    this.startupPromise = null;
    this.closePromise = null;
    this.closeSignal = new Promise((resolve) => {
      this.resolveCloseSignal = resolve;
    });
    this.startupCleanupFences = new Set();
    this.deferredCleanupFences = new Set();
  }

  async start() {
    if (this.session) return this.session;
    if (this.closing) throw runtimeClosingError();
    if (this.startupPromise) return this.startupPromise;
    const startupPromise = this.#start();
    this.startupPromise = startupPromise;
    try {
      return await startupPromise;
    } finally {
      if (this.startupPromise === startupPromise) this.startupPromise = null;
    }
  }

  async #start() {
    try {
      const {
        digestHarnessConfiguration,
        createCodexBasicFactory,
        loadHarnessConfigurations,
        productHarnessImplementations,
        startHarnessHost,
      } = await this.#awaitStartupOperation(import(this.harnessHostModuleUrl ?? "@relayer/harness-host"));
      const runtimeDirectory = join(this.userDataDirectory, "graphcomplete-runtime");
      await this.#awaitStartupOperation(mkdir(runtimeDirectory, { recursive: true }));
      await this.#awaitStartupOperation(chmod(runtimeDirectory, 0o700));
      const configurations = await this.#awaitStartupOperation(loadHarnessConfigurations(this.configurationPaths));
      const unavailableConfigurations = this.unavailableConfigurations
        .filter((unavailable) => !configurations.has(unavailable.name))
        .map((unavailable) => ({
          name: unavailable.name,
          reason: unavailable.reason,
          diagnostics: unavailable.diagnostics,
        }));
      const catalogPath = join(runtimeDirectory, "harness-configurations.json");
      await this.#awaitStartupOperation(writeFile(catalogPath, `${JSON.stringify({
        schemaVersion: 1,
        configurations: [...configurations.values()].map((configuration) => ({
          configuration,
          digest: digestHarnessConfiguration(configuration),
        })),
        unavailableConfigurations,
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }));

      const graphControlToken = randomBytes(32).toString("hex");
      const harnessControlToken = randomBytes(32).toString("hex");
      this.graphErrorReporter?.revoke();
      revokeAuthenticatedErrorCapability(this.graphErrorCapability);
      this.graphReporterGeneration += 1;
      try {
        this.graphErrorReporter = this.issueErrorReporter("rust-graph-server", this.graphReporterGeneration);
      } catch {
        this.graphErrorReporter = null;
      }
      this.graphErrorCapability = acquireAuthenticatedErrorCapability(
        this.issueErrorCapability,
        "rust-graph-server",
        this.graphReporterGeneration,
      );
      let graphProcess;
      let graphUrl;
      try {
        graphProcess = this.spawnProcess(this.graphServerBinary, [
          "--database", join(runtimeDirectory, "graph.sqlite3"),
          "--port", "0",
          "--authenticated-error-capability-stdin",
        ], { stdio: ["pipe", "pipe", "pipe"] });
        this.graphProcess = graphProcess;
        graphProcess.stdin?.on("error", () => {});
        graphProcess.stdin?.write(
          `${graphControlToken}\n${authenticatedErrorCapabilityBootstrap(this.graphErrorCapability)}`,
        );
        graphUrl = await this.#awaitStartupOperation(this.#waitForGraph(graphProcess));
      } catch (error) {
        if (!this.closing) this.#reportGraphStartupFailure(error);
        throw error;
      }
      this.#superviseGraph(graphProcess);
      if (graphProcess.exitCode !== null || graphProcess.signalCode !== null) {
        throw new Error(`Relayer graph server stopped after readiness (${graphProcess.signalCode || graphProcess.exitCode || "unknown"}).`);
      }
      let harnessHost;
      try {
        harnessHost = await this.#awaitStartupOperation(startHarnessHost({
        implementations: productHarnessImplementations({
          ...(this.codexBasicClientModuleUrl || this.codexBrowserMcpRuntime || this.graphAuthoringLauncherPath || this.codexPathOverride || this.resolveCodexRuntime ? {
            "codex.basic": createCodexBasicFactory({
              ...(this.codexBasicClientModuleUrl ? { clientModuleUrl: this.codexBasicClientModuleUrl } : {}),
              ...(this.codexBrowserMcpRuntime ? { browserMcpRuntime: this.codexBrowserMcpRuntime } : {}),
              ...(this.graphAuthoringLauncherPath ? { graphAuthoringLauncherPath: this.graphAuthoringLauncherPath } : {}),
              ...(this.codexPathOverride ? { codexPathOverride: this.codexPathOverride } : {}),
              ...(this.resolveCodexRuntime ? { resolveCodexRuntime: this.resolveCodexRuntime } : {}),
            }),
          } : {}),
          ...this.additionalImplementations,
        }),
        stateFile: join(runtimeDirectory, "harness-sessions.json"),
        controlToken: harnessControlToken,
        ...(this.candidateTrace ? { trace: this.candidateTrace } : {}),
        ...(this.acquireProviderExecution ? {
          accessBroker: createProviderExecutionAccessBroker(this.acquireProviderExecution),
        } : {}),
        }), async (lateHarnessHost) => {
          await lateHarnessHost.close();
        }, (lateHarnessHost) => lateHarnessHost.forceClose());
      } catch (error) { throw error; }
      this.harnessHost = harnessHost;
      this.session = Object.freeze({
        graphUrl,
        harnessUrl: harnessHost.url,
        graphControlToken,
        harnessControlToken,
        catalogPath,
        configurationNames: Object.freeze([...configurations.keys()]),
      });
      return this.session;
    } catch (error) {
      const cancellationRequested = this.closing;
      this.closing = true;
      this.resolveCloseSignal();
      try {
        await this.#closeResources(Date.now() + this.shutdownTimeoutMs);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "GraphComplete runtime startup and cleanup failed.");
      }
      if (cancellationRequested) throw runtimeClosingError(error);
      throw error;
    }
  }

  async exportCandidateTrace(productInteractionId, targetDirectory, correlation) {
    if (!this.harnessHost) throw new Error("GraphComplete runtime is not running.");
    return this.harnessHost.host.exportCandidateTrace(productInteractionId, targetDirectory, correlation);
  }

  candidateTracePersonalPresentationVersionId(productInteractionId) {
    if (!this.harnessHost) return undefined;
    return this.harnessHost.host.candidateTracePersonalPresentationVersionId(productInteractionId);
  }

  refreshErrorCapability() {
    const child = this.graphProcess;
    if (this.closing || !child?.stdin || this.graphReporterGeneration < 1) return false;
    const next = acquireAuthenticatedErrorCapability(
      this.issueErrorCapability,
      "rust-graph-server",
      this.graphReporterGeneration,
    );
    const previous = this.graphErrorCapability;
    this.graphErrorCapability = null;
    try {
      child.stdin.write(authenticatedErrorCapabilityBootstrap(next));
      this.graphErrorCapability = next;
      revokeAuthenticatedErrorCapability(previous);
      return true;
    } catch {
      revokeAuthenticatedErrorCapability(next);
      revokeAuthenticatedErrorCapability(previous);
      return false;
    }
  }

  close() {
    this.closing = true;
    this.resolveCloseSignal();
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.#close();
    return this.closePromise;
  }

  async #close() {
    const cleanupDeadline = Date.now() + this.shutdownTimeoutMs;
    const errors = [];
    try {
      await this.#closeResources(cleanupDeadline);
    } catch (error) {
      errors.push(error);
    }
    const startupPromise = this.startupPromise;
    if (startupPromise) {
      try {
        await startupPromise;
      } catch (error) {
        if (error?.code !== RUNTIME_CLOSING_ERROR) errors.push(error);
      }
    }
    errors.push(...await this.#settleStartupCleanups(cleanupDeadline));
    try {
      await this.#closeResources(cleanupDeadline);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "GraphComplete runtime did not close cleanly.");
  }

  #assertStarting() {
    if (this.closing) throw runtimeClosingError();
  }

  async #awaitStartupOperation(operation, onLateFulfilled, onLateDeadline) {
    const outcomePromise = Promise.resolve(operation).then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error }),
    );
    const outcome = await Promise.race([
      outcomePromise,
      this.closeSignal.then(() => ({ status: "closing" })),
    ]);
    if (outcome.status === "closing") {
      if (onLateFulfilled) this.#trackLateStartupOutcome(outcomePromise, onLateFulfilled, onLateDeadline);
      throw runtimeClosingError();
    }
    if (outcome.status === "rejected") throw outcome.error;
    if (this.closing) {
      if (onLateFulfilled) this.#trackLateStartupResource(outcome.value, onLateFulfilled, onLateDeadline);
      throw runtimeClosingError();
    }
    return outcome.value;
  }

  #trackLateStartupResource(resource, dispose, force) {
    this.#trackLateStartupOutcome(Promise.resolve({ status: "fulfilled", value: resource }), dispose, force);
  }

  #trackLateStartupOutcome(outcome, dispose, force) {
    let resource;
    let forceRequested = false;
    let forceInvoked = false;
    let forcePromise;
    const invokeForce = () => {
      forceRequested = true;
      if (resource === undefined || force === undefined) return Promise.resolve();
      if (forceInvoked) return forcePromise;
      forceInvoked = true;
      forcePromise = Promise.resolve().then(() => force(resource));
      return forcePromise;
    };
    const cleanup = outcome.then(async (lateOutcome) => {
      if (lateOutcome.status !== "fulfilled") return;
      resource = lateOutcome.value;
      let graceful;
      try {
        graceful = Promise.resolve(dispose(resource));
      } catch (error) {
        graceful = Promise.reject(error);
      }
      let forceError;
      if (forceRequested) {
        try { await invokeForce(); } catch (error) { forceError = error; }
      }
      const gracefulOutcome = await graceful.then(
        () => ({ status: "fulfilled" }),
        (error) => ({ status: "rejected", error }),
      );
      if (forceError !== undefined && gracefulOutcome.status === "rejected") {
        throw new AggregateError([gracefulOutcome.error, forceError], "Late harness host did not close cleanly.");
      }
      if (forceError !== undefined) throw forceError;
      if (gracefulOutcome.status === "rejected") throw gracefulOutcome.error;
    }).then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error }),
    );
    this.startupCleanupFences.add({ cleanup, force: invokeForce });
  }

  async #settleStartupCleanups(deadline) {
    const errors = [];
    while (this.startupCleanupFences.size > 0) {
      const entries = [...this.startupCleanupFences];
      const cleanups = entries.map((entry) => entry.cleanup);
      const remainingMs = Math.max(0, deadline - Date.now());
      let timeout;
      const outcomes = await Promise.race([
        Promise.all(cleanups),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(null), remainingMs);
        }),
      ]);
      clearTimeout(timeout);
      if (outcomes === null) {
        errors.push(startupCleanupTimeoutError(this.shutdownTimeoutMs));
        for (const entry of entries) {
          const forcing = Promise.resolve().then(() => entry.force());
          this.#retainDeferredCleanup(this.#combineCleanups(entry.cleanup, forcing));
          this.startupCleanupFences.delete(entry);
        }
        break;
      }
      for (const entry of entries) this.startupCleanupFences.delete(entry);
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status !== "rejected") continue;
        errors.push(outcome.error);
        errors.push(...await this.#forceStartupCleanupUntil(entries[index], deadline));
      }
    }
    return errors;
  }

  async #forceStartupCleanupUntil(entry, deadline) {
    const forcing = Promise.resolve().then(() => entry.force());
    const combined = this.#combineCleanups(entry.cleanup, forcing);
    const remainingMs = Math.max(0, deadline - Date.now());
    let timeout;
    const outcome = await Promise.race([
      combined.then(() => ({ status: "fulfilled" }), (error) => ({ status: "rejected", error })),
      forcing.then(() => new Promise(() => {}), (error) => ({ status: "force-rejected", error })),
      new Promise((resolve) => { timeout = setTimeout(() => resolve({ status: "timed-out" }), remainingMs); }),
    ]);
    clearTimeout(timeout);
    if (outcome.status === "force-rejected") {
      this.#retainDeferredCleanup(combined);
      return [outcome.error];
    }
    if (outcome.status === "rejected") return [outcome.error];
    if (outcome.status === "fulfilled") return [];
    this.#retainDeferredCleanup(combined);
    return [startupCleanupTimeoutError(this.shutdownTimeoutMs)];
  }

  #retainDeferredCleanup(cleanup) {
    const observed = Promise.resolve(cleanup).then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error }),
    );
    this.deferredCleanupFences.add(observed);
    void observed.finally(() => this.deferredCleanupFences.delete(observed));
  }

  async #combineCleanups(...cleanups) {
    const outcomes = await Promise.allSettled(cleanups);
    const errors = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Deferred runtime cleanup failed.");
  }

  async #closeResources(deadline = Date.now() + this.shutdownTimeoutMs) {
    this.graphErrorReporter?.revoke();
    this.graphErrorReporter = null;
    revokeAuthenticatedErrorCapability(this.graphErrorCapability);
    this.graphErrorCapability = null;
    const harnessHost = this.harnessHost;
    const graphProcess = this.graphProcess;
    this.harnessHost = null;
    this.graphProcess = null;
    this.session = null;
    const errors = [];
    if (harnessHost) {
      errors.push(...await this.#closeHarnessHost(harnessHost, deadline));
    }
    if (graphProcess) {
      try {
        await terminateChildProcess(graphProcess, {
          gracePeriodMs: this.shutdownTimeoutMs,
          deadlineMs: deadline,
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "GraphComplete runtime resources did not close cleanly.");
  }

  #reportGraphStartupFailure(error) {
    const startupReporter = this.graphErrorReporter;
    this.graphErrorReporter = null;
    Promise.resolve(startupReporter?.report({
      code: "rust_graph_server.startup_failure",
      exceptionClass: sanitizedExceptionClass(error),
      frames: [],
    })).catch(() => undefined).finally(() => startupReporter?.revoke());
  }

  async #closeHarnessHost(harnessHost, deadline) {
    const graceful = Promise.resolve().then(() => harnessHost.close()).then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error }),
    );
    const remainingMs = Math.max(0, deadline - Date.now());
    let timeout;
    const outcome = await Promise.race([
      graceful,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timed-out" }), remainingMs);
      }),
    ]);
    clearTimeout(timeout);
    if (outcome.status === "fulfilled") return [];
    if (outcome.status === "rejected") {
      const errors = [outcome.error];
      errors.push(...await this.#forceHarnessHostUntil(harnessHost, graceful, deadline));
      return errors;
    }
    const errors = [harnessCloseTimeoutError(this.shutdownTimeoutMs)];
    errors.push(...await this.#forceHarnessHostUntil(harnessHost, graceful, deadline, true));
    return errors;
  }

  async #forceHarnessHostUntil(harnessHost, graceful, deadline, timeoutAlreadyReported = false) {
    const forcing = Promise.resolve().then(() => harnessHost.forceClose());
    const combined = this.#combineCleanups(graceful, forcing);
    const remainingMs = Math.max(0, deadline - Date.now());
    let timeout;
    const outcome = await Promise.race([
      combined.then(() => ({ status: "fulfilled" }), (error) => ({ status: "rejected", error })),
      forcing.then(() => new Promise(() => {}), (error) => ({ status: "force-rejected", error })),
      new Promise((resolve) => { timeout = setTimeout(() => resolve({ status: "timed-out" }), remainingMs); }),
    ]);
    clearTimeout(timeout);
    if (outcome.status === "force-rejected") {
      this.#retainDeferredCleanup(combined);
      return [outcome.error];
    }
    if (outcome.status === "rejected") return [outcome.error];
    if (outcome.status === "fulfilled") return [];
    this.#retainDeferredCleanup(combined);
    return timeoutAlreadyReported ? [] : [harnessCloseTimeoutError(this.shutdownTimeoutMs)];
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
      const stoppedReporter = this.graphErrorReporter;
      const stoppedCapability = this.graphErrorCapability;
      this.graphErrorReporter = null;
      this.graphErrorCapability = null;
      revokeAuthenticatedErrorCapability(stoppedCapability);
      if (this.graphProcess === child) {
        this.graphProcess = null;
        this.session = null;
      }
      if (!expected) {
        Promise.resolve(stoppedReporter?.report({
          code: "rust_graph_server.unexpected_exit",
          exceptionClass: null,
          frames: [],
        })).catch(() => undefined).finally(() => stoppedReporter?.revoke());
        console.error(`Relayer graph server stopped (${signal || code || "unknown"}).`);
        Promise.resolve(this.onUnexpectedStop({ code, signal })).catch((error) => {
          console.error("Relayer graph-server stop handler failed:", error);
        });
      } else stoppedReporter?.revoke();
    };
    child.once("exit", onStopped);
  }
}
