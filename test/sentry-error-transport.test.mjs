import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { createSentryErrorTransport } from "../desktop/main/services/sentry-error-transport.mjs";

const projection = Object.freeze({
  user: Object.freeze({ id: "a".repeat(64) }),
  release: `ai.relayer.desktop@0.2.16+${"b".repeat(40)}`,
  environment: "preview",
  os: "macos",
  architecture: "arm64",
});

const gatewayEvent = Object.freeze({
  ...projection,
  component: "electron-main",
  operation: "unhandled-crash",
  code: "electron_main.unhandled_crash",
  message: "Electron main process crashed unexpectedly.",
  exceptionClass: "TypeError",
  frames: Object.freeze([
    Object.freeze({ module: "desktop/main/index.mjs", line: 413, column: 7 }),
  ]),
});

const handledShareEvent = Object.freeze({
  ...projection,
  component: "electron-main",
  operation: "share-publication",
  code: "share.snapshot_too_large",
  message: "Shared thread publication failed.",
  exceptionClass: null,
  frames: Object.freeze([]),
  attemptReferenceId: "SHR-A1B2C3D4",
  failureStage: "export",
  snapshotBytes: 16777217,
});

const startupEvent = Object.freeze({
  ...projection,
  component: "electron-main", operation: "startup", code: "electron_main.startup_failure",
  message: "Relayer could not start.", exceptionClass: null,
  startupStage: "window-load", networkCode: "ERR_FAILED",
  frames: [
    { module: "desktop/main/index.mjs", line: 413, column: 7 },
    { module: "desktop/main/window.mjs", line: 42, column: 2 },
  ],
});

function fixture({ flushResult = true, closeResult = true } = {}) {
  const accepted = [];
  let options;
  const client = {
    captureEvent: vi.fn((event) => {
      const prepared = {
        ...structuredClone(event),
        event_id: "c".repeat(32),
        timestamp: 1_900_000_000,
      };
      const filtered = options.beforeSend(prepared);
      if (filtered) accepted.push(filtered);
      return prepared.event_id;
    }),
    flush: vi.fn(async () => flushResult),
    close: vi.fn(async () => closeResult),
  };
  const createClient = vi.fn((value) => {
    options = value;
    return client;
  });
  const transport = createSentryErrorTransport({
    dsn: "https://public@example.test/1",
    createClient,
    flushTimeoutMs: 250,
  });
  return { transport, createClient, client, accepted, get options() { return options; } };
}

describe("Sentry error transport", () => {
  it("creates a hook-free privacy-disabled client only after gateway admission", async () => {
    const state = fixture();
    expect(state.createClient).not.toHaveBeenCalled();
    await expect(state.transport.enable({ ...projection, dsn: "https://override.test/1" })).rejects.toThrow();
    expect(state.createClient).not.toHaveBeenCalled();

    await state.transport.enable(projection);

    expect(state.createClient).toHaveBeenCalledOnce();
    expect(state.options).toMatchObject({
      dsn: "https://public@example.test/1",
      release: projection.release,
      environment: "preview",
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
    });
    expect(state.options).not.toHaveProperty("tracesSampleRate");
    expect(state.options).not.toHaveProperty("profilesSampleRate");
    expect(state.options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    });
  });

  it("maps one approved gateway record to one bounded Sentry error event and flushes it", async () => {
    const state = fixture();
    await state.transport.enable(projection);
    await expect(state.transport.send(gatewayEvent)).resolves.toEqual({ delivered: true });

    expect(state.client.captureEvent).toHaveBeenCalledOnce();
    expect(state.client.flush).toHaveBeenCalledWith(250);
    expect(state.accepted).toHaveLength(1);
    expect(state.accepted[0]).toMatchObject({
      level: "error",
      user: { id: projection.user.id },
      release: projection.release,
      environment: "preview",
      tags: {
        component: "electron-main",
        operation: "unhandled-crash",
        failure_code: "electron_main.unhandled_crash",
        os: "macos",
        architecture: "arm64",
      },
      exception: {
        values: [{
          type: "TypeError",
          value: "Electron main process crashed unexpectedly.",
          stacktrace: {
            frames: [{
              filename: "desktop/main/index.mjs",
              lineno: 413,
              colno: 7,
              in_app: true,
            }],
          },
        }],
      },
    });
    expect(state.accepted[0]).not.toHaveProperty("request");
    expect(state.accepted[0]).not.toHaveProperty("breadcrumbs");
    expect(state.accepted[0]).not.toHaveProperty("extra");
    expect(state.accepted[0]).not.toHaveProperty("contexts");
    expect(state.accepted[0]).not.toHaveProperty("server_name");
  });

  it("maps the closed handled-share schema without admitting content or request fields", async () => {
    const state = fixture();
    await state.transport.enable(projection);
    await expect(state.transport.send(handledShareEvent)).resolves.toEqual({ delivered: true });

    expect(state.accepted).toHaveLength(1);
    expect(state.accepted[0].tags).toEqual({
      component: "electron-main",
      operation: "share-publication",
      failure_code: "share.snapshot_too_large",
      os: "macos",
      architecture: "arm64",
      attempt_reference: "SHR-A1B2C3D4",
      failure_stage: "export",
      snapshot_bytes: "16777217",
    });
    await expect(state.transport.send({
      ...handledShareEvent,
      title: "private title",
    })).rejects.toThrow();
  });

  it("validates share diagnostics at both transport boundaries and orders frames for Sentry", async () => {
    const state = fixture();
    await state.transport.enable(projection);
    const event = { ...handledShareEvent, httpStatus: 503, networkCode: "ECONNRESET", frames: [
      { module: "desktop/main/services/share-service-client.mjs", line: 66, column: 3 },
      { module: "desktop/main/services/share-publish-coordinator.mjs", line: 348, column: 5 },
    ] };
    await state.transport.send(event);
    const prepared = state.accepted[0];
    expect(prepared.exception.values[0].stacktrace.frames.map((frame) => frame.lineno)).toEqual([348, 66]);
    for (const mutation of [
      { httpStatus: 600 }, { httpStatus: "503" }, { networkCode: "private-native-error" },
      { frames: [{ module: "desktop/main/private.mjs", line: 1, column: 1 }] },
      { frames: Array.from({ length: 33 }, () => event.frames[0]) },
    ]) await expect(state.transport.send({ ...event, ...mutation })).rejects.toThrow();
    const partial = { ...event };
    delete partial.networkCode;
    await expect(state.transport.send(partial)).rejects.toThrow();
    for (const tags of [
      { http_status: "600" }, { http_status: "503 private" }, { network_code: "private-native-error" },
      { http_status: 503 }, { network_code: null },
      { http_status: { toString: () => "503", secret: "private" } },
    ]) expect(state.options.beforeSend({ ...prepared, tags: { ...prepared.tags, ...tags } })).toBeNull();
    for (const removedTags of [["http_status"], ["network_code"], ["http_status", "network_code"]]) {
      const tags = { ...prepared.tags };
      for (const key of removedTags) delete tags[key];
      expect(state.options.beforeSend({ ...prepared, tags })).toBeNull();
    }
    expect(state.options.beforeSend({ ...prepared, exception: { values: [{ ...prepared.exception.values[0],
      stacktrace: { frames: [{ filename: "/Users/private/file.mjs", lineno: 1, colno: 1, in_app: true }] },
    }] } })).toBeNull();
    expect(state.accepted).toHaveLength(1);
  });

  it("maps a handled fatal startup event and rejects mutation at each final validator", async () => {
    const state = fixture();
    await state.transport.enable(projection);
    await expect(state.transport.send(startupEvent)).resolves.toEqual({ delivered: true });
    expect(state.accepted).toHaveLength(1);
    const prepared = state.accepted[0];
    expect(prepared.level).toBe("fatal");
    expect(prepared.tags).toEqual({
      component: "electron-main", operation: "startup", failure_code: "electron_main.startup_failure",
      os: "macos", architecture: "arm64", startup_stage: "window-load", network_code: "ERR_FAILED",
    });
    expect(prepared.exception.values[0].stacktrace.frames.map((frame) => frame.lineno)).toEqual([42, 413]);
    for (const mutation of [
      { startupStage: "private-stage" }, { networkCode: "SECRET_NATIVE_ERROR" },
      { component: "renderer" }, { code: "electron_main.unhandled_crash" },
      { message: "ERR_FAILED loading http://127.0.0.1/private" }, { url: "http://private" },
      { frames: [{ module: "desktop/main/private.mjs", line: 1, column: 2 }] },
    ]) await expect(state.transport.send({ ...startupEvent, ...mutation })).rejects.toThrow();
    for (const key of ["startupStage", "networkCode"]) {
      const event = { ...startupEvent }; delete event[key];
      await expect(state.transport.send(event)).rejects.toThrow();
    }
    for (const mutation of [
      { startup_stage: "private-stage" }, { network_code: "SECRET_NATIVE_ERROR" },
      { component: "renderer" }, { failure_code: "electron_main.unhandled_crash" },
      { url: "http://private" },
    ]) expect(state.options.beforeSend({ ...prepared, tags: { ...prepared.tags, ...mutation } })).toBeNull();
    for (const key of ["startup_stage", "network_code"]) {
      const tags = { ...prepared.tags }; delete tags[key];
      expect(state.options.beforeSend({ ...prepared, tags })).toBeNull();
    }
    expect(state.options.beforeSend({ ...prepared, level: "error" })).toBeNull();
    expect(state.options.beforeSend({ ...prepared, exception: { values: [{ ...prepared.exception.values[0], value: "private-message" }] } })).toBeNull();
    expect(state.options.beforeSend({ ...prepared, logs: "private-log" })).toBeNull();
  });

  it("drops SDK or hook mutation at beforeSend and rejects non-gateway input", async () => {
    const state = fixture();
    await state.transport.enable(projection);
    const captured = structuredClone(gatewayEvent);
    await state.transport.send(captured);
    const prepared = state.accepted[0];

    expect(state.options.beforeSend({ ...prepared, request: { url: "https://secret.test/token" } })).toBeNull();
    expect(state.options.beforeSend({ ...prepared, breadcrumbs: [{ message: "prompt" }] })).toBeNull();
    expect(state.options.beforeSend({ ...prepared, user: { ...prepared.user, email: "person@example.test" } })).toBeNull();
    expect(state.options.beforeSend({ ...prepared, tags: { ...prepared.tags, path: "/Users/person/project" } })).toBeNull();
    await expect(state.transport.send({ ...captured, prompt: "private" })).rejects.toThrow();
    await expect(state.transport.send({
      ...captured,
      frames: [{ module: "desktop/main/privacy-sentinel-token.mjs", line: 1, column: 1 }],
    })).rejects.toThrow();
  });

  it("flushes and closes on disable while surfacing delivery failures to the gateway", async () => {
    const state = fixture({ flushResult: false });
    await state.transport.enable(projection);

    await expect(state.transport.send(gatewayEvent)).rejects.toThrow("flush");
    await expect(state.transport.disable()).rejects.toThrow();
    expect(state.client.close).toHaveBeenCalledWith(250);
    await expect(state.transport.send(gatewayEvent)).rejects.toThrow("inactive");

    const closeState = fixture({ closeResult: false });
    await closeState.transport.enable(projection);
    await expect(closeState.transport.disable()).rejects.toThrow("disable cleanly");
    expect(closeState.client.close).toHaveBeenCalledWith(250);
  });

  it("sends privacy-bounded crash and startup envelopes through the real SDK transport to a loopback sink", async () => {
    const requests = [];
    const server = createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        requests.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200);
        response.end();
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const transport = createSentryErrorTransport({
      dsn: `http://public@127.0.0.1:${address.port}/1`,
      flushTimeoutMs: 1_000,
    });

    try {
      await transport.enable(projection);
      await expect(transport.send(gatewayEvent)).resolves.toEqual({ delivered: true });
      await expect(transport.send(startupEvent)).resolves.toEqual({ delivered: true });
      await expect(transport.send({ ...gatewayEvent, prompt: "private" })).rejects.toThrow();

      expect(requests).toHaveLength(2);
      const startupSent = JSON.parse(requests[1].trim().split("\n")[2]);
      expect(startupSent).toMatchObject({
        level: "fatal", tags: { failure_code: "electron_main.startup_failure", startup_stage: "window-load", network_code: "ERR_FAILED" },
      });
      expect(Object.keys(startupSent).sort()).toEqual(["environment", "event_id", "exception", "level", "release", "tags", "timestamp", "user"]);
      const lines = requests[0].trim().split("\n");
      expect(lines).toHaveLength(3);
      const envelopeHeader = JSON.parse(lines[0]);
      expect(JSON.parse(lines[1])).toMatchObject({ type: "event" });
      const sentEvent = JSON.parse(lines[2]);
      expect(Object.keys(envelopeHeader).sort()).toEqual(["event_id", "sdk", "sent_at"]);
      expect(envelopeHeader).toMatchObject({
        event_id: sentEvent.event_id,
        sdk: { name: "sentry.javascript.node", version: "10.72.0" },
      });
      expect(Object.keys(sentEvent).sort()).toEqual([
        "environment", "event_id", "exception", "level", "release", "tags",
        "timestamp", "user",
      ]);
      expect(sentEvent).toMatchObject({
        level: "error",
        user: { id: projection.user.id },
        release: projection.release,
        environment: projection.environment,
        tags: {
          component: gatewayEvent.component,
          operation: gatewayEvent.operation,
          failure_code: gatewayEvent.code,
          os: projection.os,
          architecture: projection.architecture,
        },
      });
      expect(sentEvent).not.toHaveProperty("platform");
      expect(sentEvent).not.toHaveProperty("server_name");
      expect(sentEvent).not.toHaveProperty("contexts");
      expect(sentEvent).not.toHaveProperty("request");
      expect(sentEvent).not.toHaveProperty("breadcrumbs");
    } finally {
      await transport.disable().catch(() => undefined);
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
