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

  it("does not start a prompt when the run was already cancelled", async () => {
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      configuration,
    }, { loadModule: async () => ({
      SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({ modelRegistry: { find: vi.fn() } })),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never });
    const controller = new AbortController();
    controller.abort(new Error("cancelled before admission"));

    await expect(harness.complete(runContext(11, "token"), controller.signal)).rejects.toThrow("cancelled before admission");
    expect(session.promptAndWait).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("does not settle a cancelled completion until Prime Agent abort settles", async () => {
    let releasePrompt!: () => void;
    const waitingForPrompt = new Promise<void>((resolve) => { releasePrompt = resolve; });
    let releaseAbort!: () => void;
    const waitingForAbort = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const session = {
      promptAndWait: vi.fn(async () => waitingForPrompt),
      abort: vi.fn(async () => {
        releasePrompt();
        await waitingForAbort;
      }),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);
    const controller = new AbortController();
    let settled = false;

    const completing = harness.complete(runContext(11, "token"), controller.signal);
    void completing.then(() => { settled = true; }, () => { settled = true; });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    releaseAbort();
    await completing;
    expect(settled).toBe(true);
  });

  it("reports a Prime Agent abort failure", async () => {
    let releasePrompt!: () => void;
    const waitingForPrompt = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const session = {
      promptAndWait: vi.fn(async () => waitingForPrompt),
      abort: vi.fn(async () => {
        releasePrompt();
        throw new Error("abort failed");
      }),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);
    const controller = new AbortController();

    const completing = harness.complete(runContext(11, "token"), controller.signal);
    controller.abort();

    await expect(completing).rejects.toThrow("abort failed");
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

async function createHarness(session: PrimeAgentSessionFixture): Promise<PrimeAgentHarness> {
  return PrimeAgentHarness.create({
    threadId: 7,
    workingDirectory: "/tmp/project",
    configuration,
  }, { loadModule: async () => ({
    SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
    createHostRequestHandler: (handler: unknown) => handler,
    createAgentSessionServices: vi.fn(async () => ({ modelRegistry: { find: vi.fn() } })),
    createAgentSessionFromServices: vi.fn(async () => ({ session })),
  }) as never });
}

interface PrimeAgentSessionFixture {
  readonly promptAndWait: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
}

function invocation(runContext: HarnessRunContext) {
  return {
    runContext,
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
}
