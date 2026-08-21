import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export const MODEL_CATALOG_REFRESH_PATH = "/v1/provider-catalog/refresh";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 1_024;
// Codex discovery performs account/read and model/list requests. Bound the
// combined operation and abort provider work if the deadline expires.
export const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 45_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bearerMatches(authorization, token) {
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const supplied = createHash("sha256").update(typeof authorization === "string" ? authorization : "").digest();
  return timingSafeEqual(expected, supplied);
}

function isLoopbackPeer(address) {
  return address === LOOPBACK_HOST || address === `::ffff:${LOOPBACK_HOST}`;
}

function stableProviderId(value) {
  if (typeof value !== "string") return false;
  const characters = [...value];
  return characters.length > 0
    && characters.length <= 200
    && !/\p{White_Space}/u.test(characters[0])
    && !/\p{White_Space}/u.test(characters.at(-1))
    && !characters.some((character) => /\p{Cc}/u.test(character));
}

async function readBoundedBody(request, maxBodyBytes) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    request.resume();
    throw new RequestError(413, "Request body is too large.");
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBodyBytes) throw new RequestError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response, status, message = null) {
  if (response.writableEnded || response.destroyed) return;
  if (status === 204) {
    response.writeHead(status, { "Cache-Control": "no-store" });
    response.end();
    return;
  }
  const body = JSON.stringify({ error: message });
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
  });
  response.end(body);
}

function withTimeout(operation, timeoutMs, activeControllers) {
  const controller = new AbortController();
  activeControllers.add(controller);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new RequestError(504, "Model catalog refresh timed out.");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(resolve, reject)
      .finally(() => clearTimeout(timeout));
  }).finally(() => activeControllers.delete(controller));
}

export async function startModelCatalogRefreshServer({
  refresh,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  requestTimeoutMs = MODEL_CATALOG_REFRESH_TIMEOUT_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  token = randomBytes(32).toString("hex"),
} = {}) {
  if (typeof refresh !== "function") throw new Error("Model catalog refresh server requires a refresh callback.");
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) throw new Error("Model catalog refresh body limit must be a non-negative integer.");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error("Model catalog refresh timeout must be a positive integer.");
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) throw new Error("Model catalog refresh shutdown timeout must be a positive integer.");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Model catalog refresh token must be 32 random bytes encoded as lowercase hex.");

  let closing = false;
  let expectedHost = null;
  const activeControllers = new Set();
  const server = createServer((request, response) => {
    void (async () => {
      if (closing) throw new RequestError(503, "Model catalog refresh server is shutting down.");
      if (!isLoopbackPeer(request.socket.remoteAddress)) throw new RequestError(403, "Loopback access is required.");
      if (request.headers.host !== expectedHost) throw new RequestError(400, "Invalid callback host.");
      const requestUrl = new URL(request.url || "/", `http://${LOOPBACK_HOST}`);
      if (requestUrl.pathname !== MODEL_CATALOG_REFRESH_PATH) {
        throw new RequestError(404, "Not found.");
      }
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        throw new RequestError(405, "Method not allowed.");
      }
      if (!bearerMatches(request.headers.authorization, token)) throw new RequestError(401, "Unauthorized.");
      const providerIds = requestUrl.searchParams.getAll("providerId");
      if (providerIds.length !== 1 || requestUrl.searchParams.size !== 1 || !stableProviderId(providerIds[0])) {
        throw new RequestError(400, "Exactly one valid providerId is required.");
      }
      const body = await readBoundedBody(request, maxBodyBytes);
      if (body.trim()) throw new RequestError(400, "Request body must be empty.");
      await withTimeout(
        (signal) => refresh({ signal, providerId: providerIds[0] }),
        requestTimeoutMs,
        activeControllers,
      );
      send(response, 204);
    })().catch((error) => {
      const status = error instanceof RequestError ? error.status : 503;
      if (!(error instanceof RequestError)) console.error("Pre-inference model catalog refresh failed:", error);
      send(response, status, error instanceof RequestError ? error.message : "Model catalog refresh failed.");
    });
  });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs;
  server.keepAliveTimeout = Math.min(requestTimeoutMs, 1_000);

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LOOPBACK_HOST);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Model catalog refresh server did not bind a TCP port.");
  }
  expectedHost = `${LOOPBACK_HOST}:${address.port}`;

  let closePromise = null;
  return Object.freeze({
    session: Object.freeze({ origin: `http://${expectedHost}`, token }),
    close() {
      closePromise ??= new Promise((resolve) => {
        closing = true;
        for (const controller of activeControllers) {
          controller.abort(new Error("Model catalog refresh server is shutting down."));
        }
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(forceTimer);
          resolve();
        };
        const forceTimer = setTimeout(() => {
          server.closeAllConnections?.();
          finish();
        }, shutdownTimeoutMs);
        forceTimer.unref?.();
        server.close(finish);
        server.closeIdleConnections?.();
      });
      return closePromise;
    },
  });
}
