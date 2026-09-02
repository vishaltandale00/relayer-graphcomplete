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
  it("admits, maps, scrubs, settles, and delivers one privacy-bounded gateway event end to end", async () => {
    const state = fixture();
    expect(state.createClient, "no client before gateway admission").not.toHaveBeenCalled();
    await expect(state.transport.enable({ ...projection, dsn: "https://override.test/1" }), "DSN override rejected at admission").rejects.toThrow();
    expect(state.createClient, "rejected admission never creates a client").not.toHaveBeenCalled();

    await state.transport.enable(projection);

    expect(state.createClient, "one client after admission").toHaveBeenCalledOnce();
    expect(state.options, "hook-free privacy-disabled client options").toMatchObject({
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
    expect(state.options, "no tracing sample rate").not.toHaveProperty("tracesSampleRate");
    expect(state.options, "no profiling sample rate").not.toHaveProperty("profilesSampleRate");
    expect(state.options.dataCollection, "SDK data collection fully disabled").toEqual({
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

    await expect(state.transport.send(gatewayEvent), "approved record delivered").resolves.toEqual({ delivered: true });

    expect(state.client.captureEvent, "one gateway record becomes one event").toHaveBeenCalledOnce();
    expect(state.client.flush, "event flushed with the configured timeout").toHaveBeenCalledWith(250);
    expect(state.accepted, "beforeSend accepted exactly one event").toHaveLength(1);
    expect(state.accepted[0], "bounded Sentry error event mapping").toMatchObject({
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
    expect(state.accepted[0], "no request envelope fields").not.toHaveProperty("request");
    expect(state.accepted[0], "no breadcrumbs").not.toHaveProperty("breadcrumbs");
    expect(state.accepted[0], "no extra payload").not.toHaveProperty("extra");
    expect(state.accepted[0], "no contexts").not.toHaveProperty("contexts");
    expect(state.accepted[0], "no server name").not.toHaveProperty("server_name");

    const prepared = state.accepted[0];
    expect(state.options.beforeSend({ ...prepared, request: { url: "https://secret.test/token" } }), "request mutation dropped").toBeNull();
    expect(state.options.beforeSend({ ...prepared, breadcrumbs: [{ message: "prompt" }] }), "breadcrumb mutation dropped").toBeNull();
    expect(state.options.beforeSend({ ...prepared, user: { ...prepared.user, email: "person@example.test" } }), "user PII mutation dropped").toBeNull();
    expect(state.options.beforeSend({ ...prepared, tags: { ...prepared.tags, path: "/Users/person/project" } }), "filesystem path tag dropped").toBeNull();
    const captured = structuredClone(gatewayEvent);
    await expect(state.transport.send({ ...captured, prompt: "private" }), "non-gateway input rejected").rejects.toThrow();
    await expect(state.transport.send({
      ...captured,
      frames: [{ module: "desktop/main/privacy-sentinel-token.mjs", line: 1, column: 1 }],
    }), "privacy sentinel frame rejected").rejects.toThrow();

    const failing = fixture({ flushResult: false });
    await failing.transport.enable(projection);
    await expect(failing.transport.send(gatewayEvent), "flush failure surfaced to the gateway").rejects.toThrow("flush");
    await expect(failing.transport.disable(), "disable reports the failed flush").rejects.toThrow();
    expect(failing.client.close, "close attempted with the configured timeout").toHaveBeenCalledWith(250);
    await expect(failing.transport.send(gatewayEvent), "no send after disable").rejects.toThrow("inactive");

    const closeFailing = fixture({ closeResult: false });
    await closeFailing.transport.enable(projection);
    await expect(closeFailing.transport.disable(), "failed close reported").rejects.toThrow("disable cleanly");
    expect(closeFailing.client.close, "close attempted once on disable").toHaveBeenCalledWith(250);

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
      await expect(transport.send(gatewayEvent), "real SDK delivery to the loopback sink").resolves.toEqual({ delivered: true });
      await expect(transport.send({ ...gatewayEvent, prompt: "private" }), "private input never reaches the sink").rejects.toThrow();

      expect(requests, "exactly one envelope sent").toHaveLength(1);
      const lines = requests[0].trim().split("\n");
      expect(lines, "envelope has header, item header, and event").toHaveLength(3);
      const envelopeHeader = JSON.parse(lines[0]);
      expect(JSON.parse(lines[1]), "event item type").toMatchObject({ type: "event" });
      const sentEvent = JSON.parse(lines[2]);
      expect(Object.keys(envelopeHeader).sort(), "minimal envelope header keys").toEqual(["event_id", "sdk", "sent_at"]);
      expect(envelopeHeader, "envelope header matches the sent event").toMatchObject({
        event_id: sentEvent.event_id,
        sdk: { name: "sentry.javascript.node", version: "10.72.0" },
      });
      expect(Object.keys(sentEvent).sort(), "privacy-bounded event keys").toEqual([
        "environment", "event_id", "exception", "level", "release", "tags",
        "timestamp", "user",
      ]);
      expect(sentEvent, "loopback event mapping").toMatchObject({
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
      expect(sentEvent, "no platform field").not.toHaveProperty("platform");
      expect(sentEvent, "no server name").not.toHaveProperty("server_name");
      expect(sentEvent, "no contexts").not.toHaveProperty("contexts");
      expect(sentEvent, "no request data").not.toHaveProperty("request");
      expect(sentEvent, "no breadcrumbs").not.toHaveProperty("breadcrumbs");
    } finally {
      await transport.disable().catch(() => undefined);
      await new Promise((resolve) => server.close(resolve));
    }
  }, 15_000);
});
