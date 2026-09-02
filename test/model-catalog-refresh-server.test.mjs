import { describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";

import {
  MODEL_CATALOG_REFRESH_PATH,
  MODEL_CATALOG_REFRESH_TIMEOUT_MS,
  startModelCatalogRefreshServer,
} from "../desktop/main/models/model-catalog-refresh-server.mjs";

function request(service, init = {}, providerId = "codex") {
  const url = new URL(MODEL_CATALOG_REFRESH_PATH, service.session.origin);
  url.searchParams.set("providerId", providerId);
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${service.session.token}` },
    ...init,
  });
}

function requestWithHost(service, host) {
  const url = new URL(MODEL_CATALOG_REFRESH_PATH, service.session.origin);
  url.searchParams.set("providerId", "codex");
  return new Promise((resolve, reject) => {
    const outbound = httpRequest(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${service.session.token}`,
        Host: host,
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    outbound.once("error", reject);
    outbound.end();
  });
}

describe("trusted pre-inference model catalog refresh server", () => {
  it("binds loopback, authenticates one bodyless refresh per request, fails closed, and shuts down bounded", async () => {
    expect(MODEL_CATALOG_REFRESH_TIMEOUT_MS, "provider request budget")
      .toBeGreaterThan(40_000);

    const refresh = vi.fn(async () => {});
    const service = await startModelCatalogRefreshServer({ refresh });
    try {
      expect(service.session.origin, "IPv4 loopback bind").toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(service.session.token, "bearer token shape").toMatch(/^[a-f0-9]{64}$/);

      expect((await fetch(new URL(MODEL_CATALOG_REFRESH_PATH, service.session.origin), { method: "POST" })).status, "missing token")
        .toBe(401);
      expect((await request(service, { method: "GET" })).status, "wrong method").toBe(405);
      expect(await requestWithHost(service, "attacker.invalid"), "foreign Host header").toBe(400);
      expect((await fetch(new URL("/not-found", service.session.origin), {
        method: "POST",
        headers: { Authorization: `Bearer ${service.session.token}` },
      })).status, "unknown path").toBe(404);
      expect((await fetch(new URL(MODEL_CATALOG_REFRESH_PATH, service.session.origin), {
        method: "POST",
        headers: { Authorization: `Bearer ${service.session.token}` },
      })).status, "missing providerId").toBe(400);
      expect((await request(service, {}, "🧠".repeat(201))).status, "oversized providerId").toBe(400);
      expect((await request(service, { body: "not empty" })).status, "non-empty body").toBe(400);
      expect((await request(service, { body: "x".repeat(1_025) })).status, "oversized body").toBe(413);
      expect(refresh, "rejected requests never refresh").not.toHaveBeenCalled();

      const response = await request(service);
      expect(response.status, "authenticated bodyless refresh").toBe(204);
      expect(response.headers.get("cache-control"), "no-store response").toBe("no-store");
      expect(refresh, "one refresh per accepted request").toHaveBeenCalledOnce();
      expect(refresh, "refresh receives the provider and an abort signal").toHaveBeenCalledWith({
        providerId: "codex",
        signal: expect.any(AbortSignal),
      });
      expect((await request(service, {}, "\uFEFFprovider\uFEFF")).status, "byte-exact provider identity accepted").toBe(204);
      expect(refresh, "provider identity passes through unnormalized").toHaveBeenLastCalledWith({
        providerId: "\uFEFFprovider\uFEFF",
        signal: expect.any(AbortSignal),
      });
    } finally {
      await service.close();
    }
    await expect(request(service), "closed server rejects").rejects.toThrow();

    const failed = await startModelCatalogRefreshServer({
      refresh: async () => { throw new Error("private provider detail"); },
    });
    try {
      const response = await request(failed);
      expect(response.status, "refresh failure fails closed").toBe(503);
      expect(await response.json(), "opaque failure body").toEqual({ error: "Model catalog refresh failed." });
    } finally {
      await failed.close();
    }

    let discoveryAborted = false;
    const stalled = await startModelCatalogRefreshServer({
      refresh: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          discoveryAborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
      requestTimeoutMs: 25,
      shutdownTimeoutMs: 25,
    });
    try {
      const response = await request(stalled);
      expect(response.status, "stalled refresh times out").toBe(504);
      expect(await response.json(), "timeout body").toEqual({ error: "Model catalog refresh timed out." });
      expect(discoveryAborted, "stalled discovery is aborted").toBe(true);
    } finally {
      await stalled.close();
    }

    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const shutdownBound = await startModelCatalogRefreshServer({
      refresh: () => {
        markStarted();
        return new Promise(() => {});
      },
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 25,
    });
    const pendingRequest = request(shutdownBound);
    await started;
    const closeStartedAt = Date.now();

    await shutdownBound.close();

    expect(Date.now() - closeStartedAt, "shutdown stays within its bound").toBeLessThan(250);
    await expect(pendingRequest, "active request is severed").rejects.toThrow();
    await expect(request(shutdownBound), "listener is closed").rejects.toThrow();
  }, 20_000);
});
