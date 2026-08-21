export const HARNESS_APPROVAL_PROTOCOL_VERSION = 1 as const;

export const HARNESS_APPROVAL_DECISIONS = Object.freeze(["approve_once", "approve_always", "deny"] as const);
export type HarnessApprovalDecisionKind = typeof HARNESS_APPROVAL_DECISIONS[number];

export const HARNESS_APPROVAL_ACTION_KINDS = Object.freeze(["command", "file_change", "network", "other"] as const);
export type HarnessApprovalActionKind = typeof HARNESS_APPROVAL_ACTION_KINDS[number];

export const MAX_HARNESS_APPROVAL_ID_LENGTH = 1_024;
export const MAX_HARNESS_APPROVAL_TEXT_LENGTH = 65_536;
export const MAX_HARNESS_APPROVAL_SCOPE_KEYS = 256;
export const MAX_HARNESS_APPROVAL_SCOPE_KEY_LENGTH = 4_096;
export const MAX_HARNESS_APPROVAL_AFFECTED_FILES = 4_096;

/**
 * The approval choices are a stable product contract, not provider capabilities.
 * An adapter that cannot implement every choice must fail during setup rather
 * than remove a choice from the desktop at request time.
 */
export interface HarnessApprovalCapabilities {
  readonly protocolVersion: typeof HARNESS_APPROVAL_PROTOCOL_VERSION;
  readonly decisions: typeof HARNESS_APPROVAL_DECISIONS;
}

export const HARNESS_APPROVAL_CAPABILITIES: HarnessApprovalCapabilities = Object.freeze({
  protocolVersion: HARNESS_APPROVAL_PROTOCOL_VERSION,
  decisions: HARNESS_APPROVAL_DECISIONS,
});

export interface HarnessApprovalCorrelation {
  readonly threadId: number;
  readonly interactionId: number;
  readonly completeCallId: string;
  readonly harnessSessionId: string;
  /** Opaque adapter routing data. Product storage and renderer responses must omit it. */
  readonly providerItemId: string;
}

export interface HarnessApprovalCommandAction {
  readonly kind: "command";
  readonly command: string;
  readonly workingDirectory: string;
}

export interface HarnessApprovalFileChangeAction {
  readonly kind: "file_change";
  readonly action: string;
  readonly workingDirectory: string;
  readonly affectedFiles: readonly string[];
}

export interface HarnessApprovalNetworkAction {
  readonly kind: "network";
  readonly action: string;
  readonly networkDestination: string;
  readonly workingDirectory?: string;
}

export interface HarnessApprovalOtherAction {
  readonly kind: "other";
  readonly action: string;
  readonly workingDirectory?: string;
}

export type HarnessApprovalAction =
  | HarnessApprovalCommandAction
  | HarnessApprovalFileChangeAction
  | HarnessApprovalNetworkAction
  | HarnessApprovalOtherAction;

export interface HarnessApprovalRequest {
  readonly requestId: string;
  readonly correlation: HarnessApprovalCorrelation;
  readonly title: string;
  readonly reason: string;
  readonly action: HarnessApprovalAction;
  /**
   * Stable, adapter-normalized, namespaced keys. Matching is case-sensitive and
   * exact; the product never interprets provider-native key structure.
   */
  readonly scopeKeys: readonly string[];
  readonly scopeDescription: string;
  readonly createdAt: string;
  /** Provider-owned expiry metadata. Relayer must not synthesize an expiry. */
  readonly expiresAt?: string;
}

/** Adapter-supplied normalized data, before the host stamps request authority. */
export interface HarnessApprovalRequestInput {
  readonly providerItemId: string;
  readonly title: string;
  readonly reason: string;
  readonly action: HarnessApprovalAction;
  readonly scopeKeys: readonly string[];
  readonly scopeDescription: string;
  readonly expiresAt?: string;
}

/** Host-owned request identity and correlation. Adapters must not supply it. */
export interface HarnessApprovalRequestAuthority {
  readonly requestId: string;
  readonly threadId: number;
  readonly interactionId: number;
  readonly completeCallId: string;
  readonly harnessSessionId: string;
  readonly createdAt: string;
}

export type HarnessApprovalDecisionActor = "user" | "session_grant";

export interface HarnessApprovalDecision {
  readonly requestId: string;
  readonly decision: HarnessApprovalDecisionKind;
  readonly actor: HarnessApprovalDecisionActor;
  readonly decidedAt: string;
  readonly rationale?: string;
  /** Required provenance when actor is session_grant; forbidden for user decisions. */
  readonly sourceRequestId?: string;
}

/** Renderer/API input. The host supplies actor, time, and grant provenance. */
export interface HarnessApprovalDecisionSubmission {
  readonly requestId: string;
  readonly decision: HarnessApprovalDecisionKind;
  readonly rationale?: string;
}

export type HarnessApprovalDecisionAuthority =
  | { readonly actor: "user"; readonly decidedAt: string }
  | { readonly actor: "session_grant"; readonly decidedAt: string; readonly sourceRequestId: string };

/** A non-persisted grant created only by an approve_always user decision. */
export interface HarnessApprovalSessionGrant {
  readonly sourceRequestId: string;
  readonly threadId: number;
  readonly harnessSessionId: string;
  readonly scopeKeys: readonly string[];
}

export function parseHarnessApprovalCapabilities(value: unknown): HarnessApprovalCapabilities {
  const record = approvalRecord(value, "Harness approval capabilities");
  exactKeys(record, ["protocolVersion", "decisions"], "Harness approval capabilities");
  if (record.protocolVersion !== HARNESS_APPROVAL_PROTOCOL_VERSION) {
    throw new Error(`Unsupported harness approval protocol version: ${String(record.protocolVersion)}`);
  }
  const decisions = record.decisions;
  if (!Array.isArray(decisions)
    || decisions.length !== HARNESS_APPROVAL_DECISIONS.length
    || new Set(decisions).size !== HARNESS_APPROVAL_DECISIONS.length
    || HARNESS_APPROVAL_DECISIONS.some((decision) => !decisions.includes(decision))) {
    throw new Error("Harness approval capabilities must support approve_once, approve_always, and deny");
  }
  return HARNESS_APPROVAL_CAPABILITIES;
}

export function parseHarnessApprovalRequestInput(value: unknown): HarnessApprovalRequestInput {
  const record = approvalRecord(value, "Harness approval request input");
  exactKeys(record, [
    "providerItemId",
    "title",
    "reason",
    "action",
    "scopeKeys",
    "scopeDescription",
    "expiresAt",
  ], "Harness approval request input", ["expiresAt"]);
  const expiresAt = record.expiresAt === undefined
    ? undefined
    : approvalTimestamp(record.expiresAt, "approval request expiresAt");
  return {
    providerItemId: approvalId(record.providerItemId, "approval request providerItemId"),
    title: approvalText(record.title, "approval request title"),
    reason: approvalText(record.reason, "approval request reason"),
    action: parseAction(record.action),
    scopeKeys: parseScopeKeys(record.scopeKeys),
    scopeDescription: approvalText(record.scopeDescription, "approval request scopeDescription"),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export function createHarnessApprovalRequest(
  input: HarnessApprovalRequestInput,
  authority: HarnessApprovalRequestAuthority,
): HarnessApprovalRequest {
  const normalizedInput = parseHarnessApprovalRequestInput(input);
  return parseHarnessApprovalRequest({
    requestId: authority.requestId,
    correlation: {
      threadId: authority.threadId,
      interactionId: authority.interactionId,
      completeCallId: authority.completeCallId,
      harnessSessionId: authority.harnessSessionId,
      providerItemId: normalizedInput.providerItemId,
    },
    title: normalizedInput.title,
    reason: normalizedInput.reason,
    action: normalizedInput.action,
    scopeKeys: normalizedInput.scopeKeys,
    scopeDescription: normalizedInput.scopeDescription,
    createdAt: authority.createdAt,
    ...(normalizedInput.expiresAt === undefined ? {} : { expiresAt: normalizedInput.expiresAt }),
  });
}

export function parseHarnessApprovalRequest(value: unknown): HarnessApprovalRequest {
  const record = approvalRecord(value, "Harness approval request");
  exactKeys(record, [
    "requestId",
    "correlation",
    "title",
    "reason",
    "action",
    "scopeKeys",
    "scopeDescription",
    "createdAt",
    "expiresAt",
  ], "Harness approval request", ["expiresAt"]);

  const createdAt = approvalTimestamp(record.createdAt, "approval request createdAt");
  const expiresAt = record.expiresAt === undefined
    ? undefined
    : approvalTimestamp(record.expiresAt, "approval request expiresAt");
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new Error("Harness approval request expiresAt must be later than createdAt");
  }

  return {
    requestId: approvalId(record.requestId, "approval request requestId"),
    correlation: parseCorrelation(record.correlation),
    title: approvalText(record.title, "approval request title"),
    reason: approvalText(record.reason, "approval request reason"),
    action: parseAction(record.action),
    scopeKeys: parseScopeKeys(record.scopeKeys),
    scopeDescription: approvalText(record.scopeDescription, "approval request scopeDescription"),
    createdAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export function parseHarnessApprovalDecision(value: unknown): HarnessApprovalDecision {
  const record = approvalRecord(value, "Harness approval decision");
  exactKeys(record, ["requestId", "decision", "actor", "decidedAt", "rationale", "sourceRequestId"], "Harness approval decision", ["rationale", "sourceRequestId"]);
  if (!isOneOf(record.decision, HARNESS_APPROVAL_DECISIONS)) {
    throw new Error(`Unsupported harness approval decision: ${String(record.decision)}`);
  }
  if (record.actor !== "user" && record.actor !== "session_grant") {
    throw new Error(`Unsupported harness approval decision actor: ${String(record.actor)}`);
  }
  if (record.actor === "session_grant" && record.sourceRequestId === undefined) {
    throw new Error("Harness session-grant approval decision requires sourceRequestId");
  }
  if (record.actor === "user" && record.sourceRequestId !== undefined) {
    throw new Error("Harness user approval decision must not contain sourceRequestId");
  }
  return {
    requestId: approvalId(record.requestId, "approval decision requestId"),
    decision: record.decision,
    actor: record.actor,
    decidedAt: approvalTimestamp(record.decidedAt, "approval decision decidedAt"),
    ...(record.rationale === undefined
      ? {}
      : { rationale: approvalText(record.rationale, "approval decision rationale") }),
    ...(record.sourceRequestId === undefined
      ? {}
      : { sourceRequestId: approvalId(record.sourceRequestId, "approval decision sourceRequestId") }),
  };
}

export function parseHarnessApprovalDecisionSubmission(value: unknown): HarnessApprovalDecisionSubmission {
  const record = approvalRecord(value, "Harness approval decision submission");
  exactKeys(record, ["requestId", "decision", "rationale"], "Harness approval decision submission", ["rationale"]);
  if (!isOneOf(record.decision, HARNESS_APPROVAL_DECISIONS)) {
    throw new Error(`Unsupported harness approval decision: ${String(record.decision)}`);
  }
  return {
    requestId: approvalId(record.requestId, "approval decision requestId"),
    decision: record.decision,
    ...(record.rationale === undefined
      ? {}
      : { rationale: approvalText(record.rationale, "approval decision rationale") }),
  };
}

export function createHarnessApprovalDecision(
  submission: HarnessApprovalDecisionSubmission,
  authority: HarnessApprovalDecisionAuthority,
): HarnessApprovalDecision {
  const normalized = parseHarnessApprovalDecisionSubmission(submission);
  return parseHarnessApprovalDecision({
    ...normalized,
    actor: authority.actor,
    decidedAt: authority.decidedAt,
    ...(authority.actor === "session_grant" ? { sourceRequestId: authority.sourceRequestId } : {}),
  });
}

export function createHarnessApprovalSessionGrant(request: HarnessApprovalRequest): HarnessApprovalSessionGrant {
  const validated = parseHarnessApprovalRequest(request);
  return Object.freeze({
    sourceRequestId: validated.requestId,
    threadId: validated.correlation.threadId,
    harnessSessionId: validated.correlation.harnessSessionId,
    scopeKeys: validated.scopeKeys,
  });
}

/**
 * A request consumes a session grant only when it belongs to the same thread
 * and live harness session and every required key is an exact member of the
 * grant. A grant may cover a later request that requires a subset of its keys.
 */
export function requestMatchesHarnessApprovalSessionGrant(
  request: HarnessApprovalRequest,
  grant: HarnessApprovalSessionGrant,
): boolean {
  try {
    const validatedRequest = parseHarnessApprovalRequest(request);
    const grantKeys = parseScopeKeys(grant.scopeKeys);
    if (!positiveInteger(grant.threadId)
      || approvalId(grant.sourceRequestId, "approval grant sourceRequestId") !== grant.sourceRequestId
      || approvalId(grant.harnessSessionId, "approval grant harnessSessionId") !== grant.harnessSessionId) return false;
    if (validatedRequest.correlation.threadId !== grant.threadId
      || validatedRequest.correlation.harnessSessionId !== grant.harnessSessionId) return false;
    const available = new Set(grantKeys);
    return validatedRequest.scopeKeys.every((scopeKey) => available.has(scopeKey));
  } catch {
    return false;
  }
}

function parseCorrelation(value: unknown): HarnessApprovalCorrelation {
  const record = approvalRecord(value, "Harness approval correlation");
  exactKeys(record, ["threadId", "interactionId", "completeCallId", "harnessSessionId", "providerItemId"], "Harness approval correlation");
  if (!positiveInteger(record.threadId)) throw new Error("Harness approval correlation threadId must be a positive integer");
  if (!positiveInteger(record.interactionId)) throw new Error("Harness approval correlation interactionId must be a positive integer");
  return {
    threadId: record.threadId,
    interactionId: record.interactionId,
    completeCallId: approvalId(record.completeCallId, "approval correlation completeCallId"),
    harnessSessionId: approvalId(record.harnessSessionId, "approval correlation harnessSessionId"),
    providerItemId: approvalId(record.providerItemId, "approval correlation providerItemId"),
  };
}

function parseAction(value: unknown): HarnessApprovalAction {
  const record = approvalRecord(value, "Harness approval action");
  if (!isOneOf(record.kind, HARNESS_APPROVAL_ACTION_KINDS)) {
    throw new Error(`Unsupported harness approval action kind: ${String(record.kind)}`);
  }
  switch (record.kind) {
    case "command":
      exactKeys(record, ["kind", "command", "workingDirectory"], "Harness command approval action");
      return {
        kind: record.kind,
        command: approvalText(record.command, "command approval action command"),
        workingDirectory: approvalText(record.workingDirectory, "command approval action workingDirectory"),
      };
    case "file_change":
      exactKeys(record, ["kind", "action", "workingDirectory", "affectedFiles"], "Harness file-change approval action");
      if (!Array.isArray(record.affectedFiles) || record.affectedFiles.length === 0
        || record.affectedFiles.length > MAX_HARNESS_APPROVAL_AFFECTED_FILES) {
        throw new Error("Harness file-change approval action affectedFiles must be a non-empty array");
      }
      return {
        kind: record.kind,
        action: approvalText(record.action, "file-change approval action action"),
        workingDirectory: approvalText(record.workingDirectory, "file-change approval action workingDirectory"),
        affectedFiles: Object.freeze(record.affectedFiles.map((file) => approvalText(file, "file-change approval action affectedFiles entry"))),
      };
    case "network": {
      exactKeys(record, ["kind", "action", "networkDestination", "workingDirectory"], "Harness network approval action", ["workingDirectory"]);
      const workingDirectory = record.workingDirectory === undefined
        ? undefined
        : approvalText(record.workingDirectory, "network approval action workingDirectory");
      return {
        kind: record.kind,
        action: approvalText(record.action, "network approval action action"),
        networkDestination: approvalText(record.networkDestination, "network approval action networkDestination"),
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      };
    }
    case "other": {
      exactKeys(record, ["kind", "action", "workingDirectory"], "Harness other approval action", ["workingDirectory"]);
      const workingDirectory = record.workingDirectory === undefined
        ? undefined
        : approvalText(record.workingDirectory, "other approval action workingDirectory");
      return {
        kind: record.kind,
        action: approvalText(record.action, "other approval action action"),
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      };
    }
  }
}

function parseScopeKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HARNESS_APPROVAL_SCOPE_KEYS) {
    throw new Error("Harness approval scopeKeys must be a non-empty array");
  }
  const keys = value.map((entry) => approvalString(entry, "approval scopeKeys entry", MAX_HARNESS_APPROVAL_SCOPE_KEY_LENGTH, true));
  if (new Set(keys).size !== keys.length) throw new Error("Harness approval scopeKeys must not contain duplicates");
  return Object.freeze(keys.sort());
}

function approvalTimestamp(value: unknown, label: string): string {
  const timestamp = approvalString(value, label, 64, true);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)
    || Number.isNaN(Date.parse(timestamp))) throw new Error(`Harness ${label} must be an RFC 3339 UTC timestamp`);
  return timestamp;
}

function approvalId(value: unknown, label: string): string {
  return approvalString(value, label, MAX_HARNESS_APPROVAL_ID_LENGTH, true);
}

function approvalText(value: unknown, label: string): string {
  return approvalString(value, label, MAX_HARNESS_APPROVAL_TEXT_LENGTH);
}

function approvalString(value: unknown, label: string, maxLength: number, requireNormalized = false): string {
  if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Harness ${label} must be a non-empty string without control characters`);
  }
  if (value.length > maxLength) throw new Error(`Harness ${label} exceeds the maximum length of ${maxLength}`);
  if (requireNormalized && value !== value.trim()) throw new Error(`Harness ${label} must not have surrounding whitespace`);
  return value;
}

function approvalRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string, optional: readonly string[] = []): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
  const optionalSet = new Set(optional);
  const missing = allowed.filter((key) => !optionalSet.has(key) && !(key in record));
  if (missing.length > 0) throw new Error(`${label} is missing required fields: ${missing.join(", ")}`);
}

function isOneOf<const Values extends readonly string[]>(value: unknown, values: Values): value is Values[number] {
  return typeof value === "string" && values.includes(value as Values[number]);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
