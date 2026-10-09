import { createHash, randomBytes } from "node:crypto";

import { captureShareErrorDiagnostics } from "./share-error-diagnostics.mjs";

const MAX_ATTEMPTS = 32;
const MAXIMUM_PREFLIGHT_TITLE = "😀".repeat(120);
const NON_REPORTED_CODES = new Set([
  "reusable_invocation_portability_unavailable",
  "share_cancelled",
  "share_sign_in_required",
  "share_imported_conversation",
  "share_no_accepted_completion",
  "share_title_required",
  "share_title_too_long",
  "daily_quota_exhausted",
  "reservation_limit_exhausted",
  "share_attempt_unavailable",
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
  "reusable_invocation_portability_unavailable",
  "share_upload_failed",
  "share_service_failed",
  "daily_quota_exhausted",
  "reservation_limit_exhausted",
  "share_attempt_unavailable",
]);

function attemptId() {
  return randomBytes(16).toString("hex");
}

function referenceId() {
  return `SHR-${randomBytes(6).toString("hex").toUpperCase()}`;
}

function validPublishedUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.hostname !== "";
  } catch {
    return false;
  }
}

function createMemoryAttemptStore() {
  const records = new Map();
  return Object.freeze({
    async load() {
      return [...records.values()].map((record) => structuredClone(record));
    },
    async save(record) {
      if (!records.has(record.reference) && records.size >= MAX_ATTEMPTS) {
        throw new Error("Share publish attempt capacity is exhausted.");
      }
      records.set(record.reference, structuredClone(record));
    },
    async delete(reference) {
      return records.delete(reference);
    },
  });
}

function exactAccount(value) {
  if (!value || typeof value !== "object"
    || typeof value.ownerKey !== "string" || !value.ownerKey
    || typeof value.authorization !== "string" || !value.authorization
    || !Number.isSafeInteger(value.generation) || value.generation < 1) {
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
  if (error?.code === "snapshot_too_large") return "share_snapshot_too_large";
  return CLOSED_FAILURE_CODES.has(error?.code) ? error.code : "share_service_failed";
}

function closedFailure(error, reference) {
  const code = failureCode(error);
  const result = {
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
      "reusable_invocation_portability_unavailable",
      "daily_quota_exhausted",
      "reservation_limit_exhausted",
      "share_sign_in_required",
      "share_attempt_unavailable",
    ].includes(code),
  };
  if (code === "daily_quota_exhausted" && typeof error?.resetAt === "string" && error.resetAt) {
    result.resetAt = error.resetAt;
  }
  return Object.freeze(result);
}

function telemetryRecord(error, reference) {
  const code = failureCode(error);
  if (NON_REPORTED_CODES.has(code)) return null;
  const diagnostics = captureShareErrorDiagnostics(error);
  if (code === "share_snapshot_too_large") {
    return {
      ...diagnostics,
      code: "share.snapshot_too_large",
      failureStage: "export",
      attemptReferenceId: reference,
      snapshotBytes: Number.isSafeInteger(error?.snapshotBytes) ? error.snapshotBytes : 0,
    };
  }
  const stage = error?.failureStage === "upload" ? "upload" : error?.failureStage === "export" ? "export" : "service";
  return {
    ...diagnostics,
    code: stage === "upload" ? "share.upload_failed" : stage === "export" ? "share.export_failed" : "share.service_failed",
    failureStage: stage,
    attemptReferenceId: reference,
    snapshotBytes: null,
  };
}

/**
 * Electron-main authority for durable share attempts. Snapshot bytes, bearer
 * authority, stable attempt identity, and persisted owner binding never cross
 * the renderer seam.
 */
export function createSharePublishCoordinator({
  exportSnapshot,
  capturePreview,
  getTheme = () => "dark",
  accountSession,
  sourceThreadIdentity,
  publish,
  preflightPublication = async () => Object.freeze({ status: "ready" }),
  issueHandledShareFailureReporter = () => null,
  attemptStore = createMemoryAttemptStore(),
  createAttemptId = attemptId,
  createReferenceId = referenceId,
  now = Date.now,
} = {}) {
  if (typeof exportSnapshot !== "function"
    || typeof accountSession !== "function"
    || typeof sourceThreadIdentity !== "function"
    || typeof publish !== "function"
    || typeof preflightPublication !== "function"
    || typeof issueHandledShareFailureReporter !== "function"
    || typeof attemptStore?.load !== "function"
    || typeof attemptStore?.save !== "function"
    || typeof attemptStore?.delete !== "function"
    || typeof now !== "function") {
    throw new TypeError("Share publication coordinator dependencies are invalid.");
  }
  const attempts = new Map();
  let loading = null;
  let activeDurablePublication = null;

  function persistedRecord(record) {
    return Object.freeze({
      reference: record.reference,
      attemptId: record.attemptId,
      ownerKey: record.ownerKey,
      threadId: record.threadId,
      sourceThreadId: record.sourceThreadId,
      title: record.completed ? "" : record.title,
      snapshotBytes: record.completed ? [] : new Uint8Array(record.snapshotBytes),
      ...(record.preview ? {preview:record.preview,previewBytes:record.completed ? [] : new Uint8Array(record.previewBytes)} : {}),
      createdAt: record.createdAt,
      lastFailure: record.lastFailure ? { ...record.lastFailure } : null,
      reportedFailures: [...record.reportedFailures],
      publishedUrl: record.publishedUrl ?? null,
    });
  }

  function restoredRecord(value) {
    if (!value || typeof value !== "object"
      || typeof value.reference !== "string" || !/^SHR-[A-Z0-9]{8,32}$/u.test(value.reference)
      || typeof value.attemptId !== "string" || !/^[a-f0-9]{32}$/u.test(value.attemptId)
      || typeof value.ownerKey !== "string" || !value.ownerKey
      || !Number.isSafeInteger(value.threadId) || value.threadId <= 0
      || typeof value.sourceThreadId !== "string" || !value.sourceThreadId
      || typeof value.title !== "string"
      || (!Array.isArray(value.snapshotBytes) && !(value.snapshotBytes instanceof Uint8Array))
      || (Array.isArray(value.snapshotBytes)
        && value.snapshotBytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
      || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
      || !Array.isArray(value.reportedFailures)
      || value.reportedFailures.some((key) => typeof key !== "string" || key.length > 128)) return null;
    const snapshotBytes = Uint8Array.from(value.snapshotBytes);
    const publishedUrl = validPublishedUrl(value.publishedUrl)
      ? value.publishedUrl
      : null;
    const lastFailure = value.lastFailure && typeof value.lastFailure === "object"
      && value.lastFailure.status === "failed"
      && value.lastFailure.attemptReferenceId === value.reference
      && CLOSED_FAILURE_CODES.has(value.lastFailure.code)
      && typeof value.lastFailure.retryable === "boolean"
      ? Object.freeze({
        status: "failed",
        attemptReferenceId: value.reference,
        code: value.lastFailure.code,
        retryable: value.lastFailure.retryable,
        ...(typeof value.lastFailure.resetAt === "string" && value.lastFailure.resetAt
          ? { resetAt: value.lastFailure.resetAt }
          : {}),
      })
      : null;
    try {
      const failureOnly = publishedUrl === null
        && snapshotBytes.length === 0
        && lastFailure !== null
        && lastFailure.retryable === false
        && ["share_snapshot_too_large", "share_export_failed"].includes(lastFailure.code);
      const metadata = publishedUrl === null && !failureOnly ? snapshotMetadata(snapshotBytes) : null;
      return {
        reference: value.reference,
        attemptId: value.attemptId,
        ownerKey: value.ownerKey,
        threadId: value.threadId,
        sourceThreadId: value.sourceThreadId,
        title: value.title,
        snapshotBytes,
        ...(value.preview ? {preview:value.preview,previewBytes:new Uint8Array(value.previewBytes)} : {}),
        metadata,
        createdAt: value.createdAt,
        lastFailure,
        reportedFailures: new Set(value.reportedFailures),
        completed: publishedUrl !== null,
        failureOnly,
        publishedUrl,
        running: false,
        dismissing: false,
      };
    } catch {
      return null;
    }
  }

  async function ensureLoaded() {
    if (!loading) loading = (async () => {
      const staged = new Map();
      const restore = async (value, lazy = false) => {
        const record = restoredRecord(value);
        if (record) {
          if (lazy && !record.completed) {
            record.snapshotBytes = null;
            if(record.preview) record.previewBytes=null;
            record.lazy = true;
          }
          staged.set(record.reference, record);
        }
        else if (typeof value?.reference === "string") await attemptStore.delete(value.reference).catch(() => undefined);
      };
      const saved = await attemptStore.load(typeof attemptStore.read === "function"
        ? { visit: (value) => restore(value, true) } : undefined);
      if (!Array.isArray(saved)) throw new Error("Share attempt store returned invalid records.");
      for (const value of saved) await restore(value);
      for (const record of staged.values()) remember(record);
    })().catch((error) => {
      loading = null;
      throw error;
    });
    await loading;
  }

  async function save(record) {
    await attemptStore.save(persistedRecord(record));
  }

  function remember(record) {
    attempts.set(record.reference, record);
  }

  async function report(error, reference, reporter, attempt = null) {
    const record = telemetryRecord(error, reference);
    // No frozen record means no durable deduplication authority. Suppress the
    // event rather than sending a preflight/export failure without its key.
    if (!record || !reporter || !attempt) return;
    const key = `${record.failureStage}:${record.code}`;
    if (attempt?.reportedFailures.has(key)) return;
    if (attempt) {
      attempt.reportedFailures.add(key);
      try {
        await save(attempt);
      } catch {
        attempt.reportedFailures.delete(key);
        return;
      }
    }
    await Promise.resolve(reporter.report(record)).catch(() => undefined);
  }

  async function run(record, authority) {
    if (record.failureOnly) {
      return record.lastFailure ?? Object.freeze({
        status: "failed",
        attemptReferenceId: record.reference,
        code: "share_attempt_unavailable",
        retryable: false,
      });
    }
    if (record.running || record.dismissing) {
      return Object.freeze({ status: "failed", attemptReferenceId: record.reference, code: "share_attempt_unavailable", retryable: false });
    }
    if (record.lazy && activeDurablePublication !== null) {
      record.snapshotBytes = null;
      return Object.freeze({ status: "failed", attemptReferenceId: record.reference, code: "share_attempt_unavailable", retryable: true });
    }
    if (record.lazy) activeDurablePublication = record.reference;
    record.running = true;
    try {
      if (record.lazy && record.snapshotBytes === null) {
        const saved = await attemptStore.read(record.reference);
        if (!saved) {
          await Promise.resolve().then(() => attemptStore.delete(record.reference)).catch(() => undefined);
          attempts.delete(record.reference);
          return Object.freeze({ status: "failed", attemptReferenceId: record.reference, code: "share_attempt_unavailable", retryable: false });
        }
        if (JSON.stringify(saved.preview) !== JSON.stringify(record.preview)
          || (record.preview && createHash("sha256").update(new Uint8Array(saved.previewBytes)).digest("hex") !== record.preview.sha256)) {
          throw Object.assign(new Error("Frozen preview changed"), {code:"share_attempt_unavailable"});
        }
        record.snapshotBytes = new Uint8Array(saved.snapshotBytes);
        if(record.preview)record.previewBytes=new Uint8Array(saved.previewBytes);
      }
      const assertAuthority = async () => {
        const current = exactAccount(await accountSession());
        if (current.ownerKey !== record.ownerKey || current.generation !== authority.generation) {
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
          ...(record.preview ? {preview:record.preview} : {}),
        }),
        snapshotBytes: new Uint8Array(record.snapshotBytes),
        ...(record.preview ? {previewBytes:new Uint8Array(record.previewBytes)} : {}),
      });
      if (!result || !validPublishedUrl(result.url)) throw new Error("share_service_failed");
      await assertAuthority();
      record.completed = true;
      record.publishedUrl = result.url;
      record.lastFailure = null;
      await save(record);
      try {
        await assertAuthority();
      } catch (error) {
        return closedFailure(error, record.reference);
      }
      return Object.freeze({ status: "created", attemptReferenceId: record.reference, url: result.url });
    } catch (error) {
      record.completed = false;
      record.publishedUrl = null;
      const result = closedFailure(error, record.reference);
      record.lastFailure = result;
      await save(record).catch(() => undefined);
      await report(error, record.reference, authority.failureReporter, record);
      return result;
    } finally {
      record.running = false;
      if (record.lazy || record.completed) {record.snapshotBytes = null;record.previewBytes=null;}
      if (activeDurablePublication === record.reference) activeDurablePublication = null;
    }
  }

  return Object.freeze({
    async preflight({ threadId } = {}) {
      const reference = createReferenceId();
      let failureReporter = null;
      let account = null;
      let sourceThreadId = null;
      let failureAttempt = null;
      try {
        if (!Number.isSafeInteger(threadId) || threadId <= 0) {
          throw new TypeError("Share preflight input is invalid.");
        }
        account = exactAccount(await accountSession());
        failureReporter = issueHandledShareFailureReporter({ generation: account.generation });
        sourceThreadId = await sourceThreadIdentity(threadId);
        if (typeof sourceThreadId !== "string" || !sourceThreadId.trim()) {
          throw new TypeError("Share source-thread identity is invalid.");
        }
        // This deliberately does not retain bytes or create an attempt. A
        // maximum-width public title makes the size check conservative; Create
        // remains the one boundary that freezes accepted history and identity.
        await exportSnapshot(threadId, MAXIMUM_PREFLIGHT_TITLE);
        const assertAuthority = async () => {
          const current = exactAccount(await accountSession());
          if (current.ownerKey !== account.ownerKey || current.generation !== account.generation) {
            const error = new Error("share_sign_in_required");
            error.code = "share_sign_in_required";
            throw error;
          }
          return current;
        };
        const current = await assertAuthority();
        await preflightPublication({ authorization: current.authorization, assertAuthority });
        await assertAuthority();
        return Object.freeze({ status: "ready" });
      } catch (error) {
        const result = closedFailure(error, reference);
        if (account !== null && sourceThreadId !== null
          && ["share_snapshot_too_large", "share_export_failed"].includes(result.code)) {
          const record = {
            reference,
            attemptId: createAttemptId(),
            ownerKey: account.ownerKey,
            threadId,
            sourceThreadId,
            title: "",
            snapshotBytes: new Uint8Array(),
            metadata: null,
            createdAt: now(),
            lastFailure: result,
            reportedFailures: new Set(),
            completed: false,
            failureOnly: true,
            publishedUrl: null,
            running: false,
            dismissing: false,
          };
          try {
            await save(record);
            remember(record);
            failureAttempt = record;
          } catch {
            failureAttempt = null;
          }
        }
        await report(error, reference, failureReporter, failureAttempt);
        return result;
      } finally {
        failureReporter?.revoke?.();
      }
    },

    async create({ threadId, title, signal } = {}) {
      const reference = createReferenceId();
      let failureReporter = null;
      let attempt = null;
      let attemptDurable = false;
      let account = null;
      let sourceThreadId = null;
      try {
        await ensureLoaded();
        if (!Number.isSafeInteger(threadId) || threadId <= 0 || typeof title !== "string") {
          throw new TypeError("Share creation input is invalid.");
        }
        account = exactAccount(await accountSession());
        failureReporter = issueHandledShareFailureReporter({ generation: account.generation });
        sourceThreadId = await sourceThreadIdentity(threadId);
        if (typeof sourceThreadId !== "string" || !sourceThreadId.trim()) {
          throw new TypeError("Share source-thread identity is invalid.");
        }
        signal?.throwIfAborted();
        const theme=getTheme();
        const snapshotBytes = new Uint8Array(await exportSnapshot(threadId, title, { signal }));
        const previewBytes=capturePreview ? new Uint8Array(await capturePreview({snapshotBytes:new Uint8Array(snapshotBytes),title,theme,signal})) : null;
        const preview=previewBytes ? {byteLength:previewBytes.length,sha256:createHash("sha256").update(previewBytes).digest("hex"),theme} : null;
        const currentAccount = exactAccount(await accountSession());
        if (currentAccount.ownerKey !== account.ownerKey || currentAccount.generation !== account.generation) {
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
          ...(preview ? {preview,previewBytes} : {}),
          metadata: snapshotMetadata(snapshotBytes),
          createdAt: now(),
          lastFailure: null,
          reportedFailures: new Set(),
          completed: false,
          publishedUrl: null,
          running: false,
          dismissing: false,
        };
        attempt = record;
        await save(record);
        attemptDurable = true;
        record.lazy = typeof attemptStore.read === "function";
        remember(record);
        return await run(record, { generation: account.generation, failureReporter });
      } catch (error) {
        const result = Object.freeze({ ...closedFailure(error, reference), retryable: false });
        if (attempt === null && account !== null && sourceThreadId !== null
          && ["share_snapshot_too_large", "share_export_failed"].includes(result.code)) {
          const failureRecord = {
            reference,
            attemptId: createAttemptId(),
            ownerKey: account.ownerKey,
            threadId,
            sourceThreadId,
            title,
            snapshotBytes: new Uint8Array(),
            metadata: null,
            createdAt: now(),
            lastFailure: result,
            reportedFailures: new Set(),
            completed: false,
            failureOnly: true,
            publishedUrl: null,
            running: false,
            dismissing: false,
          };
          try {
            await save(failureRecord);
            attemptDurable = true;
            remember(failureRecord);
            attempt = failureRecord;
          } catch {
            attempt = null;
          }
        }
        if (!attemptDurable) await report(error, reference, failureReporter);
        else await report(error, reference, failureReporter, attempt);
        return result;
      } finally {
        failureReporter?.revoke?.();
      }
    },

    async retry(reference) {
      let failureReporter = null;
      try {
        await ensureLoaded();
        const record = attempts.get(reference);
        if (!record) {
          return Object.freeze({ status: "failed", attemptReferenceId: reference, code: "share_attempt_unavailable", retryable: false });
        }
        const account = exactAccount(await accountSession());
        if (account.ownerKey !== record.ownerKey
          || attempts.get(reference) !== record
          || record.dismissing) {
          return Object.freeze({ status: "failed", attemptReferenceId: reference, code: "share_attempt_unavailable", retryable: false });
        }
        if (record.completed && record.publishedUrl) {
          return Object.freeze({ status: "created", attemptReferenceId: reference, url: record.publishedUrl });
        }
        failureReporter = issueHandledShareFailureReporter({ generation: account.generation });
        return await run(record, {
          generation: account.generation,
          failureReporter,
        });
      } catch (error) {
        await report(error, reference, null);
        return closedFailure(error, reference);
      } finally {
        failureReporter?.revoke?.();
      }
    },

    async pending({ threadId } = {}) {
      try {
        if (!Number.isSafeInteger(threadId) || threadId <= 0) return null;
        await ensureLoaded();
        const account = exactAccount(await accountSession());
        const candidates = [...attempts.values()]
          .filter((record) => record.ownerKey === account.ownerKey
            && record.threadId === threadId
            && !record.running
            && !record.dismissing)
          .sort((left, right) => right.createdAt - left.createdAt);
        const record = candidates[0];
        if (!record) return null;
        if (record.completed && record.publishedUrl) {
          return Object.freeze({ status: "created", attemptReferenceId: record.reference, url: record.publishedUrl });
        }
        if (record.lastFailure) {
          if (record.failureOnly) return record.lastFailure;
          const recoverable = ![
            "daily_quota_exhausted",
            "reservation_limit_exhausted",
            "share_snapshot_too_large",
          ].includes(record.lastFailure.code);
          return Object.freeze({
            ...record.lastFailure,
            code: ["share_sign_in_required", "share_attempt_unavailable"].includes(record.lastFailure.code)
              ? "share_service_failed"
              : record.lastFailure.code,
            retryable: recoverable,
          });
        }
        return Object.freeze({
          status: "failed",
          attemptReferenceId: record.reference,
          code: "share_service_failed",
          retryable: true,
        });
      } catch {
        return null;
      }
    },

    async dismiss(reference) {
      try {
        await ensureLoaded();
        const account = exactAccount(await accountSession());
        const record = attempts.get(reference);
        if (!record || record.running || record.dismissing || record.ownerKey !== account.ownerKey) {
          return Object.freeze({ status: "failed", attemptReferenceId: reference, code: "share_attempt_unavailable", retryable: false });
        }
        record.dismissing = true;
        try {
          await attemptStore.delete(reference);
          attempts.delete(reference);
        } catch (error) {
          record.dismissing = false;
          throw error;
        }
        return Object.freeze({ status: "dismissed", attemptReferenceId: reference });
      } catch (error) {
        return closedFailure(error, reference);
      }
    },
  });
}
