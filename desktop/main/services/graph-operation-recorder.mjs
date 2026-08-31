import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DEFAULT_MAX_EVENTS_PER_INTERACTION = 2_000;
const DEFAULT_MAX_BYTES_PER_INTERACTION = 2 * 1024 * 1024;
const DEFAULT_SETTLE_TIMEOUT_MS = 5_000;
const MAX_PROXY_BODY_BYTES = 4 * 1024 * 1024;
const SEARCH_BUDGET_KEYS = Object.freeze([
  "queryBytes",
  "astDepth",
  "variables",
  "patternParts",
  "traversalHops",
  "examinedExpansions",
  "intermediateRows",
  "wallTimeMs",
  "resultRows",
  "encodedResultBytes",
]);
const SENSITIVE_NAME = /(authorization|credential|password|secret|token)/i;

class InvalidGraphOperationTargetError extends Error {}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function parseJsonObject(bytes) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function bearerToken(header) {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1];
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function errorCodes(response) {
  const error = isObject(response?.error) ? response.error : undefined;
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  return [...new Set([error?.code, ...issues.map((issue) => isObject(issue) ? issue.code : undefined)])]
    .filter((code) => typeof code === "string");
}

function scrubKnownSecrets(value, knownSecrets) {
  if (typeof value === "string") {
    let scrubbed = value;
    for (const secret of knownSecrets) {
      if (secret !== "") scrubbed = scrubbed.split(secret).join("[REDACTED]");
    }
    return scrubbed;
  }
  if (Array.isArray(value)) return value.map((entry) => scrubKnownSecrets(entry, knownSecrets));
  if (!isObject(value)) return value;
  if (value.type === "record" && Array.isArray(value.fields)) {
    return {
      ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "fields").map(([key, entry]) => [
        key,
        SENSITIVE_NAME.test(key)
          ? "[REDACTED]"
          : scrubKnownSecrets(entry, knownSecrets),
      ])),
      fields: value.fields.map((field) => {
        if (!isObject(field) || typeof field.name !== "string") {
          return scrubKnownSecrets(field, knownSecrets);
        }
        return {
          ...Object.fromEntries(Object.entries(field).filter(([key]) => key !== "value").map(([key, entry]) => [
            key,
            SENSITIVE_NAME.test(key)
              ? "[REDACTED]"
              : scrubKnownSecrets(entry, knownSecrets),
          ])),
          value: SENSITIVE_NAME.test(field.name)
            ? "[REDACTED]"
            : scrubKnownSecrets(field.value, knownSecrets),
        };
      }),
    };
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_NAME.test(key)
      ? "[REDACTED]"
      : scrubKnownSecrets(entry, knownSecrets),
  ]));
}

function closedSearchTarget(value) {
  if (!isObject(value) || !["thread", "project"].includes(value.scope) || !positiveInteger(value.id)) {
    return undefined;
  }
  return { scope: value.scope, id: value.id };
}

function closedSearchBudget(value) {
  if (!isObject(value)) return undefined;
  const budget = Object.fromEntries(SEARCH_BUDGET_KEYS.flatMap((key) => (
    Number.isSafeInteger(value[key]) && value[key] >= 0 ? [[key, value[key]]] : []
  )));
  return Object.keys(budget).length === 0 ? undefined : budget;
}

function withSearchRequest(receipt, request, knownSecrets) {
  if (!isObject(request)) return receipt;
  const target = closedSearchTarget(request.target);
  const budget = closedSearchBudget(request.budget);
  return {
    ...receipt,
    ...(Number.isSafeInteger(request.queryContractVersion)
      ? { queryContractVersion: request.queryContractVersion }
      : {}),
    ...(target === undefined ? {} : { target }),
    ...(typeof request.query === "string" ? { query: scrubKnownSecrets(request.query, knownSecrets) } : {}),
    ...(isObject(request.parameters) ? { parameters: scrubKnownSecrets(request.parameters, knownSecrets) } : {}),
    ...(budget === undefined ? {} : { budget }),
  };
}

function withRecord(receipt, recordKind, value) {
  if (!isObject(value) || !positiveInteger(value.id)) return receipt;
  return {
    ...receipt,
    recordKind,
    recordId: value.id,
    ...(typeof value.state === "string" ? { recordState: value.state } : {}),
  };
}

function withAction(receipt, value) {
  const recorded = withRecord(receipt, "action", value);
  if (!isObject(value)) return recorded;
  return {
    ...recorded,
    ...(typeof value.kind === "string" ? { actionKind: value.kind } : {}),
    ...(typeof value.relation === "string" || value.relation === null ? { actionRelation: value.relation } : {}),
    ...(positiveInteger(value.sourceNodeId) ? { actionSourceNodeId: value.sourceNodeId } : {}),
    ...(positiveInteger(value.sourceLayerId) || value.sourceLayerId === null ? { actionSourceLayerId: value.sourceLayerId } : {}),
    ...(positiveInteger(value.targetLayerId) || value.targetLayerId === null ? { actionTargetLayerId: value.targetLayerId } : {}),
  };
}

function withSearch(receipt, response) {
  if (!Array.isArray(response?.rows)) return receipt;
  const searchLayerIds = response.rows.flatMap((row) => Array.isArray(row) ? row.flatMap((value) => {
    if (!isObject(value) || value.type !== "layer" || typeof value.id !== "string") return [];
    const match = /^layer:([1-9]\d*)$/.exec(value.id);
    const id = match === null ? Number.NaN : Number(match[1]);
    return Number.isSafeInteger(id) ? [id] : [];
  }) : []);
  return {
    ...receipt,
    searchLayerIds,
    ...(typeof response.truncated === "boolean" ? { resultTruncated: response.truncated } : {}),
  };
}

function withCompletion(receipt, response) {
  const rootLayer = isObject(response?.rootLayer) && isObject(response.rootLayer.layer)
    ? response.rootLayer.layer
    : undefined;
  return {
    ...receipt,
    ...(positiveInteger(response?.nodeId) ? { completionNodeId: response.nodeId } : {}),
    ...(positiveInteger(rootLayer?.id) ? { completionRootLayerId: rootLayer.id } : {}),
  };
}

function sanitizeReceipt(method, path, status, request, response, knownSecrets) {
  const receipt = { schemaVersion: 1, method, path, status };
  if (method === "POST" && path === "/api/graph/nodes") return withRecord(receipt, "node", response?.node);
  if (method === "POST" && path === "/api/graph/edges") return withRecord(receipt, "edge", response?.edge);
  if (method === "POST" && path === "/api/graph/layers") return withRecord(receipt, "layer", response?.layer);
  if (method === "POST" && path === "/api/graph/actions") return withAction(receipt, response?.action);
  if (method === "POST" && /^\/api\/graph\/layers\/[1-9]\d*\/discard$/.test(path)) {
    return withRecord(receipt, "layer", response?.layer);
  }
  if (method === "POST" && path === "/api/graph/search" && status >= 200 && status < 300) {
    return withSearch(withSearchRequest(receipt, request, knownSecrets), response);
  }
  if (method === "POST" && path === "/api/graph/submit" && status >= 200 && status < 300) {
    return withCompletion(receipt, response);
  }
  const withRequest = method === "POST" && path === "/api/graph/search"
    ? withSearchRequest(receipt, request, knownSecrets)
    : receipt;
  const codes = errorCodes(response);
  return codes.length === 0 ? withRequest : { ...withRequest, errorCodes: codes };
}

async function readBoundedBody(stream) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > MAX_PROXY_BODY_BYTES) throw new Error("Graph operation proxy body exceeded its limit.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

export async function startGraphOperationRecorder({
  upstreamUrl,
  maxEventsPerInteraction = DEFAULT_MAX_EVENTS_PER_INTERACTION,
  maxBytesPerInteraction = DEFAULT_MAX_BYTES_PER_INTERACTION,
  settleTimeoutMs = DEFAULT_SETTLE_TIMEOUT_MS,
} = {}) {
  const upstream = new URL(upstreamUrl);
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1" || !upstream.port
    || upstream.pathname !== "/" || upstream.search || upstream.hash || upstream.username || upstream.password) {
    throw new Error("Graph operation recorder upstream must be an authenticated 127.0.0.1 HTTP origin.");
  }
  if (!positiveInteger(maxEventsPerInteraction) || !positiveInteger(maxBytesPerInteraction)
    || !positiveInteger(settleTimeoutMs)) {
    throw new Error("Graph operation recorder bounds must be positive integers.");
  }

  const capabilityOwners = new Map();
  const knownSecrets = new Set();
  const interactions = new Map();
  const exportedInteractions = new Set();
  const sockets = new Set();
  const requests = new Set();
  let sequence = 0;
  let closed = false;

  const stateFor = (interactionNodeId) => {
    let state = interactions.get(interactionNodeId);
    if (state === undefined) {
      state = { events: [], byteLength: 0, discardedEvents: 0, discardedBytes: 0, pending: new Map() };
      interactions.set(interactionNodeId, state);
    }
    return state;
  };
  const record = (interactionNodeId, receipt) => {
    if (exportedInteractions.has(interactionNodeId)) return;
    const event = {
      ...receipt,
      sequence: ++sequence,
      observedAt: new Date().toISOString(),
      interactionNodeId,
    };
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
    const state = stateFor(interactionNodeId);
    if (state.events.length >= maxEventsPerInteraction || state.byteLength + bytes.byteLength > maxBytesPerInteraction) {
      state.discardedEvents += 1;
      state.discardedBytes += bytes.byteLength;
      return;
    }
    state.events.push(event);
    state.byteLength += bytes.byteLength;
  };
  const replaceCapabilityOwner = (token, interactionNodeId) => {
    for (const [activeToken, activeNodeId] of capabilityOwners) {
      if (activeNodeId === interactionNodeId) capabilityOwners.delete(activeToken);
    }
    capabilityOwners.set(token, interactionNodeId);
  };
  const revokeCapabilityOwner = (request) => {
    if (!isObject(request)) return;
    if (typeof request.graphToken === "string") capabilityOwners.delete(request.graphToken);
    if (positiveInteger(request.nodeId)) {
      for (const [activeToken, activeNodeId] of capabilityOwners) {
        if (activeNodeId === request.nodeId) capabilityOwners.delete(activeToken);
      }
    }
  };

  const server = createServer((request, response) => {
    const controller = new AbortController();
    requests.add(controller);
    let releaseActivity = () => {};
    const abortUpstream = () => {
      if (!response.writableEnded) controller.abort(new Error("Graph operation downstream closed."));
    };
    request.once("aborted", abortUpstream);
    response.once("close", abortUpstream);
    void (async () => {
      const method = request.method ?? "GET";
      const target = request.url ?? "/";
      if (!target.startsWith("/") || target.startsWith("//")) {
        throw new InvalidGraphOperationTargetError("Graph operation recorder accepts only origin-relative request targets.");
      }
      const requestUrl = new URL(target, upstream);
      if (requestUrl.origin !== upstream.origin) {
        throw new InvalidGraphOperationTargetError("Graph operation recorder request target escaped its upstream origin.");
      }
      const requestBody = await readBoundedBody(request);
      const requestValue = parseJsonObject(requestBody);
      const requestToken = bearerToken(request.headers.authorization);
      if (requestToken !== undefined) knownSecrets.add(requestToken);
      const interactionNodeId = requestToken === undefined ? undefined : capabilityOwners.get(requestToken);
      if (requestUrl.pathname.startsWith("/api/graph/") && interactionNodeId !== undefined) {
        const state = stateFor(interactionNodeId);
        let resolveActivity;
        const activity = new Promise((resolve) => { resolveActivity = resolve; });
        state.pending.set(activity, controller);
        releaseActivity = () => {
          state.pending.delete(activity);
          resolveActivity();
        };
      }
      const headers = new Headers();
      for (const name of ["accept", "authorization", "content-type"]) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const upstreamResponse = await fetch(requestUrl, {
        method,
        headers,
        signal: controller.signal,
        ...(requestBody.byteLength === 0 || method === "GET" || method === "HEAD" ? {} : { body: requestBody }),
      });
      const responseBytes = Buffer.from(await upstreamResponse.arrayBuffer());
      if (responseBytes.byteLength > MAX_PROXY_BODY_BYTES) throw new Error("Graph operation proxy response exceeded its limit.");
      const contentType = upstreamResponse.headers.get("content-type");
      response.writeHead(upstreamResponse.status, contentType === null ? {} : { "content-type": contentType });
      response.end(responseBytes);
      const responseValue = parseJsonObject(responseBytes);

      if (method === "POST" && requestUrl.pathname === "/api/control/capabilities"
        && upstreamResponse.ok && positiveInteger(requestValue?.nodeId)
        && typeof requestValue?.graphToken === "string" && requestValue.graphToken !== "") {
        knownSecrets.add(requestValue.graphToken);
        replaceCapabilityOwner(requestValue.graphToken, requestValue.nodeId);
      }
      if (method === "POST" && requestUrl.pathname === "/api/control/interactions"
        && upstreamResponse.ok && positiveInteger(responseValue?.node?.id)
        && typeof responseValue?.graphToken === "string" && responseValue.graphToken !== "") {
        knownSecrets.add(responseValue.graphToken);
        replaceCapabilityOwner(responseValue.graphToken, responseValue.node.id);
      }
      if (method === "DELETE" && requestUrl.pathname === "/api/control/capabilities" && upstreamResponse.ok) {
        revokeCapabilityOwner(requestValue);
      }
      if (requestUrl.pathname.startsWith("/api/graph/") && interactionNodeId !== undefined) {
        record(interactionNodeId, sanitizeReceipt(
          method,
          requestUrl.pathname,
          upstreamResponse.status,
          requestValue,
          responseValue,
          knownSecrets,
        ));
      }
    })().catch((error) => {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const invalidTarget = error instanceof InvalidGraphOperationTargetError;
      response.writeHead(invalidTarget ? 400 : 502, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          code: invalidTarget ? "invalid_proxy_target" : "graph_operation_proxy_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }).finally(() => {
      request.off("aborted", abortUpstream);
      response.off("close", abortUpstream);
      releaseActivity();
      requests.delete(controller);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();

  return {
    url: `http://127.0.0.1:${address.port}`,
    async exportInteraction(interactionNodeId, targetDirectory) {
      if (!positiveInteger(interactionNodeId)) throw new Error("Graph operation export needs a positive interaction node ID.");
      const state = stateFor(interactionNodeId);
      while (state.pending.size > 0) {
        let timeout;
        const settled = await Promise.race([
          Promise.allSettled([...state.pending.keys()]).then(() => true),
          new Promise((resolve) => { timeout = setTimeout(() => resolve(false), settleTimeoutMs); }),
        ]);
        clearTimeout(timeout);
        if (!settled) {
          const timedOut = [...state.pending.values()];
          state.discardedEvents += timedOut.length;
          for (const controller of timedOut) controller.abort(new Error("Graph operation export settlement timed out."));
          await Promise.allSettled([...state.pending.keys()]);
        }
      }
      exportedInteractions.add(interactionNodeId);
      const eventsBytes = Buffer.from(state.events.map((event) => JSON.stringify(event)).join("\n") + (state.events.length ? "\n" : ""));
      const truncated = state.discardedEvents > 0;
      const descriptor = {
        status: truncated ? "partial" : "complete",
        promotable: !truncated,
        format: "relayer-graph-operations-v1",
        ref: "graph-operations.jsonl",
        sha256: sha256(eventsBytes),
        byteLength: eventsBytes.byteLength,
        eventCount: state.events.length,
        truncated,
        ...(truncated ? {
          discardedEvents: state.discardedEvents,
          discardedBytes: state.discardedBytes,
        } : {}),
      };
      const target = resolve(targetDirectory);
      const manifestPath = join(target, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!isObject(manifest) || manifest.interactionNodeId !== interactionNodeId || !isObject(manifest.artifacts)) {
        throw new Error("Candidate trace manifest does not match the graph-operation interaction.");
      }
      await atomicWrite(join(target, descriptor.ref), eventsBytes);
      await atomicWrite(manifestPath, `${JSON.stringify({
        ...manifest,
        artifacts: { ...manifest.artifacts, graphOperations: descriptor },
      }, null, 2)}\n`);
      interactions.delete(interactionNodeId);
      return descriptor;
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      for (const controller of requests) controller.abort(new Error("Graph operation recorder is closing."));
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
