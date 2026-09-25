import { createHash, randomBytes } from "node:crypto";

const MAX_ATTEMPTS = 32;
const NON_REPORTED_CODES = new Set([
  "share_cancelled",
  "share_sign_in_required",
  "daily_quota_exhausted",
]);
const CLOSED_FAILURE_CODES = new Set([
  "share_cancelled",
  "share_sign_in_required",
  "share_imported_conversation",
  "share_no_accepted_completion",
  "share_title_required",
  "share_title_too_long",
  "share_snapshot_too_large",
  "share_export_failed",
  "share_upload_failed",
  "share_service_failed",
  "daily_quota_exhausted",
  "share_attempt_unavailable",
]);

function attemptId() {
  return randomBytes(16).toString("hex");
}

function referenceId() {
  return `SHR-${randomBytes(6).toString("hex").toUpperCase()}`;
}

function exactAccount(value) {
  if (!value || typeof value !== "object"
    || typeof value.ownerKey !== "string" || !value.ownerKey
    || typeof value.authorization !== "string" || !value.authorization) {
    const error = new Error("share_sign_in_required");
    error.code = "share_sign_in_required";
    throw error;
  }
  return value;
}

function snapshotMetadata(bytes) {
  const source = new Uint8Array(bytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const header = JSON.parse(lines[0]);
  return Object.freeze({
    byteLength: source.byteLength,
    lineCount: lines.length,
    snapshotSha256: createHash("sha256").update(source).digest("hex"),
    projectName: typeof header?.conversation?.projectName === "string"
      ? header.conversation.projectName
      : undefined,
  });
}

function failureCode(error) {
  if (error?.name === "AbortError") return "share_cancelled";
  return CLOSED_FAILURE_CODES.has(error?.code) ? error.code : "share_service_failed";
}

function closedFailure(error, reference) {
  const code = failureCode(error);
  return Object.freeze({
    status: "failed",
    attemptReferenceId: reference,
    code,
    retryable: ![
      "share_imported_conversation",
      "share_no_accepted_completion",
      "share_title_required",
      "share_title_too_long",
      "share_snapshot_too_large",
      "share_export_failed",
      "daily_quota_exhausted",
      "share_sign_in_required",
    ].includes(code),
  });
}

function telemetryRecord(error, reference) {
  const code = failureCode(error);
  if (NON_REPORTED_CODES.has(code)) return null;
  if (code === "share_snapshot_too_large") {
    return {
      code: "share.snapshot_too_large",
      failureStage: "export",
      attemptReferenceId: reference,
      snapshotBytes: Number.isSafeInteger(error?.snapshotBytes) ? error.snapshotBytes : 0,
    };
  }
  const stage = error?.failureStage === "upload" ? "upload" : error?.failureStage === "export" ? "export" : "service";
  return {
    code: stage === "upload" ? "share.upload_failed" : stage === "export" ? "share.export_failed" : "share.service_failed",
    failureStage: stage,
    attemptReferenceId: reference,
    snapshotBytes: null,
  };
}

/**
 * Electron-main authority for one in-session share attempt. Snapshot bytes,
 * bearer authority, and the stable attempt ID never cross the renderer seam.
 * Durable restart recovery is intentionally a later #466 seam.
 */
export function createSharePublishCoordinator({
  exportSnapshot,
  accountSession,
  sourceThreadIdentity,
  publish,
  reportHandledShareFailure = async () => {},
  createAttemptId = attemptId,
  createReferenceId = referenceId,
} = {}) {
  if (typeof exportSnapshot !== "function"
    || typeof accountSession !== "function"
    || typeof sourceThreadIdentity !== "function"
    || typeof publish !== "function"
    || typeof reportHandledShareFailure !== "function") {
    throw new TypeError("Share publication coordinator dependencies are invalid.");
  }
  const attempts = new Map();

  function remember(record) {
    attempts.set(record.reference, record);
    while (attempts.size > MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value);
  }

  async function report(error, reference) {
    const record = telemetryRecord(error, reference);
    if (record) await reportHandledShareFailure(record).catch(() => undefined);
  }

  async function run(record) {
    try {
      const assertAuthority = async () => {
        const current = exactAccount(await accountSession());
        if (current.ownerKey !== record.ownerKey) {
          const error = new Error("share_sign_in_required");
          error.code = "share_sign_in_required";
          throw error;
        }
        return current;
      };
      const currentAccount = await assertAuthority();
      const result = await publish({
        authorization: currentAccount.authorization,
        assertAuthority,
        attempt: Object.freeze({
          attemptId: record.attemptId,
          sourceThreadId: record.sourceThreadId,
          title: record.title,
          ...(record.metadata.projectName === undefined ? {} : { projectName: record.metadata.projectName }),
          byteLength: record.metadata.byteLength,
          lineCount: record.metadata.lineCount,
          snapshotSha256: record.metadata.snapshotSha256,
        }),
        snapshotBytes: new Uint8Array(record.snapshotBytes),
      });
      if (!result || typeof result.url !== "string" || !result.url) throw new Error("share_service_failed");
      await assertAuthority();
      record.completed = true;
      return Object.freeze({ status: "created", attemptReferenceId: record.reference, url: result.url });
    } catch (error) {
      await report(error, record.reference);
      return closedFailure(error, record.reference);
    }
  }

  return Object.freeze({
    async create({ threadId, title, signal } = {}) {
      const reference = createReferenceId();
      try {
        if (!Number.isSafeInteger(threadId) || threadId <= 0 || typeof title !== "string") {
          throw new TypeError("Share creation input is invalid.");
        }
        const account = exactAccount(await accountSession());
        const sourceThreadId = await sourceThreadIdentity(threadId);
        if (typeof sourceThreadId !== "string" || !sourceThreadId.trim()) {
          throw new TypeError("Share source-thread identity is invalid.");
        }
        signal?.throwIfAborted();
        const snapshotBytes = new Uint8Array(await exportSnapshot(threadId, title, { signal }));
        const currentAccount = exactAccount(await accountSession());
        if (currentAccount.ownerKey !== account.ownerKey) {
          const error = new Error("share_sign_in_required");
          error.code = "share_sign_in_required";
          throw error;
        }
        const record = {
          reference,
          attemptId: createAttemptId(),
          ownerKey: account.ownerKey,
          threadId,
          sourceThreadId,
          title,
          snapshotBytes,
          metadata: snapshotMetadata(snapshotBytes),
          completed: false,
        };
        remember(record);
        return run(record);
      } catch (error) {
        await report(error, reference);
        return closedFailure(error, reference);
      }
    },

    async retry(reference) {
      const record = attempts.get(reference);
      if (!record || record.completed) {
        return Object.freeze({ status: "failed", attemptReferenceId: reference, code: "share_attempt_unavailable", retryable: false });
      }
      try {
        const account = exactAccount(await accountSession());
        if (account.ownerKey !== record.ownerKey) {
          return Object.freeze({ status: "failed", attemptReferenceId: reference, code: "share_attempt_unavailable", retryable: false });
        }
        return run(record);
      } catch (error) {
        await report(error, reference);
        return closedFailure(error, reference);
      }
    },
  });
}
