import { describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";

import {
  MODEL_CATALOG_REFRESH_PATH,
  MODEL_CATALOG_REFRESH_TIMEOUT_MS,
  startModelCatalogRefreshServer,
} from "../desktop/main/models/model-catalog-refresh-server.mjs";

function request(service, init = {}) {
  return fetch(new URL(MODEL_CATALOG_REFRESH_PATH, service.session.origin), {
    method: "POST",
    headers: { Authorization: `Bearer ${service.session.token}` },
    ...init,
  });
}

function requestWithHost(service, host) {
  return new Promise((resolve, reject) => {
    const outbound = httpRequest(new URL(MODEL_CATALOG_REFRESH_PATH, service.session.origin), {
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
  it("allows account and model discovery to use their provider request budgets", () => {
    expect(MODEL_CATALOG_REFRESH_TIMEOUT_MS).toBeGreaterThan(40_000);
  });

  it("binds only to IPv4 loopback and authenticates one bodyless refresh per request", async () => {
    const refresh = vi.fn(async () => {});
    const service = await startModelCatalogRefreshServer({ refresh });
    try {
      expect(service.session.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(service.session.token).toMatch(/^[a-f0-9]{64}$/);

      expect((await fetch(new URL(MODEL_CATALOG_REFRESH_PATH, service.session.origin), { method: "POST" })).status).toBe(401);
      expect((await request(service, { method: "GET" })).status).toBe(405);
      expect(await requestWithHost(service, "attacker.invalid")).toBe(400);
      expect((await fetch(new URL("/not-found", service.session.origin), {
        method: "POST",
        headers: { Authorization: `Bearer ${service.session.token}` },
      })).status).toBe(404);
      expect((await request(service, { body: "not empty" })).status).toBe(400);
      expect((await request(service, { body: "x".repeat(1_025) })).status).toBe(413);
      expect(refresh).not.toHaveBeenCalled();

      const response = await request(service);
      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      await service.close();
    }
    await expect(request(service)).rejects.toThrow();
  });

  it("fails closed on refresh failure and bounds a stalled refresh", async () => {
    const failed = await startModelCatalogRefreshServer({
      refresh: async () => { throw new Error("private provider detail"); },
    });
    try {
      const response = await request(failed);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Model catalog refresh failed." });
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
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: "Model catalog refresh timed out." });
      expect(discoveryAborted).toBe(true);
    } finally {
      await stalled.close();
    }
  });

  it("closes its listener and active socket within the shutdown bound", async () => {
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const service = await startModelCatalogRefreshServer({
      refresh: () => {
        markStarted();
        return new Promise(() => {});
      },
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 25,
    });
    const pendingRequest = request(service);
    await started;
    const closeStartedAt = Date.now();

    await service.close();

    expect(Date.now() - closeStartedAt).toBeLessThan(250);
    await expect(pendingRequest).rejects.toThrow();
    await expect(request(service)).rejects.toThrow();
  });
});
