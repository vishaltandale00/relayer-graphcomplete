import type { CompletionOutput, GraphCapability, GraphId, GraphNode, InteractionInput } from "@relayer/graph-client";
import type { HarnessApprovalChannel } from "./approval-coordinator.js";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export interface HarnessModelCompatibility {
  readonly providerId: string;
  /** Omitted means every model reported by this provider. */
  readonly modelIds?: readonly string[];
  readonly preferredModelId?: string;
}

export interface HarnessModelRule {
  readonly adapterId: string;
  readonly modelIdExact?: string;
  readonly modelIdRegex?: string;
}

export interface HarnessModelRules {
  readonly allow: readonly HarnessModelRule[];
  readonly deny: readonly HarnessModelRule[];
}

export interface HarnessFamilyPolicyReference {
  readonly id: string;
  readonly version: number;
}

export interface HarnessModelDefaults {
  readonly familyPolicy: HarnessFamilyPolicyReference;
}

export interface HarnessConfiguration {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly implementation: string;
  readonly implementationVersion: number;
  readonly revision?: number;
  readonly permissionBindings: Readonly<Record<string, JsonObject>>;
  /** Legacy provider-definition compatibility retained while stored configurations migrate. */
  readonly modelCompatibility?: readonly HarnessModelCompatibility[];
  readonly modelRules?: HarnessModelRules;
  readonly executionAccessContracts?: readonly string[];
  readonly modelDefaults?: HarnessModelDefaults;
  readonly settings: JsonObject;
}

export type HarnessSessionState = JsonObject;

export type TraceCoverage = "none" | "summary" | "full";
export type HarnessTraceMode = "off" | "best-effort" | "required";
export type HarnessTraceStatus = "complete" | "partial" | "failed" | "disabled";

export interface HarnessTraceSupport {
  readonly prompt: TraceCoverage;
  readonly messages: TraceCoverage;
  readonly reasoningSummaries: TraceCoverage;
  readonly modelCalls: TraceCoverage;
  readonly toolCalls: TraceCoverage;
  readonly usage: TraceCoverage;
  readonly childStreams: TraceCoverage;
  readonly nativeArtifacts: TraceCoverage;
}

export interface HarnessTracePolicy {
  readonly mode: HarnessTraceMode;
  readonly requiredFeatures: Partial<Record<keyof HarnessTraceSupport, TraceCoverage>>;
  readonly includeNativeArtifacts: boolean;
  readonly maxBytesPerTurn: number;
  readonly maxEventsPerTurn: number;
}

export type HarnessTraceStreamKind = "agent" | "worker" | "provider" | "custom";
export type HarnessTraceSpanKind = "agent" | "model" | "tool" | "retrieval" | "evaluation" | "custom";
export type HarnessTraceTerminalStatus = "completed" | "failed" | "cancelled" | "partial";
export type CoreTraceEventType =
  | "run.started"
  | "run.completed"
  | "stream.started"
  | "stream.completed"
  | "span.started"
  | "span.completed"
  | "prompt"
  | "message"
  | "reasoning.summary"
  | "model.call.started"
  | "model.call.completed"
  | "tool.call.started"
  | "tool.call.completed"
  | "usage"
  | "warning"
  | "error"
  | "cancelled"
  | "truncated";

export interface HarnessTraceEventInput {
  readonly type: CoreTraceEventType | "provider.event";
  readonly data: JsonObject;
  readonly occurredAt?: string;
  readonly providerEventId?: string;
  readonly streamId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
}

export interface HarnessTraceEvent extends HarnessTraceEventInput {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly observedAt: string;
  readonly streamId: string;
  readonly implementation: string;
}

export interface HarnessTraceSpan {
  readonly id: string;
  emit(event: Omit<HarnessTraceEventInput, "streamId" | "spanId">): void | Promise<void>;
  end(status: HarnessTraceTerminalStatus, data?: JsonObject): void | Promise<void>;
}

export interface HarnessTraceStream {
  readonly id: string;
  emit(event: Omit<HarnessTraceEventInput, "streamId">): void | Promise<void>;
  openSpan(input: {
    readonly name: string;
    readonly kind: HarnessTraceSpanKind;
    readonly parentSpanId?: string;
    readonly providerSpanId?: string;
  }): HarnessTraceSpan;
  close(status: HarnessTraceTerminalStatus, data?: JsonObject): void | Promise<void>;
}

export interface HarnessTraceAttachmentInput {
  readonly name: string;
  readonly mediaType: string;
  readonly content: string | Uint8Array;
  readonly sensitivity: "normal" | "sensitive";
  readonly native?: boolean;
  readonly sanitized?: boolean;
}

export interface TraceAttachmentRef {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

export interface HarnessTraceSink {
  readonly policy: HarnessTracePolicy;
  readonly rootStreamId: string;
  emit(event: Omit<HarnessTraceEventInput, "streamId">): void | Promise<void>;
  openStream(input: {
    readonly name: string;
    readonly kind: HarnessTraceStreamKind;
    readonly parentStreamId?: string;
    readonly providerStreamId?: string;
  }): HarnessTraceStream;
  openSpan(input: {
    readonly name: string;
    readonly kind: HarnessTraceSpanKind;
    readonly parentSpanId?: string;
    readonly providerSpanId?: string;
  }): HarnessTraceSpan;
  attach(input: HarnessTraceAttachmentInput): Promise<TraceAttachmentRef>;
}

export interface HarnessCompletionTraceContext {
  readonly productInteractionId: number;
}

export interface HarnessTraceDescriptor {
  readonly status: HarnessTraceStatus;
  readonly format: "relayer-harness-trace-v1";
  readonly traceId?: string;
  readonly ref?: string;
  readonly sha256?: string;
  readonly byteLength?: number;
  readonly eventCount?: number;
  readonly coverage: HarnessTraceSupport;
  readonly truncated?: boolean;
  readonly redactionCount?: number;
  readonly error?: string;
}

export interface HarnessGraphScope {
  readonly interactionNodeId: GraphId;
  acquireCapability(): GraphCapability;
}

export interface HarnessRunContext {
  readonly inputGraph: GraphNode;
  /** Normalized model-visible input resolved from inputGraph; excludes context occurrence authority. */
  readonly interactionInput: InteractionInput;
  readonly graph: HarnessGraphScope;
  readonly approvals: HarnessApprovalChannel;
  /** Immutable admitted family plan. Its orchestrator is also exposed through model. */
  readonly modelPlan?: HarnessAdmittedModelPlan;
  readonly model?: InteractionModelSelection;
  /** Complete execution-scoped provider access. The orchestrator entry is also exposed through access. */
  readonly accessBundle?: HarnessExecutionAccessBundle;
  /** Execution-scoped and never persisted in harness session state or receipts. */
  readonly access?: HarnessExecutionAccess;
  readonly trace: HarnessTraceSink;
}

/**
 * Execution-scoped access to a Relayer-managed harness runtime. The runtime is
 * capability-owned and shared across compatible provider definitions; only the
 * provider-specific environment is attached to an execution lease.
 */
export interface HarnessManagedRuntimeAccess {
  readonly runtimeId: string;
  readonly version: string;
  readonly executable: string;
  readonly moduleUrl?: string;
  readonly environment: Readonly<Record<string, string>>;
}

export type HarnessExecutionAccess =
  | {
      readonly kind: "secret";
      readonly contract: "secret@1";
      readonly providerId: string;
      readonly adapterId: string;
      readonly adapterImplementationVersion: string;
      readonly endpoint: string;
      readonly fields: Readonly<Record<string, string>>;
      readonly modelCapabilities?: Readonly<Record<string, Readonly<{
        readonly contextWindow: number;
        readonly maxOutputTokens: number;
      }>>>;
      readonly runtime?: HarnessManagedRuntimeAccess;
    }
  | ({
      readonly kind: "managed-runtime";
      readonly contract: "managed-runtime@1";
      readonly providerId: string;
      readonly adapterId: string;
      readonly adapterImplementationVersion: string;
    } & (
      | HarnessManagedRuntimeAccess
      | {
          readonly runtimeId?: never;
          readonly version?: never;
          readonly executable?: never;
          readonly moduleUrl?: never;
          readonly environment: Readonly<Record<string, string>>;
        }
    ));

export interface HarnessExecutionAccessLease {
  readonly access: HarnessExecutionAccess;
  release(): void | Promise<void>;
}

/** One currently resolvable model-family member. Array order is family order. */
export interface HarnessModelRoute {
  /** Exact user-owned provider definition. */
  readonly providerId: string;
  readonly adapterId: string;
  readonly accessContract: string;
  readonly modelId: string;
}

/** Non-secret product-resolved input to execution admission. */
export interface HarnessModelPlan {
  readonly familyId: number;
  readonly familyRevision: number;
  readonly orchestrator: HarnessModelRoute;
  readonly roster: readonly HarnessModelRoute[];
}

export interface HarnessAdmittedModelRoute extends HarnessModelRoute {
  readonly adapterImplementationVersion: string;
}

/** Immutable plan returned by admission and passed to the selected harness. */
export interface HarnessAdmittedModelPlan {
  readonly familyId: number;
  readonly familyRevision: number;
  readonly orchestrator: HarnessAdmittedModelRoute;
  readonly roster: readonly HarnessAdmittedModelRoute[];
  readonly harnessPolicyDigest: string;
  readonly digest: string;
}

/** Execution-scoped access keyed by exact provider-definition ID. */
export interface HarnessExecutionAccessBundle {
  readonly byProviderId: Readonly<Record<string, HarnessExecutionAccess>>;
}

export interface HarnessExecutionAccessBroker {
  acquire(
    selection: InteractionModelSelection,
    acceptedContracts: readonly string[],
    signal: AbortSignal,
  ): Promise<HarnessExecutionAccessLease>;
}

export interface InteractionModelSelection {
  /** Exact user-owned provider definition. */
  readonly providerId: string;
  /** Stable adapter type used by harness rules, for example `openai-api`. */
  readonly adapterId?: string;
  readonly modelId: string;
}

export interface Harness {
  traceSupport?(): HarnessTraceSupport;
  complete(context: HarnessRunContext, signal?: AbortSignal): Promise<void>;
  state(): HarnessSessionState;
  dispose?(): void | Promise<void>;
  /** Immediately interrupt provider work so the host-owned dispose operation can finish. */
  forceShutdown?(): void;
}

export interface HarnessFactoryContext {
  readonly threadId: number;
  readonly workingDirectory: string;
  readonly configuration: HarnessConfiguration;
  readonly permissionProfileId: string;
  readonly permissionBinding: JsonObject;
  readonly savedState?: HarnessSessionState;
}

export type HarnessFactory = (context: HarnessFactoryContext) => Harness | Promise<Harness>;
export type HarnessImplementationMap = Readonly<Record<string, HarnessFactory>>;

export interface HarnessSessionDescriptor {
  readonly threadId: number;
  readonly configuration: HarnessConfiguration;
  readonly permissionProfileId: string;
  readonly workingDirectory: string;
  readonly state?: HarnessSessionState;
}

export type HarnessSessionRegistration = Omit<HarnessSessionDescriptor, "state">;

export interface HarnessCompleteResult {
  readonly threadId: number;
  readonly configurationName: string;
  readonly output: CompletionOutput;
  readonly trace: HarnessTraceDescriptor;
}
