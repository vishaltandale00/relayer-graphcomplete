import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const RECEIVER_HOST = "127.0.0.1";
const RECEIVER_PATH = "/v1/authenticated-errors/report";
const MAX_REQUEST_BYTES = 64 * 1024;

function respond(response, statusCode, body) {
  if (response.headersSent || response.destroyed) return;
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(body)}\n`);
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function readBoundedBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        oversized = true;
        chunks.length = 0;
      } else if (!oversized) {
        chunks.push(chunk);
      }
    });
    request.once("end", () => resolve(oversized ? null : Buffer.concat(chunks)));
    request.once("aborted", () => reject(new Error("request aborted")));
    request.once("error", reject);
  });
}

export async function createAuthenticatedErrorReceiver({ gateway } = {}) {
  if (typeof gateway?.issueReporter !== "function") {
    throw new TypeError("Authenticated error receiver gateway is invalid.");
  }

  let closed = false;
  let closePromise;
  const capabilities = new Map();

  function revokeCapability(authorization) {
    const reporter = capabilities.get(authorization);
    if (!reporter) return;
    capabilities.delete(authorization);
    reporter.revoke();
  }

  function revokeAll() {
    const reporters = [...capabilities.values()];
    capabilities.clear();
    for (const reporter of reporters) reporter.revoke();
  }

  const server = createServer(async (request, response) => {
    if (closed || request.method !== "POST" || request.url !== RECEIVER_PATH) {
      request.resume();
      respond(response, closed ? 403 : 404, { accepted: false });
      return;
    }
    const reporter = capabilities.get(request.headers.authorization);
    if (!reporter) {
      request.resume();
      respond(response, 404, { accepted: false });
      return;
    }
    if (request.headers["content-type"] !== "application/json") {
      request.resume();
      respond(response, 415, { accepted: false });
      return;
    }
    const contentLength = request.headers["content-length"];
    if (contentLength !== undefined
      && (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)) {
      request.resume();
      respond(response, 413, { accepted: false });
      return;
    }

    let body;
    try {
      body = await readBoundedBody(request);
    } catch {
      respond(response, 400, { accepted: false });
      return;
    }
    if (body === null) {
      respond(response, 413, { accepted: false });
      return;
    }
    let record;
    try {
      record = JSON.parse(body.toString("utf8"));
    } catch {
      respond(response, 400, { accepted: false });
      return;
    }
    if (record === null || Array.isArray(record) || typeof record !== "object") {
      respond(response, 400, { accepted: false });
      return;
    }
    try {
      const result = await reporter.report(record);
      const accepted = result?.accepted === true;
      respond(response, accepted ? 202 : result?.reason === "stale-capability" ? 403 : 400, { accepted });
    } catch {
      respond(response, 503, { accepted: false });
    }
  });
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(0, RECEIVER_HOST);
  });

  const address = server.address();
  const endpoint = `http://${RECEIVER_HOST}:${address.port}${RECEIVER_PATH}`;

  function close() {
    closePromise ??= (async () => {
      closed = true;
      revokeAll();
      await closeServer(server);
    })();
    return closePromise;
  }

  server.on("error", () => {
    void close();
  });

  return Object.freeze({
    issue({ component, processGeneration } = {}) {
      if (closed) return null;
      const reporter = gateway.issueReporter({ component, processGeneration });
      if (reporter === null) return null;
      let authorization;
      do {
        authorization = `Bearer ${randomBytes(32).toString("base64url")}`;
      } while (capabilities.has(authorization));
      capabilities.set(authorization, reporter);
      let revoked = false;
      return Object.freeze({
        endpoint,
        authorization,
        revoke() {
          if (revoked) return;
          revoked = true;
          revokeCapability(authorization);
        },
      });
    },
    close,
  });
}
