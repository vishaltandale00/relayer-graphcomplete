import { describe, expect, it, vi } from "vitest";

import { loadAtomicAnnotationSnapshots } from "../desktop/eval-main/annotation-snapshot-loader.mjs";

const session = {
  origin: "http://127.0.0.1:4141",
  cookie: { name: "relayer_control", value: "control" },
};

describe("Eval atomic annotation snapshot loader", () => {
  it("loads every thread in one request through a one-shot session and revokes that session even when the snapshot fails", async () => {
    const calls = [];
    const healthyFetch = vi.fn(async (url, options) => {
      calls.push({ path: new URL(url).pathname, ...options });
      if (options.method === "POST" && new URL(url).pathname === "/api/annotations/snapshot") {
        return response(200, { kind: "relayer_eval_annotation_snapshot_set", threads: [] });
      }
      return response(204);
    });
    await loadAtomicAnnotationSnapshots({
      session,
      threadIds: [41, 42],
      token: "snapshot-token",
      authorId: "local:test",
      authorDisplayName: "Test",
      fetchImpl: healthyFetch,
    });
    expect(calls.map(({ path, method }) => [method, path]), "create, snapshot, revoke in order").toEqual([
      ["POST", "/api/internal/annotation-sessions"],
      ["POST", "/api/annotations/snapshot"],
      ["DELETE", "/api/internal/annotation-sessions"],
    ]);
    expect(JSON.parse(calls[1].body), "one atomic snapshot request for every thread").toEqual({ threadIds: [41, 42] });
    expect(calls[1].headers.Cookie, "snapshot request uses the one-shot annotation session").toContain("relayer_annotation=snapshot-token");

    const failingMethods = [];
    const failingFetch = vi.fn(async (url, options) => {
      failingMethods.push(options.method);
      if (new URL(url).pathname === "/api/annotations/snapshot") {
        return response(500, { error: "snapshot failed" });
      }
      return response(204);
    });
    await expect(loadAtomicAnnotationSnapshots({
      session,
      threadIds: [41],
      token: "snapshot-token",
      authorId: "local:test",
      authorDisplayName: "Test",
      fetchImpl: failingFetch,
    }), "snapshot failure surfaces the backend error").rejects.toThrow("snapshot failed");
    expect(failingMethods, "failed snapshot still revokes its one-shot session").toEqual(["POST", "POST", "DELETE"]);
  });
});

function response(status, value = undefined) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}
