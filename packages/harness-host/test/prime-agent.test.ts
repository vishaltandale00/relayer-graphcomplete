import { describe, expect, it, vi } from "vitest";
import { PrimeAgentHarness } from "../src/implementations/prime-agent.js";
import type { HarnessConfiguration, HarnessRunContext } from "../src/types.js";

const configuration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "prime-agent-basic",
  implementation: "prime.agent",
  implementationVersion: 1,
  settings: { thinkingLevel: "medium", rlmMaxDepth: 2, prewarmIpythonKernel: true },
};

describe("PrimeAgentHarness", () => {
  it("keeps one Prime Agent session while passing a distinct context to each run", async () => {
    const prompts: { text: string; runContext: HarnessRunContext }[] = [];
    const session = {
      sessionFile: "/tmp/prime-session.jsonl",
      promptAndWait: vi.fn(async (text: string, options: { runContext: HarnessRunContext }) => { prompts.push({ text, runContext: options.runContext }); }),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    let graphHandler: ((payload: Record<string, unknown>, context: any) => Promise<Record<string, unknown>>) | undefined;
    const selectedModel = { provider: "openai-codex", id: "gpt-test" };
    const services = { modelRegistry: { find: vi.fn(() => selectedModel) } };
    const createAgentSessionFromServices = vi.fn(async () => ({ session }));
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      configuration: { ...configuration, settings: { ...configuration.settings, model: selectedModel } },
    }, { loadModule: async () => ({
      SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: typeof graphHandler) => { graphHandler = handler; return handler; },
      createAgentSessionServices: vi.fn(async () => services),
      createAgentSessionFromServices,
    }) as never });

    const first = runContext(11, "first-token");
    const second = runContext(12, "second-token");
    await harness.complete(first);
    await harness.complete(second);

    expect(createAgentSessionFromServices).toHaveBeenCalledTimes(1);
    expect(services.modelRegistry.find).toHaveBeenCalledWith("openai-codex", "gpt-test");
    expect(createAgentSessionFromServices).toHaveBeenCalledWith(expect.objectContaining({ model: selectedModel }));
    expect(prompts.map(({ runContext }) => runContext)).toEqual([first, second]);
    expect(prompts[0]!.text).toContain("graph = await GraphSession.current()");
    expect(prompts[0]!.text).toContain("await graph.submit(11)");
    await expect(graphHandler?.({}, invocation(first))).resolves.toEqual({
      url: "http://127.0.0.1:43123",
      token: "first-token",
      nodeId: 11,
    });
    expect(harness.state()).toEqual({ primeAgentSessionFile: "/tmp/prime-session.jsonl" });
  });

  it("opens saved Prime Agent state and forwards cancellation", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const session = {
      sessionFile: "/tmp/saved.jsonl",
      promptAndWait: vi.fn(async () => waiting),
      abort: vi.fn(async () => { release(); }),
      dispose: vi.fn(),
    };
    const open = vi.fn(() => "opened-session");
    const services = { modelRegistry: { find: vi.fn() } };
    const createAgentSessionFromServices = vi.fn(async () => ({ session }));
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      configuration,
      savedState: { primeAgentSessionFile: "/tmp/saved.jsonl" },
    }, { loadModule: async () => ({
      SessionManager: { create: vi.fn(), open },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => services),
      createAgentSessionFromServices,
    }) as never });
    const controller = new AbortController();

    const completing = harness.complete(runContext(11, "token"), controller.signal);
    controller.abort();
    await completing;

    expect(open).toHaveBeenCalledWith("/tmp/saved.jsonl");
    expect(createAgentSessionFromServices).toHaveBeenCalledWith(expect.objectContaining({ sessionManager: "opened-session", services }));
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported implementation settings before loading Prime Agent", async () => {
    const loadModule = vi.fn();
    await expect(PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      configuration: { ...configuration, settings: { model: "invalid" } },
    }, { loadModule })).rejects.toThrow("model must contain provider and id");
    expect(loadModule).not.toHaveBeenCalled();
  });
});

function runContext(nodeId: number, token: string): HarnessRunContext {
  return {
    inputGraph: { id: nodeId, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" },
    graph: {
      interactionNodeId: nodeId,
      acquireCapability: () => ({ url: "http://127.0.0.1:43123", token, nodeId }),
    },
  };
}

function invocation(runContext: HarnessRunContext) {
  return {
    runContext,
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
}
