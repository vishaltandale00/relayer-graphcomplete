import { describe, expect, it, vi } from "vitest";
import { PrimeAgentHarness } from "../src/implementations/prime-agent.js";
import { createNoopHarnessTraceSink } from "../src/trace.js";
import type { HarnessConfiguration, HarnessRunContext, HarnessTraceEventInput, HarnessTraceSink } from "../src/types.js";

const configuration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "prime-agent-basic",
  implementation: "prime.agent",
  implementationVersion: 1,
  permissionBindings: { full: {} },
  settings: { thinkingLevel: "medium", rlmMaxDepth: 1, prewarmIpythonKernel: true },
};
const fullPermission = { permissionProfileId: "full", permissionBinding: {} } as const;

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
      ...fullPermission,
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
    expect(prompts[0]!.text).toContain("exactly one NodePlacementObject(node, x, y) per member node");
    expect(prompts[0]!.text).toContain("Place a one-node layer at (0.5, 0.5)");
    expect(prompts[0]!.text).toContain("explicit descriptive client_key");
    expect(prompts[0]!.text).toContain("rerun the same authoring code with the same client_key values");
    expect(prompts[0]!.text).toContain("Do not add fake navigation");
    expect(prompts[0]!.text).toContain("await graph.discard_layer(layer)");
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
      ...fullPermission,
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

  it("uses the separate layered-navigation prompt profile", async () => {
    let prompt = "";
    const session = {
      promptAndWait: vi.fn(async (text: string) => { prompt = text; }),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      ...fullPermission,
      configuration: {
        ...configuration,
        name: "prime-agent-layered-navigation-luna",
        settings: { ...configuration.settings, promptProfile: "layered-navigation-v1" },
      },
    }, { loadModule: async () => ({
      SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({ modelRegistry: { find: vi.fn() } })),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never });

    await harness.complete(runContext(11, "token"));

    expect(prompt).toContain('relation="expand"');
    expect(prompt).toContain('relation="reference"');
    expect(prompt).toContain("A flat answer is valid");
    expect(prompt).toContain("Author in whatever order fits the task");
    expect(prompt).toContain("final graph call must be await graph.submit(11)");
    expect(prompt).toContain("await graph.get_node(11)");
    expect(prompt).toContain("await graph.get_neighbors(11)");
    expect(prompt).toContain("ordinary graph.submit(11) automatically fulfills any lease");
    expect(prompt).toContain("There is no separate resolve_action call");
    expect(prompt).toContain("Never mention or expose the size justification");
    expect(prompt).toContain("Every new root, expansion, and reference layer requires a version-1 LayerLayoutObject");
    expect(prompt).toContain("align comparisons deliberately");
    expect(prompt).toContain('NodeObject("info", "Summary", "...", client_key="summary-node")');
    expect(prompt).not.toContain('NodeObject("lightbulb"');
    expect(prompt).toContain('client_key="root-response"');
    expect(prompt).toContain('client_key="node-detail"');
    expect(prompt).toContain('client_key="node-evidence"');
    expect(prompt).toContain('client_key="node-follow-up"');
    expect(prompt).toContain("rerun it with the same client_key values");
    expect(prompt).toContain("Do not add fake navigate or reference actions");
    expect(prompt).toContain("await graph.discard_layer(layer)");
  });

  it("delivers the same ordered normalized context to Prime and its native children", async () => {
    let prompt = "";
    const session = {
      promptAndWait: vi.fn(async (text: string) => { prompt = text; }),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);

    await harness.complete(attachedRunContext(11, "token"));

    expect(prompt).toContain('"message": "Question"');
    expect(prompt.indexOf('"title": "First target"')).toBeLessThan(prompt.indexOf('"title": "Second target"'));
    expect(prompt.indexOf('"first annotation"')).toBeLessThan(prompt.indexOf('"second annotation"'));
    expect(prompt).toContain("product assigns no semantic precedence");
    expect(prompt).toContain("including in native child agents");
    expect(prompt).toContain("await graph.get_interaction_input()");
    expect(prompt).not.toContain("sourceNodeId");
    expect(prompt).not.toContain("sourceLayerId");
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
      ...fullPermission,
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
      ...fullPermission,
      configuration: { ...configuration, settings: { model: "invalid" } },
    }, { loadModule })).rejects.toThrow("model must contain provider and id");
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("rejects bounded permission profiles until Prime Agent exposes bounded controls", async () => {
    const loadModule = vi.fn();
    await expect(PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      permissionProfileId: "auto",
      permissionBinding: {},
      configuration,
    }, { loadModule })).rejects.toThrow("supports only the Full access permission profile");
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("subscribes for the duration of a run and reports recursive coverage honestly", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => {
        listener?.({ type: "turn_start" });
        listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Visible" }], usage: { input: 2, output: 3 } } });
        listener?.({ type: "rlm_child_update", child: { id: "child-1", label: "Research", status: "completed", answerPreview: "Evidence", toolUseCount: 1 } });
        listener?.({ type: "turn_end" });
      }),
      subscribe: vi.fn((next: (event: unknown) => void) => { listener = next; return unsubscribe; }),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);
    const trace = recordingTrace();

    await harness.complete(runContext(11, "token", trace.sink));

    expect(session.subscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(JSON.stringify(trace.events)).not.toContain("hidden");
    expect(trace.events.map((event) => event.type)).toEqual(expect.arrayContaining(["provider.event", "message", "usage", "model.call.started", "model.call.completed"]));
    expect(harness.traceSupport()).toMatchObject({ childStreams: "summary", reasoningSummaries: "none" });
  });
});

function runContext(nodeId: number, token: string, trace: HarnessTraceSink = createNoopHarnessTraceSink()): HarnessRunContext {
  const inputGraph = { id: nodeId, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" as const };
  return {
    inputGraph,
    interactionInput: { interaction: inputGraph, contexts: [] },
    graph: {
      interactionNodeId: nodeId,
      acquireCapability: () => ({ url: "http://127.0.0.1:43123", token, nodeId }),
    },
    approvals: { request: async () => { throw new Error("unused approval channel"); } },
    trace,
  };
}

function attachedRunContext(nodeId: number, token: string): HarnessRunContext {
  const context = runContext(nodeId, token);
  return {
    ...context,
    interactionInput: {
      interaction: context.inputGraph,
      contexts: [
        {
          type: "interaction.context",
          targetNode: { id: 20, kind: "concept", icon: "box", title: "First target", detail: "First detail", state: "accepted" },
          annotations: ["first annotation", "second annotation"],
        },
        {
          type: "interaction.context",
          targetNode: { id: 21, kind: "concept", icon: "box", title: "Second target", detail: "Second detail", state: "accepted" },
          annotations: ["third annotation"],
        },
      ],
    },
  };
}

async function createHarness(session: PrimeAgentSessionFixture): Promise<PrimeAgentHarness> {
  return PrimeAgentHarness.create({
    threadId: 7,
    workingDirectory: "/tmp/project",
    ...fullPermission,
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
  readonly subscribe?: ReturnType<typeof vi.fn>;
}

function invocation(runContext: HarnessRunContext) {
  return {
    runContext,
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
}

function recordingTrace(): { sink: HarnessTraceSink; events: HarnessTraceEventInput[] } {
  const events: HarnessTraceEventInput[] = [];
  const noop = createNoopHarnessTraceSink();
  return { sink: { ...noop, emit: (event) => { events.push({ ...event, streamId: noop.rootStreamId }); } }, events };
}
