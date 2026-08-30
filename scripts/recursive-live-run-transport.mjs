import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Product request authenticated with the loopback session cookie. */
export async function productRequest(session, path, options = {}) {
  const response = await fetch(new URL(path, session.origin), {
    ...options,
    headers: {
      ...options.headers,
      Cookie: `${session.cookie.name}=${session.cookie.value}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${JSON.stringify(value)}`);
  }
  return value;
}

/** Read trusted invocation provenance for every completion observed by the product. */
export async function completionMetadata(runtimeSession, completionIds) {
  return Promise.all([...completionIds].map(async (completionId) => {
    const response = await fetch(new URL(
      `api/control/interactions/${completionId}`,
      `${runtimeSession.graphUrl}/`,
    ), {
      headers: { authorization: `Bearer ${runtimeSession.graphControlToken}` },
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`graph metadata ${completionId} failed (${response.status}): ${JSON.stringify(value)}`);
    }
    return value;
  }));
}

/** Read the graph runtime's effective temporal feature set through control authority. */
export async function temporalFeatures(runtimeSession) {
  const response = await fetch(new URL(
    "api/control/temporal-features",
    `${runtimeSession.graphUrl}/`,
  ), {
    headers: { authorization: `Bearer ${runtimeSession.graphControlToken}` },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`graph temporal features failed (${response.status}): ${JSON.stringify(value)}`);
  }
  return value;
}

const COMPLETION_EXECUTION_EVIDENCE_QUERY = `
SELECT
  ce.interaction_id AS interactionId,
  ce.graph_completion_id AS completionId,
  source.id AS sourceInteractionId,
  source.graph_node_id AS sourceCompletionId,
  invocation.action_id AS sourceActionId,
  ce.phase AS phase,
  ce.attachment_json AS attachmentJson,
  ce.settlement_json AS settlementJson,
  ce.safe_reason AS safeReason,
  child.completion_status AS completionStatus,
  ce.created_at AS createdAt,
  ce.updated_at AS updatedAt
FROM completion_executions ce
JOIN interactions child ON child.id = ce.interaction_id
LEFT JOIN action_invocations invocation
  ON invocation.result_interaction_id = ce.interaction_id
 AND invocation.authoritative = 1
LEFT JOIN interactions source ON source.id = invocation.source_interaction_id
ORDER BY ce.interaction_id;
`;

/**
 * Read the production durability fence without exposing provider-native identities.
 *
 * The raw attachment and settlement never leave this function. The attachment digest is
 * calculated over canonical JSON so an artifact can bind to the durable bytes without
 * publishing native thread or turn identifiers.
 */
export async function completionExecutionEvidence(
  databasePath,
  { sqliteExecutable = "/usr/bin/sqlite3" } = {},
) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      sqliteExecutable,
      ["-readonly", "-json", databasePath, COMPLETION_EXECUTION_EVIDENCE_QUERY],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (error) {
    const code = typeof error?.code === "string" || typeof error?.code === "number"
      ? String(error.code)
      : "unknown";
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim().slice(0, 500) : "";
    throw new Error(
      `Could not read durable completion-execution evidence (sqlite ${code})${stderr ? `: ${stderr}` : "."}`,
    );
  }

  let rows;
  try {
    rows = stdout.trim() === "" ? [] : JSON.parse(stdout);
  } catch {
    throw new Error("SQLite returned invalid completion-execution evidence JSON");
  }
  if (!Array.isArray(rows)) {
    throw new Error("SQLite returned completion-execution evidence in an invalid shape");
  }
  return rows.map(sanitizeCompletionExecution);
}

/** Wait for the requested completion fences to settle, while retaining all observed rows. */
export async function waitForSettledCompletionExecutionEvidence(
  databasePath,
  completionIds,
  {
    sqliteExecutable = "/usr/bin/sqlite3",
    timeoutMs = 5_000,
    pollIntervalMs = 50,
  } = {},
) {
  const requested = [...new Set(completionIds)];
  if (requested.some((completionId) => !isPositiveInteger(completionId))) {
    throw new Error("Completion-execution settlement wait requires positive completion IDs");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > timeoutMs) {
    throw new Error("Completion-execution settlement wait requires bounded positive timing values");
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const evidence = await completionExecutionEvidence(databasePath, { sqliteExecutable });
    const pending = requested.filter((completionId) => !evidence.some((row) => (
      row.completionId === completionId && row.phase === "settled"
    )));
    if (pending.length === 0) return evidence;
    if (Date.now() >= deadline) {
      throw new Error(`Durable completion executions did not settle before timeout: ${pending.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())));
  }
}

function sanitizeCompletionExecution(row) {
  if (!isRecord(row)
    || !isPositiveInteger(row.interactionId)
    || !isPositiveInteger(row.completionId)
    || typeof row.phase !== "string"
    || typeof row.completionStatus !== "string"
    || typeof row.createdAt !== "string"
    || typeof row.updatedAt !== "string") {
    throw new Error("SQLite returned an invalid completion-execution row");
  }
  const attachment = row.attachmentJson === null
    ? { present: false }
    : sanitizeAttachment(row.attachmentJson, row.completionId);
  if (!(row.safeReason === null || typeof row.safeReason === "string")) {
    throw new Error(`SQLite returned an invalid safe reason for completion ${row.completionId}`);
  }
  return {
    interactionId: row.interactionId,
    completionId: row.completionId,
    sourceInteractionId: nullablePositiveInteger(row.sourceInteractionId),
    sourceCompletionId: nullablePositiveInteger(row.sourceCompletionId),
    sourceActionId: nullablePositiveInteger(row.sourceActionId),
    phase: row.phase,
    attachment,
    settlement: sanitizeSettlement(
      row.settlementJson,
      row.completionStatus,
      row.safeReason,
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sanitizeAttachment(encoded, completionId) {
  let attachment;
  try {
    attachment = JSON.parse(encoded);
  } catch {
    throw new Error(`SQLite stored invalid attachment JSON for completion ${completionId}`);
  }
  if (!isRecord(attachment)) {
    throw new Error(`SQLite stored a non-object attachment for completion ${completionId}`);
  }
  if (typeof attachment.provider !== "string"
    || !/^[a-z][a-z0-9.-]{0,63}$/u.test(attachment.provider)
    || attachment.schemaVersion !== 1) {
    throw new Error(`SQLite stored an invalid provider attachment for completion ${completionId}`);
  }
  const canonical = canonicalJson(attachment);
  return {
    present: true,
    provider: attachment.provider,
    schemaVersion: attachment.schemaVersion,
    sha256: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
  };
}

function sanitizeSettlement(encoded, completionStatus, safeReason) {
  let valid = false;
  if (encoded !== null) {
    try {
      valid = isRecord(JSON.parse(encoded));
    } catch {
      valid = false;
    }
  }
  return {
    present: encoded !== null,
    valid,
    completionStatus,
    ...(safeReason === null ? {} : { safeReason }),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function nullablePositiveInteger(value) {
  if (value === null) return null;
  if (!isPositiveInteger(value)) throw new Error("SQLite returned an invalid completion-execution identity");
  return value;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
