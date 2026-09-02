import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthenticatedErrorGateway } from "../desktop/main/services/authenticated-error-gateway.mjs";
import { createAuthenticatedErrorReceiver } from "../desktop/main/services/authenticated-error-receiver.mjs";

const cleanups = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "relayer-error-receiver-"));
  const send = vi.fn(async () => {});
  const gateway = createAuthenticatedErrorGateway({
    queuePath: join(directory, "queue.json"),
    encrypt: async (value) => Buffer.from(value).toString("base64"),
    decrypt: async (value) => Buffer.from(value, "base64").toString("utf8"),
    transport: { enable: async () => {}, disable: async () => {}, send },
    release: "ai.relayer.desktop@0.2.16+receiver-fixture",
    environment: "preview",
    os: "darwin",
    architecture: "arm64",
  });
  await gateway.transitionIdentity({ generation: 1, subject: "auth0|receiver-person" });
  cleanups.push(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { gateway, send };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function requestChunks(endpoint, { method = "POST", headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(endpoint, { method, headers }, (response) => {
      const received = [];
      response.on("data", (chunk) => received.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(received).toString("utf8"),
      }));
    });
    request.once("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

function postJson(endpoint, authorization, body) {
  return fetch(endpoint, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body,
  });
}

describe("authenticated error receiver", () => {
  it("admits loopback capabilities and rejects the complete unauthorized request corpus", async () => {
    const { gateway, send } = await fixture();
    const receiver = await createAuthenticatedErrorReceiver({ gateway });
    cleanups.push(() => receiver.close());
    const capability = receiver.issue({
      component: "node-harness-host",
      processGeneration: 4,
    });
    cleanups.push(() => capability.revoke());

    expect(Object.keys(capability).sort(), "capability exposes only endpoint, authorization, and revoke")
      .toEqual(["authorization", "endpoint", "revoke"]);
    const endpoint = new URL(capability.endpoint);
    expect(endpoint.hostname, "capability binds only to loopback").toBe("127.0.0.1");
    expect(endpoint.pathname, "capability serves the versioned report route").toBe("/v1/authenticated-errors/report");
    expect(capability.authorization, "capability bears an opaque 32-byte token").toMatch(/^Bearer [A-Za-z0-9_-]{43}$/u);

    const headers = { authorization: capability.authorization, "content-type": "application/json" };
    const rejections = [
      ["non-POST method is not routed", await fetch(capability.endpoint, { method: "GET", headers }), 404],
      ["unknown path is not routed", await fetch(new URL("/wrong", capability.endpoint), { method: "POST", headers, body: "{}" }), 404],
      ["wrong bearer token is not routed", await postJson(capability.endpoint, "Bearer wrong", "{}"), 404],
      ["non-JSON media type is refused", await fetch(capability.endpoint, {
        method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "{}",
      }), 415],
      ["non-record JSON is refused", await postJson(capability.endpoint, capability.authorization, "[1,2,3]"), 400],
      ["advertised oversized body is refused", await postJson(capability.endpoint, capability.authorization, `{"padding":"${"x".repeat(64 * 1024)}"}`), 413],
      ["streamed oversized body is refused", await requestChunks(capability.endpoint, {
        headers: { ...headers, "transfer-encoding": "chunked" },
        chunks: ["{".repeat(32 * 1024), "x".repeat(32 * 1024 + 1)],
      }), 413],
    ];
    expect(rejections, "unauthorized request inventory").toHaveLength(7);
    for (const [label, response, status] of rejections) {
      expect.soft(response.status, label).toBe(status);
    }
    expect(send, "no rejected request reached the gateway").not.toHaveBeenCalled();

    const accepted = await postJson(capability.endpoint, capability.authorization, JSON.stringify({
      code: "node_harness_host.unhandled_crash",
      exceptionClass: "Error",
      frames: [{ module: "packages/harness-host/dist/host.js", line: 27, column: 4 }],
    }));
    expect(accepted.status, "one closed record is forwarded over loopback").toBe(202);
    expect(await accepted.json(), "forwarded record is acknowledged").toEqual({ accepted: true });
    expect(send, "exactly one record reached the gateway").toHaveBeenCalledTimes(1);

    await gateway.transitionIdentity({ generation: 2, subject: "auth0|receiver-person" });
    const staleAccount = await postJson(capability.endpoint, capability.authorization, JSON.stringify({
      code: "node_harness_host.unhandled_crash", exceptionClass: null, frames: [],
    }));
    expect(staleAccount.status, "account-generation change rejects the issued capability").toBe(403);

    const processStale = receiver.issue({ component: "node-harness-host", processGeneration: 5 });
    cleanups.push(() => processStale.revoke());
    const current = receiver.issue({ component: "node-harness-host", processGeneration: 6 });
    cleanups.push(() => current.revoke());
    const staleProcess = await postJson(processStale.endpoint, processStale.authorization, JSON.stringify({
      code: "node_harness_host.unhandled_crash", exceptionClass: null, frames: [],
    }));
    expect(staleProcess.status, "process restart rejects superseded capabilities").toBe(403);

    await current.revoke();
    const revoked = await postJson(current.endpoint, current.authorization, "{}");
    expect(revoked.status, "revoked bearer is unroutable").toBe(404);
    expect(send, "stale and revoked capabilities never reach the gateway").toHaveBeenCalledTimes(1);
  }, 15_000);

  it("contains failure, refuses unsigned binding, and shuts the shared endpoint down for every component", async () => {
    const unsignedDirectory = await mkdtemp(join(tmpdir(), "relayer-error-receiver-unsigned-"));
    cleanups.push(() => rm(unsignedDirectory, { recursive: true, force: true }));
    const unsignedGateway = createAuthenticatedErrorGateway({
      queuePath: join(unsignedDirectory, "queue.json"),
      encrypt: async (value) => value,
      decrypt: async (value) => value,
      transport: { enable: async () => {}, disable: async () => {}, send: async () => {} },
      release: "ai.relayer.desktop@0.2.16+receiver-fixture",
      environment: "preview",
      os: "darwin",
      architecture: "arm64",
    });
    cleanups.push(() => unsignedGateway.close());
    const unsignedReceiver = await createAuthenticatedErrorReceiver({ gateway: unsignedGateway });
    cleanups.push(() => unsignedReceiver.close());
    expect(unsignedReceiver.issue({ component: "rust-graph-server", processGeneration: 1 }),
      "no capability binds while the gateway has no verified reporter").toBeNull();

    const failingReport = vi.fn(async () => { throw new Error("private raw reporting failure"); });
    const failingGateway = { issueReporter: vi.fn(() => ({ report: failingReport, revoke: vi.fn() })) };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingReceiver = await createAuthenticatedErrorReceiver({ gateway: failingGateway });
    cleanups.push(() => failingReceiver.close());
    const failingCapability = failingReceiver.issue({ component: "rust-app-server", processGeneration: 7 });
    cleanups.push(() => failingCapability.revoke());

    const failureResponse = await postJson(failingCapability.endpoint, failingCapability.authorization, JSON.stringify({
      code: "rust_app_server.unexpected_exit", exceptionClass: null, frames: [],
    }));
    const failureBody = await failureResponse.text();
    expect(failureResponse.status, "reporter failure answers with a fixed unavailable status").toBe(503);
    expect(failureBody, "reporter failure answers with a fixed body").toBe('{"accepted":false}\n');
    expect(failureBody, "the raw failure never leaks to the caller").not.toContain("private raw reporting failure");
    expect(failingReport, "the reporter was attempted exactly once").toHaveBeenCalledTimes(1);
    expect(consoleError, "reporter failure is not logged").not.toHaveBeenCalled();
    consoleError.mockRestore();

    const rendererReporter = { report: vi.fn(async () => ({ accepted: true })), revoke: vi.fn() };
    const graphServerReporter = { report: vi.fn(async () => ({ accepted: true })), revoke: vi.fn() };
    const pendingReporters = [rendererReporter, graphServerReporter];
    const sharedGateway = { issueReporter: vi.fn(() => pendingReporters.shift()) };
    const sharedReceiver = await createAuthenticatedErrorReceiver({ gateway: sharedGateway });
    const renderer = sharedReceiver.issue({ component: "renderer", processGeneration: 1 });
    const graphServer = sharedReceiver.issue({ component: "rust-graph-server", processGeneration: 8 });

    expect(renderer.endpoint, "every component shares one loopback endpoint").toBe(graphServer.endpoint);
    await sharedReceiver.close();
    expect(sharedGateway.issueReporter, "one reporter binds per issued component").toHaveBeenCalledTimes(2);
    expect(rendererReporter.revoke, "close revokes the renderer reporter").toHaveBeenCalledTimes(1);
    expect(graphServerReporter.revoke, "close revokes the graph-server reporter").toHaveBeenCalledTimes(1);
    await expect(postJson(renderer.endpoint, renderer.authorization, "{}"),
      "the shared endpoint stops serving after close").rejects.toThrow();
  }, 15_000);
});
