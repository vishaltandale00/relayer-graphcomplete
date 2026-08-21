import { randomUUID } from "node:crypto";
import {
  MAX_HARNESS_APPROVAL_TEXT_LENGTH,
  createHarnessApprovalDecision,
  createHarnessApprovalRequest,
  createHarnessApprovalSessionGrant,
  parseHarnessApprovalDecisionSubmission,
  requestMatchesHarnessApprovalSessionGrant,
  type HarnessApprovalAction,
  type HarnessApprovalDecision,
  type HarnessApprovalDecisionKind,
  type HarnessApprovalRequest,
  type HarnessApprovalRequestInput,
  type HarnessApprovalSessionGrant,
} from "./approval.js";

export type HarnessApprovalTerminalOutcome = "approved" | "denied" | "cancelled" | "expired" | "aborted";
export type HarnessApprovalResolutionActor = "user" | "session_grant" | "harness" | "host";
export type HarnessApprovalRequestTerminationOutcome = "expired" | "aborted";

export const MAX_HARNESS_APPROVAL_RETAINED_EVENTS = 1_024;
export const MAX_HARNESS_APPROVAL_TERMINAL_TOMBSTONES = 256;
export const MAX_HARNESS_APPROVAL_SESSION_GRANTS = 128;

export interface PublicHarnessApprovalCorrelation {
  readonly threadId: number;
  readonly interactionId: number;
  readonly completeCallId: string;
  readonly harnessSessionId: string;
}

export interface PublicHarnessApprovalRequest {
  readonly requestId: string;
  readonly correlation: PublicHarnessApprovalCorrelation;
  readonly title: string;
  readonly reason: string;
  readonly action: HarnessApprovalAction;
  readonly scopeKeys: readonly string[];
  readonly scopeDescription: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface HarnessApprovalResolution {
  readonly requestId: string;
  readonly correlation: PublicHarnessApprovalCorrelation;
  readonly outcome: HarnessApprovalTerminalOutcome;
  readonly actor: HarnessApprovalResolutionActor;
  readonly resolvedAt: string;
  readonly decision?: HarnessApprovalDecisionKind;
  readonly rationale?: string;
  readonly sourceRequestId?: string;
}

export interface HarnessApprovalRequestedEvent {
  readonly sequence: number;
  readonly type: "requested";
  readonly request: PublicHarnessApprovalRequest;
}

export interface HarnessApprovalResolvedEvent {
  readonly sequence: number;
  readonly type: "resolved";
  readonly resolution: HarnessApprovalResolution;
}

export type HarnessApprovalEvent = HarnessApprovalRequestedEvent | HarnessApprovalResolvedEvent;

export interface HarnessApprovalSnapshot {
  readonly harnessSessionId: string;
  readonly latestSequence: number;
  readonly pendingRequests: readonly PublicHarnessApprovalRequest[];
  readonly events: readonly HarnessApprovalEvent[];
}

export interface HarnessApprovalRequestOptions {
  /** A provider-owned signal. Relayer does not derive a timer from expiresAt. */
  readonly signal?: AbortSignal;
  readonly terminationOutcome?: HarnessApprovalRequestTerminationOutcome;
  readonly terminationRationale?: string;
}

export interface HarnessApprovalChannel {
  request(input: HarnessApprovalRequestInput, options?: HarnessApprovalRequestOptions): Promise<HarnessApprovalDecision>;
}

export interface HarnessApprovalCompletionAuthority {
  readonly interactionId: number;
  readonly completeCallId: string;
}

export interface HarnessApprovalCoordinatorOptions {
  readonly threadId: number;
  readonly harnessSessionId?: string;
  readonly now?: () => string;
  readonly requestId?: () => string;
}

export class HarnessApprovalCoordinatorError extends Error {
  constructor(
    readonly code: "invalid_approval_request" | "approval_request_not_found" | "approval_request_resolved" | "approval_completion_inactive" | "approval_event_backlog_full",
    message: string,
  ) {
    super(message);
    this.name = "HarnessApprovalCoordinatorError";
  }
}

export class HarnessApprovalRequestTerminatedError extends Error {
  constructor(readonly resolution: HarnessApprovalResolution) {
    super(`Harness approval request ${resolution.requestId} ${resolution.outcome}`);
    this.name = "HarnessApprovalRequestTerminatedError";
  }
}

interface PendingApproval {
  readonly request: HarnessApprovalRequest;
  readonly resolve: (decision: HarnessApprovalDecision) => void;
  readonly reject: (error: HarnessApprovalRequestTerminatedError) => void;
  readonly detachProviderSignal: () => void;
}

/**
 * Live-session-only approval state. It is deliberately neither serializable nor
 * included in the harness host state file.
 */
export class HarnessApprovalCoordinator {
  readonly harnessSessionId: string;
  private readonly now: () => string;
  private readonly nextRequestId: () => string;
  private readonly activeCompletions = new Map<string, number>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly terminal = new Map<string, HarnessApprovalResolution>();
  private readonly grants: HarnessApprovalSessionGrant[] = [];
  private readonly retainedEvents: HarnessApprovalEvent[] = [];
  private nextSequence = 1;
  private closed = false;

  constructor(private readonly options: HarnessApprovalCoordinatorOptions) {
    if (!Number.isSafeInteger(options.threadId) || options.threadId < 1) {
      throw new Error("Harness approval coordinator threadId must be a positive integer");
    }
    this.harnessSessionId = options.harnessSessionId ?? randomUUID();
    if (this.harnessSessionId.trim() === "") throw new Error("Harness approval coordinator session ID must be non-empty");
    this.now = options.now ?? (() => new Date().toISOString());
    this.nextRequestId = options.requestId ?? randomUUID;
  }

  beginCompletion(authority: HarnessApprovalCompletionAuthority): HarnessApprovalChannel {
    if (this.closed) throw new HarnessApprovalCoordinatorError("approval_completion_inactive", "Harness approval session is closed");
    if (!Number.isSafeInteger(authority.interactionId) || authority.interactionId < 1 || authority.completeCallId.trim() === "") {
      throw new HarnessApprovalCoordinatorError("invalid_approval_request", "Harness approval completion authority is invalid");
    }
    if (this.activeCompletions.has(authority.completeCallId)) {
      throw new HarnessApprovalCoordinatorError("invalid_approval_request", `Duplicate harness completion ID: ${authority.completeCallId}`);
    }
    this.activeCompletions.set(authority.completeCallId, authority.interactionId);
    return Object.freeze({
      request: async (input: HarnessApprovalRequestInput, options?: HarnessApprovalRequestOptions) => {
        if (this.activeCompletions.get(authority.completeCallId) !== authority.interactionId) {
          throw new HarnessApprovalCoordinatorError("approval_completion_inactive", "Harness approval completion is no longer active");
        }
        return this.request(authority, input, options);
      },
    });
  }

  endCompletion(
    completeCallId: string,
    outcome: Extract<HarnessApprovalTerminalOutcome, "cancelled" | "aborted"> = "aborted",
    rationale = "Harness completion ended before the approval was resolved.",
  ): void {
    if (outcome !== "cancelled" && outcome !== "aborted") {
      this.failClosedCompletion(completeCallId, "Harness completion supplied an invalid terminal approval outcome.");
      throw new HarnessApprovalCoordinatorError(
        "invalid_approval_request",
        `Unsupported harness completion approval outcome: ${String(outcome)}`,
      );
    }
    try {
      approvalRationale(rationale, "completion termination rationale");
    } catch (error) {
      this.failClosedCompletion(completeCallId, "Harness completion supplied an invalid terminal approval rationale.");
      throw new HarnessApprovalCoordinatorError(
        "invalid_approval_request",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!this.activeCompletions.delete(completeCallId)) return;
    this.terminateMatching((request) => request.correlation.completeCallId === completeCallId, outcome, "host", rationale);
  }

  decide(requestId: string, input: unknown): HarnessApprovalResolution {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      if (this.terminal.has(requestId)) {
        throw new HarnessApprovalCoordinatorError("approval_request_resolved", `Harness approval request ${requestId} is already resolved`);
      }
      throw new HarnessApprovalCoordinatorError("approval_request_not_found", `Unknown harness approval request: ${requestId}`);
    }
    let submission: ReturnType<typeof parseHarnessApprovalDecisionSubmission>;
    try {
      if (!isRecord(input)) throw new Error("Harness approval decision body must be an object");
      const unknown = Object.keys(input).filter((key) => key !== "decision" && key !== "rationale");
      if (unknown.length > 0) throw new Error(`Harness approval decision body contains unsupported fields: ${unknown.join(", ")}`);
      submission = parseHarnessApprovalDecisionSubmission({ requestId, ...input });
    } catch (error) {
      throw new HarnessApprovalCoordinatorError(
        "invalid_approval_request",
        error instanceof Error ? error.message : String(error),
      );
    }
    const decision = createHarnessApprovalDecision(submission, { actor: "user", decidedAt: this.now() });
    const resolution = this.resolveWithDecision(pending, decision);
    if (decision.decision === "approve_always") {
      const grant = createHarnessApprovalSessionGrant(pending.request);
      this.grants.push(grant);
      if (this.grants.length > MAX_HARNESS_APPROVAL_SESSION_GRANTS) this.grants.shift();
      for (const candidate of [...this.pending.values()]) {
        if (!requestMatchesHarnessApprovalSessionGrant(candidate.request, grant)) continue;
        this.resolveWithDecision(candidate, createHarnessApprovalDecision({
          requestId: candidate.request.requestId,
          decision: "approve_once",
        }, {
          actor: "session_grant",
          decidedAt: this.now(),
          sourceRequestId: grant.sourceRequestId,
        }));
      }
    }
    return resolution;
  }

  snapshot(after = 0): HarnessApprovalSnapshot {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new HarnessApprovalCoordinatorError("invalid_approval_request", "Approval event cursor must be a non-negative integer");
    }
    const latestSequence = this.nextSequence - 1;
    const snapshot = {
      harnessSessionId: this.harnessSessionId,
      latestSequence,
      pendingRequests: Object.freeze([...this.pending.values()].map(({ request }) => publicRequest(request))),
      events: Object.freeze(this.retainedEvents.filter(({ sequence }) => sequence > after)),
    };
    // Rust cursors are completion-local and restart from zero. Reset only after
    // returning an exact final acknowledgement, never while a completion can race it.
    if (after === latestSequence && this.activeCompletions.size === 0 && this.pending.size === 0) {
      this.retainedEvents.length = 0;
      this.terminal.clear();
      this.nextSequence = 1;
    }
    return snapshot;
  }

  close(rationale = "Harness session ended before the approval was resolved."): void {
    if (this.closed) return;
    this.closed = true;
    this.activeCompletions.clear();
    this.terminateMatching(() => true, "aborted", "host", rationale);
    this.grants.length = 0;
  }

  private request(
    authority: HarnessApprovalCompletionAuthority,
    input: HarnessApprovalRequestInput,
    options?: HarnessApprovalRequestOptions,
  ): Promise<HarnessApprovalDecision> {
    let normalizedOptions: HarnessApprovalRequestOptions | undefined;
    try {
      normalizedOptions = normalizeRequestOptions(options);
    } catch (error) {
      return Promise.reject(new HarnessApprovalCoordinatorError(
        "invalid_approval_request",
        error instanceof Error ? error.message : String(error),
      ));
    }
    let request: HarnessApprovalRequest;
    try {
      request = createHarnessApprovalRequest(input, {
        requestId: this.nextRequestId(),
        threadId: this.options.threadId,
        interactionId: authority.interactionId,
        completeCallId: authority.completeCallId,
        harnessSessionId: this.harnessSessionId,
        createdAt: this.now(),
      });
    } catch (error) {
      return Promise.reject(new HarnessApprovalCoordinatorError(
        "invalid_approval_request",
        error instanceof Error ? error.message : String(error),
      ));
    }
    if (this.pending.has(request.requestId) || this.terminal.has(request.requestId)) {
      return Promise.reject(new HarnessApprovalCoordinatorError("invalid_approval_request", `Duplicate harness approval request ID: ${request.requestId}`));
    }
    // Every pending request has one requested event and reserves one terminal
    // event. Refuse new work rather than drop an unacknowledged event.
    if (this.retainedEvents.length + this.pending.size + 2 > MAX_HARNESS_APPROVAL_RETAINED_EVENTS) {
      return Promise.reject(new HarnessApprovalCoordinatorError(
        "approval_event_backlog_full",
        "Harness approval event backlog is full; wait for product acknowledgement before requesting another approval",
      ));
    }

    let resolveDecision!: (decision: HarnessApprovalDecision) => void;
    let rejectDecision!: (error: HarnessApprovalRequestTerminatedError) => void;
    const decision = new Promise<HarnessApprovalDecision>((resolve, reject) => {
      resolveDecision = resolve;
      rejectDecision = reject;
    });
    const abortProvider = () => {
      const outcome = normalizedOptions?.terminationOutcome ?? "aborted";
      this.terminate(request.requestId, outcome, "harness", normalizedOptions?.terminationRationale ?? providerAbortRationale(normalizedOptions?.signal));
    };
    normalizedOptions?.signal?.addEventListener("abort", abortProvider, { once: true });
    const detachProviderSignal = () => normalizedOptions?.signal?.removeEventListener("abort", abortProvider);
    const pending: PendingApproval = { request, resolve: resolveDecision, reject: rejectDecision, detachProviderSignal };
    this.pending.set(request.requestId, pending);
    this.append({ type: "requested", request: publicRequest(request) });

    // Close the race between the preflight check and listener registration.
    if (normalizedOptions?.signal?.aborted) {
      abortProvider();
      return decision;
    }

    const grant = this.grants.find((candidate) => requestMatchesHarnessApprovalSessionGrant(request, candidate));
    if (grant !== undefined) {
      this.resolveWithDecision(pending, createHarnessApprovalDecision({
        requestId: request.requestId,
        decision: "approve_once",
      }, {
        actor: "session_grant",
        decidedAt: this.now(),
        sourceRequestId: grant.sourceRequestId,
      }));
    }
    return decision;
  }

  private resolveWithDecision(pending: PendingApproval, decision: HarnessApprovalDecision): HarnessApprovalResolution {
    const outcome = decision.decision === "deny" ? "denied" : "approved";
    const resolution: HarnessApprovalResolution = {
      requestId: pending.request.requestId,
      correlation: publicCorrelation(pending.request),
      outcome,
      actor: decision.actor,
      resolvedAt: decision.decidedAt,
      decision: decision.decision,
      ...(decision.rationale === undefined ? {} : { rationale: decision.rationale }),
      ...(decision.sourceRequestId === undefined ? {} : { sourceRequestId: decision.sourceRequestId }),
    };
    this.finish(pending, resolution);
    pending.resolve(decision);
    return resolution;
  }

  private terminate(
    requestId: string,
    outcome: Extract<HarnessApprovalTerminalOutcome, "cancelled" | "expired" | "aborted">,
    actor: Extract<HarnessApprovalResolutionActor, "harness" | "host">,
    rationale: string,
  ): HarnessApprovalResolution | undefined {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return undefined;
    const resolution: HarnessApprovalResolution = {
      requestId,
      correlation: publicCorrelation(pending.request),
      outcome,
      actor,
      resolvedAt: this.now(),
      rationale,
    };
    this.finish(pending, resolution);
    pending.reject(new HarnessApprovalRequestTerminatedError(resolution));
    return resolution;
  }

  private terminateMatching(
    matches: (request: HarnessApprovalRequest) => boolean,
    outcome: Extract<HarnessApprovalTerminalOutcome, "cancelled" | "expired" | "aborted">,
    actor: Extract<HarnessApprovalResolutionActor, "harness" | "host">,
    rationale: string,
  ): void {
    for (const { request } of [...this.pending.values()]) {
      if (matches(request)) this.terminate(request.requestId, outcome, actor, rationale);
    }
  }

  private finish(pending: PendingApproval, resolution: HarnessApprovalResolution): void {
    pending.detachProviderSignal();
    this.pending.delete(pending.request.requestId);
    this.terminal.set(pending.request.requestId, resolution);
    while (this.terminal.size > MAX_HARNESS_APPROVAL_TERMINAL_TOMBSTONES) {
      const oldest = this.terminal.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.terminal.delete(oldest);
    }
    this.append({ type: "resolved", resolution });
  }

  private failClosedCompletion(completeCallId: string, rationale: string): void {
    if (!this.activeCompletions.delete(completeCallId)) return;
    this.terminateMatching(
      (request) => request.correlation.completeCallId === completeCallId,
      "aborted",
      "host",
      rationale,
    );
  }

  private append(event: Omit<HarnessApprovalRequestedEvent, "sequence"> | Omit<HarnessApprovalResolvedEvent, "sequence">): void {
    const sequence = this.nextSequence++;
    this.retainedEvents.push(event.type === "requested"
      ? { sequence, type: event.type, request: event.request }
      : { sequence, type: event.type, resolution: event.resolution });
  }
}

function publicRequest(request: HarnessApprovalRequest): PublicHarnessApprovalRequest {
  return {
    requestId: request.requestId,
    correlation: publicCorrelation(request),
    title: request.title,
    reason: request.reason,
    action: request.action,
    scopeKeys: request.scopeKeys,
    scopeDescription: request.scopeDescription,
    createdAt: request.createdAt,
    ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
  };
}

function publicCorrelation(request: HarnessApprovalRequest): PublicHarnessApprovalCorrelation {
  const { threadId, interactionId, completeCallId, harnessSessionId } = request.correlation;
  return { threadId, interactionId, completeCallId, harnessSessionId };
}

function providerAbortRationale(signal: AbortSignal | undefined): string {
  if (signal?.reason instanceof Error) {
    try {
      return approvalRationale(signal.reason.message, "provider abort rationale");
    } catch {
      // Provider reasons are advisory; malformed values must not corrupt the
      // normalized terminal event.
    }
  }
  return "Provider approval request ended before a user decision.";
}

function normalizeRequestOptions(options: HarnessApprovalRequestOptions | undefined): HarnessApprovalRequestOptions | undefined {
  if (options === undefined) return undefined;
  if (!isRecord(options)) throw new Error("Harness approval request options must be an object");
  const allowed = new Set(["signal", "terminationOutcome", "terminationRationale"]);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Harness approval request options contain unsupported fields: ${unknown.join(", ")}`);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new Error("Harness approval request signal must be an AbortSignal");
  }
  if (options.terminationOutcome !== undefined
    && options.terminationOutcome !== "expired"
    && options.terminationOutcome !== "aborted") {
    throw new Error(`Unsupported harness approval request termination outcome: ${String(options.terminationOutcome)}`);
  }
  const terminationRationale = options.terminationRationale === undefined
    ? undefined
    : approvalRationale(options.terminationRationale, "request termination rationale");
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.terminationOutcome === undefined ? {} : { terminationOutcome: options.terminationOutcome }),
    ...(terminationRationale === undefined ? {} : { terminationRationale }),
  };
}

function approvalRationale(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Harness approval ${label} must be a non-empty string without control characters`);
  }
  if (value.length > MAX_HARNESS_APPROVAL_TEXT_LENGTH) {
    throw new Error(`Harness approval ${label} exceeds the maximum length of ${MAX_HARNESS_APPROVAL_TEXT_LENGTH}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
