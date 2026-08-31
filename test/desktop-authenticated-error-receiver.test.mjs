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

describe("authenticated error receiver", () => {
  it("exposes only an opaque bearer capability and forwards one closed record over loopback", async () => {
    const { gateway, send } = await fixture();
    const receiver = await createAuthenticatedErrorReceiver({ gateway });
    cleanups.push(() => receiver.close());
    const capability = receiver.issue({
      component: "node-harness-host",
      processGeneration: 4,
    });
    cleanups.push(() => capability.revoke());

    expect(Object.keys(capability).sort()).toEqual(["authorization", "endpoint", "revoke"]);
    const endpoint = new URL(capability.endpoint);
    expect(endpoint.hostname).toBe("127.0.0.1");
    expect(endpoint.pathname).toBe("/v1/authenticated-errors/report");
    expect(capability.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/u);

    const response = await fetch(capability.endpoint, {
      method: "POST",
      headers: {
        authorization: capability.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        code: "node_harness_host.unhandled_crash",
        exceptionClass: "Error",
        frames: [{ module: "packages/harness-host/dist/host.js", line: 27, column: 4 }],
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects the wrong route, authority, media type, oversized body, and non-record JSON before reporting", async () => {
    const { gateway, send } = await fixture();
    const receiver = await createAuthenticatedErrorReceiver({ gateway });
    cleanups.push(() => receiver.close());
    const capability = receiver.issue({
      component: "renderer",
      processGeneration: 1,
    });
    cleanups.push(() => capability.revoke());
    const headers = { authorization: capability.authorization, "content-type": "application/json" };

    const wrongMethod = await fetch(capability.endpoint, { method: "GET", headers });
    const wrongPath = await fetch(new URL("/wrong", capability.endpoint), { method: "POST", headers, body: "{}" });
    const wrongAuth = await fetch(capability.endpoint, {
      method: "POST", headers: { ...headers, authorization: "Bearer wrong" }, body: "{}",
    });
    const wrongType = await fetch(capability.endpoint, {
      method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "{}",
    });
    const invalidJson = await fetch(capability.endpoint, { method: "POST", headers, body: "[1,2,3]" });
    const advertisedOversize = await fetch(capability.endpoint, {
      method: "POST", headers, body: `{"padding":"${"x".repeat(64 * 1024)}"}`,
    });
    const streamedOversize = await requestChunks(capability.endpoint, {
      headers: { ...headers, "transfer-encoding": "chunked" },
      chunks: ["{".repeat(32 * 1024), "x".repeat(32 * 1024 + 1)],
    });

    expect(wrongMethod.status).toBe(404);
    expect(wrongPath.status).toBe(404);
    expect(wrongAuth.status).toBe(404);
    expect(wrongType.status).toBe(415);
    expect(invalidJson.status).toBe(400);
    expect(advertisedOversize.status).toBe(413);
    expect(streamedOversize.status).toBe(413);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects stale account, stale process, and revoked bearer capabilities", async () => {
    const { gateway, send } = await fixture();
    const receiver = await createAuthenticatedErrorReceiver({ gateway });
    cleanups.push(() => receiver.close());
    const accountStale = receiver.issue({
      component: "renderer", processGeneration: 1,
    });
    cleanups.push(() => accountStale.revoke());
    await gateway.transitionIdentity({ generation: 2, subject: "auth0|receiver-person" });
    const accountResponse = await fetch(accountStale.endpoint, {
      method: "POST",
      headers: { authorization: accountStale.authorization, "content-type": "application/json" },
      body: JSON.stringify({ code: "renderer.unhandled_crash", exceptionClass: null, frames: [] }),
    });
    expect(accountResponse.status).toBe(403);

    const processStale = receiver.issue({
      component: "renderer", processGeneration: 2,
    });
    cleanups.push(() => processStale.revoke());
    const current = receiver.issue({
      component: "renderer", processGeneration: 3,
    });
    cleanups.push(() => current.revoke());
    const processResponse = await fetch(processStale.endpoint, {
      method: "POST",
      headers: { authorization: processStale.authorization, "content-type": "application/json" },
      body: JSON.stringify({ code: "renderer.unhandled_crash", exceptionClass: null, frames: [] }),
    });
    expect(processResponse.status).toBe(403);

    await current.revoke();
    const revokedResponse = await fetch(current.endpoint, {
      method: "POST",
      headers: { authorization: current.authorization, "content-type": "application/json" },
      body: "{}",
    });
    expect(revokedResponse.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it("contains reporting failures behind a fixed response without logging or recursive reporting", async () => {
    const report = vi.fn(async () => { throw new Error("private raw reporting failure"); });
    const revoke = vi.fn();
    const gateway = { issueReporter: vi.fn(() => ({ report, revoke })) };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const receiver = await createAuthenticatedErrorReceiver({ gateway });
    cleanups.push(() => receiver.close());
    const capability = receiver.issue({
      component: "rust-app-server", processGeneration: 7,
    });
    cleanups.push(() => capability.revoke());

    const response = await fetch(capability.endpoint, {
      method: "POST",
      headers: { authorization: capability.authorization, "content-type": "application/json" },
      body: JSON.stringify({ code: "rust_app_server.unexpected_exit", exceptionClass: null, frames: [] }),
    });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toBe('{"accepted":false}\n');
    expect(body).not.toContain("private raw reporting failure");
    expect(report).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does not bind a receiver while the gateway has no verified reporter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-error-receiver-unsigned-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const gateway = createAuthenticatedErrorGateway({
      queuePath: join(directory, "queue.json"),
      encrypt: async (value) => value,
      decrypt: async (value) => value,
      transport: { enable: async () => {}, disable: async () => {}, send: async () => {} },
      release: "ai.relayer.desktop@0.2.16+receiver-fixture",
      environment: "preview",
      os: "darwin",
      architecture: "arm64",
    });
    cleanups.push(() => gateway.close());

    const receiver = await createAuthenticatedErrorReceiver({ gateway });
    cleanups.push(() => receiver.close());
    expect(receiver.issue({ component: "rust-graph-server", processGeneration: 1 })).toBeNull();
  });

  it("shares one receiver endpoint across components and closes every issued reporter together", async () => {
    const rendererReporter = { report: vi.fn(async () => ({ accepted: true })), revoke: vi.fn() };
    const graphServerReporter = { report: vi.fn(async () => ({ accepted: true })), revoke: vi.fn() };
    const pendingReporters = [rendererReporter, graphServerReporter];
    const gateway = { issueReporter: vi.fn(() => pendingReporters.shift()) };
    const receiver = await createAuthenticatedErrorReceiver({ gateway });
    const renderer = receiver.issue({ component: "renderer", processGeneration: 1 });
    const graphServer = receiver.issue({ component: "rust-graph-server", processGeneration: 8 });

    expect(renderer.endpoint).toBe(graphServer.endpoint);
    await receiver.close();
    expect(gateway.issueReporter).toHaveBeenCalledTimes(2);
    expect(rendererReporter.revoke).toHaveBeenCalledTimes(1);
    expect(graphServerReporter.revoke).toHaveBeenCalledTimes(1);
    await expect(fetch(renderer.endpoint, {
      method: "POST",
      headers: { authorization: renderer.authorization, "content-type": "application/json" },
      body: "{}",
    })).rejects.toThrow();
  });
});
