import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isApprovedTelemetryModule } from "../../shared/telemetry-module-inventory.mjs";
import { exactKeys, validSourcePosition } from "../../shared/telemetry-validation.mjs";

const COMPONENTS = new Set([
  "renderer",
  "electron-main",
  "node-harness-host",
  "rust-app-server",
  "rust-graph-server",
]);

const EVENT_DEFINITIONS = Object.freeze({
  "renderer.unhandled_crash": Object.freeze({
    component: "renderer",
    operation: "unhandled-crash",
    message: "Renderer process crashed unexpectedly.",
  }),
  "electron_main.unhandled_crash": Object.freeze({
    component: "electron-main",
    operation: "unhandled-crash",
    message: "Electron main process crashed unexpectedly.",
  }),
  "node_harness_host.unhandled_crash": Object.freeze({
    component: "node-harness-host",
    operation: "unhandled-crash",
    message: "Node harness host process crashed unexpectedly.",
  }),
  "rust_app_server.startup_failure": Object.freeze({
    component: "rust-app-server",
    operation: "supervised-child-startup",
    message: "Relayer app server failed to start.",
  }),
  "rust_app_server.unexpected_exit": Object.freeze({
    component: "rust-app-server",
    operation: "supervised-child-exit",
    message: "Relayer app server exited unexpectedly.",
  }),
  "rust_graph_server.startup_failure": Object.freeze({
    component: "rust-graph-server",
    operation: "supervised-child-startup",
    message: "Relayer graph server failed to start.",
  }),
  "rust_graph_server.unexpected_exit": Object.freeze({
    component: "rust-graph-server",
    operation: "supervised-child-exit",
    message: "Relayer graph server exited unexpectedly.",
  }),
});

const QUEUE_VERSION = 1;
const MAX_QUEUE_RECORDS = 32;
const MAX_ENCRYPTED_QUEUE_BYTES = 256 * 1024;
const MAX_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const ENVIRONMENTS = new Set(["development", "preview", "stable"]);

const EXCEPTION_CLASSES = new Set([
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

function validFrame(frame, component) {
  const segments = typeof frame?.module === "string" ? frame.module.split("/") : [];
  if (!exactKeys(frame, ["module", "line", "column"])
    || typeof frame.module !== "string"
    || frame.module.length === 0
    || frame.module.length > 256
    || frame.module.startsWith("/")
    || frame.module.includes("\\")
    || !/^[A-Za-z0-9._/-]+$/u.test(frame.module)
    || segments.some((segment) => segment === "." || segment === ".." || segment === "node_modules" || segment === "vendor")
    || !validSourcePosition(frame.line)
    || !validSourcePosition(frame.column)) return false;
  const prefix = {
    renderer: "desktop/renderer/",
    "electron-main": "desktop/main/",
    "node-harness-host": "packages/harness-host/",
    "rust-app-server": "crates/relayer-app-server/",
    "rust-graph-server": "crates/relayer-graph-server/",
  }[component];
  return frame.module.startsWith(prefix)
    && isApprovedTelemetryModule(component, frame.module)
    && (component.startsWith("rust-") ? frame.module.endsWith(".rs") : /\.(?:[cm]?js|ts)$/u.test(frame.module));
}

function validateRecord(record, component) {
  if (!exactKeys(record, ["code", "exceptionClass", "frames"])) return null;
  const definition = EVENT_DEFINITIONS[record.code];
  if (!definition || definition.component !== component) return null;
  if (record.exceptionClass !== null && !EXCEPTION_CLASSES.has(record.exceptionClass)) return null;
  if (!Array.isArray(record.frames) || record.frames.length > 32 || record.frames.some((frame) => !validFrame(frame, component))) return null;
  return Object.freeze({
    code: record.code,
    operation: definition.operation,
    message: definition.message,
    exceptionClass: record.exceptionClass,
    frames: Object.freeze(record.frames.map((frame) => Object.freeze({ ...frame }))),
  });
}

function pseudonym(subject) {
  return createHash("sha256")
    .update("graphcomplete-sentry-user-v1\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
}

function validateEvent(event) {
  if (!exactKeys(event, [
    "user", "release", "environment", "os", "architecture", "component",
    "operation", "code", "message", "exceptionClass", "frames",
  ]) || !exactKeys(event.user, ["id"]) || !/^[a-f0-9]{64}$/u.test(event.user.id)) return false;
  if (![event.release, event.environment, event.os, event.architecture].every((value) => typeof value === "string" && value.length > 0)) return false;
  const sanitized = validateRecord({
    code: event.code,
    exceptionClass: event.exceptionClass,
    frames: event.frames,
  }, event.component);
  return sanitized !== null
    && event.operation === sanitized.operation
    && event.message === sanitized.message;
}

export function createAuthenticatedErrorGateway({
  queuePath,
  encrypt,
  decrypt,
  transport,
  release,
  environment,
  os,
  architecture,
  now = Date.now,
  randomBytes = nodeRandomBytes,
} = {}) {
  if (typeof queuePath !== "string" || !queuePath
    || typeof encrypt !== "function"
    || typeof decrypt !== "function"
    || typeof transport?.enable !== "function"
    || typeof transport?.disable !== "function"
    || typeof transport?.send !== "function"
    || ![release, environment, os, architecture].every((value) => typeof value === "string" && value.length > 0)
    || !ENVIRONMENTS.has(environment)
    || typeof now !== "function"
    || typeof randomBytes !== "function") {
    throw new TypeError("Authenticated error gateway dependencies are invalid.");
  }

  let identity = null;
  let desiredIdentity = null;
  let latestGeneration = 0;
  let latestGenerationUserId = null;
  let currentEnvironment = environment;
  let transportIdentity = null;
  let closed = false;
  const reporters = new Set();
  const reporterByComponent = new Map();
  const latestProcessGenerationByComponent = new Map();
  let operationQueue = Promise.resolve();

  function serialize(operation) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => undefined);
    return result;
  }

  function revokeReporters() {
    for (const reporter of reporters) reporter.active = false;
    reporters.clear();
    reporterByComponent.clear();
  }

  async function clearQueue() {
    await rm(queuePath, { force: true });
  }

  async function loadQueue() {
    let envelope;
    try {
      envelope = JSON.parse(await readFile(queuePath, "utf8"));
      if (!exactKeys(envelope, ["version", "sealed"])
        || envelope.version !== QUEUE_VERSION
        || typeof envelope.sealed !== "string"
        || Buffer.byteLength(envelope.sealed, "utf8") > MAX_ENCRYPTED_QUEUE_BYTES) throw new Error("invalid queue envelope");
      const payload = JSON.parse(await decrypt(envelope.sealed));
      if (!exactKeys(payload, ["version", "records"])
        || payload.version !== QUEUE_VERSION
        || !Array.isArray(payload.records)
        || payload.records.length > MAX_QUEUE_RECORDS) throw new Error("invalid queue payload");
      for (const record of payload.records) {
        if (!exactKeys(record, ["accountId", "generation", "occurredAt", "event"])
          || !/^[a-f0-9]{64}$/u.test(record.accountId)
          || !Number.isSafeInteger(record.generation)
          || record.generation < 1
          || !Number.isSafeInteger(record.occurredAt)
          || record.occurredAt < 0
          || !validateEvent(record.event)
          || record.event.release !== release
          || !ENVIRONMENTS.has(record.event.environment)
          || record.event.os !== os
          || record.event.architecture !== architecture
          || record.event.user.id !== record.accountId) throw new Error("invalid queue record");
      }
      return payload.records;
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      await clearQueue().catch(() => undefined);
      return [];
    }
  }

  async function saveQueue(inputRecords) {
    let records = inputRecords.slice(-MAX_QUEUE_RECORDS);
    let sealed = null;
    while (records.length > 0) {
      sealed = await encrypt(JSON.stringify({ version: QUEUE_VERSION, records }));
      if (typeof sealed !== "string") throw new Error("Queue encryption returned an invalid value.");
      if (Buffer.byteLength(sealed, "utf8") <= MAX_ENCRYPTED_QUEUE_BYTES) break;
      records = records.slice(1);
      sealed = null;
    }
    if (records.length === 0 || sealed === null) {
      await clearQueue();
      return false;
    }
    await mkdir(dirname(queuePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${queuePath}.${process.pid}.${Buffer.from(randomBytes(12)).toString("base64url")}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ version: QUEUE_VERSION, sealed })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, queuePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return true;
  }

  function freshRecords(records) {
    const currentTime = now();
    return records.filter((record) => currentTime - record.occurredAt <= MAX_RECORD_AGE_MS);
  }

  function transportProjection(boundIdentity) {
    return Object.freeze({
      user: Object.freeze({ id: boundIdentity.userId }),
      release,
      environment: currentEnvironment,
      os,
      architecture,
    });
  }

  async function disableTransport() {
    transportIdentity = null;
    try {
      await transport.disable();
      return true;
    } catch {
      return false;
    }
  }

  async function enableTransport(boundIdentity) {
    try {
      await transport.enable(transportProjection(boundIdentity));
      if (desiredIdentity !== boundIdentity || closed) {
        await disableTransport();
        return false;
      }
      transportIdentity = boundIdentity;
      return true;
    } catch {
      transportIdentity = null;
      return false;
    }
  }

  async function flushQueue(boundIdentity) {
    const records = freshRecords(await loadQueue());
    if (records.length === 0) {
      await clearQueue();
      return;
    }
    if (records.some((record) => record.accountId !== boundIdentity.userId)) {
      await clearQueue();
      return;
    }
    const remaining = [];
    let deliveryFailed = false;
    for (const record of records) {
      if (identity !== boundIdentity || transportIdentity !== boundIdentity || closed || deliveryFailed) {
        remaining.push(record);
        continue;
      }
      try {
        if (!validateEvent(record.event)) throw new Error("Queued event failed final validation.");
        await transport.send(record.event);
      } catch {
        deliveryFailed = true;
        remaining.push(record);
      }
    }
    if (remaining.length === 0) await clearQueue();
    else await saveQueue(remaining);
  }

  return Object.freeze({
    async transitionIdentity(next) {
      if (next === null) {
        desiredIdentity = null;
        identity = null;
        revokeReporters();
        await serialize(() => disableTransport());
        return;
      }
      if (!exactKeys(next, ["generation", "subject"])
        || !Number.isSafeInteger(next.generation)
        || next.generation < 1
        || typeof next.subject !== "string"
        || next.subject.length === 0) {
        throw new TypeError("Verified error-reporting identity is invalid.");
      }
      const nextUserId = pseudonym(next.subject);
      if (next.generation < latestGeneration
        || (next.generation === latestGeneration
          && latestGenerationUserId !== null
          && latestGenerationUserId !== nextUserId)) {
        return;
      }
      const previous = identity;
      latestGeneration = Math.max(latestGeneration, next.generation);
      latestGenerationUserId = nextUserId;
      const boundIdentity = Object.freeze({ generation: next.generation, userId: nextUserId });
      desiredIdentity = boundIdentity;
      identity = null;
      revokeReporters();
      await serialize(async () => {
        await disableTransport();
        if (desiredIdentity !== boundIdentity || closed) return;
        if (previous !== null && previous.userId !== boundIdentity.userId) {
          await clearQueue();
        }
        if (desiredIdentity !== boundIdentity || closed) return;
        identity = boundIdentity;
        await enableTransport(boundIdentity);
        await flushQueue(boundIdentity);
      }).catch(() => undefined);
    },

    issueReporter({ component, processGeneration } = {}) {
      if (closed || identity === null) return null;
      if (!COMPONENTS.has(component)
        || !Number.isSafeInteger(processGeneration)
        || processGeneration < 1) {
        throw new TypeError("Error reporter identity is invalid.");
      }
      const latestProcessGeneration = latestProcessGenerationByComponent.get(component) ?? 0;
      if (processGeneration < latestProcessGeneration) {
        throw new Error("Error reporter process generation is stale.");
      }
      latestProcessGenerationByComponent.set(component, processGeneration);
      const boundIdentity = identity;
      const prior = reporterByComponent.get(component);
      if (prior) {
        prior.active = false;
        reporters.delete(prior);
      }
      const state = { active: true, component, processGeneration };
      reporters.add(state);
      reporterByComponent.set(component, state);
      return Object.freeze({
        async report(record) {
          if (closed || !state.active || identity !== boundIdentity) {
            return Object.freeze({ accepted: false, reason: "stale-capability" });
          }
          const sanitized = validateRecord(record, component);
          if (!sanitized) return Object.freeze({ accepted: false, reason: "invalid-record" });
          const event = Object.freeze({
            user: Object.freeze({ id: boundIdentity.userId }),
            release,
            environment: currentEnvironment,
            os,
            architecture,
            component,
            ...sanitized,
          });
          if (!validateEvent(event)) return Object.freeze({ accepted: false, reason: "invalid-record" });
          return serialize(async () => {
            if (closed || !state.active || identity !== boundIdentity) {
              return Object.freeze({ accepted: false, reason: "stale-capability" });
            }
            try {
              if (!validateEvent(event)) return Object.freeze({ accepted: false, reason: "invalid-record" });
              if (transportIdentity !== boundIdentity) throw new Error("Authenticated error transport is inactive.");
              await transport.send(event);
              return Object.freeze({ accepted: true, delivery: "sent" });
            } catch {
              try {
                const records = freshRecords(await loadQueue())
                  .filter((queued) => queued.accountId === boundIdentity.userId);
                records.push({
                  accountId: boundIdentity.userId,
                  generation: boundIdentity.generation,
                  occurredAt: now(),
                  event,
                });
                const persisted = await saveQueue(records);
                return Object.freeze({ accepted: true, delivery: persisted ? "queued" : "dropped" });
              } catch {
                return Object.freeze({ accepted: true, delivery: "dropped" });
              }
            }
          });
        },
        revoke() {
          state.active = false;
          reporters.delete(state);
          if (reporterByComponent.get(component) === state) reporterByComponent.delete(component);
        },
      });
    },

    async retireIdentity() {
      desiredIdentity = null;
      identity = null;
      revokeReporters();
      await serialize(async () => {
        await disableTransport();
        await clearQueue();
      }).catch(() => undefined);
    },

    async updateEnvironment(nextEnvironment) {
      if (!ENVIRONMENTS.has(nextEnvironment)) throw new TypeError("Error-reporting environment is invalid.");
      if (nextEnvironment === currentEnvironment) return;
      const boundIdentity = identity;
      identity = null;
      revokeReporters();
      await serialize(async () => {
        await disableTransport();
        currentEnvironment = nextEnvironment;
        if (boundIdentity === null || desiredIdentity !== boundIdentity || closed) return;
        identity = boundIdentity;
        await enableTransport(boundIdentity);
        await flushQueue(boundIdentity);
      }).catch(() => undefined);
    },

    async close() {
      closed = true;
      desiredIdentity = null;
      identity = null;
      revokeReporters();
      await operationQueue;
      await disableTransport();
    },
  });
}
