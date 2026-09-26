/**
 * Main-process transport for the shared-thread service. This module is kept
 * separate from renderer code deliberately: callers provide a verified Auth0
 * ID-token bearer, and the client never returns that bearer in a result or
 * error.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

const KNOWN_SERVICE_CODES = new Set([
  "daily_quota_exhausted",
  "snapshot_too_large",
  "reservation_expired",
  "staged_snapshot_missing",
  "snapshot_mismatch",
  "attempt_closed",
  "attempt_conflict",
  "invalid_request",
  "invalid_share_title",
]);

function exactBearer(value) {
  if (typeof value !== "string" || !/^Bearer\s+\S+$/u.test(value)) {
    const error = new ShareServiceClientError("share_sign_in_required", { failureStage: "service" });
    throw error;
  }
  return value;
}

function exactUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${label} must be an HTTP(S) URL.`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(`${label} must be an HTTP(S) URL.`);
  return url.href.replace(/\/$/u, "");
}

function pathUrl(origin, path) {
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}

async function responseBody(response) {
  if (response.status === 204) return null;
  try { return await response.json(); } catch { return null; }
}

export class ShareServiceClientError extends Error {
  constructor(code, { status = 0, failureStage = "service", data = {}, cause } = {}) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "ShareServiceClientError";
    this.code = code;
    this.status = status;
    this.failureStage = failureStage;
    if (Number.isSafeInteger(data.resetAt) || typeof data.resetAt === "string") this.resetAt = data.resetAt;
    if (Number.isSafeInteger(data.used)) this.used = data.used;
    if (Number.isSafeInteger(data.limit)) this.limit = data.limit;
  }
}

function serviceError(response, body, failureStage) {
  const rawCode = body && typeof body === "object" && typeof body.error === "string" ? body.error : "";
  const code = failureStage === "service" && (response.status === 401 || response.status === 403)
    ? "share_sign_in_required"
    : KNOWN_SERVICE_CODES.has(rawCode) ? rawCode : "share_service_failed";
  return new ShareServiceClientError(code, {
    status: response.status,
    failureStage,
    data: {
      resetAt: body?.resetAt,
      used: body?.used,
      limit: body?.limit,
    },
  });
}

function transportError(error, failureStage) {
  if (error instanceof ShareServiceClientError) return error;
  if (error?.name === "AbortError") return error;
  return new ShareServiceClientError(failureStage === "upload" ? "share_upload_failed" : "share_service_failed", {
    failureStage,
    cause: error,
  });
}

function exactUploadPolicy(value) {
  if (!value || typeof value !== "object" || value.method !== "POST"
    || typeof value.url !== "string" || typeof value.key !== "string"
    || !value.fields || typeof value.fields !== "object") {
    throw new ShareServiceClientError("share_service_failed", { failureStage: "service" });
  }
  return value;
}

function appendUpload(form, policy, bytes) {
  for (const [name, value] of Object.entries(policy.fields)) {
    if (typeof value !== "string") throw new ShareServiceClientError("share_upload_failed", { failureStage: "upload" });
    form.append(name, value);
  }
  form.append("file", new Blob([bytes], { type: "application/x-ndjson" }), "snapshot.jsonl");
}

export function createShareServiceClient({
  endpoint,
  baseUrl,
  fetchImpl = globalThis.fetch,
  uploadFetchImpl = fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const origin = exactUrl(endpoint ?? baseUrl, "Share service endpoint");
  if (typeof fetchImpl !== "function" || typeof uploadFetchImpl !== "function") throw new TypeError("Share service fetch implementations are required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("Share service timeout must be positive.");
  const boundedSignal = (signal) => signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  async function request(path, { authorization, method = "GET", body, signal, headers = {} } = {}) {
    exactBearer(authorization);
    const requestSignal = boundedSignal(signal);
    let response;
    try {
      response = await fetchImpl(pathUrl(origin, path), {
        method,
        headers: {
          accept: "application/json",
          authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal,
      });
    } catch (error) {
      throw transportError(error, "service");
    }
    const payload = await responseBody(response);
    if (!response.ok) throw serviceError(response, payload, "service");
    return payload;
  }

  async function upload(policy, bytes, signal) {
    const exact = exactUploadPolicy(policy);
    const form = new FormData();
    appendUpload(form, exact, bytes);
    const uploadSignal = boundedSignal(signal);
    let response;
    try {
      response = await uploadFetchImpl(exact.url, {
        method: "POST",
        body: form,
        signal: uploadSignal,
      });
    } catch (error) {
      throw transportError(error, "upload");
    }
    if (!response.ok) {
      const payload = await responseBody(response);
      throw serviceError(response, payload, "upload");
    }
  }

  async function publish({ authorization, assertAuthority = async () => {}, attempt, snapshotBytes, signal } = {}) {
    exactBearer(authorization);
    if (typeof assertAuthority !== "function") throw new TypeError("Share authority assertion is required.");
    if (!attempt || typeof attempt !== "object") throw new TypeError("Share attempt metadata is required.");
    const bytes = new Uint8Array(snapshotBytes ?? []);
    await assertAuthority();
    let reservation;
    try {
      reservation = await request("/shares", {
        authorization,
        method: "POST",
        signal,
        headers: { "idempotency-key": attempt.attemptId },
        body: attempt,
      });
      if (!reservation || typeof reservation !== "object" || typeof reservation.shareId !== "string") {
        throw new ShareServiceClientError("share_service_failed", { failureStage: "service" });
      }
      await assertAuthority();
      if (reservation.status === "reserved") {
        await upload(reservation.upload, bytes, signal);
        await assertAuthority();
        return await request(`/shares/${encodeURIComponent(reservation.shareId)}/finalize`, {
          authorization,
          method: "POST",
          signal,
        });
      }
      if (reservation.status === "published" && typeof reservation.url === "string") return reservation;
      throw new ShareServiceClientError("share_service_failed", { failureStage: "service" });
    } catch (error) {
      throw transportError(error, error?.failureStage ?? "service");
    }
  }

  async function list({ authorization, signal } = {}) {
    const response = await request("/shares", { authorization, signal });
    if (!response || !Array.isArray(response.items)) throw new ShareServiceClientError("share_service_failed", { failureStage: "service" });
    return response.items;
  }

  async function preflight({ authorization, assertAuthority = async () => {}, signal } = {}) {
    await assertAuthority();
    const items = await list({ authorization, signal });
    await assertAuthority();
    const current = new Date(now());
    const day = current.toISOString().slice(0, 10);
    const used = items.filter((item) => (
      typeof item?.createdAt === "string" && item.createdAt.slice(0, 10) === day
    )).length;
    if (used >= 20) {
      const reset = new Date(Date.UTC(
        current.getUTCFullYear(),
        current.getUTCMonth(),
        current.getUTCDate() + 1,
      )).toISOString();
      throw new ShareServiceClientError("daily_quota_exhausted", {
        status: 429,
        data: { resetAt: reset, used, limit: 20 },
      });
    }
    return Object.freeze({ status: "ready" });
  }

  return Object.freeze({ publish, list, preflight });
}

export const createShareServiceHttpClient = createShareServiceClient;
