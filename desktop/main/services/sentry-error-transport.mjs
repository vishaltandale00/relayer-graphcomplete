import { randomBytes } from "node:crypto";

import {
  NodeClient,
  Scope,
  defaultStackParser,
  makeNodeTransport,
} from "@sentry/node";

import { isApprovedTelemetryModule } from "../../shared/telemetry-module-inventory.mjs";
import { exactKeys, validSourcePosition } from "../../shared/telemetry-validation.mjs";

const ENVIRONMENTS = new Set(["development", "preview", "stable"]);
const COMPONENT_PREFIXES = Object.freeze({
  renderer: "desktop/renderer/",
  "electron-main": "desktop/main/",
  "node-harness-host": "packages/harness-host/",
  "rust-app-server": "crates/relayer-app-server/",
  "rust-graph-server": "crates/relayer-graph-server/",
});
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
const SENTRY_SDK_VERSION = "10.72.0";

function validModule(module, component) {
  if (typeof module !== "string"
    || module.length === 0
    || module.length > 256
    || module.startsWith("/")
    || module.includes("\\")
    || !/^[A-Za-z0-9._/-]+$/u.test(module)) return false;
  const segments = module.split("/");
  const prefix = COMPONENT_PREFIXES[component];
  return typeof prefix === "string"
    && module.startsWith(prefix)
    && isApprovedTelemetryModule(component, module)
    && !segments.some((segment) => segment === "." || segment === ".." || segment === "node_modules" || segment === "vendor")
    && (component.startsWith("rust-") ? module.endsWith(".rs") : /\.(?:[cm]?js|ts)$/u.test(module));
}

function validGatewayFrame(frame, component) {
  return exactKeys(frame, ["module", "line", "column"])
    && validModule(frame.module, component)
    && validSourcePosition(frame.line)
    && validSourcePosition(frame.column);
}

function validateProjection(value) {
  if (!exactKeys(value, ["user", "release", "environment", "os", "architecture"])
    || !exactKeys(value.user, ["id"])
    || !/^[a-f0-9]{64}$/u.test(value.user.id)
    || typeof value.release !== "string"
    || value.release.length === 0
    || !ENVIRONMENTS.has(value.environment)
    || typeof value.os !== "string"
    || value.os.length === 0
    || typeof value.architecture !== "string"
    || value.architecture.length === 0) {
    throw new TypeError("Sentry gateway projection is invalid.");
  }
  return Object.freeze({
    user: Object.freeze({ id: value.user.id }),
    release: value.release,
    environment: value.environment,
    os: value.os,
    architecture: value.architecture,
  });
}

function validateGatewayEvent(event, projection) {
  const keys = [
    "user", "release", "environment", "os", "architecture", "component",
    "operation", "code", "message", "exceptionClass", "frames",
  ];
  if (!exactKeys(event, keys)
    || !exactKeys(event.user, ["id"])
    || event.user.id !== projection.user.id
    || event.release !== projection.release
    || event.environment !== projection.environment
    || event.os !== projection.os
    || event.architecture !== projection.architecture
    || !Object.hasOwn(COMPONENT_PREFIXES, event.component)
    || typeof event.operation !== "string"
    || !/^[a-z0-9-]+$/u.test(event.operation)
    || typeof event.code !== "string"
    || !/^[a-z0-9_.]+$/u.test(event.code)
    || typeof event.message !== "string"
    || event.message.length === 0
    || event.message.length > 256
    || (event.exceptionClass !== null && !EXCEPTION_CLASSES.has(event.exceptionClass))
    || !Array.isArray(event.frames)
    || event.frames.length > 32
    || event.frames.some((frame) => !validGatewayFrame(frame, event.component))) {
    throw new TypeError("Sentry gateway event is invalid.");
  }
}

function mapEvent(event) {
  return {
    level: "error",
    user: { id: event.user.id },
    release: event.release,
    environment: event.environment,
    tags: {
      component: event.component,
      operation: event.operation,
      failure_code: event.code,
      os: event.os,
      architecture: event.architecture,
    },
    exception: {
      values: [{
        type: event.exceptionClass ?? "Error",
        value: event.message,
        stacktrace: {
          frames: event.frames.map((frame) => ({
            filename: frame.module,
            lineno: frame.line,
            colno: frame.column,
            in_app: true,
          })),
        },
      }],
    },
  };
}

function validSentryFrame(frame, component) {
  return exactKeys(frame, ["filename", "lineno", "colno", "in_app"])
    && validModule(frame.filename, component)
    && validSourcePosition(frame.lineno)
    && validSourcePosition(frame.colno)
    && frame.in_app === true;
}

function isApprovedSentryEvent(event, projection) {
  const topLevelKeys = [
    "environment", "event_id", "exception", "level", "release", "tags",
    "timestamp", "user",
  ];
  if (!exactKeys(event, topLevelKeys)
    || event.level !== "error"
    || event.release !== projection.release
    || event.environment !== projection.environment
    || !/^[a-f0-9]{32}$/u.test(event.event_id)
    || typeof event.timestamp !== "number"
    || !Number.isFinite(event.timestamp)
    || event.timestamp < 0
    || !exactKeys(event.user, ["id"])
    || event.user.id !== projection.user.id
    || !exactKeys(event.tags, ["component", "operation", "failure_code", "os", "architecture"])
    || event.tags.os !== projection.os
    || event.tags.architecture !== projection.architecture
    || !Object.hasOwn(COMPONENT_PREFIXES, event.tags.component)
    || typeof event.tags.operation !== "string"
    || !/^[a-z0-9-]+$/u.test(event.tags.operation)
    || typeof event.tags.failure_code !== "string"
    || !/^[a-z0-9_.]+$/u.test(event.tags.failure_code)
    || !exactKeys(event.exception, ["values"])
    || !Array.isArray(event.exception.values)
    || event.exception.values.length !== 1) return false;
  const [exception] = event.exception.values;
  return exactKeys(exception, ["type", "value", "stacktrace"])
    && EXCEPTION_CLASSES.has(exception.type)
    && typeof exception.value === "string"
    && exception.value.length > 0
    && exception.value.length <= 256
    && exactKeys(exception.stacktrace, ["frames"])
    && Array.isArray(exception.stacktrace.frames)
    && exception.stacktrace.frames.length <= 32
    && exception.stacktrace.frames.every((frame) => validSentryFrame(frame, event.tags.component));
}

function fixedSdkMetadata(value) {
  return exactKeys(value, ["name", "version", "integrations", "packages", "settings"])
    && value.name === "sentry.javascript.node"
    && value.version === SENTRY_SDK_VERSION
    && Array.isArray(value.integrations)
    && value.integrations.length === 0
    && Array.isArray(value.packages)
    && value.packages.length === 1
    && exactKeys(value.packages[0], ["name", "version"])
    && value.packages[0].name === "npm:@sentry/node"
    && value.packages[0].version === SENTRY_SDK_VERSION
    && value.settings === undefined;
}

function approvedEnvelope(envelope, beforeSend) {
  if (!Array.isArray(envelope)
    || envelope.length !== 2
    || !exactKeys(envelope[0], ["event_id", "sent_at", "sdk"])
    || !/^[a-f0-9]{32}$/u.test(envelope[0].event_id)
    || typeof envelope[0].sent_at !== "string"
    || !exactKeys(envelope[0].sdk, ["name", "version"])
    || envelope[0].sdk.name !== "sentry.javascript.node"
    || envelope[0].sdk.version !== SENTRY_SDK_VERSION
    || !Array.isArray(envelope[1])
    || envelope[1].length !== 1) return null;
  const [item] = envelope[1];
  if (!Array.isArray(item)
    || item.length !== 2
    || !exactKeys(item[0], ["type"])
    || item[0].type !== "event"
    || !exactKeys(item[1], [
      "environment", "event_id", "exception", "level", "release", "sdk",
      "tags", "timestamp", "user",
    ])
    || !fixedSdkMetadata(item[1].sdk)) return null;
  const { sdk: _sdk, ...event } = item[1];
  if (envelope[0].event_id !== event.event_id || beforeSend(event) !== event) return null;
  return [
    { ...envelope[0] },
    [[{ ...item[0] }, structuredClone(event)]],
  ];
}

function privacyNodeTransport(transportOptions, beforeSend) {
  const transport = makeNodeTransport(transportOptions);
  return Object.freeze({
    send(envelope) {
      const approved = approvedEnvelope(envelope, beforeSend);
      return approved === null ? Promise.resolve({}) : transport.send(approved);
    },
    flush(timeout) {
      return transport.flush(timeout);
    },
  });
}

class PrivacyNodeClient extends NodeClient {
  _prepareEvent(event, hint = {}) {
    return Promise.resolve({
      ...event,
      event_id: event.event_id ?? hint.event_id ?? randomBytes(16).toString("hex"),
      timestamp: event.timestamp ?? Date.now() / 1_000,
    });
  }
}

function defaultCreateClient(options) {
  const client = new PrivacyNodeClient({
    ...options,
    transport: (transportOptions) => privacyNodeTransport(transportOptions, options.beforeSend),
    stackParser: defaultStackParser,
  });
  const scope = new Scope();
  scope.setClient(client);
  client.init();
  return Object.freeze({
    captureEvent(event) {
      return client.captureEvent(event, {}, scope);
    },
    flush(timeout) {
      return client.flush(timeout);
    },
    close(timeout) {
      return client.close(timeout);
    },
  });
}

function clientOptions({ dsn, projection, beforeSend }) {
  return Object.freeze({
    dsn,
    release: projection.release,
    environment: projection.environment,
    defaultIntegrations: [],
    integrations: [],
    sendDefaultPii: false,
    sendClientReports: false,
    maxBreadcrumbs: 0,
    enableLogs: false,
    attachStacktrace: false,
    autoSessionTracking: false,
    skipOpenTelemetrySetup: true,
    registerEsmLoaderHooks: false,
    includeServerName: false,
    serverName: undefined,
    runtime: Object.freeze({ name: "", version: "" }),
    dataCollection: Object.freeze({
      userInfo: false,
      cookies: false,
      httpHeaders: Object.freeze({ request: false, response: false }),
      httpBodies: Object.freeze([]),
      urlQueryParams: false,
      graphQL: Object.freeze({ document: false, variables: false }),
      genAI: Object.freeze({ inputs: false, outputs: false }),
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    }),
    beforeSend,
  });
}

export function createSentryErrorTransport({
  dsn,
  createClient = defaultCreateClient,
  flushTimeoutMs = 2_000,
} = {}) {
  if (typeof dsn !== "string"
    || dsn.length === 0
    || typeof createClient !== "function"
    || !Number.isSafeInteger(flushTimeoutMs)
    || flushTimeoutMs < 1) {
    throw new TypeError("Sentry error transport dependencies are invalid.");
  }

  let active = null;

  async function disable() {
    const current = active;
    active = null;
    if (current === null) return;

    const failures = [];
    try {
      if (await current.client.flush(flushTimeoutMs) !== true) {
        failures.push(new Error("Sentry error transport flush failed."));
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      if (await current.client.close(flushTimeoutMs) !== true) {
        failures.push(new Error("Sentry error transport close failed."));
      }
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Sentry error transport failed to disable cleanly.");
    }
  }

  return Object.freeze({
    async enable(value) {
      const projection = validateProjection(value);
      if (active !== null) await disable();
      const beforeSend = (event) => isApprovedSentryEvent(event, projection) ? event : null;
      const client = createClient(clientOptions({ dsn, projection, beforeSend }));
      if (typeof client?.captureEvent !== "function"
        || typeof client?.flush !== "function"
        || typeof client?.close !== "function") {
        throw new TypeError("Sentry client factory returned an invalid client.");
      }
      active = Object.freeze({ client, projection });
    },

    async disable() {
      await disable();
    },

    async send(event) {
      const current = active;
      if (current === null) throw new Error("Sentry error transport is inactive.");
      validateGatewayEvent(event, current.projection);
      current.client.captureEvent(mapEvent(event));
      if (await current.client.flush(flushTimeoutMs) !== true) {
        throw new Error("Sentry error transport flush failed.");
      }
      return Object.freeze({ delivered: true });
    },
  });
}
