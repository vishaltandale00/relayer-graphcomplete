import { NativeExecutionCancelled } from "./completion-execution.js";
import { ArtifactFileError, checkArtifactFiles } from "./artifact-files.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GraphApiError, RelayerGraphClient, type GraphCapability, type GraphId } from "@relayer/graph-client";
import {
  VisualAssetsError,
  createMemoryVisualDetailPersistence,
  createVisualAssetImportValidator,
  type CanonicalNodeDetailPackage,
  type FileVisualAssetsLibrary,
  type VisualAsset,
  type VisualAssetScope,
} from "@relayer/visual-assets";
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
  harnessAllowsAgentAuthoredComplete,
  harnessAllowsModel,
  resolveGraphCapabilityProfile,
  sameHarnessExecutionConfiguration,
  canResumeHarnessExecutionConfiguration,
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
  DraftPreviewRenderer,
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
  HarnessCompletionBrokerScope,
  HarnessExecutionAccess,
  HarnessExecutionAccessBroker,
  HarnessExecutionAccessBundle,
  HarnessExecutionAccessLease,
  HarnessModelPlan,
  HarnessAdmittedModelPlan,
  HarnessModelRoute,
  HarnessTraceDescriptor,
  HarnessTraceSink,
  CompletionOrigin,
  JsonObject,
} from "./types.js";
import type { NativeExecutionHandle } from "./completion-execution.js";

interface HeldExecutionAccessLease {
  readonly lease: HarnessExecutionAccessLease;
  released: boolean;
}

interface PendingExecutionAccess {
  readonly threadId: number;
  readonly interactionId?: number;
  readonly attemptAdmissionId?: string;
  readonly model: InteractionModelSelection;
  readonly modelPlan?: HarnessModelPlan;
  readonly admittedPlan?: HarnessAdmittedModelPlan;
  readonly accessBundle?: HarnessExecutionAccessBundle;
  readonly policyIdentity?: string;
  readonly heldLeases: readonly HeldExecutionAccessLease[];
  timeout: NodeJS.Timeout | undefined;
  releasePromise: Promise<void> | undefined;
  /**
   * `claimed` while the native turn that uses the access runs, `settled` once that turn has
   * ended and the access is being released, and `released` until the owner acknowledges.
   */
  state: "admitted" | "claimed" | "settled" | "released";
  /** Set once a release has been decided; the admission can no longer be claimed. */
  releaseRequested: boolean;
  /** The owner has given up the lease; its acknowledgement follows the release. */
  ownerReleased: boolean;
  /** Cancels the completion that claimed this access. */
  abandon?: () => void;
}

interface LiveSession {
  descriptor: HarnessSessionDescriptor;
  harness: Harness;
  lifecycle: HarnessLifecycle;
  approvals: HarnessApprovalCoordinator;
  tail: Promise<void>;
  activeCompletions: Map<GraphId, {
    readonly completeCallId: string;
    readonly interactionId: number;
    readonly controller: AbortController;
  }>;
  invokedCompletionRuns: Map<GraphId, InvokedCompletionRun>;
  activeHumanRootCompletionId?: GraphId;
  currentPolicyRevision?: number;
  currentPolicyIdentity?: string;
}

interface HarnessExecutionPolicy {
  readonly configurationRevision: number;
  readonly configurationDigest: string;
  readonly modelRules?: HarnessConfiguration["modelRules"];
  readonly executionAccessContracts?: readonly string[];
}

export interface HarnessInvokedCompletion {
  readonly capability: GraphCapability;
  readonly origin: Extract<CompletionOrigin, { readonly kind: "invoke" }>;
  /** Trusted product attribution for the independently exportable child trace. */
  readonly traceContext?: HarnessCompletionTraceContext;
  readonly model?: InteractionModelSelection;
  /** Required once this session has taken a dynamic policy update, exactly as a root run is. */
  readonly harnessPolicy?: HarnessExecutionPolicy;
  readonly completionBroker?: HarnessCompletionBrokerScope;
  /**
   * A family-admitted child, exactly as a root run is admitted. The three travel together,
   * and the admission is claimed against traceContext.productInteractionId.
   */
  readonly modelPlan?: HarnessModelPlan;
  readonly executionLeaseId?: string;
  readonly attemptAdmissionId?: string;
}

export interface HarnessInvokedCompletionStart {
  readonly completionId: GraphId;
  readonly attachment?: JsonObject;
}

export interface HarnessInvokedCompletionObservation {
  readonly completionId: GraphId;
}

/** A bounded observation's answer while the child still runs. */
export interface HarnessInvokedCompletionPending {
  readonly completionId: GraphId;
  readonly running: true;
}

/** The longest an observation may wait before answering that the child still runs. */
const MAX_OBSERVATION_WAIT_MS = 60_000;

interface InvokedCompletionRun {
  readonly invocationDigest: string;
  readonly run: Promise<HarnessInvokedCompletionObservation>;
  readonly started: Promise<HarnessInvokedCompletionStart>;
}

const EXECUTION_ADMISSION_TIMEOUT_MS = 30_000;
const EXECUTION_RELEASE_RETRY_MS = 30_000;
/** How long access released without an owner waits for the owner's acknowledgement. */
const UNACKNOWLEDGED_RELEASE_TTL_MS = 10 * 60_000;
/**
 * How long a settled invoked completion still answers observations and exact start retries.
 * The product observes a child's end at once; after this the host forgets the run, and an
 * observation is refused as a restarted host refuses it, which the product also reads as ended.
 * An exact start retry after that would start a new run; the product never sends one, since its
 * launch claim allows one start per child.
 */
const SETTLED_INVOKED_COMPLETION_TTL_MS = 10 * 60_000;
const HARNESS_CLOSE_SESSION_TIMEOUT_MS = 5_000;
/** A cancelled turn that has not settled after this long is force-stopped (PROV-004). */
export const CANCELLED_TURN_FORCE_STOP_MS = 2 * 60_000;
/** How long the host waits for a force-stopped turn to settle before releasing its access. */
export const FORCE_STOPPED_TURN_SETTLE_MS = 10_000;
const FORCE_STOPPED_TURN_MESSAGE = "The turn did not stop within two minutes of cancellation, so it was force-stopped.";

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

const CURRENT_HOST_STATE_SCHEMA_VERSION = 6;
const SUPPORTED_HOST_STATE_SCHEMA_VERSIONS = "3, 4, 5, or 6";

export interface HarnessHostOptions {
  readonly implementations: HarnessImplementationMap;
  readonly stateFile: string;
  readonly controlToken: string;
  readonly host?: string;
  readonly port?: number;
  readonly trace?: HarnessTraceStoreOptions;
  readonly accessBroker?: HarnessExecutionAccessBroker;
  readonly visualAssets?: {
    readonly token: string;
    readonly generation: number;
    readonly library: FileVisualAssetsLibrary;
  };
  /** The render bridge the graph server calls for draft previews (PRD §11.10). */
  readonly draftPreviews?: {
    readonly token: string;
    readonly renderer: DraftPreviewRenderer;
  };
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
  private readonly pendingExecutionAccess = new Map<string, PendingExecutionAccess>();
  private readonly ownerReleasesInProgress = new Set<string>();
  private readonly visualAssetAuthorities = new Map<number, { state: "active" | "paused" | "revoked"; generation: number; barrierId?: string; completionEpoch?: number }>();
  private closed = false;
  private closeAbandoned = false;
  private initializePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private forceClosePromise: Promise<void> | undefined;
  private readonly traceStore: HarnessTraceStore | undefined;
  /** Active completions with preview support, keyed by interaction node, for trace metadata. */
  private readonly previewTraces = new Map<number, HarnessTraceSink>();

  constructor(private readonly options: HarnessHostOptions) {
    this.traceStore = options.trace === undefined ? undefined : new HarnessTraceStore(options.trace);
  }

  /**
   * Renders one draft preview for the graph server. The trace records metadata
   * only; the image goes back to the graph server and never into the trace.
   */
  async renderDraftPreview(input: unknown): Promise<{ pngBase64: string; width: number; height: number }> {
    const renderer = this.options.draftPreviews?.renderer;
    if (renderer === undefined) throw new Error("Draft previews are unavailable");
    const request = readDraftPreviewRequest(input);
    const trace = this.previewTraces.get(request.interactionNodeId);
    const started = Date.now();
    const target = request.snapshot.target as JsonObject;
    try {
      const image = await renderer.render(request);
      if (!isPng(image.png) || !positiveInteger(image.width) || !positiveInteger(image.height)) {
        throw new Error("Draft preview renderer returned an invalid image");
      }
      trace?.emit({
        type: "graph.preview",
        data: {
          outcome: "rendered", target, fingerprint: request.fingerprint,
          width: image.width, height: image.height, byteLength: image.png.byteLength,
          durationMs: Date.now() - started,
        },
      });
      return { pngBase64: Buffer.from(image.png).toString("base64"), width: image.width, height: image.height };
    } catch (error) {
      trace?.emit({
        type: "graph.preview",
        data: { outcome: "failed", target, fingerprint: request.fingerprint, durationMs: Date.now() - started },
      });
      throw error;
    }
  }

  async visualAssetOperation(input: unknown): Promise<unknown> {
    const bridge = this.options.visualAssets;
    if (bridge === undefined) throw new VisualAssetsError("visual_assets_unavailable", "Visual assets are unavailable");
    if (this.closed) throw new VisualAssetsError("completion_inactive", "Visual asset authority is no longer active");
    const request = readVisualAssetRequest(input, bridge.generation);
    if (request.authority.kind === "lifecycle") {
      const id = request.authority.interactionNodeId;
      const current = this.visualAssetAuthorities.get(id) ?? { state: "active" as const, generation: 1 };
      if (request.operation.kind === "activate") {
        const epoch = request.operation.completionEpoch as number;
        const previousEpoch = current.completionEpoch ?? 0;
        if (epoch < previousEpoch || (epoch === previousEpoch && current.state !== "active")) {
          throw new VisualAssetsError("visual_assets_generation_stale", "Visual asset activation epoch is stale");
        }
        const activated = epoch === previousEpoch ? current : {
          state: "active" as const,
          generation: this.visualAssetAuthorities.has(id) ? current.generation + 1 : 1,
          completionEpoch: epoch,
        };
        this.visualAssetAuthorities.set(id, activated);
        // Fence old in-flight work before graph control publishes the new token.
        await bridge.library.settleMutations();
        if (this.visualAssetAuthorities.get(id) !== activated) {
          throw new VisualAssetsError("visual_assets_generation_stale", "Visual asset activation was superseded");
        }
        return { activated: true, assetGeneration: activated.generation };
      }
      if (request.operation.kind === "pause") {
        if (current.state === "revoked") {
          const revoked = { ...current, state: "revoked" as const, generation: current.generation, barrierId: request.operation.barrierId as string };
          this.visualAssetAuthorities.set(id, revoked);
          await bridge.library.settleMutations();
          return { paused: true, assetGeneration: revoked.generation };
        }
        if (current.state === "paused") {
          const sameBarrier = current.barrierId === request.operation.barrierId;
          const expectedGeneration = request.operation.expectedGeneration as number;
          const revocationTakeover = request.operation.revocationTakeover === true
            && (current.generation === expectedGeneration || current.generation === expectedGeneration + 1);
          if (!sameBarrier && !revocationTakeover) throw new VisualAssetsError("visual_assets_generation_stale", "Visual asset authority generation is stale");
          const paused = sameBarrier ? current : { ...current, barrierId: request.operation.barrierId as string };
          this.visualAssetAuthorities.set(id, paused);
          await bridge.library.settleMutations();
          return { paused: true, assetGeneration: paused.generation };
        }
        if (current.state !== "active" || current.generation !== request.operation.expectedGeneration) throw new VisualAssetsError("visual_assets_generation_stale", "Visual asset authority generation is stale");
        const paused = { ...current, state: "paused" as const, generation: current.generation + 1, barrierId: request.operation.barrierId as string };
        this.visualAssetAuthorities.set(id, paused);
        await bridge.library.settleMutations();
        return { paused: true, assetGeneration: paused.generation };
      }
      if (current.barrierId !== request.operation.barrierId || current.generation !== request.operation.assetGeneration) throw new VisualAssetsError("visual_assets_barrier_stale", "Visual asset authority barrier is stale");
      if (request.operation.kind === "resume") {
        if (current.state === "revoked") throw new VisualAssetsError("completion_inactive", "Visual asset authority is revoked");
        this.visualAssetAuthorities.set(id, { ...current, state: "active", generation: current.generation, ...(current.barrierId === undefined ? {} : { barrierId: current.barrierId }) });
        return { resumed: true, assetGeneration: current.generation };
      }
      if (current.state === "active") throw new VisualAssetsError("visual_assets_barrier_stale", "Active visual asset authority cannot be revoked by this barrier");
      this.visualAssetAuthorities.set(id, { ...current, state: "revoked", generation: current.generation, ...(current.barrierId === undefined ? {} : { barrierId: current.barrierId }) });
      await bridge.library.settleMutations();
      return { revoked: true, assetGeneration: current.generation };
    }
    let isCurrent: (() => boolean) | undefined;
    if (request.authority.kind === "completion") {
      const interactionNodeId = request.authority.interactionNodeId;
      const threadId = request.authority.scope.threadId;
      const session = this.sessions.get(threadId);
      const active = session?.activeCompletions.get(interactionNodeId);
      const assetAuthority = this.visualAssetAuthorities.get(interactionNodeId) ?? { state: "active" as const, generation: 1 };
      const capturedAssetGeneration = request.assetGeneration;
      if (request.assetGeneration !== assetAuthority.generation || assetAuthority.state !== "active") throw new VisualAssetsError("visual_assets_generation_stale", "Visual asset authority generation is stale");
      isCurrent = () => !this.closed
        && this.sessions.get(threadId) === session
        && session?.activeCompletions.get(interactionNodeId) === active
        && active !== undefined
        && (this.visualAssetAuthorities.get(interactionNodeId)?.generation ?? 1) === capturedAssetGeneration
        && this.visualAssetAuthorities.get(interactionNodeId)?.state !== "paused"
        && this.visualAssetAuthorities.get(interactionNodeId)?.state !== "revoked"
        && !active.controller.signal.aborted;
      if (!isCurrent()) throw new VisualAssetsError("completion_inactive", "Visual asset completion authority is no longer active");
    } else {
      const validator = createVisualAssetImportValidator(bridge.library, operationScope(request));
      if (request.operation.kind === "validate-import") {
        return { details: await validator.importArchive(request.operation.archive as never) };
      }
      if (request.operation.kind === "validate-import-content") {
        await validator.validateContent(request.operation.content);
        return { valid: true };
      }
      throw new VisualAssetsError("visual_assets_control_operation_invalid", "Control authority may validate imports only");
    }
    if (request.operation.kind === "check-artifact") {
      // Artifact files live in the session's working directory, not the asset library.
      operationScope(request);
      const session = this.sessions.get(request.authority.scope.threadId);
      if (session === undefined) throw new VisualAssetsError("completion_inactive", "Artifact checks need an active session");
      const result = await checkArtifactFiles(session.descriptor.workingDirectory, request.operation.artifact);
      if (isCurrent !== undefined && !isCurrent()) {
        throw new VisualAssetsError("completion_inactive", "Visual asset completion authority is no longer active");
      }
      return result;
    }
    await bridge.library.authorizeScope(request.authority.scope, isCurrent);
    if (isCurrent !== undefined && !isCurrent()) {
      throw new VisualAssetsError("completion_inactive", "Visual asset completion authority is no longer active");
    }
    const scope = operationScope(request);
    const visibleScopes = completionVisibleScopes(request.authority.scope);
    const result = await executeVisualAssetOperation(bridge.library, scope, request.operation, isCurrent, visibleScopes);
    if (isCurrent !== undefined && !isCurrent()) {
      throw new VisualAssetsError("completion_inactive", "Visual asset completion authority is no longer active");
    }
    return result;
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
      if (parsed.schemaVersion === 5) {
        if (this.closed) throw new Error("Harness host is closed");
        await this.backupState(serialized, "v5");
        if (this.closed) throw new Error("Harness host is closed");
        const sessions = uniqueSessions(parsed.sessions.map(readPersistedSession));
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
        if (!canResumeHarnessExecutionConfiguration(live.descriptor.configuration, descriptor.configuration)
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
    const priorUpgrade = prior !== undefined
      && productCodexUpgradeMatches(prior.configuration, descriptor.configuration);
    const priorMatches = prior !== undefined && (canResumeHarnessExecutionConfiguration(prior.configuration, descriptor.configuration)
      || priorUpgrade);
    if (prior !== undefined && (!priorMatches
      || prior.permissionProfileId !== descriptor.permissionProfileId
      || prior.workingDirectory !== descriptor.workingDirectory)) {
      throw new Error(`Thread ${descriptor.threadId} is already pinned to harness configuration ${prior.configuration.name}`);
    }
    if (priorUpgrade) {
      console.warn(`Migrating retired product Codex configuration for harness thread ${descriptor.threadId} during registration`);
    }
    const legacy = this.legacySaved.get(descriptor.threadId);
    const legacyUpgrade = legacy !== undefined
      && legacyProductCodexUpgradeMatches(legacy.configuration, descriptor.configuration);
    const legacyAccepted = legacy !== undefined
      && descriptor.permissionProfileId === legacyPermissionProfileId(descriptor.configuration)
      && (sameLegacyHarnessConfiguration(legacy.configuration, descriptor.configuration)
        || legacyUpgrade)
      && legacy.workingDirectory === descriptor.workingDirectory;
    if (legacyAccepted && legacyUpgrade) {
      console.warn(`Migrating deferred product Codex configuration for harness thread ${descriptor.threadId} during registration`);
    }
    const legacyState = legacyAccepted ? legacy.state : undefined;
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
      activeCompletions: new Map(),
      invokedCompletionRuns: new Map(),
    });
    this.saved.set(descriptor.threadId, persistedDescriptor(persisted));
    this.legacySaved.delete(descriptor.threadId);
    await this.persist();
  }

  async complete(
    threadId: number,
    invocation: HarnessInvokedCompletion,
    signal?: AbortSignal,
  ): Promise<HarnessInvokedCompletionObservation>;
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
    modelPlan?: HarnessModelPlan,
    attemptAdmissionId?: string,
    completionBroker?: HarnessCompletionBrokerScope,
  ): Promise<HarnessCompleteResult>;
  async complete(
    threadId: number,
    interactionOrInvocation: number | HarnessInvokedCompletion,
    capabilityOrSignal?: GraphCapability | AbortSignal,
    modelOrSignal?: InteractionModelSelection | AbortSignal,
    trailingSignal?: AbortSignal,
    traceContext?: HarnessCompletionTraceContext,
    executionLeaseId?: string,
    harnessPolicy?: HarnessExecutionPolicy,
    inputPlan?: HarnessModelPlan,
    attemptAdmissionId?: string,
    completionBroker?: HarnessCompletionBrokerScope,
  ): Promise<HarnessCompleteResult | HarnessInvokedCompletionObservation> {
    if (this.closed) throw new Error("Harness host is closed");
    if (typeof interactionOrInvocation !== "number") {
      const invocationSignal = isAbortSignal(capabilityOrSignal) ? capabilityOrSignal : undefined;
      return this.invokedCompletion(threadId, interactionOrInvocation, invocationSignal).run;
    }
    const interactionId = interactionOrInvocation;
    const capability = capabilityOrSignal as GraphCapability;
    if (!Number.isSafeInteger(interactionId) || interactionId < 1) throw new Error("Harness interactionId must be a positive integer");
    validateGraphCapability(capability);
    const suppliedModel = isAbortSignal(modelOrSignal) ? undefined : modelOrSignal;
    const signal = isAbortSignal(modelOrSignal) ? modelOrSignal : trailingSignal;
    const modelPlan = inputPlan === undefined ? undefined : normalizeModelPlan(inputPlan);
    const model = modelPlan?.orchestrator ?? suppliedModel;
    if (modelPlan !== undefined && suppliedModel !== undefined && !sameModelRoute(modelPlan.orchestrator, suppliedModel)) {
      throw new Error("Harness completion model must match the family-plan orchestrator");
    }
    if (model !== undefined) validateInteractionModelSelection(model);
    const session = this.liveSession(threadId);
    const effectiveConfiguration = executionConfiguration(session, harnessPolicy);
    if (completionBroker !== undefined && !harnessAllowsAgentAuthoredComplete(effectiveConfiguration)) {
      throw new Error(`Harness configuration ${effectiveConfiguration.name} does not allow agent-authored Complete`);
    }
    if (model !== undefined) validateConfiguredModelSelection(effectiveConfiguration, model);
    const runInput = {
      threadId,
      interactionId,
      session,
      capability,
      ...(model === undefined ? {} : { model }),
      ...(signal === undefined ? {} : { signal }),
      ...(traceContext === undefined ? {} : { traceContext }),
      ...(executionLeaseId === undefined ? {} : { executionLeaseId }),
      ...(harnessPolicy === undefined ? {} : { harnessPolicy }),
      ...(modelPlan === undefined ? {} : { modelPlan }),
      ...(attemptAdmissionId === undefined ? {} : { attemptAdmissionId }),
      ...(completionBroker === undefined ? {} : { completionBroker }),
      origin: { kind: "root" },
    } as const;
    return this.withSessionLock(session, () => this.runCompletion(runInput));
  }

  /** Agent-invoked Complete uses the same operation while bypassing only the human-root queue. */
  startInvokedCompletion(
    threadId: number,
    invocation: HarnessInvokedCompletion,
    signal?: AbortSignal,
  ): Promise<HarnessInvokedCompletionStart> {
    if (this.closed) throw new Error("Harness host is closed");
    return this.invokedCompletion(threadId, invocation, signal).started;
  }

  observeInvokedCompletion(threadId: number, completionId: GraphId): Promise<HarnessInvokedCompletionObservation>;
  observeInvokedCompletion(
    threadId: number,
    completionId: GraphId,
    waitMs: number,
  ): Promise<HarnessInvokedCompletionObservation | HarnessInvokedCompletionPending>;
  /**
   * Answers when the child's run ends. With `waitMs`, it answers that the child still runs
   * once that long has passed instead, so an observer that polls never leaves a request
   * waiting on a run after it has given up on it.
   */
  async observeInvokedCompletion(
    threadId: number,
    completionId: GraphId,
    waitMs?: number,
  ): Promise<HarnessInvokedCompletionObservation | HarnessInvokedCompletionPending> {
    if (!Number.isSafeInteger(completionId) || completionId < 1) {
      throw new Error("Invoked completion ID must be a positive integer");
    }
    if (waitMs !== undefined && (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > MAX_OBSERVATION_WAIT_MS)) {
      throw new Error(`Invoked completion observation wait must be 1 to ${MAX_OBSERVATION_WAIT_MS} ms`);
    }
    const run = this.liveSession(threadId).invokedCompletionRuns.get(completionId);
    if (run === undefined) throw new Error("Invoked completion is not registered");
    if (waitMs === undefined) return run.run;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<HarnessInvokedCompletionPending>((resolve) => {
      timer = setTimeout(() => resolve({ completionId, running: true }), waitMs);
    });
    try {
      return await Promise.race([run.run, pending]);
    } finally {
      clearTimeout(timer);
    }
  }

  private invokedCompletion(
    threadId: number,
    invocation: HarnessInvokedCompletion,
    signal?: AbortSignal,
  ): InvokedCompletionRun {
    const {
      capability, origin, traceContext, harnessPolicy, completionBroker, executionLeaseId, attemptAdmissionId,
    } = invocation;
    validateGraphCapability(capability);
    validateCompletionOrigin(origin);
    const admitted = validateInvokedAdmission(invocation);
    const modelPlan = invocation.modelPlan === undefined ? undefined : normalizeModelPlan(invocation.modelPlan);
    const model = modelPlan?.orchestrator ?? invocation.model;
    if (model !== undefined) validateInteractionModelSelection(model);
    const session = this.liveSession(threadId);
    if (!harnessAllowsAgentAuthoredComplete(session.descriptor.configuration)) {
      throw new Error(`Harness configuration ${session.descriptor.configuration.name} does not allow agent-authored Complete`);
    }
    if (model !== undefined) {
      validateConfiguredModelSelection(executionConfiguration(session, harnessPolicy), model);
    }
    const invocationDigest = graphInvocationDigest(capability, origin, traceContext, model);
    const existing = session.invokedCompletionRuns.get(capability.nodeId);
    if (existing !== undefined) {
      if (existing.invocationDigest !== invocationDigest) {
        throw new Error("Invoked completion is already active under a different graph binding");
      }
      return existing;
    }
    let resolveStarted!: (value: HarnessInvokedCompletionStart) => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<HarnessInvokedCompletionStart>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    // The blocking Complete compatibility path observes only `run`. Keep its
    // unused start acknowledgement from becoming an unhandled rejection.
    void started.catch(() => undefined);
    const run = this.runCompletion({
      threadId,
      interactionId: capability.nodeId,
      session,
      capability,
      origin,
      ...(traceContext === undefined ? {} : { traceContext }),
      ...(model === undefined ? {} : { model }),
      ...(harnessPolicy === undefined ? {} : { harnessPolicy }),
      ...(completionBroker === undefined ? {} : { completionBroker }),
      ...(admitted ? {
        modelPlan: modelPlan!,
        executionLeaseId: executionLeaseId!,
        attemptAdmissionId: attemptAdmissionId!,
        admissionInteractionId: traceContext!.productInteractionId,
      } : {}),
      ...(signal === undefined ? {} : { signal }),
      onNativeExecution: (native) => {
        if (native?.attached === undefined) {
          resolveStarted({ completionId: capability.nodeId });
          return;
        }
        void native.attached.then(
          (attachment) => resolveStarted({ completionId: capability.nodeId, attachment }),
          rejectStarted,
        );
      },
    }).then(() => ({ completionId: capability.nodeId }));
    // The start acknowledgement never outlives the run. A run can end before its native
    // attachment settles, for example when a force-stopped child's adapter never settles
    // either: the start then answers with the run's end instead of waiting forever. An
    // attachment that already settled wins, because a promise settles once.
    void run.then(
      () => resolveStarted({ completionId: capability.nodeId }),
      (error: unknown) => rejectStarted(error),
    );
    const entry = { invocationDigest, run, started };
    session.invokedCompletionRuns.set(capability.nodeId, entry);
    const forget = () => {
      const timer = setTimeout(() => {
        if (session.invokedCompletionRuns.get(capability.nodeId) === entry) {
          session.invokedCompletionRuns.delete(capability.nodeId);
        }
      }, SETTLED_INVOKED_COMPLETION_TTL_MS);
      timer.unref?.();
    };
    void run.then(forget, forget);
    return entry;
  }

  private async runCompletion(input: {
    readonly threadId: number;
    readonly interactionId: number;
    readonly session: LiveSession;
    readonly capability: GraphCapability;
    readonly model?: InteractionModelSelection;
    readonly signal?: AbortSignal;
    readonly traceContext?: HarnessCompletionTraceContext;
    readonly executionLeaseId?: string;
    readonly harnessPolicy?: HarnessExecutionPolicy;
    readonly modelPlan?: HarnessModelPlan;
    readonly attemptAdmissionId?: string;
    readonly completionBroker?: HarnessCompletionBrokerScope;
    /** The product interaction an invoked child's admission was issued for. */
    readonly admissionInteractionId?: number;
    readonly origin: CompletionOrigin;
    readonly onNativeExecution?: (native: NativeExecutionHandle | undefined) => void;
  }): Promise<HarnessCompleteResult | HarnessInvokedCompletionObservation> {
    const { threadId, interactionId, session, capability } = input;
    const controller = new AbortController();
    // Per-turn force-stop: once this completion is cancelled, a harness that supports it gets
    // two minutes to settle before this one turn, and nothing else, is force-stopped.
    const forceController = new AbortController();
    let forceTimer: NodeJS.Timeout | undefined;
    const armForceStop = () => {
      if (session.harness.supportsForceStop !== true || forceTimer !== undefined) return;
      forceTimer = setTimeout(
        () => forceController.abort(new Error(FORCE_STOPPED_TURN_MESSAGE)),
        CANCELLED_TURN_FORCE_STOP_MS,
      );
      forceTimer.unref?.();
    };
    controller.signal.addEventListener("abort", armForceStop, { once: true });
    // A force-stopped root turn's harness forgets its native conversation in its own force
    // listener. Record that at once: after the force (two minutes after the cancel), the host
    // run may take ten more seconds to end, and a crash before then must not restore it.
    const recordForcedState = () => queueMicrotask(() => {
      void this.recordSessionState(threadId, session).catch(() => undefined);
    });
    forceController.signal.addEventListener("abort", recordForcedState, { once: true });
    const detachSignal = forwardAbort(input.signal, controller);
    const completeCallId = randomUUID();
    const approvals = session.approvals.beginCompletion({ interactionId, completeCallId });
    session.activeCompletions.set(capability.nodeId, { completeCallId, interactionId, controller });
    if (input.origin.kind === "root") session.activeHumanRootCompletionId = capability.nodeId;
    const abortApprovals = () => session.approvals.endCompletion(
      completeCallId,
      "aborted",
      "Harness completion ended before the approval was resolved.",
    );
    controller.signal.addEventListener("abort", abortApprovals, { once: true });
    let result: HarnessCompleteResult | HarnessInvokedCompletionObservation | undefined;
    let operationError: unknown;
    let nativeStarted = false;
    try {
      if (this.closed) throw new Error("Harness host is closed");
      controller.signal.throwIfAborted();
      result = await this.executeCompletion(
        threadId,
        interactionId,
        session,
        capability,
        input.model,
        approvals,
        controller.signal,
        input.traceContext,
        input.executionLeaseId,
        input.harnessPolicy,
        input.modelPlan,
        input.attemptAdmissionId,
        input.origin,
        input.completionBroker,
        input.onNativeExecution,
        () => { nativeStarted = true; },
        input.admissionInteractionId,
        () => controller.abort(new Error("Provider execution access was released by its owner")),
        forceController.signal,
      );
    } catch (error) {
      operationError = error;
      if (!nativeStarted && error !== null && typeof error === "object") executionNotStartedErrors.add(error);
    }
    controller.signal.removeEventListener("abort", armForceStop);
    forceController.signal.removeEventListener("abort", recordForcedState);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    session.approvals.endCompletion(
      completeCallId,
      "aborted",
      "Harness completion ended before the approval was resolved.",
    );
    controller.signal.removeEventListener("abort", abortApprovals);
    if (session.activeCompletions.get(capability.nodeId)?.controller === controller) {
      session.activeCompletions.delete(capability.nodeId);
    }
    if (session.activeHumanRootCompletionId === capability.nodeId) {
      delete session.activeHumanRootCompletionId;
    }
    detachSignal();
    const errors: unknown[] = operationError === undefined ? [] : [operationError];
    try {
      await this.recordSessionState(threadId, session);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Harness completion and cleanup failed");
    return result!;
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
      validateExecutionAccess(lease, model, acceptedContracts);
      const executionLeaseId = randomUUID();
      const timeout = this.releaseAfter(executionLeaseId, EXECUTION_ADMISSION_TIMEOUT_MS);
      this.pendingExecutionAccess.set(executionLeaseId, {
        threadId, model, heldLeases: [{ lease, released: false }], timeout, releasePromise: undefined, state: "admitted",
        releaseRequested: false, ownerReleased: false,
        ...(harnessPolicy === undefined ? {} : { policyIdentity: executionPolicyIdentity(harnessPolicy) }),
      });
      return { executionLeaseId, adapterImplementationVersion: lease.access.adapterImplementationVersion };
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async admitModelPlanExecution(
    threadId: number,
    interactionId: number,
    attemptAdmissionId: string,
    inputPlan: HarnessModelPlan,
    signal: AbortSignal,
    harnessPolicy: HarnessExecutionPolicy,
  ): Promise<{
    executionLeaseId: string;
    admittedPlan: HarnessAdmittedModelPlan;
    /** Selected-orchestrator compatibility alias for existing attempt readers. */
    adapterImplementationVersion: string;
  }> {
    if (this.closed) throw new Error("Harness host is closed");
    if (!Number.isSafeInteger(interactionId) || interactionId < 1) {
      throw new Error("Family execution admission requires a positive interactionId");
    }
    validateAttemptAdmissionId(attemptAdmissionId);
    const session = this.liveSession(threadId);
    const acceptedContracts = session.descriptor.configuration.executionAccessContracts;
    if (acceptedContracts === undefined || this.options.accessBroker === undefined) {
      throw new HarnessExecutionFailure("Harness execution access is unavailable", "configuration", "none");
    }
    validateFamilyPolicyAccessContracts(harnessPolicy, acceptedContracts);
    const configuration = executionConfiguration(session, harnessPolicy);
    const modelPlan = normalizeModelPlan(inputPlan);
    validateConfiguredModelPlan(configuration, modelPlan);
    for (const route of modelPlan.roster) {
      if (!acceptedContracts.includes(route.accessContract)) {
        throw new HarnessExecutionFailure(
          `Harness does not accept execution access contract ${route.accessContract}`,
          "configuration",
          "none",
        );
      }
    }

    const heldLeases: HeldExecutionAccessLease[] = [];
    const byProviderId: Record<string, HarnessExecutionAccessBundle["byProviderId"][string]> = Object.create(null) as Record<string, HarnessExecutionAccessBundle["byProviderId"][string]>;
    try {
      for (const route of uniqueProviderRoutes(modelPlan.roster)) {
        signal.throwIfAborted();
        const lease = await this.options.accessBroker.acquire(route, acceptedContracts, signal);
        const held = { lease, released: false };
        heldLeases.push(held);
        validateExecutionAccess(lease, route, acceptedContracts);
        byProviderId[route.providerId] = lease.access;
      }
      const accessBundle = freezeAccessBundle(byProviderId);
      const policyIdentity = executionPolicyIdentity(harnessPolicy);
      const admittedPlan = admitModelPlan(modelPlan, accessBundle, policyIdentity);
      const executionLeaseId = randomUUID();
      const timeout = this.releaseAfter(executionLeaseId, EXECUTION_ADMISSION_TIMEOUT_MS);
      this.pendingExecutionAccess.set(executionLeaseId, {
        threadId,
        interactionId,
        attemptAdmissionId,
        model: modelPlan.orchestrator,
        modelPlan,
        admittedPlan,
        accessBundle,
        policyIdentity,
        heldLeases,
        timeout,
        releasePromise: undefined,
        state: "admitted",
        releaseRequested: false,
        ownerReleased: false,
      });
      return {
        executionLeaseId,
        admittedPlan,
        adapterImplementationVersion: admittedPlan.orchestrator.adapterImplementationVersion,
      };
    } catch (error) {
      try {
        await releaseHeldExecutionAccess(heldLeases);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Family execution admission and rollback failed");
      }
      throw error;
    }
  }

  /**
   * The owner of an execution lease gives it up after durably recording that the work using
   * it ended. Provider access lives exactly as long as the native turn that uses it: access
   * claimed by a turn that still runs is not released here; the turn is cancelled and the
   * access is released when it settles. Access that is already released is acknowledged to
   * its provider, which may finish a removal that was waiting on that work. Returns false for
   * an unknown lease.
   */
  async releaseProviderExecution(executionLeaseId: string): Promise<boolean> {
    // An HTTP client may disconnect while the provider still releases or acknowledges.
    // Reject retries until that work settles instead of accumulating server-side waiters.
    if (this.ownerReleasesInProgress.has(executionLeaseId)) throw new ExecutionLeaseReleaseInProgress();
    this.ownerReleasesInProgress.add(executionLeaseId);
    try {
      return await this.releaseProviderExecutionOnce(executionLeaseId);
    } finally {
      this.ownerReleasesInProgress.delete(executionLeaseId);
    }
  }

  private async releaseProviderExecutionOnce(executionLeaseId: string): Promise<boolean> {
    const pending = this.pendingExecutionAccess.get(executionLeaseId);
    if (pending === undefined) {
      // The acknowledgement this lease would have carried must not be lost: a failure here is
      // returned to the owner, which retries.
      await this.options.accessBroker?.acknowledgeUnknownRelease?.();
      return false;
    }
    pending.ownerReleased = true;
    if (pending.state === "claimed") {
      pending.abandon?.();
      return true;
    }
    if (pending.state === "admitted") pending.releaseRequested = true;
    await this.releaseHeldExecution(executionLeaseId, pending);
    await this.acknowledgeReleasedExecution(executionLeaseId, pending);
    return true;
  }

  /** Releases access whose native turn has ended. */
  private settleExecutionAccess(executionLeaseId: string): void {
    const pending = this.pendingExecutionAccess.get(executionLeaseId);
    if (pending?.state !== "claimed") return;
    pending.state = "settled";
    delete pending.abandon;
    void this.releaseHeldExecution(executionLeaseId, pending)
      .then(() => this.finishReleasedExecution(executionLeaseId, pending))
      .catch(() => {});
  }

  /**
   * After access is released without the owner waiting on it: acknowledge it if the owner has
   * already given the lease up, retrying on failure because the owner will not ask again;
   * otherwise keep it for the owner's acknowledgement for a bounded time.
   */
  private async finishReleasedExecution(executionLeaseId: string, pending: PendingExecutionAccess): Promise<void> {
    if (this.pendingExecutionAccess.get(executionLeaseId) !== pending) return;
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.timeout = undefined;
    if (!pending.ownerReleased) {
      pending.timeout = this.expireUnacknowledged(executionLeaseId, pending);
      return;
    }
    try {
      await this.acknowledgeReleasedExecution(executionLeaseId, pending);
    } catch (error) {
      if (this.pendingExecutionAccess.get(executionLeaseId) === pending && !this.closed) {
        pending.timeout = this.retryAcknowledgement(executionLeaseId, pending);
      }
      throw error;
    }
  }

  private retryAcknowledgement(executionLeaseId: string, pending: PendingExecutionAccess): NodeJS.Timeout {
    const timer = setTimeout(() => {
      pending.timeout = undefined;
      void this.finishReleasedExecution(executionLeaseId, pending).catch(() => {});
    }, EXECUTION_RELEASE_RETRY_MS);
    timer.unref?.();
    return timer;
  }

  private expireUnacknowledged(executionLeaseId: string, pending: PendingExecutionAccess): NodeJS.Timeout {
    const timer = setTimeout(() => {
      if (this.pendingExecutionAccess.get(executionLeaseId) === pending && !pending.ownerReleased) {
        this.pendingExecutionAccess.delete(executionLeaseId);
      }
    }, UNACKNOWLEDGED_RELEASE_TTL_MS);
    timer.unref?.();
    return timer;
  }

  /** Releases held access, retrying on the host's own timer until it succeeds. */
  private async releaseHeldExecution(executionLeaseId: string, pending: PendingExecutionAccess): Promise<void> {
    if (pending.state === "released") return;
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.timeout = undefined;
    pending.releasePromise ??= releaseHeldExecutionAccess(pending.heldLeases).then(() => {
      pending.state = "released";
    });
    try {
      await pending.releasePromise;
    } catch (error) {
      pending.releasePromise = undefined;
      if (this.pendingExecutionAccess.get(executionLeaseId) === pending && !this.closed) {
        if (pending.timeout !== undefined) clearTimeout(pending.timeout);
        pending.timeout = this.releaseAfter(executionLeaseId, EXECUTION_RELEASE_RETRY_MS);
      }
      throw error;
    }
  }

  /** Tells each provider its access ended durably, then forgets the lease. */
  private async acknowledgeReleasedExecution(executionLeaseId: string, pending: PendingExecutionAccess): Promise<void> {
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.timeout = undefined;
    for (const held of pending.heldLeases) await held.lease.acknowledge?.();
    if (this.pendingExecutionAccess.get(executionLeaseId) === pending) this.pendingExecutionAccess.delete(executionLeaseId);
  }

  private releaseAfter(executionLeaseId: string, delay: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const pending = this.pendingExecutionAccess.get(executionLeaseId);
      if (pending === undefined || pending.state === "claimed" || pending.state === "released") return;
      pending.releaseRequested = true;
      void this.releaseHeldExecution(executionLeaseId, pending)
        .then(() => this.finishReleasedExecution(executionLeaseId, pending))
        .catch(() => {});
    }, delay);
    timer.unref?.();
    return timer;
  }

  private async executeCompletion(
    threadId: number,
    productInteractionId: number,
    session: LiveSession,
    capability: GraphCapability,
    model: InteractionModelSelection | undefined,
    approvals: HarnessApprovalChannel,
    signal: AbortSignal,
    traceContext?: HarnessCompletionTraceContext,
    executionLeaseId?: string,
    harnessPolicy?: HarnessExecutionPolicy,
    modelPlan?: HarnessModelPlan,
    attemptAdmissionId?: string,
    origin: CompletionOrigin = { kind: "root" },
    completionBroker?: HarnessCompletionBrokerScope,
    onNativeExecution?: (native: NativeExecutionHandle | undefined) => void,
    onNativeStarted?: () => void,
    admissionInteractionId: number = productInteractionId,
    abandonCompletion?: () => void,
    forceSignal: AbortSignal = new AbortController().signal,
  ): Promise<HarnessCompleteResult | HarnessInvokedCompletionObservation> {
    const graph = new RelayerGraphClient(capability);
    const interactionNodeId = capability.nodeId;
    try {
      const output = await graph.getCompletionOutput(interactionNodeId);
      onNativeExecution?.(undefined);
      if (origin.kind === "invoke") return { completionId: interactionNodeId };
      return { threadId, configurationName: session.descriptor.configuration.name, output, trace: disabledTraceDescriptor() };
    } catch (error) {
      if (!(error instanceof GraphApiError && error.status === 404 && error.code === "completion_not_found")) throw error;
    }
    const expectedPersonalPresentationVersionId = traceContext?.personalPresentationVersionId;
    const [interaction, interactionInput, personalPresentation] = await Promise.all([
      graph.getNode(interactionNodeId),
      graph.getInteractionInput(),
      graph.getPersonalPresentation().catch((error: unknown) => {
        if (error instanceof GraphApiError && error.status === 404 && error.code === "personal_presentation_not_attached"
          && expectedPersonalPresentationVersionId === undefined) return undefined;
        throw error;
      }),
    ]);
    if (origin.kind === "invoke") {
      if (interaction.leasedActionId !== origin.actionId) {
        throw new HarnessExecutionFailure(
          "Invoked completion does not match its graph-owned action lease",
          "configuration",
          "none",
        );
      }
      if (session.harness.supportsInvokedComplete !== true) {
        throw new HarnessExecutionFailure(
          `Harness ${session.descriptor.configuration.name} does not support agent-invoked Complete`,
          "configuration",
          "none",
        );
      }
    }
    if (expectedPersonalPresentationVersionId !== undefined
      && personalPresentation?.attachment.versionInteractionNodeId !== expectedPersonalPresentationVersionId) {
      throw new Error("Attached personal presentation does not match the pinned trace version");
    }
    const support = session.harness.traceSupport?.() ?? NO_HARNESS_TRACE_SUPPORT;
    const trace = this.traceStore?.start({
      threadId,
      interactionNodeId,
      ...(traceContext === undefined ? {} : { productInteractionId: traceContext.productInteractionId }),
      ...(traceContext?.personalPresentationVersionId === undefined ? {} : {
        personalPresentationVersionId: traceContext.personalPresentationVersionId,
      }),
      ...(traceContext?.personalPresentationVersionKey === undefined ? {} : {
        personalPresentationVersionKey: traceContext.personalPresentationVersionKey,
      }),
      implementation: session.descriptor.configuration.implementation,
      configurationName: session.descriptor.configuration.name,
      support,
    });
    const traceSink = trace?.sink ?? createNoopHarnessTraceSink();
    traceSink.emit({
      type: "execution.scope",
      data: { completionBrokerAvailable: completionBroker !== undefined },
    });
    // Only runs whose configuration declares preview support, on a host with a
    // renderer, get a preview folder. Its presence is what enables previews.
    // Created last before the try, so the finally below always removes it.
    const previewDirectory = this.options.draftPreviews !== undefined
      && resolveGraphCapabilityProfile(session.descriptor.configuration).preview === "enabled"
      ? await mkdtemp(join(tmpdir(), "relayer-graph-previews-"))
      : undefined;
    // The host owns the turn folder lifetime; clients may only create children.
    // Create inside the try so failures still clean up previews and normalize.
    const programDirectory = join(tmpdir(), `relayer-graph-programs-${randomBytes(9).toString("base64url")}`);
    const scope = new ActiveHarnessGraphScope({
      ...capability,
      programDirectory,
      ...(previewDirectory === undefined ? {} : { previewDirectory }),
      ...(traceContext === undefined ? {} : { authoringErrors: true }),
    });
    if (previewDirectory !== undefined) this.previewTraces.set(interactionNodeId, traceSink);
    const observedTrace = new EffectObservingTraceSink(traceSink);
    let completionError: HarnessExecutionFailure | undefined;
    let accessLease: HarnessExecutionAccessLease | undefined;
    let selectedAccess: HarnessExecutionAccess | undefined;
    let admittedModelPlan: HarnessAdmittedModelPlan | undefined;
    let accessBundle: HarnessExecutionAccessBundle | undefined;
    let releaseAccessAfterCompletion = false;
    let claimedExecutionLeaseId: string | undefined;
    let harnessStarted = false;
    /** Set when the force-stop fired before the native turn settled: how that turn ended. */
    let forceStoppedNativeOutcome: { readonly kind: ForceStoppedNativeOutcome; readonly detail?: string } | undefined;
    try {
      await mkdir(programDirectory, { mode: 0o700 });
      const acceptedContracts = session.descriptor.configuration.executionAccessContracts;
      if (executionLeaseId !== undefined) {
        const pending = this.pendingExecutionAccess.get(executionLeaseId);
        if (pending === undefined || pending.state !== "admitted" || pending.releaseRequested
          || pending.threadId !== threadId || model === undefined
          || pending.model.providerId !== model.providerId || pending.model.adapterId !== model.adapterId
          || pending.model.modelId !== model.modelId
          || pending.interactionId !== (modelPlan === undefined ? undefined : admissionInteractionId)
          || pending.attemptAdmissionId !== attemptAdmissionId
          || (pending.modelPlan === undefined) !== (modelPlan === undefined)
          || (pending.modelPlan !== undefined && modelPlan !== undefined
            && modelPlanIdentity(pending.modelPlan) !== modelPlanIdentity(modelPlan))
          || pending.policyIdentity !== (harnessPolicy === undefined ? undefined : executionPolicyIdentity(harnessPolicy))) {
          throw new HarnessExecutionFailure("Execution access admission is invalid or expired", "configuration", "none");
        }
        pending.state = "claimed";
        if (pending.timeout !== undefined) clearTimeout(pending.timeout);
        pending.timeout = undefined;
        if (abandonCompletion !== undefined) pending.abandon = abandonCompletion;
        claimedExecutionLeaseId = executionLeaseId;
        accessLease = pending.heldLeases[0]?.lease;
        admittedModelPlan = pending.admittedPlan;
        accessBundle = pending.accessBundle;
        selectedAccess = pending.accessBundle?.byProviderId[pending.model.providerId] ?? accessLease?.access;
      } else if (model !== undefined && acceptedContracts === undefined) {
        throw new HarnessExecutionFailure(
          "A model-using harness must declare execution access contracts",
          "configuration",
          "none",
        );
      }
      if (executionLeaseId === undefined && acceptedContracts !== undefined && model !== undefined) {
        if (modelPlan !== undefined) {
          throw new HarnessExecutionFailure(
            "Family execution requires prior admission",
            "configuration",
            "none",
          );
        }
        if (this.options.accessBroker === undefined) throw new Error("Harness execution access broker is unavailable");
        accessLease = await this.options.accessBroker.acquire(model, acceptedContracts, signal);
        releaseAccessAfterCompletion = true;
        if (!acceptedContracts.includes(accessLease.access.contract)
          || accessLease.access.providerId !== model.providerId
          || accessLease.access.adapterId !== model.adapterId) {
          throw new Error("Harness execution access does not match the selected provider or contract");
        }
        selectedAccess = accessLease.access;
      }
      // A turn cancelled and force-stopped before its native work starts ends as a cancellation.
      if (forceSignal.aborted) throw signal.reason;
      harnessStarted = true;
      onNativeStarted?.();
      const native = session.harness.complete({
        origin,
        requireNativeContinuity: traceContext?.requireNativeContinuity === true,
        ...(traceContext?.threadIconSelection === undefined ? {} : { threadIconSelection: traceContext.threadIconSelection }),
        ...(traceContext?.nativeHistoryAnchor === undefined ? {} : { nativeHistoryAnchor: traceContext.nativeHistoryAnchor }),
        inputGraph: interaction,
        interactionInput,
        ...(personalPresentation === undefined ? {} : { personalPresentation }),
        graph: scope,
        ...(completionBroker === undefined ? {} : { completionBroker }),
        approvals,
        trace: observedTrace,
        ...(admittedModelPlan === undefined ? {} : { modelPlan: admittedModelPlan }),
        ...(model === undefined ? {} : { model }),
        ...(accessBundle === undefined ? {} : { accessBundle }),
        ...(selectedAccess === undefined ? {} : { access: selectedAccess }),
        ...(session.harness.supportsForceStop === true ? { forceSignal } : {}),
      }, signal);
      onNativeExecution?.(isNativeExecutionHandle(native) ? native : undefined);
      await settledOrForceStopped(native, forceSignal);
      // Checked at once: the timer may still fire during later cleanup, after a natural settle.
      if (forceSignal.aborted) forceStoppedNativeOutcome = { kind: "settled" };
    } catch (error) {
      if (forceSignal.aborted && harnessStarted) {
        forceStoppedNativeOutcome = error instanceof ForceStoppedTurnDidNotSettle
          ? { kind: "did not settle within ten seconds" }
          : { kind: "rejected", detail: errorMessage(error) };
      } else if (!signal.aborted || (error !== signal.reason && !(error instanceof NativeExecutionCancelled))) {
        // Adapters may reject with this exact AbortSignal reason before native work
        // starts. Distinct abort, quiescence, or cleanup errors remain failures.
        completionError = normalizeHarnessFailure(error, harnessStarted, observedTrace.effectBoundary());
      }
    } finally {
      scope.close();
      if (previewDirectory !== undefined) {
        this.previewTraces.delete(interactionNodeId);
        // Preview images are transient: they never outlive the turn.
        await rm(previewDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      // The native turn has ended, was force-stopped, or never started, so nothing uses the
      // claimed access. Only this completion's claim is settled.
      if (claimedExecutionLeaseId !== undefined) this.settleExecutionAccess(claimedExecutionLeaseId);
      if (releaseAccessAfterCompletion) {
        try {
          await accessLease?.release();
        } catch (error) {
          completionError ??= normalizeHarnessFailure(error, true, observedTrace.effectBoundary());
        }
      }
      // Saved programs are transient too: they never outlive the turn.
      await rm(programDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    const forceStopped = forceStoppedNativeOutcome !== undefined;
    if (forceStoppedNativeOutcome !== undefined) {
      // A force-stop only follows a cancellation, so the turn settles as a settled
      // cancellation, whether the harness resolved or rejected while being stopped: a user's
      // Stop stays stopped. The force-stop and the native outcome are diagnostics only. The
      // product log carries no provider text; the trace, when one is kept, adds the detail.
      console.warn(`Force-stopped harness completion ${interactionNodeId} on thread ${threadId}`, {
        threadId,
        completionId: interactionNodeId,
        origin: origin.kind,
        ...(traceContext === undefined ? {} : { productInteractionId: traceContext.productInteractionId }),
        nativeOutcome: forceStoppedNativeOutcome.kind,
      });
      traceSink.emit({
        type: "warning",
        data: {
          message: FORCE_STOPPED_TURN_MESSAGE,
          forceStopped: true,
          nativeOutcome: forceStoppedNativeOutcome.detail ?? forceStoppedNativeOutcome.kind,
        },
      });
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
    if (signal.aborted) {
      traceSink.emit({
        type: "cancelled",
        data: { message: errorMessage(signal.reason), ...(forceStopped ? { forceStopped: true } : {}) },
      });
      await sealTrace(trace, "partial", forceStopped ? `Stopped by user. ${FORCE_STOPPED_TURN_MESSAGE}` : "Stopped by user");
      throw new HarnessCancellationSettled(errorMessage(signal.reason));
    }
    if (origin.kind === "invoke") {
      await sealTrace(trace, "complete");
      return { completionId: interactionNodeId };
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

  candidateTracePersonalPresentationVersionId(productInteractionId: number): number | undefined {
    if (this.traceStore === undefined) return undefined;
    return this.traceStore.personalPresentationVersionId(productInteractionId);
  }

  cancel(threadId: number, completionId?: GraphId): boolean {
    const session = this.sessions.get(threadId);
    const targetId = completionId ?? session?.activeHumanRootCompletionId;
    const active = targetId === undefined ? undefined : session?.activeCompletions.get(targetId);
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
    for (const session of this.sessions.values()) {
      session.approvals.close("Harness host closed before the approval was resolved.");
      for (const active of session.activeCompletions.values()) {
        active.controller.abort(new Error("Harness host closed"));
      }
    }
    const errors: unknown[] = [];
    try {
      await this.initializePromise;
    } catch (error) {
      if (!(error instanceof Error && error.message === "Harness host is closed")) errors.push(error);
    }
    await Promise.all([...this.sessions.entries()].map(async ([threadId, session]) => {
      try {
        const invokedRuns = Promise.allSettled(
          [...session.invokedCompletionRuns.values()].map(({ run }) => run),
        )
          .then(() => undefined);
        await waitForHarnessSessionClose(
          Promise.all([session.tail, invokedRuns]).then(() => undefined),
          HARNESS_CLOSE_SESSION_TIMEOUT_MS,
        );
      } catch (error) {
        errors.push(error);
      }
      try {
        this.captureSessionState(threadId, session);
      } catch (error) {
        errors.push(error);
      }
      try {
        await session.lifecycle.dispose();
      } catch (error) {
        errors.push(error);
      }
    }));
    // Unclaimed and settled access is released now. Access still claimed by a native turn
    // that did not stop within the close wait stays held until the process exits.
    await Promise.all([...this.pendingExecutionAccess.entries()]
      .filter(([, pending]) => pending.state === "admitted" || pending.state === "settled")
      .map(async ([id, pending]) => {
        pending.releaseRequested = true;
        try {
          await this.releaseHeldExecution(id, pending);
        } catch (error) {
          errors.push(error);
        }
        if (pending.timeout !== undefined) clearTimeout(pending.timeout);
        pending.timeout = undefined;
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
    for (const [threadId, session] of this.sessions) {
      session.approvals.close("Harness host force-closed before the approval was resolved.");
      for (const active of session.activeCompletions.values()) {
        active.controller.abort(new Error("Harness host force-closed"));
      }
      try { session.lifecycle.forceShutdown(); } catch (error) { errors.push(error); }
      // A harness forgets a root conversation its force shutdown killed. Capture that now: the
      // killed turn may never settle before the process exits. Recording is best effort: a
      // failure keeps that thread's previous state and never fails the shutdown.
      try {
        this.captureSessionState(threadId, session);
      } catch (error) {
        console.warn(`Could not capture harness state for thread ${threadId} during force close`, errorMessage(error));
      }
    }
    // Force close skips close()'s final persist, so it writes the captured state itself.
    const persisted = (this.initialized && this.sessions.size > 0 ? this.persist() : Promise.resolve())
      .catch((error: unknown) => {
        console.warn("Could not persist harness state during force close", errorMessage(error));
      });
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
      await persisted;
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

  private captureSessionState(threadId: number, session: LiveSession): void {
    session.descriptor = { ...session.descriptor, state: captureHarnessState(session.harness) };
    this.saved.set(threadId, persistedDescriptor(session.descriptor));
  }

  private async recordSessionState(threadId: number, session: LiveSession): Promise<void> {
    this.captureSessionState(threadId, session);
    await this.persist();
  }

  private persist(): Promise<void> {
    const operation = this.persistTail.then(() => {
      const legacySessions = [...this.legacySaved.values()];
      const serialized = `${JSON.stringify({
        schemaVersion: CURRENT_HOST_STATE_SCHEMA_VERSION,
        sessions: [...this.saved.values()],
        ...(legacySessions.length === 0 ? {} : { legacySessions }),
      }, null, 2)}\n`;
      return this.writeState(serialized);
    });
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

  private async backupState(serialized: string, version: "v3" | "v4" | "v5"): Promise<void> {
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
  // Graceful close ends each connection itself once nothing is in flight on it. Node's
  // closeIdleConnections() skips a keep-alive connection that has not sent its first request
  // (the graph server's pooled client opens those), and a response that finishes after close()
  // still offers keep-alive, so either would hold server.close() past the runtime's deadline.
  // A request whose headers are still arriving when close begins is reset, not served.
  const connections = new Map<Socket, Set<ServerResponse>>();
  const lastResponses = new WeakSet<ServerResponse>();
  let closing = false;
  // Only the connection's final response may close it, so earlier pipelined responses still reply.
  const closeConnectionAfter = (response: ServerResponse) => {
    if (response.headersSent) return;
    response.shouldKeepAlive = false;
    lastResponses.add(response);
  };
  const server = createServer((request, response) => {
    const socket = request.socket;
    const inFlight = connections.get(socket);
    const previous = inFlight === undefined ? undefined : [...inFlight].at(-1);
    inFlight?.add(response);
    response.once("close", () => {
      inFlight?.delete(response);
      if (closing && inFlight?.size === 0 && !socket.destroyed) socket.end(() => socket.destroy());
    });
    if (!closing) return void route(host, options, request, response);
    // A request that arrives while the host closes is refused without routing, so it has no
    // effect that its caller could miss when the connection closes.
    if (previous !== undefined && lastResponses.has(previous) && !previous.headersSent) {
      previous.shouldKeepAlive = true;
      lastResponses.delete(previous);
    }
    closeConnectionAfter(response);
    reply(response, 503, { error: "harness_host_closing" });
  });
  server.on("connection", (socket) => {
    connections.set(socket, new Set());
    socket.once("close", () => connections.delete(socket));
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
      for (const socket of connections.keys()) socket.destroy();
      server.closeAllConnections();
      return runningForceClosePromise;
    },
    close: () => {
      if (runningForceClosePromise !== undefined) return runningForceClosePromise;
      if (runningClosePromise !== undefined) return runningClosePromise;
      closing = true;
      const closingServer = close(server);
      for (const [socket, inFlight] of connections) {
        const newest = [...inFlight].at(-1);
        if (newest === undefined) socket.destroy();
        else closeConnectionAfter(newest);
      }
      runningClosePromise = host.close().finally(() => closingServer);
      return runningClosePromise;
    },
  };
}

const executionNotStartedErrors = new WeakSet<object>();

class ExecutionLeaseReleaseInProgress extends Error {
  constructor() { super("execution_lease_release_in_progress"); }
}

class HarnessCancellationSettled extends Error {
  constructor(message: string) { super(message); }
}

async function route(host: HarnessHost, options: HarnessHostOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/draft-previews/render") {
      if (options.draftPreviews === undefined
        || request.headers.authorization !== `Bearer ${options.draftPreviews.token}`) {
        return reply(response, 401, { error: { code: "unauthorized", message: "Draft preview bridge authorization failed" } });
      }
      try {
        return reply(response, 200, { result: await host.renderDraftPreview(await body(request)) });
      } catch (error) {
        return reply(response, 500, { error: { code: "draft_preview_failed", message: errorMessage(error) } });
      }
    }
    if (request.method === "POST" && url.pathname === "/visual-assets/operations") {
      if (options.visualAssets === undefined
        || request.headers.authorization !== `Bearer ${options.visualAssets.token}`) {
        return reply(response, 401, { error: { code: "unauthorized", message: "Visual asset bridge authorization failed" } });
      }
      try {
        return reply(response, 200, { result: await host.visualAssetOperation(await body(request)) });
      } catch (error) {
        if (error instanceof ArtifactFileError) {
          return reply(response, 400, { error: { code: error.code, path: error.path, message: error.message } });
        }
        const code = error instanceof VisualAssetsError ? error.code : "visual_assets_operation_failed";
        const status = code === "completion_inactive" ? 409 : 400;
        return reply(response, status, { error: { code, message: errorMessage(error) } });
      }
    }
    if (request.headers.authorization !== `Bearer ${options.controlToken}`) return reply(response, 401, { error: "unauthorized" });
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
        const modelPlan = readHarnessModelPlan(input);
        const model = readInteractionModelSelection(input);
        if (modelPlan === undefined && model === undefined) return reply(response, 400, { error: "model_selection_required" });
        if (modelPlan !== undefined && model !== undefined && !sameModelRoute(modelPlan.orchestrator, model)) {
          throw new Error("Harness execution admission model must match the family-plan orchestrator");
        }
        const controller = new AbortController();
        const abort = () => controller.abort(new Error("Execution admission request disconnected"));
        request.once("aborted", abort);
        try {
          if (modelPlan !== undefined) {
            return reply(response, 201, await host.admitModelPlanExecution(
              threadId,
              readPositiveInteractionId(input),
              readAttemptAdmissionId(input, true)!,
              modelPlan,
              controller.signal,
              requireHarnessExecutionPolicy(input),
            ));
          }
          return reply(response, 201, await host.admitProviderExecution(
            threadId, model!, controller.signal, readHarnessExecutionPolicy(input),
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
      const completionIdInput = url.searchParams.get("completionId");
      const completionId = completionIdInput === null ? undefined : Number(completionIdInput);
      if (completionId !== undefined && (!Number.isSafeInteger(completionId) || completionId < 1)) {
        return reply(response, 400, { error: "invalid_completion_id" });
      }
      return reply(response, 200, { cancelled: host.cancel(threadId, completionId) });
    }
    const invokedCompletionMatch = /^\/sessions\/([^/]+)\/invoked-completions$/.exec(url.pathname);
    if (request.method === "POST" && invokedCompletionMatch?.[1] !== undefined) {
      const threadId = readThreadId(invokedCompletionMatch[1]);
      if (threadId === undefined) return reply(response, 400, { error: "invalid_thread_id" });
      let input: HarnessInvokedCompletion;
      try {
        input = readInvokedCompletionInput(await body(request));
      } catch (error) {
        return reply(response, 400, { error: "invalid_invoked_completion", message: errorMessage(error) });
      }
      return reply(response, 201, await host.startInvokedCompletion(
        threadId,
        input,
      ));
    }
    const invokedCompletionObservationMatch = /^\/sessions\/([^/]+)\/invoked-completions\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && invokedCompletionObservationMatch?.[1] !== undefined
      && invokedCompletionObservationMatch[2] !== undefined) {
      const threadId = readThreadId(invokedCompletionObservationMatch[1]);
      const completionId = readThreadId(invokedCompletionObservationMatch[2]);
      if (threadId === undefined || completionId === undefined) {
        return reply(response, 400, { error: "invalid_completion_identity" });
      }
      const wait = url.searchParams.get("waitMs");
      if (wait === null) return reply(response, 200, await host.observeInvokedCompletion(threadId, completionId));
      const waitMs = /^[1-9][0-9]*$/.test(wait) ? Number(wait) : Number.NaN;
      if (!Number.isSafeInteger(waitMs) || waitMs > MAX_OBSERVATION_WAIT_MS) {
        return reply(response, 400, { error: "invalid_observation_wait" });
      }
      return reply(response, 200, await host.observeInvokedCompletion(threadId, completionId, waitMs));
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
          input.modelPlan,
          input.attemptAdmissionId,
          input.completionBroker,
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
    if (error instanceof ExecutionLeaseReleaseInProgress) {
      return reply(response, 503, { error: error.message });
    }
    if (error instanceof HarnessCancellationSettled) {
      return reply(response, 409, { error: error.message, cancellationSettled: true });
    }
    if (error instanceof HarnessApprovalCoordinatorError) {
      const status = error.code === "invalid_approval_request"
        ? 400
        : error.code === "approval_request_not_found"
          ? 404
          : 409;
      return reply(response, status, { error: error.code, message: error.message });
    }
    return reply(response, 500, {
      ...(error instanceof HarnessExecutionFailure
        ? { error: error.message, failureCategory: error.failureCategory, effectBoundary: error.effectBoundary }
        : { error: error instanceof Error ? error.message : String(error), failureCategory: "application", effectBoundary: "unknown" }),
      ...(error !== null && typeof error === "object" && executionNotStartedErrors.has(error) ? { executionNotStarted: true } : {}),
    });
  }
}

function readExecutionLeaseId(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("executionLeaseId" in input)) return undefined;
  const value = (input as { executionLeaseId?: unknown }).executionLeaseId;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/iu.test(value)) throw new Error("invalid execution lease ID");
  return value;
}

function readDraftPreviewRequest(input: unknown): { interactionNodeId: number; fingerprint: string; snapshot: JsonObject } {
  if (!isJsonObject(input) || input.version !== 1 || !positiveInteger(input.interactionNodeId)
    || typeof input.fingerprint !== "string" || !isJsonObject(input.snapshot) || !isJsonObject(input.snapshot.target)) {
    throw new Error("Draft preview request is invalid");
  }
  return { interactionNodeId: input.interactionNodeId, fingerprint: input.fingerprint, snapshot: input.snapshot };
}

function isPng(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength > 8
    && Buffer.from(value.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function reply(response: ServerResponse, status: number, value: unknown): void { const data = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) }); response.end(data); }
function listen(server: Server, port: number, host: string): Promise<void> { return new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolveListen(); }); }); }
function close(server: Server): Promise<void> { return new Promise((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error))); }

type VisualBridgeScope =
  | { readonly kind: "project"; readonly projectId: number; readonly threadId: number }
  | { readonly kind: "thread"; readonly threadId: number };
type VisualBridgeOperation = Record<string, unknown> & { readonly kind: string };
type VisualBridgeRequest = {
  readonly authority: { readonly kind: "completion"; readonly interactionNodeId: number; readonly scope: VisualBridgeScope }
    | { readonly kind: "control"; readonly scope: VisualBridgeScope }
    | { readonly kind: "lifecycle"; readonly interactionNodeId: number };
  readonly assetGeneration?: number;
  readonly operation: VisualBridgeOperation;
};

function readVisualAssetRequest(value: unknown, generation: number): VisualBridgeRequest {
  if (!isRecord(value) || value.version !== 1 || value.generation !== generation
    || !isRecord(value.authority) || !isRecord(value.operation) || typeof value.operation.kind !== "string") {
    throw new VisualAssetsError("visual_assets_request_invalid", "Visual asset bridge request is invalid");
  }
  if (value.authority.kind === "lifecycle") {
    if (!["activate", "pause", "resume", "finalize-revoke"].includes(value.operation.kind)
      || !Number.isSafeInteger(value.authority.interactionNodeId)
      || (value.authority.interactionNodeId as number) < 1
      || Object.keys(value.authority).sort().join(",") !== "interactionNodeId,kind") {
      throw new VisualAssetsError("visual_assets_authority_invalid", "Visual asset revocation authority is invalid");
    }
    if (value.operation.kind === "activate") {
      if (!Number.isSafeInteger(value.operation.completionEpoch) || (value.operation.completionEpoch as number) < 1
        || Object.keys(value.operation).sort().join(",") !== "completionEpoch,kind") {
        throw new VisualAssetsError("visual_assets_authority_invalid", "Visual asset activation epoch is invalid");
      }
      return {
        authority: { kind: "lifecycle", interactionNodeId: value.authority.interactionNodeId as number },
        operation: value.operation as VisualBridgeOperation,
      };
    }
    const barrierId = value.operation.barrierId;
    const operationGeneration = value.operation.kind === "pause" ? value.operation.expectedGeneration : value.operation.assetGeneration;
    if (typeof barrierId !== "string" || barrierId.length < 8
      || !Number.isSafeInteger(operationGeneration) || (operationGeneration as number) < 1
      || (value.operation.revocationTakeover !== undefined && (value.operation.kind !== "pause" || typeof value.operation.revocationTakeover !== "boolean"))) {
      throw new VisualAssetsError("visual_assets_authority_invalid", "Visual asset lifecycle barrier is invalid");
    }
    return {
      authority: { kind: "lifecycle", interactionNodeId: value.authority.interactionNodeId as number },
      operation: value.operation as VisualBridgeOperation,
    };
  }
  const scope = readVisualBridgeScope(value.authority.scope);
  if (value.authority.kind === "completion") {
    if (!Number.isSafeInteger(value.authority.interactionNodeId) || (value.authority.interactionNodeId as number) < 1
      || !Number.isSafeInteger(value.assetGeneration) || (value.assetGeneration as number) < 1) {
      throw new VisualAssetsError("visual_assets_authority_invalid", "Visual asset completion authority is invalid");
    }
    return {
      authority: { kind: "completion", interactionNodeId: value.authority.interactionNodeId as number, scope },
      assetGeneration: value.assetGeneration as number,
      operation: value.operation as VisualBridgeOperation,
    };
  }
  if (value.authority.kind === "control") {
    return { authority: { kind: "control", scope }, operation: value.operation as VisualBridgeOperation };
  }
  throw new VisualAssetsError("visual_assets_authority_invalid", "Visual asset bridge authority is invalid");
}

function readVisualBridgeScope(value: unknown): VisualBridgeScope {
  if (!isRecord(value) || !Number.isSafeInteger(value.threadId) || (value.threadId as number) < 1) {
    throw new VisualAssetsError("scope_invalid", "Visual asset scope is invalid");
  }
  if (value.kind === "thread" && Object.keys(value).sort().join(",") === "kind,threadId") {
    return { kind: "thread", threadId: value.threadId as number };
  }
  if (value.kind === "project" && Object.keys(value).sort().join(",") === "kind,projectId,threadId"
    && Number.isSafeInteger(value.projectId) && (value.projectId as number) > 0) {
    return { kind: "project", projectId: value.projectId as number, threadId: value.threadId as number };
  }
  throw new VisualAssetsError("scope_invalid", "Visual asset scope is invalid");
}

function libraryScope(scope: VisualBridgeScope): VisualAssetScope {
  return scope.kind === "project"
    ? { kind: "project", projectId: scope.projectId }
    : { kind: "thread", threadId: scope.threadId };
}

const READ_ONLY_VISUAL_OPERATIONS = new Set([
  "list-registries", "list-tags", "list-assets", "find", "inspect", "download", "resolve", "icon-candidates", "inspect-icon",
]);
const MUTATING_VISUAL_OPERATIONS = new Set([
  "add", "create-tag", "move-tag", "associate", "organize", "archive",
]);

function requestedVisualScope(value: unknown): VisualAssetScope {
  if (!isRecord(value)) throw new VisualAssetsError("scope_invalid", "Visual asset operation scope is invalid");
  if (value.kind === "library" && Object.keys(value).join(",") === "kind") return { kind: "library" };
  if (value.kind === "project" && Object.keys(value).sort().join(",") === "kind,projectId"
    && Number.isSafeInteger(value.projectId) && (value.projectId as number) > 0) {
    return { kind: "project", projectId: value.projectId as number };
  }
  if (value.kind === "thread" && Object.keys(value).sort().join(",") === "kind,threadId"
    && Number.isSafeInteger(value.threadId) && (value.threadId as number) > 0) {
    return { kind: "thread", threadId: value.threadId as number };
  }
  throw new VisualAssetsError("scope_invalid", "Visual asset operation scope is invalid");
}

function operationScope(request: VisualBridgeRequest): VisualAssetScope {
  if (request.authority.kind === "lifecycle") {
    throw new VisualAssetsError("visual_assets_authority_invalid", "Revocation is not a visual asset operation");
  }
  if (request.authority.kind === "control") return libraryScope(request.authority.scope);
  if (request.operation.kind === "resolve" && request.operation.scope === undefined) {
    return libraryScope(request.authority.scope);
  }
  const scope = requestedVisualScope(request.operation.scope);
  const derived = request.authority.scope;
  const allowed = scope.kind === "library"
    || (scope.kind === "thread" && scope.threadId === derived.threadId)
    || (scope.kind === "project" && derived.kind === "project" && scope.projectId === derived.projectId);
  if (!allowed) throw new VisualAssetsError("scope_not_authorized", "Visual asset operation scope is not authorized");
  if (scope.kind === "library" && !READ_ONLY_VISUAL_OPERATIONS.has(request.operation.kind)) {
    throw new VisualAssetsError("scope_read_only", "The visual asset library scope is read-only");
  }
  if (!READ_ONLY_VISUAL_OPERATIONS.has(request.operation.kind)
    && !MUTATING_VISUAL_OPERATIONS.has(request.operation.kind)
    && request.operation.kind !== "prepare-detail"
    && request.operation.kind !== "prepare-icon"
    && request.operation.kind !== "check-artifact") {
    throw new VisualAssetsError("visual_assets_operation_unsupported", `Unsupported visual asset operation: ${request.operation.kind}`);
  }
  return scope;
}

function completionVisibleScopes(scope: VisualBridgeScope): readonly VisualAssetScope[] {
  return [
    { kind: "library" },
    ...(scope.kind === "project" ? [{ kind: "project" as const, projectId: scope.projectId }] : []),
    { kind: "thread", threadId: scope.threadId },
  ];
}

function stringField(operation: VisualBridgeOperation, field: string): string {
  const value = operation[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new VisualAssetsError("visual_assets_request_invalid", `Visual asset operation requires ${field}`);
  }
  return value;
}

function stringArrayField(operation: VisualBridgeOperation, field: string): readonly string[] {
  const value = operation[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new VisualAssetsError("visual_assets_request_invalid", `Visual asset operation requires ${field}`);
  }
  return value as string[];
}

function resolveLogicalIds(operation: VisualBridgeOperation): readonly string[] {
  const logicalIds = stringArrayField(operation, "logicalIds");
  if (logicalIds.length > 32 || new Set(logicalIds).size !== logicalIds.length
    || logicalIds.some((logicalId) => !boundedVisualAssetIdentity(logicalId))) {
    throw new VisualAssetsError(
      "visual_assets_request_invalid",
      "Visual asset resolve identities are invalid",
    );
  }
  return logicalIds;
}

function boundedVisualAssetIdentity(value: string): boolean {
  return value !== "" && value.trim() === value && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= 128;
}

function pageFields(operation: VisualBridgeOperation): { readonly limit?: number; readonly cursor?: string } {
  return {
    ...(operation.limit === undefined ? {} : { limit: operation.limit as number }),
    ...(operation.cursor === undefined ? {} : { cursor: operation.cursor as string }),
  };
}

async function visibleAsset(library: FileVisualAssetsLibrary, scope: VisualAssetScope, assetId: string, includeArchived = false): Promise<VisualAsset> {
  if (includeArchived) {
    try { return await library.lookupAsset({ scope, assetId }); } catch (error) {
      if (!(error instanceof VisualAssetsError) || !["asset_not_found", "asset_not_authorized"].includes(error.code)) throw error;
      throw new VisualAssetsError("asset_not_authorized", "Visual asset is not authorized in this scope");
    }
  }
  let cursor: string | undefined;
  do {
    const page = await library.listAssets({ scope, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    const asset = page.items.find((candidate) => candidate.id === assetId);
    if (asset !== undefined) return asset;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  throw new VisualAssetsError("asset_not_authorized", "Visual asset is not authorized in this scope");
}

async function visibleAssetAcross(
  library: FileVisualAssetsLibrary,
  scopes: readonly VisualAssetScope[],
  assetId: string,
  includeArchived = false,
): Promise<VisualAsset> {
  for (const scope of scopes) {
    try { return await visibleAsset(library, scope, assetId, includeArchived); } catch (error) {
      if (!(error instanceof VisualAssetsError) || error.code !== "asset_not_authorized") throw error;
    }
  }
  throw new VisualAssetsError("asset_not_authorized", "Visual asset is not authorized in the completion scope");
}

async function visibleTag(library: FileVisualAssetsLibrary, scope: VisualAssetScope, tagId: string): Promise<void> {
  await library.find({ scope, tagId, limit: 1 });
}

async function serializedFile(file: { readonly name: string; readonly mediaType: string; readonly expectedDigest?: string; read(): Promise<Uint8Array> }): Promise<unknown> {
  const bytes = await file.read();
  return {
    name: file.name,
    mediaType: file.mediaType,
    ...(file.expectedDigest === undefined ? {} : { expectedDigest: file.expectedDigest }),
    contentBase64: Buffer.from(bytes).toString("base64"),
  };
}

async function executeVisualAssetOperation(
  library: FileVisualAssetsLibrary,
  scope: VisualAssetScope,
  operation: VisualBridgeOperation,
  isCurrent?: () => boolean,
  visibleScopes: readonly VisualAssetScope[] = [scope],
): Promise<unknown> {
  const page = pageFields(operation);
  switch (operation.kind) {
    case "list-registries": return library.listRegistries({ scope, ...page });
    case "list-tags": return library.listTags({ scope, ...page, ...(operation.parentTagId === undefined ? {} : { parentTagId: operation.parentTagId as string | null }) });
    case "list-assets": return library.listAssets({ scope, ...page });
    case "find": return library.find({ scope, tagId: stringField(operation, "tagId"), ...page });
    case "icon-candidates": {
      const assets = new Map<string, VisualAsset>();
      const tagNames = new Map<string, string>();
      for (const visibleScope of [scope, { kind: "library" } as const]) {
        const parentIds: (string | null)[] = [null];
        for (let parentIndex = 0; parentIndex < parentIds.length; parentIndex += 1) {
          let tagCursor: string | undefined;
          do {
            const result = await library.listTags({ scope: visibleScope, parentTagId: parentIds[parentIndex]!, limit: 100, ...(tagCursor === undefined ? {} : { cursor: tagCursor }) });
            for (const tag of result.items) {
              if (!tagNames.has(tag.id)) parentIds.push(tag.id);
              tagNames.set(tag.id, tag.name);
            }
            tagCursor = result.nextCursor ?? undefined;
            if (tagNames.size > 10000) throw new VisualAssetsError("catalog_too_large", "Icon discovery catalog exceeds its candidate budget");
          } while (tagCursor !== undefined);
        }
        let cursor: string | undefined;
        do {
          const result = await library.listAssets({ scope: visibleScope, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
          for (const asset of result.items) assets.set(asset.id, asset);
          cursor = result.nextCursor ?? undefined;
          if (assets.size > 10000) throw new VisualAssetsError("catalog_too_large", "Icon discovery catalog exceeds its candidate budget");
        } while (cursor !== undefined);
      }
      return { candidates: [...assets.values()].map((asset) => ({
        id: `image:${asset.id}`, name: asset.name, description: asset.description ?? "",
        aliases: [], categories: [], tags: asset.tagIds.map((id) => tagNames.get(id) ?? id), useCases: [],
        icon: { kind: "image", assetId: asset.id }, kind: "image",
      })) };
    }
    case "inspect-icon":
    case "inspect": {
      const assetId = stringField(operation, "assetId");
      if (operation.kind === "inspect-icon") await visibleAssetAcross(library, [scope, { kind: "library" }], assetId, true);
      else await visibleAsset(library, scope, assetId, true);
      const inspected = await library.inspect(assetId);
      return { asset: inspected.asset, preview: await serializedFile(inspected.preview) };
    }
    case "add": {
      if (!isRecord(operation.file) || typeof operation.file.name !== "string"
        || typeof operation.file.mediaType !== "string" || typeof operation.file.contentBase64 !== "string") {
        throw new VisualAssetsError("visual_assets_request_invalid", "Visual asset add requires a file");
      }
      const bytes = new Uint8Array(Buffer.from(operation.file.contentBase64, "base64"));
      if (Buffer.from(bytes).toString("base64") !== operation.file.contentBase64) {
        throw new VisualAssetsError("visual_assets_request_invalid", "Visual asset file base64 is invalid");
      }
      const tagIds = stringArrayField(operation, "tagIds");
      await Promise.all(tagIds.map((tagId) => visibleTag(library, scope, tagId)));
      const expectedDigest = operation.file.expectedDigest;
      if (expectedDigest !== undefined && typeof expectedDigest !== "string") {
        throw new VisualAssetsError("visual_assets_request_invalid", "Visual asset expected digest must be a string");
      }
      return library.add({
        scope,
        name: stringField(operation, "name"),
        ...(operation.description === undefined ? {} : { description: stringField(operation, "description") }),
        tagIds,
        ...(operation.registryId === undefined ? {} : { registryId: String(operation.registryId) }),
        file: Object.freeze({
          name: operation.file.name,
          mediaType: operation.file.mediaType,
          ...(expectedDigest === undefined ? {} : { expectedDigest }),
          async read() { return bytes.slice(); },
        }),
      }, isCurrent);
    }
    case "create-tag": return library.createTag({ scope, name: stringField(operation, "name"), ...(operation.parentTagId === undefined ? {} : { parentTagId: String(operation.parentTagId) }) }, isCurrent);
    case "move-tag": {
      const tagId = stringField(operation, "tagId");
      const parentTagId = operation.parentTagId === null ? null : stringField(operation, "parentTagId");
      await visibleTag(library, scope, tagId);
      if (parentTagId !== null) await visibleTag(library, scope, parentTagId);
      return library.moveTag({ tagId, parentTagId }, isCurrent);
    }
    case "associate": {
      const assetId = stringField(operation, "assetId");
      await visibleAssetAcross(library, [{ kind: "library" }, scope], assetId);
      return library.associate({ assetId, scope }, isCurrent);
    }
    case "organize": {
      const assetId = stringField(operation, "assetId");
      const addTagIds = stringArrayField(operation, "addTagIds");
      const removeTagIds = stringArrayField(operation, "removeTagIds");
      await visibleAsset(library, scope, assetId);
      await Promise.all([...addTagIds, ...removeTagIds].map((tagId) => visibleTag(library, scope, tagId)));
      return library.organize({ assetId, addTagIds, removeTagIds }, isCurrent);
    }
    case "archive": {
      const assetId = stringField(operation, "assetId");
      await visibleAsset(library, scope, assetId);
      return library.archive(assetId, isCurrent);
    }
    case "download": {
      const assetId = stringField(operation, "assetId");
      await visibleAsset(library, scope, assetId, true);
      return serializedFile(await library.download(assetId));
    }
    case "resolve": {
      const logicalIds = resolveLogicalIds(operation);
      const assets = await Promise.all(logicalIds.map(async (logicalId) => {
        const asset = await visibleAssetAcross(library, visibleScopes, logicalId, true);
        return {
          logicalId,
          authority: "current",
          availability: asset.archived ? "unavailable" : "available",
          digestSha256: asset.digest.replace(/^sha256:/u, ""),
          mediaType: asset.mediaType,
          representation: { kind: "image", sanitized: true },
        };
      }));
      return { assets };
    }
    case "prepare-icon": {
      if (Object.keys(operation).sort().join(",") !== "assetId,kind,scope") {
        throw new VisualAssetsError("visual_assets_request_invalid", "Image icon preparation accepts only an asset reference");
      }
      const asset = await visibleAssetAcross(library, visibleScopes, stringField(operation, "assetId"));
      if (asset.archived) throw new VisualAssetsError("asset_unavailable", "Archived assets cannot be used for new image icons");
      const file = await library.download(asset.id);
      return { assetId: asset.id, digestSha256: asset.digest.replace(/^sha256:/u, ""),
        mediaType: asset.mediaType, byteLength: asset.byteLength,
        provenanceSource: asset.provenance.source, provenanceFileName: asset.provenance.fileName,
        content: Buffer.from(await file.read()).toString("base64") };
    }
    case "prepare-detail": {
      const package_ = operation.package as CanonicalNodeDetailPackage;
      // Persistence validates the complete canonical package and all count bounds
      // before its scoped asset lookups; a separate discovery scan only duplicates
      // authority checks and permits unbounded pre-validation work.
      const candidate = createMemoryVisualDetailPersistence(library, { visibleScopes });
      const detail = await candidate.accept({ package: package_, scope }).catch((error: unknown) => {
        if (error instanceof VisualAssetsError && ["asset_not_found", "asset_not_authorized"].includes(error.code)) {
          throw new VisualAssetsError("asset_not_authorized", "Visual asset is not authorized in the completion scope");
        }
        throw error;
      });
      const archive = await candidate.exportArchive({ details: [detail], scope });
      return { detail, contents: archive.contents };
    }
    default: throw new VisualAssetsError("visual_assets_operation_unsupported", `Unsupported visual asset operation: ${operation.kind}`);
  }
}

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

function migratedProductCodexConfiguration(configuration: HarnessConfiguration): HarnessConfiguration {
  const legacySettings = stableJson(configuration.settings);
  const expectedLegacySettings = configuration.name === "codex-basic-high"
    ? stableJson({ modelReasoningEffort: "high", skipGitRepoCheck: true })
    : stableJson({ modelReasoningEffort: "medium", skipGitRepoCheck: true });
  if ((configuration.name !== "codex-basic" && configuration.name !== "codex-basic-high")
    || configuration.implementation !== "codex.basic"
    || configuration.implementationVersion !== 1
    || (configuration.revision !== 1 && configuration.revision !== 2)
    || legacySettings !== expectedLegacySettings) return configuration;
  return parseHarnessConfiguration({
    ...configuration,
    name: "codex-basic",
    revision: 3,
    settings: {
      modelReasoningEffort: "medium",
      promptProfile: "layered-navigation-multi-agent-v1",
      skipGitRepoCheck: true,
    },
  });
}

function productCodexUpgradeMatches(
  prior: HarnessConfiguration,
  current: HarnessConfiguration,
): boolean {
  const migrated = migratedProductCodexConfiguration(prior);
  return migrated !== prior && sameHarnessExecutionConfiguration(migrated, current);
}

function migratedLegacyProductCodexConfiguration(
  configuration: Omit<HarnessConfiguration, "permissionBindings">,
): Omit<HarnessConfiguration, "permissionBindings"> {
  const legacySettings = stableJson(configuration.settings);
  const expectedLegacySettings = configuration.name === "codex-basic-high"
    ? stableJson({ modelReasoningEffort: "high", skipGitRepoCheck: true })
    : stableJson({ modelReasoningEffort: "medium", skipGitRepoCheck: true });
  if ((configuration.name !== "codex-basic" && configuration.name !== "codex-basic-high")
    || configuration.implementation !== "codex.basic"
    || configuration.implementationVersion !== 1
    || legacySettings !== expectedLegacySettings) return configuration;
  return {
    ...configuration,
    name: "codex-basic",
    revision: 3,
    executionAccessContracts: ["managed-runtime@1", "secret@1"],
    settings: {
      modelReasoningEffort: "medium",
      promptProfile: "layered-navigation-multi-agent-v1",
      skipGitRepoCheck: true,
    },
  };
}

function legacyProductCodexUpgradeMatches(
  prior: Omit<HarnessConfiguration, "permissionBindings">,
  current: HarnessConfiguration,
): boolean {
  const migrated = migratedLegacyProductCodexConfiguration(prior);
  return migrated !== prior && sameLegacyHarnessConfiguration(migrated, current);
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

type ForceStoppedNativeOutcome = "settled" | "rejected" | "did not settle within ten seconds";

class ForceStoppedTurnDidNotSettle extends Error {
  constructor() { super("The force-stopped turn did not settle within ten seconds"); }
}

/**
 * Waits for a native turn to settle. Once the turn is force-stopped, waits at most
 * FORCE_STOPPED_TURN_SETTLE_MS more and then rejects, so the host can release the turn's
 * access even if the harness never settles. A later settlement is ignored.
 */
async function settledOrForceStopped(native: PromiseLike<void>, forceSignal: AbortSignal): Promise<void> {
  const settled = Promise.resolve(native);
  void settled.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  let detach = () => {};
  const abandoned = new Promise<never>((_resolve, reject) => {
    const expire = () => {
      timer = setTimeout(() => reject(new ForceStoppedTurnDidNotSettle()), FORCE_STOPPED_TURN_SETTLE_MS);
      timer.unref?.();
    };
    if (forceSignal.aborted) {
      expire();
      return;
    }
    forceSignal.addEventListener("abort", expire, { once: true });
    detach = () => forceSignal.removeEventListener("abort", expire);
  });
  try {
    await Promise.race([settled, abandoned]);
  } finally {
    detach();
    if (timer !== undefined) clearTimeout(timer);
  }
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
  readonly modelPlan?: HarnessModelPlan;
  readonly attemptAdmissionId?: string;
  readonly traceContext?: HarnessCompletionTraceContext;
  readonly executionLeaseId?: string;
  readonly harnessPolicy?: HarnessExecutionPolicy;
  readonly completionBroker?: HarnessCompletionBrokerScope;
} {
  if (!isRecord(value)) throw new Error("Harness completion input must be an object");
  const unknown = Object.keys(value).filter((key) => ![
    "interactionId", "graph", "model", "modelPlan", "attemptAdmissionId", "traceContext", "executionLeaseId", "harnessPolicy", "completionBroker",
  ].includes(key));
  if (unknown.length > 0) throw new Error(`Harness completion contains unsupported fields: ${unknown.join(", ")}`);
  if (!Number.isSafeInteger(value.interactionId) || (value.interactionId as number) < 1) {
    throw new Error("Harness completion requires a positive interactionId");
  }
  const model = readInteractionModelSelection(value);
  const modelPlan = readHarnessModelPlan(value);
  const attemptAdmissionId = readAttemptAdmissionId(value, modelPlan !== undefined);
  if (modelPlan !== undefined && model !== undefined && !sameModelRoute(modelPlan.orchestrator, model)) {
    throw new Error("Harness completion model must match the family-plan orchestrator");
  }
  const traceContext = readTraceContext(value);
  const executionLeaseId = readExecutionLeaseId(value);
  const harnessPolicy = readHarnessExecutionPolicy(value);
  const completionBroker = readCompletionBroker(value);
  return {
    interactionId: value.interactionId as number,
    graph: readGraphCapability(value),
    ...(model === undefined ? {} : { model }),
    ...(modelPlan === undefined ? {} : { modelPlan }),
    ...(attemptAdmissionId === undefined ? {} : { attemptAdmissionId }),
    ...(traceContext === undefined ? {} : { traceContext }),
    ...(executionLeaseId === undefined ? {} : { executionLeaseId }),
    ...(harnessPolicy === undefined ? {} : { harnessPolicy }),
    ...(completionBroker === undefined ? {} : { completionBroker }),
  };
}

function readInvokedCompletionInput(value: unknown): HarnessInvokedCompletion {
  if (!isRecord(value)) throw new Error("Harness invoked completion input must be an object");
  const unknown = Object.keys(value).filter((key) => ![
    "capability", "origin", "traceContext", "model", "harnessPolicy", "completionBroker",
    "modelPlan", "executionLeaseId", "attemptAdmissionId",
  ].includes(key));
  if (unknown.length > 0) throw new Error(`Harness invoked completion contains unsupported fields: ${unknown.join(", ")}`);
  if (!isRecord(value.capability)
    || Object.keys(value.capability).some((key) => !["url", "token", "nodeId"].includes(key))) {
    throw new Error("Harness invoked completion requires an exact graph capability");
  }
  if (value.model !== undefined
    && (!isRecord(value.model) || Object.keys(value.model).some((key) => !["providerId", "adapterId", "modelId"].includes(key)))) {
    throw new Error("Harness invoked completion contains an invalid model selection");
  }
  validateCompletionOrigin(value.origin);
  const traceContext = readTraceContext(value);
  const model = readInteractionModelSelection(value);
  const harnessPolicy = readHarnessExecutionPolicy(value);
  const completionBroker = readCompletionBroker(value);
  const modelPlan = readHarnessModelPlan(value);
  const executionLeaseId = readExecutionLeaseId(value);
  const attemptAdmissionId = readAttemptAdmissionId(value, false);
  const input: HarnessInvokedCompletion = {
    capability: readGraphCapability({ graph: value.capability }),
    origin: value.origin,
    ...(traceContext === undefined ? {} : { traceContext }),
    ...(model === undefined ? {} : { model }),
    ...(harnessPolicy === undefined ? {} : { harnessPolicy }),
    ...(completionBroker === undefined ? {} : { completionBroker }),
    ...(modelPlan === undefined ? {} : { modelPlan }),
    ...(executionLeaseId === undefined ? {} : { executionLeaseId }),
    ...(attemptAdmissionId === undefined ? {} : { attemptAdmissionId }),
  };
  validateInvokedAdmission(input);
  return input;
}

/**
 * An invoked child is either admitted like a root run (plan, lease, attempt, and the product
 * interaction the admission names) or carries none of them. Returns whether it is admitted.
 */
function validateInvokedAdmission(input: HarnessInvokedCompletion): boolean {
  const parts = [input.modelPlan, input.executionLeaseId, input.attemptAdmissionId];
  if (parts.every((part) => part === undefined)) return false;
  if (parts.some((part) => part === undefined)) {
    throw new Error("An admitted invoked completion requires modelPlan, executionLeaseId, and attemptAdmissionId together");
  }
  if (input.traceContext?.productInteractionId === undefined) {
    throw new Error("An admitted invoked completion requires its product interaction in traceContext");
  }
  if (input.harnessPolicy === undefined) {
    throw new Error("An admitted invoked completion requires its harness policy");
  }
  const plan = normalizeModelPlan(input.modelPlan);
  if (input.model !== undefined && !sameModelRoute(plan.orchestrator, input.model)) {
    throw new Error("Invoked completion model must match the family-plan orchestrator");
  }
  return true;
}

function readCompletionBroker(value: unknown): HarnessCompletionBrokerScope | undefined {
  if (!isRecord(value) || value.completionBroker === undefined) return undefined;
  const broker = value.completionBroker;
  if (!isRecord(broker)
    || Object.keys(broker).some((key) => !["url", "token"].includes(key))
    || typeof broker.url !== "string"
    || typeof broker.token !== "string"
    || broker.token.length < 32) {
    throw new Error("Harness completion contains an invalid completion broker");
  }
  const url = new URL(broker.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "") {
    throw new Error("Harness completion broker must use authenticated 127.0.0.1 HTTP");
  }
  return Object.freeze({ url: url.toString().replace(/\/$/u, ""), token: broker.token });
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

function readHarnessModelPlan(value: unknown): HarnessModelPlan | undefined {
  if (!isRecord(value) || value.modelPlan === undefined) return undefined;
  return normalizeModelPlan(value.modelPlan);
}

function normalizeModelPlan(value: unknown): HarnessModelPlan {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.familyId) || (value.familyId as number) < 1
    || !Number.isSafeInteger(value.familyRevision) || (value.familyRevision as number) < 1
    || !Array.isArray(value.roster) || value.roster.length < 1 || value.roster.length > 100) {
    throw new Error("Harness modelPlan is invalid");
  }
  const orchestrator = normalizeModelRoute(value.orchestrator);
  const roster = Object.freeze(value.roster.map(normalizeModelRoute));
  const identities = new Set<string>();
  const providerAdapters = new Map<string, string>();
  const providerContracts = new Map<string, string>();
  for (const route of roster) {
    const identity = modelRouteIdentity(route);
    if (identities.has(identity)) throw new Error("Harness modelPlan contains a duplicate model route");
    identities.add(identity);
    const adapter = providerAdapters.get(route.providerId);
    if (adapter !== undefined && adapter !== route.adapterId) {
      throw new Error("Harness modelPlan maps one provider definition to multiple adapters");
    }
    providerAdapters.set(route.providerId, route.adapterId);
    const contract = providerContracts.get(route.providerId);
    if (contract !== undefined && contract !== route.accessContract) {
      throw new Error("Harness modelPlan maps one provider definition to multiple access contracts");
    }
    providerContracts.set(route.providerId, route.accessContract);
  }
  if (!identities.has(modelRouteIdentity(orchestrator))) {
    throw new Error("Harness modelPlan orchestrator must belong to its roster");
  }
  return Object.freeze({
    familyId: value.familyId as number,
    familyRevision: value.familyRevision as number,
    orchestrator,
    roster,
  });
}

function normalizeModelRoute(value: unknown): HarnessModelRoute {
  if (!isRecord(value)
    || !isStableId(value.providerId)
    || !isStableId(value.adapterId)
    || !isVersionedIdentifier(value.accessContract)
    || !isStableId(value.modelId)) {
    throw new Error("Harness modelPlan contains an invalid model route");
  }
  return Object.freeze({
    providerId: value.providerId,
    adapterId: value.adapterId,
    accessContract: value.accessContract,
    modelId: value.modelId,
  });
}

function readPositiveInteractionId(value: unknown): number {
  if (!isRecord(value) || !Number.isSafeInteger(value.interactionId) || (value.interactionId as number) < 1) {
    throw new Error("Family execution admission requires a positive interactionId");
  }
  return value.interactionId as number;
}

function readAttemptAdmissionId(value: unknown, required: boolean): string | undefined {
  if (!isRecord(value) || value.attemptAdmissionId === undefined) {
    if (required) throw new Error("Family execution requires an attemptAdmissionId");
    return undefined;
  }
  validateAttemptAdmissionId(value.attemptAdmissionId);
  return value.attemptAdmissionId;
}

function validateAttemptAdmissionId(value: unknown): asserts value is string {
  if (!isStableId(value)) throw new Error("Family execution attemptAdmissionId is invalid");
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

function validateConfiguredModelPlan(configuration: HarnessConfiguration, plan: HarnessModelPlan): void {
  for (const route of plan.roster) validateConfiguredModelSelection(configuration, route);
}

function sameModelRoute(left: InteractionModelSelection, right: InteractionModelSelection): boolean {
  return left.providerId === right.providerId && left.adapterId === right.adapterId && left.modelId === right.modelId;
}

function modelRouteIdentity(route: HarnessModelRoute): string {
  return JSON.stringify([route.providerId, route.adapterId, route.accessContract, route.modelId]);
}

function modelPlanIdentity(plan: HarnessModelPlan): string {
  return JSON.stringify(plan);
}

function uniqueProviderRoutes(roster: readonly HarnessModelRoute[]): readonly HarnessModelRoute[] {
  const seen = new Set<string>();
  return roster.filter((route) => {
    if (seen.has(route.providerId)) return false;
    seen.add(route.providerId);
    return true;
  });
}

function validateExecutionAccess(
  lease: HarnessExecutionAccessLease,
  route: InteractionModelSelection | HarnessModelRoute,
  acceptedContracts: readonly string[],
): void {
  const expectedContract = "accessContract" in route ? route.accessContract : undefined;
  if (!acceptedContracts.includes(lease.access.contract)
    || (expectedContract !== undefined && lease.access.contract !== expectedContract)
    || lease.access.providerId !== route.providerId
    || lease.access.adapterId !== route.adapterId) {
    throw new Error("Harness execution access does not match the selected provider or contract");
  }
}

function freezeExecutionAccess(access: HarnessExecutionAccess): HarnessExecutionAccess {
  if (access.kind === "secret") {
    const modelCapabilities = access.modelCapabilities === undefined
      ? undefined
      : Object.freeze(Object.fromEntries(Object.entries(access.modelCapabilities).map(([modelId, capabilities]) => (
        [modelId, Object.freeze({ ...capabilities })]
      ))));
    return Object.freeze({
      ...access,
      fields: Object.freeze({ ...access.fields }),
      ...(modelCapabilities === undefined ? {} : { modelCapabilities }),
    });
  }
  return Object.freeze({ ...access, environment: Object.freeze({ ...access.environment }) });
}

function freezeAccessBundle(byProviderId: Readonly<Record<string, HarnessExecutionAccess>>): HarnessExecutionAccessBundle {
  const frozen: Record<string, HarnessExecutionAccess> = Object.create(null) as Record<string, HarnessExecutionAccess>;
  for (const [providerId, access] of Object.entries(byProviderId)) frozen[providerId] = freezeExecutionAccess(access);
  return Object.freeze({ byProviderId: Object.freeze(frozen) });
}

function admitModelPlan(
  plan: HarnessModelPlan,
  accessBundle: HarnessExecutionAccessBundle,
  policyIdentity: string,
): HarnessAdmittedModelPlan {
  const versioned = (route: HarnessModelRoute) => Object.freeze({
    ...route,
    adapterImplementationVersion: accessBundle.byProviderId[route.providerId]!.adapterImplementationVersion,
  });
  const withoutDigest = Object.freeze({
    familyId: plan.familyId,
    familyRevision: plan.familyRevision,
    orchestrator: versioned(plan.orchestrator),
    roster: Object.freeze(plan.roster.map(versioned)),
    harnessPolicyDigest: semanticDigest("relayer.harness-policy.v1", policyIdentity),
  });
  return Object.freeze({
    ...withoutDigest,
    digest: semanticDigest("relayer.harness-model-plan.v1", JSON.stringify(withoutDigest)),
  });
}

function semanticDigest(domain: string, value: string): string {
  return `sha256:${createHash("sha256").update(domain).update("\0").update(value).digest("hex")}`;
}

async function releaseHeldExecutionAccess(heldLeases: readonly HeldExecutionAccessLease[]): Promise<void> {
  const errors: unknown[] = [];
  for (const held of [...heldLeases].reverse()) {
    if (held.released) continue;
    try {
      await held.lease.release();
      held.released = true;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Provider execution access release failed");
}

async function waitForHarnessSessionClose(tail: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      tail,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Harness session did not stop before the close deadline")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
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
  return stableJson(policy);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function readHarnessExecutionPolicy(value: unknown): HarnessExecutionPolicy | undefined {
  if (!isRecord(value) || value.harnessPolicy === undefined) return undefined;
  const policy = value.harnessPolicy;
  if (!isRecord(policy)) throw new Error("Harness execution policy is invalid");
  const { configurationRevision, configurationDigest, modelRules, executionAccessContracts } = policy;
  if (typeof configurationRevision !== "number" || !Number.isSafeInteger(configurationRevision) || configurationRevision < 1
    || typeof configurationDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(configurationDigest)
    || (modelRules !== undefined && modelRules !== null && !isRecord(modelRules))
    || (executionAccessContracts !== undefined
      && (!Array.isArray(executionAccessContracts)
        || executionAccessContracts.length < 1
        || executionAccessContracts.some((contract) => !isVersionedIdentifier(contract))
        || new Set(executionAccessContracts).size !== executionAccessContracts.length))) {
    throw new Error("Harness execution policy is invalid");
  }
  return {
    configurationRevision,
    configurationDigest,
    ...(modelRules === undefined || modelRules === null
      ? {}
      : { modelRules: modelRules as unknown as HarnessConfiguration["modelRules"] }),
    ...(executionAccessContracts === undefined
      ? {}
      : { executionAccessContracts: Object.freeze([...(executionAccessContracts as string[])]) }),
  };
}

function validateFamilyPolicyAccessContracts(
  policy: HarnessExecutionPolicy,
  configuredContracts: readonly string[],
): void {
  const policyContracts = policy.executionAccessContracts;
  if (policyContracts === undefined) {
    throw new Error("Family execution harnessPolicy requires executionAccessContracts");
  }
  if (policyContracts.length !== configuredContracts.length
    || policyContracts.some((contract, index) => contract !== configuredContracts[index])) {
    throw new Error("Family execution harnessPolicy access contracts do not match the pinned harness configuration");
  }
}

function requireHarnessExecutionPolicy(value: unknown): HarnessExecutionPolicy {
  const policy = readHarnessExecutionPolicy(value);
  if (policy === undefined) throw new Error("Family execution requires a harnessPolicy");
  return policy;
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

function isVersionedIdentifier(value: unknown): value is string {
  return isStableId(value) && /^[^@\s]+@[1-9][0-9]*$/u.test(value);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isRecord(value)
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

function isNativeExecutionHandle(value: Promise<void> | NativeExecutionHandle): value is NativeExecutionHandle {
  return typeof value === "object" && value !== null && "settled" in value;
}

function readTraceContext(value: unknown): HarnessCompletionTraceContext | undefined {
  if (!isRecord(value) || value.traceContext === undefined) return undefined;
  if (!isRecord(value.traceContext)) throw new Error("Harness completion contains an invalid trace context");
  const { productInteractionId, personalPresentationVersionId, personalPresentationVersionKey, requireNativeContinuity, nativeHistoryAnchor, threadIconSelection } = value.traceContext;
  if (threadIconSelection !== undefined && (!isRecord(threadIconSelection) || threadIconSelection.eligible !== true || Object.keys(threadIconSelection).length !== 1)) throw new Error("Invalid thread icon selection eligibility");
  if (nativeHistoryAnchor != null && (!isRecord(nativeHistoryAnchor) || !Number.isSafeInteger(nativeHistoryAnchor.interactionNodeId) || Number(nativeHistoryAnchor.interactionNodeId) < 1 || typeof nativeHistoryAnchor.message !== "string")) throw new Error("Invalid native history anchor");
  if (requireNativeContinuity !== undefined && typeof requireNativeContinuity !== "boolean") throw new Error("Invalid native continuity requirement");
  if (typeof productInteractionId !== "number" || !Number.isSafeInteger(productInteractionId) || productInteractionId < 1) {
    throw new Error("Harness completion trace context requires a positive product interaction id");
  }
  if (personalPresentationVersionId !== undefined
    && (typeof personalPresentationVersionId !== "number"
      || !Number.isSafeInteger(personalPresentationVersionId)
      || personalPresentationVersionId < 1)) {
    throw new Error("Harness completion trace context personal presentation version must be a positive integer");
  }
  if (personalPresentationVersionKey !== undefined
    && (personalPresentationVersionId === undefined
      || typeof personalPresentationVersionKey !== "string"
      || !/^personal-presentation-v[0-4]$/.test(personalPresentationVersionKey))) {
    throw new Error("Harness completion trace context presentation key requires its pinned version id and a supported key");
  }
  return {
    productInteractionId,
    ...(requireNativeContinuity === undefined ? {} : { requireNativeContinuity }),
    ...(threadIconSelection === undefined ? {} : { threadIconSelection: { eligible: true as const } }),
    ...(nativeHistoryAnchor == null ? {} : { nativeHistoryAnchor: nativeHistoryAnchor as { interactionNodeId: number; message: string } }),
    ...(personalPresentationVersionId === undefined ? {} : { personalPresentationVersionId }),
    ...(personalPresentationVersionKey === undefined ? {} : { personalPresentationVersionKey }),
  };
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

function validateCompletionOrigin(
  origin: unknown,
): asserts origin is Extract<CompletionOrigin, { readonly kind: "invoke" }> {
  if (!isRecord(origin)
    || origin.kind !== "invoke"
    || Object.keys(origin).sort().join(",") !== "actionId,kind,sourceCompletionId"
    || !Number.isSafeInteger(origin.sourceCompletionId) || (origin.sourceCompletionId as number) < 1
    || !Number.isSafeInteger(origin.actionId) || (origin.actionId as number) < 1) {
    throw new Error("Harness invoked completion contains invalid trusted origin provenance");
  }
}

function graphInvocationDigest(
  capability: GraphCapability,
  origin: Extract<CompletionOrigin, { readonly kind: "invoke" }>,
  traceContext: HarnessCompletionTraceContext | undefined,
  model: InteractionModelSelection | undefined,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      completionId: capability.nodeId,
      origin: {
        kind: origin.kind,
        sourceCompletionId: origin.sourceCompletionId,
        actionId: origin.actionId,
      },
      productInteractionId: traceContext?.productInteractionId,
      model: model === undefined ? undefined : {
        providerId: model.providerId,
        adapterId: model.adapterId,
        modelId: model.modelId,
      },
    }))
    .digest("hex");
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
