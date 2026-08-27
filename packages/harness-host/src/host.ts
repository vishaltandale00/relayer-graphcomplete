import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { GraphApiError, RelayerGraphClient, type GraphCapability } from "@relayer/graph-client";
import {
  HarnessApprovalCoordinator,
  HarnessApprovalCoordinatorError,
  type HarnessApprovalChannel,
  type HarnessApprovalResolution,
  type HarnessApprovalSnapshot,
} from "./approval-coordinator.js";
import {
  isJsonObject,
  parseHarnessConfiguration,
  harnessAllowsModel,
  sameHarnessExecutionConfiguration,
} from "./configuration.js";
import { resolveHarnessFactory } from "./registry.js";
import {
  HarnessTraceStore,
  NO_HARNESS_TRACE_SUPPORT,
  createNoopHarnessTraceSink,
  type HarnessTraceExportCorrelation,
  type HarnessTraceStoreOptions,
} from "./trace.js";
import type {
  Harness,
  HarnessCompleteResult,
  HarnessConfiguration,
  HarnessImplementationMap,
  InteractionModelSelection,
  HarnessGraphScope,
  HarnessSessionDescriptor,
  HarnessSessionRegistration,
  HarnessSessionState,
  HarnessCompletionTraceContext,
  HarnessExecutionAccessBroker,
  HarnessExecutionAccessLease,
  HarnessTraceDescriptor,
  HarnessTraceSink,
} from "./types.js";

interface LiveSession {
  descriptor: HarnessSessionDescriptor;
  harness: Harness;
  lifecycle: HarnessLifecycle;
  approvals: HarnessApprovalCoordinator;
  tail: Promise<void>;
  activeCompletion?: {
    readonly completeCallId: string;
    readonly interactionId: number;
    readonly controller: AbortController;
  };
  currentPolicyRevision?: number;
  currentPolicyIdentity?: string;
}

interface HarnessExecutionPolicy {
  readonly configurationRevision: number;
  readonly configurationDigest: string;
  readonly modelRules?: HarnessConfiguration["modelRules"];
}

const EXECUTION_ADMISSION_TIMEOUT_MS = 30_000;
const EXECUTION_TERMINAL_ACK_TIMEOUT_MS = 30_000;

export type HarnessEffectBoundary = "none" | "partial_output" | "graph_write" | "tool_effect" | "unknown";

export class HarnessExecutionFailure extends Error {
  constructor(message: string, readonly failureCategory: string, readonly effectBoundary: HarnessEffectBoundary, options?: ErrorOptions) {
    super(message, options);
    this.name = "HarnessExecutionFailure";
  }
}

class HarnessLifecycle {
  private disposePromise: Promise<void> | undefined;
  private forceRequested = false;

  constructor(readonly harness: Harness) {}

  dispose(): Promise<void> {
    if (this.disposePromise === undefined) {
      this.disposePromise = Promise.resolve().then(() => this.harness.dispose?.());
    }
    return this.disposePromise;
  }

  forceShutdown(): void {
    if (this.forceRequested) return;
    this.forceRequested = true;
    this.harness.forceShutdown?.();
  }
}

interface PersistedHarnessSessionDescriptor {
  readonly threadId: number;
  readonly configuration: HarnessConfiguration;
  readonly permissionProfileId: string;
  readonly workingDirectory: string;
  readonly state?: HarnessSessionState;
}

interface LegacyPersistedHarnessSessionDescriptor {
  readonly threadId: number;
  readonly configuration: Omit<HarnessConfiguration, "permissionBindings">;
  readonly workingDirectory: string;
  readonly state?: HarnessSessionState;
}

const CURRENT_HOST_STATE_SCHEMA_VERSION = 5;
const SUPPORTED_HOST_STATE_SCHEMA_VERSIONS = "3, 4, or 5";

export interface HarnessHostOptions {
  readonly implementations: HarnessImplementationMap;
  readonly stateFile: string;
  readonly controlToken: string;
  readonly host?: string;
  readonly port?: number;
  readonly trace?: HarnessTraceStoreOptions;
  readonly accessBroker?: HarnessExecutionAccessBroker;
}

export interface RunningHarnessHost {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly forceClose: () => Promise<void>;
  readonly host: HarnessHost;
}

export class HarnessHost {
  private readonly sessions = new Map<number, LiveSession>();
  private readonly lateClosingHarnesses = new Set<HarnessLifecycle>();
  private readonly registrationTails = new Map<number, Promise<void>>();
  private saved = new Map<number, PersistedHarnessSessionDescriptor>();
  private legacySaved = new Map<number, LegacyPersistedHarnessSessionDescriptor>();
  private persistTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private readonly pendingExecutionAccess = new Map<string, {
    readonly threadId: number;
    readonly model: InteractionModelSelection;
    readonly policyIdentity?: string;
    readonly lease: HarnessExecutionAccessLease;
    timeout: NodeJS.Timeout | undefined;
    releasePromise: Promise<void> | undefined;
    state: "admitted" | "claimed" | "awaiting-terminal";
  }>();
  private closed = false;
  private closeAbandoned = false;
  private initializePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private forceClosePromise: Promise<void> | undefined;
  private readonly traceStore: HarnessTraceStore | undefined;

  constructor(private readonly options: HarnessHostOptions) {
    this.traceStore = options.trace === undefined ? undefined : new HarnessTraceStore(options.trace);
  }

  initialize(): Promise<void> {
    if (this.initializePromise === undefined) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      this.initializePromise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      void this.initializeInternal().then(resolve, reject);
    }
    return this.initializePromise;
  }

  private async initializeInternal(): Promise<void> {
    await this.traceStore?.ready();
    if (this.closed) throw new Error("Harness host is closed");
    try {
      const serialized = await readFile(this.options.stateFile, "utf8");
      if (this.closed) throw new Error("Harness host is closed");
      const parsed = JSON.parse(serialized) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) {
        throw new Error(`Unsupported harness host state; expected schema version ${SUPPORTED_HOST_STATE_SCHEMA_VERSIONS}`);
      }
      if (parsed.schemaVersion === 3) {
        if (this.closed) throw new Error("Harness host is closed");
        await this.backupState(serialized, "v3");
        if (this.closed) throw new Error("Harness host is closed");
        this.legacySaved = readLegacySessions(parsed.sessions);
        await this.persist();
        if (this.closed) throw new Error("Harness host is closed");
        this.initialized = true;
        return;
      }
      if (parsed.schemaVersion === 4) {
        if (this.closed) throw new Error("Harness host is closed");
        await this.backupState(serialized, "v4");
        if (this.closed) throw new Error("Harness host is closed");
        const sessions = uniqueSessions(parsed.sessions.flatMap(migrateSchemaV4Session));
        this.saved = new Map(sessions.map((session) => [session.threadId, session]));
        if (parsed.legacySessions !== undefined && !Array.isArray(parsed.legacySessions)) {
          throw new Error("Harness state contains invalid legacy sessions");
        }
        this.legacySaved = readLegacySessions(parsed.legacySessions ?? []);
        await this.persist();
        if (this.closed) throw new Error("Harness host is closed");
        this.initialized = true;
        return;
      }
      if (parsed.schemaVersion !== CURRENT_HOST_STATE_SCHEMA_VERSION) {
        throw new Error(`Unsupported harness host state; expected schema version ${SUPPORTED_HOST_STATE_SCHEMA_VERSIONS}`);
      }
      const sessions = uniqueSessions(parsed.sessions.map(readPersistedSession));
      this.saved = new Map(sessions.map((session) => [session.threadId, session]));
      if (parsed.legacySessions !== undefined && !Array.isArray(parsed.legacySessions)) {
        throw new Error("Harness state contains invalid legacy sessions");
      }
      this.legacySaved = readLegacySessions(parsed.legacySessions ?? []);
      if (this.closed) throw new Error("Harness host is closed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (this.closed) throw new Error("Harness host is closed");
    this.initialized = true;
  }

  async createSession(descriptor: HarnessSessionRegistration): Promise<void> {
    if (this.closed) throw new Error("Harness host is closed");
    const normalized = { ...descriptor, configuration: parseHarnessConfiguration(descriptor.configuration) };
    permissionBinding(normalized.configuration, normalized.permissionProfileId);
    return this.withRegistrationLock(normalized.threadId, () => this.registerSession(normalized));
  }

  private async registerSession(descriptor: HarnessSessionRegistration): Promise<void> {
    if (this.closed) throw new Error("Harness host is closed");
    const live = this.sessions.get(descriptor.threadId);
    if (live !== undefined) {
      await this.withSessionLock(live, async () => {
        if (!sameHarnessExecutionConfiguration(live.descriptor.configuration, descriptor.configuration)
          || live.descriptor.permissionProfileId !== descriptor.permissionProfileId
          || live.descriptor.workingDirectory !== descriptor.workingDirectory) {
          throw new Error(`Thread ${descriptor.threadId} is already pinned to harness configuration ${live.descriptor.configuration.name}`);
        }
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
    if (prior !== undefined && (!sameHarnessExecutionConfiguration(prior.configuration, descriptor.configuration)
      || prior.permissionProfileId !== descriptor.permissionProfileId
      || prior.workingDirectory !== descriptor.workingDirectory)) {
      throw new Error(`Thread ${descriptor.threadId} is already pinned to harness configuration ${prior.configuration.name}`);
    }
    const legacy = this.legacySaved.get(descriptor.threadId);
    const legacyState = legacy !== undefined
      && descriptor.permissionProfileId === legacyPermissionProfileId(descriptor.configuration)
      && sameLegacyHarnessConfiguration(legacy.configuration, descriptor.configuration)
      && legacy.workingDirectory === descriptor.workingDirectory
      ? legacy.state
      : undefined;
    const savedState = prior?.state ?? legacyState;
    const harness = await resolveHarnessFactory(this.options.implementations, descriptor.configuration.implementation)({
      threadId: descriptor.threadId,
      workingDirectory: descriptor.workingDirectory,
      configuration: descriptor.configuration,
      permissionProfileId: descriptor.permissionProfileId,
      permissionBinding: permissionBinding(descriptor.configuration, descriptor.permissionProfileId),
      ...(savedState === undefined ? {} : { savedState }),
    });
    const lifecycle = new HarnessLifecycle(harness);
    if (this.closed) {
      if (this.forceClosePromise !== undefined) {
        try {
          lifecycle.forceShutdown();
        } catch {
          // The canonical force close has already completed. A late provider
          // interruption failure cannot replace its stable registration outcome.
        }
        void lifecycle.dispose().catch(() => undefined);
        throw new Error("Harness host force-closed while the session was starting");
      }
      this.lateClosingHarnesses.add(lifecycle);
      try {
        await lifecycle.dispose();
      } finally {
        this.lateClosingHarnesses.delete(lifecycle);
      }
      throw new Error("Harness host closed while the session was starting");
    }
    let state: HarnessSessionState;
    try {
      state = captureHarnessState(harness);
    } catch (error) {
      try {
        await lifecycle.dispose();
      } catch (disposeError) {
        throw new AggregateError([error, disposeError], "Harness session initialization and cleanup failed");
      }
      throw error;
    }
    const persisted: HarnessSessionDescriptor = { ...descriptor, state };
    this.sessions.set(descriptor.threadId, {
      descriptor: persisted,
      harness,
      lifecycle,
      approvals: new HarnessApprovalCoordinator({ threadId: descriptor.threadId }),
      tail: Promise.resolve(),
    });
    this.saved.set(descriptor.threadId, persistedDescriptor(persisted));
    this.legacySaved.delete(descriptor.threadId);
    await this.persist();
  }

  async complete(
    threadId: number,
    interactionId: number,
    capability: GraphCapability,
    signal?: AbortSignal,
  ): Promise<HarnessCompleteResult>;
  async complete(
    threadId: number,
    interactionId: number,
    capability: GraphCapability,
    model: InteractionModelSelection | undefined,
    signal?: AbortSignal,
    traceContext?: HarnessCompletionTraceContext,
    executionLeaseId?: string,
    harnessPolicy?: HarnessExecutionPolicy,
  ): Promise<HarnessCompleteResult>;
  async complete(
    threadId: number,
    interactionId: number,
    capability: GraphCapability,
    modelOrSignal?: InteractionModelSelection | AbortSignal,
    trailingSignal?: AbortSignal,
    traceContext?: HarnessCompletionTraceContext,
    executionLeaseId?: string,
    harnessPolicy?: HarnessExecutionPolicy,
  ): Promise<HarnessCompleteResult> {
    if (this.closed) throw new Error("Harness host is closed");
    if (!Number.isSafeInteger(interactionId) || interactionId < 1) throw new Error("Harness interactionId must be a positive integer");
    validateGraphCapability(capability);
    const model = isAbortSignal(modelOrSignal) ? undefined : modelOrSignal;
    const signal = isAbortSignal(modelOrSignal) ? modelOrSignal : trailingSignal;
    if (model !== undefined) validateInteractionModelSelection(model);
    const session = this.liveSession(threadId);
    const effectiveConfiguration = executionConfiguration(session, harnessPolicy);
    if (model !== undefined) validateConfiguredModelSelection(effectiveConfiguration, model);
    return this.withSessionLock(session, async () => {
      const controller = new AbortController();
      const detachSignal = forwardAbort(signal, controller);
      const completeCallId = randomUUID();
      const approvals = session.approvals.beginCompletion({ interactionId, completeCallId });
      session.activeCompletion = { completeCallId, interactionId, controller };
      const abortApprovals = () => session.approvals.endCompletion(
        completeCallId,
        "aborted",
        "Harness completion ended before the approval was resolved.",
      );
      controller.signal.addEventListener("abort", abortApprovals, { once: true });
      let result: HarnessCompleteResult | undefined;
      let operationError: unknown;
      try {
        if (this.closed) throw new Error("Harness host is closed");
        controller.signal.throwIfAborted();
        result = await this.executeCompletion(
          threadId,
          session,
          capability,
          model,
          approvals,
          controller.signal,
          traceContext,
          executionLeaseId,
          harnessPolicy,
        );
      } catch (error) {
        operationError = error;
      }
      session.approvals.endCompletion(
        completeCallId,
        "aborted",
        "Harness completion ended before the approval was resolved.",
      );
      controller.signal.removeEventListener("abort", abortApprovals);
      if (session.activeCompletion?.controller === controller) delete session.activeCompletion;
      detachSignal();
      const errors: unknown[] = operationError === undefined ? [] : [operationError];
      try {
        session.descriptor = { ...session.descriptor, state: captureHarnessState(session.harness) };
        this.saved.set(threadId, persistedDescriptor(session.descriptor));
        await this.persist();
      } catch (error) {
        errors.push(error);
      }
      if (executionLeaseId !== undefined) this.awaitTerminalAcknowledgement(executionLeaseId);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Harness completion and cleanup failed");
      return result!;
    });
  }

  async admitProviderExecution(
    threadId: number,
    model: InteractionModelSelection,
    signal: AbortSignal,
    harnessPolicy?: HarnessExecutionPolicy,
  ): Promise<{
    executionLeaseId: string;
    adapterImplementationVersion: string;
  }> {
    if (this.closed) throw new Error("Harness host is closed");
    validateInteractionModelSelection(model);
    const session = this.liveSession(threadId);
    validateConfiguredModelSelection(executionConfiguration(session, harnessPolicy), model);
    const acceptedContracts = session.descriptor.configuration.executionAccessContracts;
    if (acceptedContracts === undefined || this.options.accessBroker === undefined) {
      throw new HarnessExecutionFailure("Harness execution access is unavailable", "configuration", "none");
    }
    const lease = await this.options.accessBroker.acquire(model, acceptedContracts, signal);
    try {
      if (!acceptedContracts.includes(lease.access.contract)
        || lease.access.providerId !== model.providerId
        || lease.access.adapterId !== model.adapterId) {
        throw new Error("Harness execution access does not match the selected provider or contract");
      }
      const executionLeaseId = randomUUID();
      const timeout = this.releaseAfter(executionLeaseId, EXECUTION_ADMISSION_TIMEOUT_MS);
      this.pendingExecutionAccess.set(executionLeaseId, {
        threadId, model, lease, timeout, releasePromise: undefined, state: "admitted",
        ...(harnessPolicy === undefined ? {} : { policyIdentity: executionPolicyIdentity(harnessPolicy) }),
      });
      return { executionLeaseId, adapterImplementationVersion: lease.access.adapterImplementationVersion };
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async releaseProviderExecution(executionLeaseId: string): Promise<boolean> {
    const pending = this.pendingExecutionAccess.get(executionLeaseId);
    if (pending === undefined) return false;
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.timeout = undefined;
    pending.releasePromise ??= Promise.resolve(pending.lease.release()).then(() => {
      this.pendingExecutionAccess.delete(executionLeaseId);
    });
    try {
      await pending.releasePromise;
    } catch (error) {
      pending.releasePromise = undefined;
      pending.timeout = this.releaseAfter(
        executionLeaseId,
        pending.state === "admitted" ? EXECUTION_ADMISSION_TIMEOUT_MS : EXECUTION_TERMINAL_ACK_TIMEOUT_MS,
      );
      throw error;
    }
    return true;
  }

  private releaseAfter(executionLeaseId: string, delay: number): NodeJS.Timeout {
    return setTimeout(() => {
      void this.releaseProviderExecution(executionLeaseId).catch(() => {});
    }, delay);
  }

  private awaitTerminalAcknowledgement(executionLeaseId: string): void {
    const pending = this.pendingExecutionAccess.get(executionLeaseId);
    if (pending?.state !== "claimed") return;
    pending.state = "awaiting-terminal";
    pending.timeout = this.releaseAfter(executionLeaseId, EXECUTION_TERMINAL_ACK_TIMEOUT_MS);
  }

  private async executeCompletion(
    threadId: number,
    session: LiveSession,
    capability: GraphCapability,
    model: InteractionModelSelection | undefined,
    approvals: HarnessApprovalChannel,
    signal: AbortSignal,
    traceContext?: HarnessCompletionTraceContext,
    executionLeaseId?: string,
    harnessPolicy?: HarnessExecutionPolicy,
  ): Promise<HarnessCompleteResult> {
    const graph = new RelayerGraphClient(capability);
    const interactionNodeId = capability.nodeId;
    try {
      const output = await graph.getCompletionOutput(interactionNodeId);
      return { threadId, configurationName: session.descriptor.configuration.name, output, trace: disabledTraceDescriptor() };
    } catch (error) {
      if (!(error instanceof GraphApiError && error.status === 404 && error.code === "completion_not_found")) throw error;
    }
    const [interaction, interactionInput] = await Promise.all([
      graph.getNode(interactionNodeId),
      graph.getInteractionInput(),
    ]);
    const scope = new ActiveHarnessGraphScope(capability);
    const support = session.harness.traceSupport?.() ?? NO_HARNESS_TRACE_SUPPORT;
    const trace = this.traceStore?.start({
      threadId,
      interactionNodeId,
      ...(traceContext === undefined ? {} : { productInteractionId: traceContext.productInteractionId }),
      implementation: session.descriptor.configuration.implementation,
      configurationName: session.descriptor.configuration.name,
      support,
    });
    const traceSink = trace?.sink ?? createNoopHarnessTraceSink();
    const observedTrace = new EffectObservingTraceSink(traceSink);
    let completionError: HarnessExecutionFailure | undefined;
    let accessLease: HarnessExecutionAccessLease | undefined;
    let releaseAccessAfterCompletion = false;
    let harnessStarted = false;
    try {
      const acceptedContracts = session.descriptor.configuration.executionAccessContracts;
      if (executionLeaseId !== undefined) {
        const pending = this.pendingExecutionAccess.get(executionLeaseId);
        if (pending === undefined || pending.state !== "admitted" || pending.threadId !== threadId || model === undefined
          || pending.model.providerId !== model.providerId || pending.model.adapterId !== model.adapterId
          || pending.model.modelId !== model.modelId
          || pending.policyIdentity !== (harnessPolicy === undefined ? undefined : executionPolicyIdentity(harnessPolicy))) {
          throw new HarnessExecutionFailure("Execution access admission is invalid or expired", "configuration", "none");
        }
        pending.state = "claimed";
        if (pending.timeout !== undefined) clearTimeout(pending.timeout);
        pending.timeout = undefined;
        accessLease = pending.lease;
      } else if (model !== undefined && acceptedContracts === undefined) {
        throw new HarnessExecutionFailure(
          "A model-using harness must declare execution access contracts",
          "configuration",
          "none",
        );
      }
      if (executionLeaseId === undefined && acceptedContracts !== undefined && model !== undefined) {
        if (this.options.accessBroker === undefined) throw new Error("Harness execution access broker is unavailable");
        accessLease = await this.options.accessBroker.acquire(model, acceptedContracts, signal);
        releaseAccessAfterCompletion = true;
        if (!acceptedContracts.includes(accessLease.access.contract)
          || accessLease.access.providerId !== model.providerId
          || accessLease.access.adapterId !== model.adapterId) {
          throw new Error("Harness execution access does not match the selected provider or contract");
        }
      }
      harnessStarted = true;
      await session.harness.complete({
        inputGraph: interaction,
        interactionInput,
        graph: scope,
        approvals,
        trace: observedTrace,
        ...(model === undefined ? {} : { model }),
        ...(accessLease === undefined ? {} : { access: accessLease.access }),
      }, signal);
    } catch (error) {
      completionError = normalizeHarnessFailure(error, harnessStarted, observedTrace.effectBoundary());
    } finally {
      scope.close();
      if (releaseAccessAfterCompletion) {
        try {
          await accessLease?.release();
        } catch (error) {
          completionError ??= normalizeHarnessFailure(error, true, observedTrace.effectBoundary());
        }
      }
    }
    if (completionError !== undefined) {
      // A harness can successfully accept the graph and then fail while unwinding. The accepted
      // graph is authoritative and idempotent, so surface it as the completion instead of asking
      // the user to repeat an execution that may already have produced effects.
      try {
        const output = await graph.getCompletionOutput(interactionNodeId);
        const traceDescriptor = await sealTrace(trace, "partial", errorMessage(completionError));
        return { threadId, configurationName: session.descriptor.configuration.name, output, trace: traceDescriptor };
      } catch (error) {
        if (!(error instanceof GraphApiError && error.status === 404 && error.code === "completion_not_found")) {
          completionError = new HarnessExecutionFailure(
            errorMessage(completionError),
            classifyHarnessFailure(completionError),
            "unknown",
            { cause: new AggregateError([completionError, error], "Completion failure and graph recovery inspection failed") },
          );
        }
      }
      if (completionError.effectBoundary !== "tool_effect") {
        const hasGraphWrites = await graph.getNeighbors(interactionNodeId)
          .then((neighbors) => neighbors.length > 0)
          .catch(() => false);
        if (hasGraphWrites) {
          completionError = new HarnessExecutionFailure(
            completionError.message,
            completionError.failureCategory,
            "graph_write",
            { cause: completionError },
          );
        }
      }
      traceSink.emit({
        type: signal.aborted ? "cancelled" : "error",
        data: { message: errorMessage(completionError) },
      });
      await sealTrace(trace, signal.aborted ? "partial" : "failed", errorMessage(completionError));
      throw completionError;
    }
    try {
      const output = await graph.getCompletionOutput(interactionNodeId);
      const traceDescriptor = await sealTrace(trace, "complete");
      return { threadId, configurationName: session.descriptor.configuration.name, output, trace: traceDescriptor };
    } catch (error) {
      if (error instanceof GraphApiError && error.status === 404 && error.code === "completion_not_found") {
        const completionMissing = new Error("Harness ended its turn without accepting a graph completion.", { cause: error });
        await sealTrace(trace, "partial", completionMissing.message);
        throw completionMissing;
      }
      await sealTrace(trace, "failed", errorMessage(error));
      throw error;
    }
  }

  exportCandidateTrace(
    productInteractionId: number,
    targetDirectory: string,
    correlation: HarnessTraceExportCorrelation,
  ): Promise<HarnessTraceDescriptor> {
    if (this.traceStore === undefined) throw new Error("Candidate trace capture is disabled for this harness host");
    return this.traceStore.export(productInteractionId, targetDirectory, correlation);
  }

  cancel(threadId: number): boolean {
    const session = this.sessions.get(threadId);
    const active = session?.activeCompletion;
    if (session === undefined || active === undefined || active.controller.signal.aborted) return false;
    session.approvals.endCompletion(
      active.completeCallId,
      "cancelled",
      `Harness completion cancelled for thread ${threadId}`,
    );
    active.controller.abort(new Error(`Harness completion cancelled for thread ${threadId}`));
    return true;
  }

  approvalEvents(threadId: number, after = 0): HarnessApprovalSnapshot {
    return this.approvalSession(threadId).snapshot(after);
  }

  decideApproval(threadId: number, requestId: string, input: unknown): HarnessApprovalResolution {
    if (requestId.trim() === "") {
      throw new HarnessApprovalCoordinatorError("invalid_approval_request", "Harness approval request ID must be non-empty");
    }
    return this.approvalSession(threadId).decide(requestId, input);
  }

  close(): Promise<void> {
    if (this.forceClosePromise !== undefined) return this.forceClosePromise;
    return this.beginClose();
  }

  private beginClose(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.closePromise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void this.closeInternal().then(resolve, reject);
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    await Promise.all([...this.pendingExecutionAccess.keys()].map((id) => this.releaseProviderExecution(id)));
    for (const session of this.sessions.values()) {
      session.approvals.close("Harness host closed before the approval was resolved.");
      session.activeCompletion?.controller.abort(new Error("Harness host closed"));
    }
    const errors: unknown[] = [];
    try {
      await this.initializePromise;
    } catch (error) {
      if (!(error instanceof Error && error.message === "Harness host is closed")) errors.push(error);
    }
    await Promise.all([...this.sessions.entries()].map(async ([threadId, session]) => {
      await session.tail;
      try {
        session.descriptor = { ...session.descriptor, state: captureHarnessState(session.harness) };
        this.saved.set(threadId, persistedDescriptor(session.descriptor));
      } catch (error) {
        errors.push(error);
      }
      try {
        await session.lifecycle.dispose();
      } catch (error) {
        errors.push(error);
      }
    }));
    this.sessions.clear();
    if (!this.closeAbandoned && this.initialized) {
      try {
        await this.persist();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.traceStore?.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "Harness host did not close cleanly");
  }

  abandonClose(): void {
    this.closeAbandoned = true;
  }

  forceClose(): Promise<void> {
    if (this.forceClosePromise !== undefined) return this.forceClosePromise;
    this.closed = true;
    this.closeAbandoned = true;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.forceClosePromise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const errors: unknown[] = [];
    for (const session of this.sessions.values()) {
      session.approvals.close("Harness host force-closed before the approval was resolved.");
      session.activeCompletion?.controller.abort(new Error("Harness host force-closed"));
      try { session.lifecycle.forceShutdown(); } catch (error) { errors.push(error); }
    }
    for (const lifecycle of this.lateClosingHarnesses) {
      try { lifecycle.forceShutdown(); } catch (error) { errors.push(error); }
    }
    // Force close is intentionally bounded, but every harness still has one
    // host-owned disposal path. The interrupt hooks above unblock that path;
    // do not await it here because a broken provider must not prevent exit.
    void this.beginClose().catch(() => undefined);
    void (async () => {
      try {
        await this.initializePromise;
      } catch (error) {
        if (!(error instanceof Error && error.message === "Harness host is closed")) errors.push(error);
      }
      await this.persistTail;
      try { await this.traceStore?.forceClose(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, "Harness host did not force-close cleanly");
    })().then(resolve, reject);
    return this.forceClosePromise;
  }

  sessionCount(): number { return this.sessions.size; }

  private liveSession(threadId: number): LiveSession {
    const live = this.sessions.get(threadId);
    if (live !== undefined) return live;
    const saved = this.saved.get(threadId);
    if (saved === undefined) throw new Error(`Unknown harness thread: ${threadId}`);
    throw new Error(`Thread ${threadId} must be registered before its harness can resume`);
  }

  private approvalSession(threadId: number): HarnessApprovalCoordinator {
    const session = this.sessions.get(threadId);
    if (session !== undefined) return session.approvals;
    throw new HarnessApprovalCoordinatorError("approval_request_not_found", `Unknown live harness thread: ${threadId}`);
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
    const legacySessions = [...this.legacySaved.values()];
    const serialized = `${JSON.stringify({
      schemaVersion: CURRENT_HOST_STATE_SCHEMA_VERSION,
      sessions: [...this.saved.values()],
      ...(legacySessions.length === 0 ? {} : { legacySessions }),
    }, null, 2)}\n`;
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

  private async backupState(serialized: string, version: "v3" | "v4"): Promise<void> {
    const stateFile = resolve(this.options.stateFile);
    await mkdir(dirname(stateFile), { recursive: true });
    try {
      await writeFile(`${stateFile}.${version}.backup`, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function normalizeHarnessFailure(
  error: unknown,
  harnessStarted: boolean,
  observedBoundary: HarnessEffectBoundary,
): HarnessExecutionFailure {
  if (error instanceof HarnessExecutionFailure) {
    return new HarnessExecutionFailure(
      error.message,
      error.failureCategory,
      observedBoundary === "unknown"
        ? error.effectBoundary
        : strongestEffectBoundary(error.effectBoundary, observedBoundary),
      { cause: error },
    );
  }
  const effectBoundary = !harnessStarted
    ? "none"
    : observedBoundary === "none" ? "unknown" : observedBoundary;
  return new HarnessExecutionFailure(
    errorMessage(error),
    classifyHarnessFailure(error),
    effectBoundary,
    { cause: error },
  );
}

const EFFECT_BOUNDARY_RANK: Readonly<Record<HarnessEffectBoundary, number>> = {
  none: 0,
  partial_output: 1,
  graph_write: 2,
  tool_effect: 3,
  unknown: 4,
};

function strongestEffectBoundary(left: HarnessEffectBoundary, right: HarnessEffectBoundary): HarnessEffectBoundary {
  return EFFECT_BOUNDARY_RANK[left] >= EFFECT_BOUNDARY_RANK[right] ? left : right;
}

class EffectObservingTraceSink implements HarnessTraceSink {
  // No observed output, graph write, or tool call is affirmative no-effect evidence.
  // Unknown is reserved for process loss where the host cannot make that observation.
  private boundary: HarnessEffectBoundary = "none";

  constructor(private readonly delegate: HarnessTraceSink) {}

  get policy(): HarnessTraceSink["policy"] { return this.delegate.policy; }
  get rootStreamId(): string { return this.delegate.rootStreamId; }

  effectBoundary(): HarnessEffectBoundary { return this.boundary; }

  emit(event: Parameters<HarnessTraceSink["emit"]>[0]): void | Promise<void> {
    this.observe(event.type);
    return this.delegate.emit(event);
  }

  openStream(input: Parameters<HarnessTraceSink["openStream"]>[0]): ReturnType<HarnessTraceSink["openStream"]> {
    return this.observeStream(this.delegate.openStream(input));
  }

  openSpan(input: Parameters<HarnessTraceSink["openSpan"]>[0]): ReturnType<HarnessTraceSink["openSpan"]> {
    return this.observeSpan(this.delegate.openSpan(input));
  }

  attach(input: Parameters<HarnessTraceSink["attach"]>[0]): ReturnType<HarnessTraceSink["attach"]> {
    return this.delegate.attach(input);
  }

  private observe(type: string): void {
    if (type === "tool.call.started" || type === "tool.call.completed") {
      this.boundary = "tool_effect";
    } else if (this.boundary !== "tool_effect" && (type === "message" || type === "provider.event" || type === "model.call.completed")) {
      this.boundary = "partial_output";
    }
  }

  private observeStream(stream: ReturnType<HarnessTraceSink["openStream"]>): ReturnType<HarnessTraceSink["openStream"]> {
    return {
      id: stream.id,
      emit: (event) => { this.observe(event.type); return stream.emit(event); },
      openSpan: (input) => this.observeSpan(stream.openSpan(input)),
      close: (status, data) => stream.close(status, data),
    };
  }

  private observeSpan(span: ReturnType<HarnessTraceSink["openSpan"]>): ReturnType<HarnessTraceSink["openSpan"]> {
    return {
      id: span.id,
      emit: (event) => { this.observe(event.type); return span.emit(event); },
      end: (status, data) => span.end(status, data),
    };
  }
}

export async function startHarnessHost(options: HarnessHostOptions): Promise<RunningHarnessHost> {
  const host = new HarnessHost(options);
  await host.initialize();
  const server = createServer((request, response) => void route(host, options.controlToken, request, response));
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await listen(server, options.port ?? 0, options.host ?? "127.0.0.1");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Harness host did not bind a TCP address");
  const boundHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  let runningClosePromise: Promise<void> | undefined;
  let runningForceClosePromise: Promise<void> | undefined;
  return {
    url: `http://${boundHost}:${address.port}`,
    host,
    forceClose: () => {
      if (runningForceClosePromise !== undefined) return runningForceClosePromise;
      let forceError: unknown;
      const forcing = host.forceClose().catch((error) => { forceError = error; });
      runningForceClosePromise = forcing.then(() => {
        if (forceError !== undefined) throw forceError;
      });
      server.close();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      return runningForceClosePromise;
    },
    close: () => {
      if (runningForceClosePromise !== undefined) return runningForceClosePromise;
      if (runningClosePromise !== undefined) return runningClosePromise;
      const closingServer = close(server);
      runningClosePromise = host.close().finally(() => closingServer);
      return runningClosePromise;
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
    const leaseMatch = /^\/sessions\/([^/]+)\/execution-leases(?:\/([^/]+))?$/.exec(url.pathname);
    if (leaseMatch?.[1] !== undefined) {
      const threadId = Number(decodeURIComponent(leaseMatch[1]));
      if (!Number.isSafeInteger(threadId) || threadId < 1) return reply(response, 400, { error: "invalid_thread_id" });
      if (request.method === "POST" && leaseMatch[2] === undefined) {
        const input = await body(request);
        const model = readInteractionModelSelection(input);
        if (model === undefined) return reply(response, 400, { error: "model_selection_required" });
        const controller = new AbortController();
        const abort = () => controller.abort(new Error("Execution admission request disconnected"));
        request.once("aborted", abort);
        try {
          return reply(response, 201, await host.admitProviderExecution(
            threadId, model, controller.signal, readHarnessExecutionPolicy(input),
          ));
        } finally {
          request.off("aborted", abort);
        }
      }
      if (request.method === "DELETE" && leaseMatch[2] !== undefined) {
        return reply(response, 200, { released: await host.releaseProviderExecution(decodeURIComponent(leaseMatch[2])) });
      }
    }
    const cancelMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(url.pathname);
    if (request.method === "POST" && cancelMatch?.[1] !== undefined) {
      const threadId = Number(decodeURIComponent(cancelMatch[1]));
      if (!Number.isSafeInteger(threadId) || threadId < 1) return reply(response, 400, { error: "invalid_thread_id" });
      return reply(response, 200, { cancelled: host.cancel(threadId) });
    }
    const approvalDecisionMatch = /^\/sessions\/([^/]+)\/approvals\/([^/]+)\/decision$/.exec(url.pathname);
    if (request.method === "POST" && approvalDecisionMatch?.[1] !== undefined && approvalDecisionMatch[2] !== undefined) {
      const threadId = readThreadId(approvalDecisionMatch[1]);
      if (threadId === undefined) return reply(response, 400, { error: "invalid_thread_id" });
      const requestId = decodeURIComponent(approvalDecisionMatch[2]);
      return reply(response, 200, host.decideApproval(threadId, requestId, await body(request)));
    }
    const approvalEventsMatch = /^\/sessions\/([^/]+)\/approval-events$/.exec(url.pathname);
    if (request.method === "GET" && approvalEventsMatch?.[1] !== undefined) {
      const threadId = readThreadId(approvalEventsMatch[1]);
      if (threadId === undefined) return reply(response, 400, { error: "invalid_thread_id" });
      const cursor = url.searchParams.get("after");
      const after = cursor === null ? 0 : Number(cursor);
      return reply(response, 200, host.approvalEvents(threadId, after));
    }
    const match = /^\/sessions\/([^/]+)\/complete$/.exec(url.pathname);
    if (request.method === "POST" && match?.[1] !== undefined) {
      const threadId = Number(decodeURIComponent(match[1]));
      if (!Number.isSafeInteger(threadId) || threadId < 1) return reply(response, 400, { error: "invalid_thread_id" });
      const input = readCompleteInput(await body(request));
      const controller = new AbortController();
      const abort = () => controller.abort(new Error("Harness completion request disconnected"));
      const abortOnResponseClose = () => {
        if (!response.writableEnded) abort();
      };
      request.once("aborted", abort);
      response.once("close", abortOnResponseClose);
      try {
        const completed = await host.complete(
          threadId,
          input.interactionId,
          input.graph,
          input.model,
          controller.signal,
          input.traceContext,
          readExecutionLeaseId(input),
          readHarnessExecutionPolicy(input),
        );
        return reply(response, 200, completed);
      } finally {
        request.off("aborted", abort);
        response.off("close", abortOnResponseClose);
      }
    }
    if (request.method === "GET" && url.pathname === "/health") return reply(response, 200, { ok: true });
    return reply(response, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof HarnessApprovalCoordinatorError) {
      const status = error.code === "invalid_approval_request"
        ? 400
        : error.code === "approval_request_not_found"
          ? 404
          : 409;
      return reply(response, status, { error: error.code, message: error.message });
    }
    return reply(response, 500, error instanceof HarnessExecutionFailure
      ? { error: error.message, failureCategory: error.failureCategory, effectBoundary: error.effectBoundary }
      : { error: error instanceof Error ? error.message : String(error), failureCategory: "application", effectBoundary: "unknown" });
  }
}

function readExecutionLeaseId(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("executionLeaseId" in input)) return undefined;
  const value = (input as { executionLeaseId?: unknown }).executionLeaseId;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/iu.test(value)) throw new Error("invalid execution lease ID");
  return value;
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
    configuration: descriptor.configuration,
    permissionProfileId: descriptor.permissionProfileId,
    workingDirectory: descriptor.workingDirectory,
    ...(descriptor.state === undefined ? {} : { state: descriptor.state }),
  };
}

function legacyPermissionProfileId(configuration: HarnessConfiguration): string | undefined {
  const profiles = Object.keys(configuration.permissionBindings);
  if (profiles.includes("auto")) return "auto";
  return profiles.length === 1 ? profiles[0] : undefined;
}

function sameLegacyHarnessConfiguration(
  legacy: Omit<HarnessConfiguration, "permissionBindings">,
  current: HarnessConfiguration,
): boolean {
  return sameHarnessExecutionConfiguration(
    { ...legacy, permissionBindings: current.permissionBindings },
    current,
  );
}

function readPersistedSession(value: unknown): PersistedHarnessSessionDescriptor {
  if (!isRecord(value)) throw new Error("Harness state contains an invalid session descriptor");
  const { threadId, permissionProfileId, workingDirectory } = value;
  if (typeof threadId !== "number" || !Number.isSafeInteger(threadId) || threadId < 1
    || typeof permissionProfileId !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(permissionProfileId)
    || typeof workingDirectory !== "string") {
    throw new Error("Harness state contains an invalid session descriptor");
  }
  const configuration = parseHarnessConfiguration(value.configuration);
  permissionBinding(configuration, permissionProfileId);
  const state = readHarnessState(value.state);
  return {
    threadId,
    configuration,
    permissionProfileId,
    workingDirectory,
    ...(state === undefined ? {} : { state }),
  };
}

function migrateSchemaV4Session(value: unknown): readonly PersistedHarnessSessionDescriptor[] {
  try {
    return [readPersistedSession(value)];
  } catch (error) {
    const threadId = preAccessContractThreadId(value);
    if (threadId === undefined) throw error;
    // Schema v4 predates execution-scoped provider access. Its opaque provider
    // state may have been created through ambient credentials, so preserve the
    // original file in the migration backup but never resume that authority.
    console.warn(`Discarding pre-access-contract provider state for harness thread ${threadId} during schema v4 migration`);
    return [];
  }
}

function preAccessContractThreadId(value: unknown): number | undefined {
  if (!isRecord(value) || !isRecord(value.configuration)) return undefined;
  const descriptorFields = new Set(["threadId", "configuration", "permissionProfileId", "workingDirectory", "state"]);
  if (Object.keys(value).some((key) => !descriptorFields.has(key))) return undefined;
  const { threadId, permissionProfileId, workingDirectory } = value;
  if (typeof threadId !== "number" || !Number.isSafeInteger(threadId) || threadId < 1
    || typeof permissionProfileId !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(permissionProfileId)
    || typeof workingDirectory !== "string") return undefined;
  const configurationFields = new Set([
    "schemaVersion", "name", "implementation", "implementationVersion",
    "permissionBindings", "modelCompatibility", "settings",
  ]);
  if (Object.keys(value.configuration).some((key) => !configurationFields.has(key))
    || value.configuration.modelCompatibility === undefined) return undefined;
  try {
    const configuration = parseHarnessConfiguration({
      ...value.configuration,
      executionAccessContracts: ["pre-access-contract-migration@1"],
    });
    permissionBinding(configuration, permissionProfileId);
    readHarnessState(value.state);
    return threadId;
  } catch {
    return undefined;
  }
}

function readLegacyPersistedSession(value: unknown): LegacyPersistedHarnessSessionDescriptor {
  if (!isRecord(value) || !isRecord(value.configuration)) {
    throw new Error("Harness state contains an invalid legacy session descriptor");
  }
  const { threadId, workingDirectory } = value;
  const { schemaVersion, name, implementation, implementationVersion, settings } = value.configuration;
  if (typeof threadId !== "number" || !Number.isSafeInteger(threadId) || threadId < 1
    || schemaVersion !== 1
    || typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)
    || typeof implementation !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(implementation)
    || typeof implementationVersion !== "number" || !Number.isSafeInteger(implementationVersion) || implementationVersion < 1
    || !isJsonObject(settings)
    || typeof workingDirectory !== "string") {
    throw new Error("Harness state contains an invalid legacy session descriptor");
  }
  const state = readHarnessState(value.state);
  return {
    threadId,
    configuration: { schemaVersion, name, implementation, implementationVersion, settings },
    workingDirectory,
    ...(state === undefined ? {} : { state }),
  };
}

function uniqueSessions<T extends { readonly threadId: number }>(sessions: readonly T[]): readonly T[] {
  if (new Set(sessions.map((session) => session.threadId)).size !== sessions.length) {
    throw new Error("Harness state contains duplicate thread sessions");
  }
  return sessions;
}

function readLegacySessions(values: readonly unknown[]): Map<number, LegacyPersistedHarnessSessionDescriptor> {
  const sessions = new Map<number, LegacyPersistedHarnessSessionDescriptor>();
  for (const value of values) {
    try {
      const session = readLegacyPersistedSession(value);
      if (sessions.has(session.threadId)) throw new Error(`duplicate thread ${session.threadId}`);
      sessions.set(session.threadId, session);
    } catch (error) {
      console.warn("Skipping invalid legacy harness session during schema v3 migration", error);
    }
  }
  return sessions;
}

function permissionBinding(configuration: HarnessConfiguration, profileId: string) {
  const binding = configuration.permissionBindings[profileId];
  if (binding === undefined) throw new Error(`Harness configuration ${configuration.name} does not bind permission profile ${profileId}`);
  return binding;
}

function readHarnessState(value: unknown): HarnessSessionState | undefined {
  if (value === undefined) return undefined;
  if (isJsonObject(value)) return value;
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

function readThreadId(value: string): number | undefined {
  const threadId = Number(decodeURIComponent(value));
  return Number.isSafeInteger(threadId) && threadId > 0 ? threadId : undefined;
}

function readCompleteInput(value: unknown): {
  readonly interactionId: number;
  readonly graph: GraphCapability;
  readonly model?: InteractionModelSelection;
  readonly traceContext?: HarnessCompletionTraceContext;
  readonly executionLeaseId?: string;
  readonly harnessPolicy?: HarnessExecutionPolicy;
} {
  if (!isRecord(value)) throw new Error("Harness completion input must be an object");
  const unknown = Object.keys(value).filter((key) => ![
    "interactionId", "graph", "model", "traceContext", "executionLeaseId", "harnessPolicy",
  ].includes(key));
  if (unknown.length > 0) throw new Error(`Harness completion contains unsupported fields: ${unknown.join(", ")}`);
  if (!Number.isSafeInteger(value.interactionId) || (value.interactionId as number) < 1) {
    throw new Error("Harness completion requires a positive interactionId");
  }
  const model = readInteractionModelSelection(value);
  const traceContext = readTraceContext(value);
  const executionLeaseId = readExecutionLeaseId(value);
  const harnessPolicy = readHarnessExecutionPolicy(value);
  return {
    interactionId: value.interactionId as number,
    graph: readGraphCapability(value),
    ...(model === undefined ? {} : { model }),
    ...(traceContext === undefined ? {} : { traceContext }),
    ...(executionLeaseId === undefined ? {} : { executionLeaseId }),
    ...(harnessPolicy === undefined ? {} : { harnessPolicy }),
  };
}

function readGraphCapability(value: unknown): GraphCapability {
  if (!isRecord(value) || !isRecord(value.graph)) throw new Error("Harness completion requires a graph capability");
  const { url, token, nodeId } = value.graph;
  if (typeof url !== "string" || url.trim() === "" || typeof token !== "string" || token === "" || typeof nodeId !== "number" || !Number.isSafeInteger(nodeId) || nodeId < 1) {
    throw new Error("Harness completion contains an invalid graph capability");
  }
  const capability = { url, token, nodeId };
  validateGraphCapability(capability);
  return capability;
}

function readInteractionModelSelection(value: unknown): InteractionModelSelection | undefined {
  if (!isRecord(value) || value.model === undefined) return undefined;
  if (!isRecord(value.model)) throw new Error("Harness completion contains an invalid model selection");
  const { providerId, adapterId, modelId } = value.model;
  const selection = { providerId, ...(adapterId === undefined ? {} : { adapterId }), modelId };
  validateInteractionModelSelection(selection);
  return selection;
}

function validateInteractionModelSelection(value: unknown): asserts value is InteractionModelSelection {
  if (!isRecord(value)
    || !isStableId(value.providerId)
    || (value.adapterId !== undefined && !isStableId(value.adapterId))
    || !isStableId(value.modelId)) {
    throw new Error("Harness completion contains an invalid model selection");
  }
}

function validateConfiguredModelSelection(
  configuration: HarnessConfiguration,
  selection: InteractionModelSelection,
): void {
  // modelRules is the adapter-aware replacement contract. Keep legacy provider-ID
  // compatibility only for configurations that have not migrated to modelRules;
  // enforcing both would reject valid models from custom provider definitions.
  const compatibility = configuration.modelRules === undefined
    ? configuration.modelCompatibility
    : undefined;
  if (compatibility !== undefined) {
    const provider = compatibility.find((entry) => entry.providerId === selection.providerId);
    if (!provider || (provider.modelIds !== undefined && !provider.modelIds.includes(selection.modelId))) {
      throw new Error("Harness completion model is not compatible with this configuration");
    }
  }
  if (!harnessAllowsModel(configuration.modelRules, selection)) {
    throw new Error("Harness completion model is not compatible with this configuration");
  }
}

function executionConfiguration(
  session: LiveSession,
  policy: HarnessExecutionPolicy | undefined,
): HarnessConfiguration {
  const configuration = session.descriptor.configuration;
  if (policy === undefined) {
    if (session.currentPolicyRevision !== undefined) {
      throw new Error("Current harness execution policy is required after a dynamic policy update");
    }
    return configuration;
  }
  const identity = executionPolicyIdentity(policy);
  if ((session.currentPolicyRevision ?? 0) > policy.configurationRevision
    || (session.currentPolicyRevision === policy.configurationRevision
      && session.currentPolicyIdentity !== undefined && session.currentPolicyIdentity !== identity)) {
    throw new Error("Harness execution policy is stale or conflicts with the current semantic revision");
  }
  const candidate = parseHarnessConfiguration({
    ...configuration,
    revision: policy.configurationRevision,
    ...(policy.modelRules === undefined ? { modelRules: undefined } : { modelRules: policy.modelRules }),
  });
  if (!sameHarnessExecutionConfiguration(configuration, candidate)) {
    throw new Error("Current harness policy cannot change the pinned execution configuration");
  }
  session.currentPolicyRevision = policy.configurationRevision;
  session.currentPolicyIdentity = identity;
  return candidate;
}

function executionPolicyIdentity(policy: HarnessExecutionPolicy): string {
  return JSON.stringify(policy);
}

function readHarnessExecutionPolicy(value: unknown): HarnessExecutionPolicy | undefined {
  if (!isRecord(value) || value.harnessPolicy === undefined) return undefined;
  const policy = value.harnessPolicy;
  if (!isRecord(policy)) throw new Error("Harness execution policy is invalid");
  const { configurationRevision, configurationDigest, modelRules } = policy;
  if (typeof configurationRevision !== "number" || !Number.isSafeInteger(configurationRevision) || configurationRevision < 1
    || typeof configurationDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(configurationDigest)
    || (modelRules !== undefined && modelRules !== null && !isRecord(modelRules))) {
    throw new Error("Harness execution policy is invalid");
  }
  return {
    configurationRevision,
    configurationDigest,
    ...(modelRules === undefined || modelRules === null
      ? {}
      : { modelRules: modelRules as unknown as HarnessConfiguration["modelRules"] }),
  };
}

function isStableId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const characters = [...value];
  return characters.length > 0
    && characters.length <= 200
    && !/\p{White_Space}/u.test(characters[0]!)
    && !/\p{White_Space}/u.test(characters.at(-1)!)
    && !characters.some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character))
    && !characters.some((character) => /\p{Cc}/u.test(character));
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isRecord(value)
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

function readTraceContext(value: unknown): HarnessCompletionTraceContext | undefined {
  if (!isRecord(value) || value.traceContext === undefined) return undefined;
  if (!isRecord(value.traceContext)) throw new Error("Harness completion contains an invalid trace context");
  const { productInteractionId } = value.traceContext;
  if (typeof productInteractionId !== "number" || !Number.isSafeInteger(productInteractionId) || productInteractionId < 1) {
    throw new Error("Harness completion trace context requires a positive product interaction id");
  }
  return { productInteractionId };
}

function disabledTraceDescriptor(): HarnessTraceDescriptor {
  return { status: "disabled", format: "relayer-harness-trace-v1", coverage: NO_HARNESS_TRACE_SUPPORT };
}

async function sealTrace(
  trace: ReturnType<HarnessTraceStore["start"]> | undefined,
  status: "complete" | "partial" | "failed",
  reason?: string,
): Promise<HarnessTraceDescriptor> {
  if (trace === undefined) return disabledTraceDescriptor();
  try {
    return await trace.seal(status, reason);
  } catch (error) {
    return {
      status: "failed",
      format: "relayer-harness-trace-v1",
      coverage: NO_HARNESS_TRACE_SUPPORT,
      error: `Candidate trace could not be sealed: ${errorMessage(error)}`,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyHarnessFailure(error: unknown): string {
  const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined;
  const message = errorMessage(error).toLowerCase();
  if (status === 401 || status === 403 || /auth|api key|credential/.test(message)) return "authentication";
  if (status === 404 || /model.*not found|unknown model/.test(message)) return "model_not_found";
  if (status === 429 || /rate.?limit/.test(message)) return "rate_limit";
  if (status !== undefined && status >= 500) return "provider_5xx";
  if (/timeout/.test(message)) return "provider_timeout";
  if (/transport|network|connection/.test(message)) return "transport";
  return "execution";
}

function validateGraphCapability(capability: GraphCapability): void {
  if (capability.token === "" || !Number.isSafeInteger(capability.nodeId) || capability.nodeId < 1) {
    throw new Error("Harness completion contains an invalid graph capability");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(capability.url);
  } catch {
    throw new Error("Harness completion contains an invalid graph capability URL");
  }
  if (parsedUrl.protocol !== "http:" || parsedUrl.hostname !== "127.0.0.1" || parsedUrl.port === "" || parsedUrl.username !== "" || parsedUrl.password !== "" || parsedUrl.pathname !== "/" || parsedUrl.search !== "" || parsedUrl.hash !== "") {
    throw new Error("Harness graph capability URL must use authenticated 127.0.0.1 HTTP");
  }
}

class ActiveHarnessGraphScope implements HarnessGraphScope {
  readonly interactionNodeId: number;
  private active = true;

  constructor(private readonly capability: GraphCapability) {
    this.interactionNodeId = capability.nodeId;
  }

  acquireCapability(): GraphCapability {
    if (!this.active) throw new Error("The graph scope is no longer active");
    return { ...this.capability };
  }

  close(): void {
    this.active = false;
  }
}
