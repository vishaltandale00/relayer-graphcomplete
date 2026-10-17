import { afterEach, expect, it, vi } from "vitest";
import { RelayerGraphClient } from "../src/client.js";

afterEach(() => vi.unstubAllGlobals());

it("reads bounded history and inert inputs with only the current capability", async () => {
  const calls: { url: string; authorization: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, authorization: new Headers(init.headers).get("authorization") });
    return new Response(JSON.stringify({ entries: [], nextBeforeNodeId: null }));
  }));
  const graph = new RelayerGraphClient({ url: "http://graph.test", token: "current", nodeId: 99 });
  await graph.getHistory();
  await graph.getHistory({ beforeNodeId: 42, limit: 8 });
  await graph.getHistoricalInput(41, 7);
  expect(calls).toEqual([
    { url: "http://graph.test/api/graph/history?limit=20", authorization: "Bearer current" },
    { url: "http://graph.test/api/graph/history?limit=8&beforeNodeId=42", authorization: "Bearer current" },
    { url: "http://graph.test/api/graph/nodes/41/input?afterAnswerSequence=7", authorization: "Bearer current" },
  ]);
  for (const limit of [0, 51, 1.5]) await expect(graph.getHistory({ limit })).rejects.toThrow("Invalid history limit");
  await expect(graph.getHistory({ beforeNodeId: -1 })).rejects.toThrow("Invalid history cursor");
  await expect(graph.getHistoricalInput(41, -1)).rejects.toThrow("Invalid historical answer cursor");
  expect(calls).toHaveLength(3);
});
