import type { Codex } from "@openai/codex-sdk";
import { describe, expect, it, vi } from "vitest";
import { CodexBasicHarness } from "../src/implementations/codex-basic.js";
import type { HarnessConfiguration } from "../src/types.js";

const codexBasicConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "codex-basic",
  implementation: "codex.basic",
  implementationVersion: 1,
  settings: {
    model: "gpt-test",
    modelReasoningEffort: "medium",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: true,
    webSearchMode: "disabled",
    skipGitRepoCheck: true,
  },
};

describe("CodexBasicHarness", () => {
  it("rejects an unsupported implementation version", () => {
    expect(() => new CodexBasicHarness({
      threadId: 1,
      workingDirectory: process.cwd(),
      graph: { url: "http://127.0.0.1:43123", token: "token", nodeId: 1 },
      configuration: { ...codexBasicConfiguration, implementationVersion: 2 },
      savedState: { codexThreadId: "codex-thread" },
    }, { createCodex: () => ({}) as Codex })).toThrow("Unsupported codex.basic implementation version: 2");
  });

  it("retains a provider thread ID when the first turn fails", async () => {
    let submittedPrompt = "";
    const thread = {
      id: null as string | null,
      run: vi.fn(async (prompt: string) => {
        submittedPrompt = prompt;
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
        configuration: codexBasicConfiguration,
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
    expect(harness.state()).toEqual({ codexThreadId: "codex-thread-after-start" });
    expect(submittedPrompt).toContain("Relayer graph affordances:");
    expect(submittedPrompt).toContain("system temporary directory, not in the project checkout");
    expect(submittedPrompt).toContain("first-class options");
    expect(submittedPrompt).toContain("must use exactly one supported Relayer icon name");
    expect(submittedPrompt).toContain("compass");
    expect(submittedPrompt).toContain("square-dashed-kanban");
    expect(submittedPrompt).toContain('graph.addAction(node, { kind: "navigate"');
    expect(submittedPrompt).toContain('"chip": the most compact inline action');
    expect(submittedPrompt).toContain('"card": a full-width action');
    expect(submittedPrompt).toContain("footprint guidance is advisory, not a limit");
    expect(submittedPrompt).toContain("author multiple cards");
    expect(codex.startThread).toHaveBeenCalledWith({
      workingDirectory: process.cwd(),
      model: "gpt-test",
      modelReasoningEffort: "medium",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      webSearchMode: "disabled",
      skipGitRepoCheck: true,
    });
  });

  it("passes the packaged executable override to the Codex process", () => {
    const createCodex = vi.fn(() => ({}) as Codex);
    new CodexBasicHarness({
      threadId: 1,
      workingDirectory: process.cwd(),
      graph: { url: "http://127.0.0.1:43123", token: "token", nodeId: 1 },
      configuration: codexBasicConfiguration,
    }, {
      createCodex,
      codexPathOverride: "/Applications/Relayer.app/Contents/Resources/codex",
    });

    expect(createCodex).toHaveBeenCalledWith(
      expect.objectContaining({ RELAYER_GRAPH_TOKEN: "token", RELAYER_NODE_ID: "1" }),
      "/Applications/Relayer.app/Contents/Resources/codex",
    );
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
        rootAction: { id: nodeId, sourceNodeId: nodeId, kind: "navigate", label: "Response", variant: "pill", targetLayerId: nodeId, response: true, state: "accepted" },
        rootLayer: { layer: { id: nodeId, nodes: [], edges: [], state: "accepted" }, nodes: [], edges: [], actions: [] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    try {
      const harness = new CodexBasicHarness({
        threadId: 1,
        workingDirectory: process.cwd(),
        graph: { url: "http://127.0.0.1:43123", token: "first-token", nodeId: 1 },
        configuration: codexBasicConfiguration,
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
      expect(harness.state()).toEqual({ codexThreadId: "codex-thread-1" });
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
