import type { Codex } from "@openai/codex-sdk";
import { describe, expect, it, vi } from "vitest";
import { CodexBasicHarness } from "../src/implementations/codex-basic.js";
import type { HarnessConfiguration } from "../src/types.js";

const codexBasicConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "codex-basic",
  implementation: "codex.basic",
  implementationVersion: 1,
  permissionBindings: {
    ask: { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user", networkAccessEnabled: true },
    auto: { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review", networkAccessEnabled: true },
    full: { sandboxMode: "danger-full-access", approvalPolicy: "never" },
  },
  settings: {
    model: "gpt-test",
    modelReasoningEffort: "medium",
    webSearchMode: "disabled",
    skipGitRepoCheck: true,
  },
};

describe("CodexBasicHarness", () => {
  it("rejects an unsupported implementation version", () => {
    expect(() => new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "auto",
      permissionBinding: codexBasicConfiguration.permissionBindings.auto!,
      workingDirectory: process.cwd(),
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
        permissionProfileId: "auto",
        permissionBinding: codexBasicConfiguration.permissionBindings.auto!,
        workingDirectory: process.cwd(),
        configuration: codexBasicConfiguration,
      },
      { createCodex: () => codex as unknown as Codex },
    );

    await expect(harness.complete(runContext(1, "token"))).rejects.toThrow("turn failed");
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
      approvalPolicy: "on-request",
      networkAccessEnabled: true,
      webSearchMode: "disabled",
      skipGitRepoCheck: true,
    });
  });

  it("passes the packaged executable override to the Codex process", async () => {
    const thread = { id: "codex-thread", run: vi.fn(async () => ({ finalResponse: "", items: [], usage: null })) };
    const createCodex = vi.fn(() => ({ startThread: () => thread }) as unknown as Codex);
    const harness = new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "auto",
      permissionBinding: codexBasicConfiguration.permissionBindings.auto!,
      workingDirectory: process.cwd(),
      configuration: codexBasicConfiguration,
    }, {
      createCodex,
      codexPathOverride: "/Applications/Relayer.app/Contents/Resources/codex",
    });
    await harness.complete(runContext(1, "token"));

    expect(createCodex).toHaveBeenCalledWith(
      expect.objectContaining({ RELAYER_GRAPH_TOKEN: "token", RELAYER_NODE_ID: "1" }),
      "/Applications/Relayer.app/Contents/Resources/codex",
      { approvals_reviewer: "auto_review" },
    );
  });

  it("translates the three product profiles without adding a fixture-only profile", async () => {
    const cases = [
      ["ask", { sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccessEnabled: true }, { approvals_reviewer: "user" }],
      ["auto", { sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccessEnabled: true }, { approvals_reviewer: "auto_review" }],
      ["full", { sandboxMode: "danger-full-access", approvalPolicy: "never" }, {}],
    ] as const;
    expect(Object.keys(codexBasicConfiguration.permissionBindings)).toEqual(["ask", "auto", "full"]);
    for (const [permissionProfileId, expectedThreadOptions, expectedCodexConfig] of cases) {
      const thread = { id: null, run: vi.fn(async () => { throw new Error("stop after options"); }) };
      const codex = { startThread: vi.fn(() => thread), resumeThread: vi.fn() };
      const createCodex = vi.fn(() => codex as unknown as Codex);
      const harness = new CodexBasicHarness({
        threadId: 1,
        permissionProfileId,
        permissionBinding: codexBasicConfiguration.permissionBindings[permissionProfileId]!,
        workingDirectory: process.cwd(),
        configuration: codexBasicConfiguration,
      }, { createCodex });
      await expect(harness.complete(runContext(1, "token"))).rejects.toThrow("stop after options");
      expect(createCodex).toHaveBeenCalledWith(expect.any(Object), undefined, expectedCodexConfig);
      expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining(expectedThreadOptions));
    }
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
    const harness = new CodexBasicHarness({
        threadId: 1,
        permissionProfileId: "auto",
        permissionBinding: codexBasicConfiguration.permissionBindings.auto!,
        workingDirectory: process.cwd(),
        configuration: codexBasicConfiguration,
      }, { createCodex });

    await harness.complete({ ...runContext(1, "first-token"), model: { providerId: "codex", modelId: "gpt-first" } });
    await harness.complete({ ...runContext(2, "second-token"), model: { providerId: "codex", modelId: "gpt-second" } });

    expect(createCodex).toHaveBeenCalledTimes(2);
    expect(environments.map((environment) => [environment.RELAYER_GRAPH_TOKEN, environment.RELAYER_NODE_ID])).toEqual([
      ["first-token", "1"],
      ["second-token", "2"],
    ]);
    expect(firstCodex.startThread).toHaveBeenCalledTimes(1);
    expect(firstCodex.startThread).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-first" }));
    expect(secondCodex.resumeThread).toHaveBeenCalledWith("codex-thread-1", expect.objectContaining({ model: "gpt-second" }));
    expect(harness.state()).toEqual({ codexThreadId: "codex-thread-1" });
  });

  it("rejects a provider model that codex.basic cannot execute before starting a thread", async () => {
    const codex = { startThread: vi.fn(), resumeThread: vi.fn() };
    const harness = new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "auto",
      permissionBinding: codexBasicConfiguration.permissionBindings.auto!,
      workingDirectory: process.cwd(),
      configuration: codexBasicConfiguration,
    }, { createCodex: () => codex as unknown as Codex });

    await expect(harness.complete({
      ...runContext(1, "token"),
      model: { providerId: "future-provider", modelId: "future-model" },
    })).rejects.toThrow("codex.basic cannot run provider future-provider");
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(codex.resumeThread).not.toHaveBeenCalled();
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

function runContext(id: number, token: string) {
  return {
    inputGraph: interaction(id),
    graph: {
      interactionNodeId: id,
      acquireCapability: () => ({ url: "http://127.0.0.1:43123", token, nodeId: id }),
    },
  };
}
