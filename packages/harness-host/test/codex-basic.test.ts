import type { Codex } from "@openai/codex-sdk";
import { describe, expect, it, vi } from "vitest";
import { CodexBasicHarness } from "../src/implementations/codex-basic.js";

describe("CodexBasicHarness", () => {
  it("rejects an unsupported saved-state version", () => {
    expect(() => new CodexBasicHarness({
      threadId: 1,
      workingDirectory: process.cwd(),
      graph: { url: "http://127.0.0.1:43123", token: "token", nodeId: 1 },
      savedState: { schemaVersion: 2, values: { codexThreadId: "codex-thread" } },
    }, { createCodex: () => ({}) as Codex })).toThrow("Unsupported codex.basic session state version: 2");
  });

  it("retains a provider thread ID when the first turn fails", async () => {
    const thread = {
      id: null as string | null,
      run: vi.fn(async () => {
        thread.id = "codex-thread-after-start";
        throw new Error("turn failed");
      }),
    };
    const codex = {
      startThread: vi.fn(() => thread),
      resumeThread: vi.fn(),
    };
    const harness = new CodexBasicHarness(
      {
        threadId: 1,
        workingDirectory: process.cwd(),
        graph: { url: "http://127.0.0.1:43123", token: "token", nodeId: 1 },
      },
      { createCodex: () => codex as unknown as Codex },
    );

    await expect(harness.complete({
      id: 1,
      kind: "user-interaction",
      icon: "user",
      title: "Question",
      detail: "Question",
      state: "accepted",
    })).rejects.toThrow("turn failed");
    expect(harness.state()).toEqual({ schemaVersion: 1, values: { codexThreadId: "codex-thread-after-start" } });
  });

  it("rotates graph credentials while resuming the same provider thread", async () => {
    const firstThread = { id: "codex-thread-1", run: vi.fn(async () => ({ finalResponse: "", items: [], usage: null })) };
    const secondThread = { id: "codex-thread-1", run: vi.fn(async () => ({ finalResponse: "", items: [], usage: null })) };
    const firstCodex = { startThread: vi.fn(() => firstThread), resumeThread: vi.fn() };
    const secondCodex = { startThread: vi.fn(), resumeThread: vi.fn(() => secondThread) };
    const environments: Record<string, string>[] = [];
    const createCodex = vi.fn((environment: Record<string, string>) => {
      environments.push(environment);
      return (environments.length === 1 ? firstCodex : secondCodex) as unknown as Codex;
    });
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      const nodeId = authorizations.length === 1 ? 1 : 2;
      return new Response(JSON.stringify({
        nodeId,
        rootAction: { id: nodeId, sourceNodeId: nodeId, kind: "navigate", label: "Response", targetLayerId: nodeId, response: true, state: "accepted" },
        rootLayer: { layer: { id: nodeId, nodes: [], edges: [], state: "accepted" }, nodes: [], edges: [], actions: [] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    try {
      const harness = new CodexBasicHarness({
        threadId: 1,
        workingDirectory: process.cwd(),
        graph: { url: "http://127.0.0.1:43123", token: "first-token", nodeId: 1 },
      }, { createCodex });

      await harness.complete(interaction(1));
      harness.setGraphCapability({ url: "http://127.0.0.1:43123", token: "second-token", nodeId: 2 });
      await harness.complete(interaction(2));

      expect(createCodex).toHaveBeenCalledTimes(2);
      expect(environments.map((environment) => [environment.RELAYER_GRAPH_TOKEN, environment.RELAYER_NODE_ID])).toEqual([
        ["first-token", "1"],
        ["second-token", "2"],
      ]);
      expect(firstCodex.startThread).toHaveBeenCalledTimes(1);
      expect(secondCodex.resumeThread).toHaveBeenCalledWith("codex-thread-1", expect.any(Object));
      expect(authorizations).toEqual(["Bearer first-token", "Bearer second-token"]);
      expect(harness.state()).toEqual({ schemaVersion: 1, values: { codexThreadId: "codex-thread-1" } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function interaction(id: number) {
  return {
    id,
    kind: "user-interaction",
    icon: "user",
    title: "Question",
    detail: "Question",
    state: "accepted" as const,
  };
}
