import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { InteractionInput } from "@relayer/graph-client";
import { HarnessExecutionFailure, HarnessHost, startHarnessHost, type HarnessInvokedCompletion } from "../src/host.js";
import { PrimeAgentHarness } from "../src/implementations/prime-agent.js";
import type {
  Harness,
  HarnessConfiguration,
  HarnessFactoryContext,
  HarnessModelPlan,
  HarnessRunContext,
  HarnessSessionState,
} from "../src/types.js";

const completion = {
  nodeId: 1,
  rootAction: { id: 4, sourceNodeId: 1, sourceLayerId: null, kind: "navigate" as const, relation: "expand" as const, label: "Response", variant: "pill" as const, targetLayerId: 3, state: "accepted" as const },
  rootLayer: {
    layer: { id: 3, nodes: [2], edges: [], state: "accepted" as const },
    nodes: [{ id: 2, kind: "concept", icon: "box", title: "Answer", detail: "Detail", state: "accepted" as const }],
    edges: [],
    actions: [],
  },
};
const emptyState = (): HarnessSessionState => ({});
const graph = (nodeId = 1, token = "token") => ({ url: "http://127.0.0.1:43123", token, nodeId });
const invoked = (
  inputGraph: ReturnType<typeof graph>,
  sourceCompletionId = 1,
  actionId = inputGraph.nodeId + 100,
) => ({
  capability: inputGraph,
  origin: { kind: "invoke" as const, sourceCompletionId, actionId },
});
const graphNode = (nodeId = 1, leasedActionId?: number) => ({
  id: nodeId,
  ...(leasedActionId === undefined ? {} : { leasedActionId }),
  kind: "user-interaction",
  icon: "user",
  title: "Question",
  detail: "Question",
  state: "accepted" as const,
});
const interactionInput = (nodeId = 1, contexts: InteractionInput["contexts"] = []): InteractionInput => ({
  interaction: graphNode(nodeId),
  contexts,
});
const graphReadResponse = (url: string, nodeId = 1, contexts: InteractionInput["contexts"] = [], leasedActionId?: number) => new Response(
  JSON.stringify(url.endsWith("/input") ? interactionInput(nodeId, contexts) : { node: graphNode(nodeId, leasedActionId) }),
  { status: 200, headers: { "content-type": "application/json" } },
);
const testConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "test-default",
  implementation: "test",
  implementationVersion: 1,
  permissionBindings: { ask: {}, auto: {}, full: {} },
  settings: {},
};
const legacyConfiguration = (configuration: HarnessConfiguration) => {
  const { permissionBindings: _permissionBindings, ...legacy } = configuration;
  return legacy;
};

describe("HarnessHost", () => {
  it("classifies and preserves partial streamed output without making the attempt replayable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-partial-output-"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : url.endsWith("/neighbors")
        ? new Response(JSON.stringify({ nodes: [] }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control",
        trace: {
          directory: join(directory, "traces"),
          policy: { mode: "required", requiredFeatures: {}, includeNativeArtifacts: false, maxBytesPerTurn: 10_000, maxEventsPerTurn: 100 },
        },
        implementations: { test: () => ({ async complete(context) {
          context.trace.emit({ type: "message", data: { text: "inspectable partial answer" } });
          throw new Error("stream disconnected");
        }, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
      await expect(host.complete(1, 1, graph(), undefined, undefined, { productInteractionId: 31 }))
        .rejects.toMatchObject({ effectBoundary: "partial_output" });
      const exported = join(directory, "exported");
      await host.exportCandidateTrace(31, exported, {
        runId: "run", executionId: "execution", interactionId: "31", harnessConfigurationName: "test-default",
      });
      expect(await readFile(join(exported, "events.jsonl"), "utf8")).toContain("inspectable partial answer");
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("classifies an observable partial graph as a protected graph write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-partial-graph-"));
    let wroteGraph = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : url.endsWith("/neighbors")
        ? new Response(JSON.stringify({ nodes: wroteGraph ? [{ id: 2 }] : [] }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control",
        implementations: { test: () => ({ async complete() { wroteGraph = true; throw new Error("crash after write"); }, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
      await expect(host.complete(1, 1, graph())).rejects.toMatchObject({ effectBoundary: "graph_write" });
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("classifies a started tool call as protected even when later graph inspection is empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-tool-effect-"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : url.endsWith("/neighbors")
        ? new Response(JSON.stringify({ nodes: [] }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control",
        implementations: { test: () => ({ async complete(context) {
          context.trace.emit({ type: "tool.call.started", data: { name: "write-file" } });
          throw new Error("tool result connection lost");
        }, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
      await expect(host.complete(1, 1, graph())).rejects.toMatchObject({ effectBoundary: "tool_effect" });
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adopts an accepted graph after a harness unwind failure and never repeats execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-accepted-recovery-"));
    let accepted = false;
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? accepted
        ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control",
        implementations: { test: () => ({ async complete() {
          calls += 1;
          accepted = true;
          throw new Error("crash after graph.submit");
        }, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
      await expect(host.complete(1, 1, graph())).resolves.toMatchObject({ output: completion });
      await expect(host.complete(1, 1, graph())).resolves.toMatchObject({ output: completion });
      expect(calls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows an adapter to attest a no-effect failure before provider execution", () => {
    expect(new HarnessExecutionFailure("not started", "authentication", "none"))
      .toMatchObject({ failureCategory: "authentication", effectBoundary: "none" });
  });

  it("fails closed for an untyped provider failure after execution starts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-no-effect-"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : url.endsWith("/neighbors")
        ? new Response(JSON.stringify({ nodes: [] }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const configuration = {
        ...testConfiguration,
        modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt-test" }], deny: [] },
        executionAccessContracts: ["secret@1"],
      } as HarnessConfiguration;
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control",
        accessBroker: { async acquire() { return { access: { kind: "secret", contract: "secret@1", providerId: "provider", adapterId: "openai-api", adapterImplementationVersion: "1", endpoint: "https://api.openai.com/v1", fields: { "api-key": "secret" } }, async release() {} }; } },
        implementations: { test: () => ({ async complete() { throw new Error("model not found"); }, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration, workingDirectory: directory });
      await expect(host.complete(1, 1, graph(), { providerId: "provider", adapterId: "openai-api", modelId: "gpt-test" }))
        .rejects.toMatchObject({ effectBoundary: "unknown" });
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a selected model when the harness omits access contracts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-missing-access-contract-"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : url.endsWith("/neighbors")
        ? new Response(JSON.stringify({ nodes: [] }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control",
        implementations: { test: () => ({ async complete() {}, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
      await expect(host.complete(1, 1, graph(), { providerId: "provider", adapterId: "openai-api", modelId: "gpt-test" }))
        .rejects.toMatchObject({ failureCategory: "configuration", effectBoundary: "none" });
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists resumable harness state even when completion fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-host-"));
    const stateFile = join(directory, "sessions.json");
    const capability = graph(1, "graph-token");
    const descriptor = { threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory };
    let restoredState: HarnessSessionState | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : graphReadResponse(url)));

    try {
      const failing = new HarnessHost({
        stateFile,
        controlToken: "control",
        trace: {
          directory: join(directory, "failure-traces"),
          policy: { mode: "required", requiredFeatures: {}, includeNativeArtifacts: false, maxBytesPerTurn: 10_000, maxEventsPerTurn: 100 },
        },
        implementations: {
          test: () => ({
            async complete() { throw new Error("model failed"); },
            state: () => ({ primeAgentSessionId: "resume-after-failure" }),
          }),
        },
      });
      await failing.initialize();
      await failing.createSession(descriptor);
      await expect(failing.complete(descriptor.threadId, 1, capability, undefined, undefined, { productInteractionId: 7 })).rejects.toThrow("model failed");
      await failing.exportCandidateTrace(7, join(directory, "failed-export"), {
        runId: "run", executionId: "execution", interactionId: "7", harnessConfigurationName: "test-default",
      });
      expect(JSON.parse(await readFile(join(directory, "failed-export", "manifest.json"), "utf8"))).toMatchObject({ status: "failed" });
      await expect(failing.createSession({ ...descriptor, configuration: { ...testConfiguration, name: "other" } })).rejects.toThrow("already pinned");

      const restored = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: {
          test: (context: HarnessFactoryContext) => {
            restoredState = context.savedState;
            return {
              async complete() { throw new Error("unused"); },
              state: () => context.savedState ?? emptyState(),
            };
          },
        },
      });
      await restored.initialize();
      await restored.createSession(descriptor);
      expect(restoredState).toEqual({ primeAgentSessionId: "resume-after-failure" });
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("awaits asynchronous harness construction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-async-factory-"));
    let releaseFactory!: () => void;
    const factoryReady = new Promise<void>((resolveReady) => { releaseFactory = resolveReady; });
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: {
          test: async () => {
            await factoryReady;
            return { async complete() {}, state: emptyState };
          },
        },
      });
      await host.initialize();
      const creating = host.createSession({
        threadId: 1, permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));
      expect(host.sessionCount()).toBe(0);

      releaseFactory();
      await creating;
      expect(host.sessionCount()).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("constructs only one harness when a thread is registered concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-concurrent-factory-"));
    let factoryCalls = 0;
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: async () => {
          factoryCalls += 1;
          await new Promise((resolveTurn) => setTimeout(resolveTurn, 5));
          return { async complete() {}, state: emptyState };
        } },
      });
      await host.initialize();
      const descriptor = { threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory };

      await Promise.all([host.createSession(descriptor), host.createSession(descriptor)]);

      expect(factoryCalls).toBe(1);
      expect(host.sessionCount()).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("disposes a harness that finishes starting after the host closes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-close-during-factory-"));
    let releaseFactory!: () => void;
    const factoryReady = new Promise<void>((resolveReady) => { releaseFactory = resolveReady; });
    const dispose = vi.fn(async () => undefined);
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: async () => {
          await factoryReady;
          return { async complete() {}, state: emptyState, dispose };
        } },
      });
      await host.initialize();
      const creating = host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));

      await host.close();
      releaseFactory();

      await expect(creating).rejects.toThrow("closed while the session was starting");
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(host.sessionCount()).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("disposes a newly constructed harness when its initial state is invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-invalid-state-"));
    const dispose = vi.fn(async () => undefined);
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({
          async complete() {},
          state: () => ({ invalid: Number.NaN }),
          dispose,
        }) },
      });
      await host.initialize();

      await expect(host.createSession({
        threadId: 1, permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      })).rejects.toThrow("invalid implementation state");
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(host.sessionCount()).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores saved state when the stable session is registered again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-fresh-capability-"));
    const stateFile = join(directory, "sessions.json");
    const descriptor = {
      threadId: 1, permissionProfileId: "auto",
      configuration: testConfiguration,
      workingDirectory: directory,
    };
    try {
      const first = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { test: () => ({ async complete() {}, state: () => ({ sessionId: "saved" }) }) },
      });
      await first.initialize();
      await first.createSession(descriptor);

      let restoredState: HarnessSessionState | undefined;
      const restored = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { test: (context) => {
          restoredState = context.savedState;
          return { async complete() {}, state: () => context.savedState ?? emptyState() };
        } },
      });
      await restored.initialize();
      await expect(restored.complete(1, 1, graph())).rejects.toThrow("must be registered");
      await restored.createSession(descriptor);
      expect(restoredState).toEqual({ sessionId: "saved" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels the active completion through its abort signal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-cancel-"));
    let completionStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => { completionStarted = resolveStarted; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : graphReadResponse(url)));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        trace: {
          directory: join(directory, "cancel-traces"),
          policy: { mode: "required", requiredFeatures: {}, includeNativeArtifacts: false, maxBytesPerTurn: 10_000, maxEventsPerTurn: 100 },
        },
        implementations: { test: () => ({
          complete(_interaction, signal) {
            completionStarted();
            return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
          },
          state: emptyState,
        }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

      const completing = host.complete(1, 1, graph(), undefined, undefined, { productInteractionId: 8 });
      await started;
      expect(host.cancel(1, 2)).toBe(false);
      expect(host.cancel(1, 1)).toBe(true);
      await expect(completing).rejects.toThrow("cancelled for thread 1");
      expect(host.cancel(1)).toBe(false);
      await host.exportCandidateTrace(8, join(directory, "cancelled-export"), {
        runId: "run", executionId: "execution", interactionId: "8", harnessConfigurationName: "test-default",
      });
      const cancelledManifest = JSON.parse(await readFile(join(directory, "cancelled-export", "manifest.json"), "utf8"));
      const cancelledEvents = await readFile(join(directory, "cancelled-export", "events.jsonl"), "utf8");
      expect(cancelledManifest).toMatchObject({ status: "partial" });
      expect(cancelledEvents).toContain('"type":"cancelled"');
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts an AbortSignal after the required interaction identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-signal-"));
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: { test: () => ({ async complete() {}, state: emptyState }) },
    });
    try {
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
      const controller = new AbortController();
      controller.abort(new Error("legacy caller cancelled"));

      await expect(host.complete(1, 1, graph(), controller.signal)).rejects.toThrow("legacy caller cancelled");
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels a waiting approval closed and returns the terminal outcome to the harness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-approval-cancel-"));
    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => { approvalStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : graphReadResponse(url)));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({
          async complete(context) {
            const waiting = context.approvals.request({
              providerItemId: "provider-1",
              title: "Run tests",
              reason: "Verify the requested change.",
              action: { kind: "command", command: "npm test", workingDirectory: directory },
              scopeKeys: ["command:npm test"],
              scopeDescription: "Run npm test for this session.",
            });
            approvalStarted();
            await waiting;
          },
          state: emptyState,
        }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "ask", configuration: testConfiguration, workingDirectory: directory });
      const completing = host.complete(1, 44, graph());
      await started;

      expect(host.cancel(1)).toBe(true);

      await expect(completing).rejects.toThrow("cancelled");
      expect(host.approvalEvents(1)).toMatchObject({
        pendingRequests: [],
        events: [
          { sequence: 1, type: "requested" },
          { sequence: 2, type: "resolved", resolution: { outcome: "cancelled", actor: "host" } },
        ],
      });
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("disposes live harnesses when the host closes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-dispose-"));
    const dispose = vi.fn(async () => undefined);
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({ async complete() {}, state: emptyState, dispose }) },
      });
      await host.initialize();
      const descriptor = { threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory };
      await host.createSession(descriptor);

      await host.close();
      await host.close();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(host.sessionCount()).toBe(0);
      await expect(host.createSession(descriptor)).rejects.toThrow("closed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects admitted queued completions before disposing during shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-close-queue-"));
    let completionStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => { completionStarted = resolveStarted; });
    const calls: number[] = [];
    const dispose = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/output")) {
        return new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      const nodeId = new Headers(init?.headers).get("authorization") === "Bearer queued-token" ? 2 : 1;
      return graphReadResponse(url, nodeId);
    }));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        trace: {
          directory: join(directory, "shutdown-traces"),
          policy: { mode: "required", requiredFeatures: {}, includeNativeArtifacts: false, maxBytesPerTurn: 10_000, maxEventsPerTurn: 100 },
        },
        implementations: { test: () => ({
          complete(context, signal) {
            calls.push(context.inputGraph.id);
            if (calls.length > 1) return Promise.resolve();
            completionStarted();
            return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
          },
          state: emptyState,
          dispose,
        }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

      const active = host.complete(1, 1, graph(1, "active-token"), undefined, undefined, { productInteractionId: 10 });
      await started;
      const queued = host.complete(1, 2, graph(2, "queued-token"));
      const closing = host.close();

      await expect(active).rejects.toThrow("closed");
      await expect(queued).rejects.toThrow("closed");
      await closing;
      expect(calls).toEqual([1]);
      expect(dispose).toHaveBeenCalledTimes(1);
      await host.exportCandidateTrace(10, join(directory, "shutdown-export"), {
        runId: "run", executionId: "execution", interactionId: "10", harnessConfigurationName: "test-default",
      });
      expect(JSON.parse(await readFile(join(directory, "shutdown-export", "manifest.json"), "utf8"))).toMatchObject({ status: "partial" });
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns an accepted completion without rerunning the harness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-idempotent-"));
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({ async complete() { calls += 1; }, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

      await expect(host.complete(1, 1, graph())).resolves.toMatchObject({ output: completion });
      expect(calls).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects missing required trace coverage before invoking paid inference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-trace-preflight-"));
    let completionCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : graphReadResponse(url)));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        trace: {
          directory: join(directory, "traces"),
          policy: {
            mode: "required",
            requiredFeatures: { modelCalls: "full" },
            includeNativeArtifacts: false,
            maxBytesPerTurn: 1_000,
            maxEventsPerTurn: 100,
          },
        },
        implementations: { test: () => ({
          traceSupport: () => ({
            prompt: "full", messages: "none", reasoningSummaries: "none", modelCalls: "none",
            toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none",
          }),
          async complete() { completionCalls += 1; },
          state: emptyState,
        }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

      await expect(host.complete(1, 1, graph(), undefined, undefined, { productInteractionId: 9 })).rejects.toThrow("before inference");
      expect(completionCalls).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps an accepted graph when required trace sealing fails and never reruns inference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-trace-seal-failure-"));
    const blockedTraceDirectory = join(directory, "blocked-trace-path");
    let accepted = false;
    let completionCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/output")) {
        return accepted
          ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return graphReadResponse(url);
    }));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        trace: {
          directory: blockedTraceDirectory,
          policy: { mode: "required", requiredFeatures: {}, includeNativeArtifacts: false, maxBytesPerTurn: 10_000, maxEventsPerTurn: 100 },
        },
        implementations: { test: () => ({
          async complete() { completionCalls += 1; accepted = true; },
          state: emptyState,
        }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
      await rm(blockedTraceDirectory, { recursive: true, force: true });
      await writeFile(blockedTraceDirectory, "not a directory");

      await expect(host.complete(1, 1, graph(), undefined, undefined, { productInteractionId: 11 })).resolves.toMatchObject({
        output: completion,
        trace: { status: "failed", error: expect.stringContaining("could not be sealed") },
      });
      expect(completionCalls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("supplies a distinct run scope without rebuilding the harness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-advance-"));
    const adopted: { url: string; token: string; nodeId: number }[] = [];
    const accepted = new Set<number>();
    const scopes: { acquireCapability(): unknown }[] = [];
    const inputs: InteractionInput[] = [];
    const leasedActionIds: Array<number | null | undefined> = [];
    const models: unknown[] = [];
    let revocationRequests = 0;
    let factoryCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      const nodeId = authorization === "Bearer second-token" ? 2 : 1;
      if (url.endsWith("/output")) {
        return accepted.has(nodeId)
          ? new Response(JSON.stringify({ ...completion, nodeId }), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/api/control/capabilities")) {
        revocationRequests += 1;
        return new Response(JSON.stringify({ revoked: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${nodeId === 1 ? "first-token" : "second-token"}`);
      const contexts = nodeId === 1 ? [{
        type: "interaction.context" as const,
        targetNode: { id: 90, kind: "concept", icon: "box", title: "Attached", detail: "Context", state: "accepted" as const },
        annotations: ["first", "second"],
      }] : [];
      return graphReadResponse(url, nodeId, contexts, nodeId === 1 ? 77 : undefined);
    }));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        accessBroker: { async acquire(model) { return { access: { kind: "managed-runtime", contract: "managed-runtime@1", providerId: model.providerId, adapterId: model.adapterId!, adapterImplementationVersion: "1", environment: {} }, async release() {} }; } },
        implementations: { test: () => {
          factoryCalls += 1;
          return {
            async complete(context) {
              scopes.push(context.graph);
              inputs.push(context.interactionInput);
              leasedActionIds.push(context.inputGraph.leasedActionId);
              models.push(context.model);
              adopted.push(context.graph.acquireCapability());
              accepted.add(context.inputGraph.id);
            },
            state: emptyState,
          };
        } },
      });
      await host.initialize();
      const base = { threadId: 1, permissionProfileId: "auto", configuration: { ...testConfiguration, executionAccessContracts: ["managed-runtime@1"] }, workingDirectory: directory };
      await host.createSession(base);

      await host.complete(1, 1, graph(1, "first-token"), { providerId: "codex", adapterId: "codex-subscription", modelId: "gpt-first" });
      await expect(host.complete(1, 2, graph(2, "second-token"), { providerId: "codex", adapterId: "codex-subscription", modelId: "gpt-second" })).resolves.toMatchObject({
        output: { nodeId: 2 },
      });
      expect(factoryCalls).toBe(1);
      expect(adopted.map(({ token, nodeId }) => [token, nodeId])).toEqual([["first-token", 1], ["second-token", 2]]);
      expect(models).toEqual([
        { providerId: "codex", adapterId: "codex-subscription", modelId: "gpt-first" },
        { providerId: "codex", adapterId: "codex-subscription", modelId: "gpt-second" },
      ]);
      expect(inputs[0]).toEqual(interactionInput(1, [{
        type: "interaction.context",
        targetNode: { id: 90, kind: "concept", icon: "box", title: "Attached", detail: "Context", state: "accepted" },
        annotations: ["first", "second"],
      }]));
      expect(inputs[1]).toEqual(interactionInput(2));
      expect(leasedActionIds).toEqual([77, undefined]);
      expect(inputs[0]!.interaction).not.toHaveProperty("leasedActionId");
      expect(revocationRequests).toBe(0);
      expect(() => scopes[0]!.acquireCapability()).toThrow("no longer active");
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a model outside the pinned harness compatibility before graph access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-model-compatibility-"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({ async complete() {}, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: {
          ...testConfiguration,
          modelCompatibility: [{ providerId: "codex", modelIds: ["allowed"] }],
          executionAccessContracts: ["managed-runtime@1"],
        },
        workingDirectory: directory,
      });

      await expect(host.complete(1, 1, graph(), { providerId: "codex", modelId: "blocked" }))
        .rejects.toThrow("not compatible with this configuration");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("defensively enforces adapter model rules before graph access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-model-rules-"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({ async complete() {}, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: {
          ...testConfiguration,
          modelRules: {
            allow: [{ adapterId: "openai-api", modelIdRegex: "^gpt-" }],
            deny: [{ adapterId: "openai-api", modelIdExact: "gpt-preview" }],
          },
          executionAccessContracts: ["secret@1"],
        },
        workingDirectory: directory,
      });

      await expect(host.complete(1, 1, graph(), {
        providerId: "openai-work",
        adapterId: "openai-api",
        modelId: "gpt-preview",
      })).rejects.toThrow("not compatible with this configuration");
      await expect(host.complete(1, 1, graph(), {
        providerId: "openai-work",
        modelId: "gpt-5.2",
      })).rejects.toThrow("not compatible with this configuration");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("defensively applies the current saved rule policy on the very next send", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-current-policy-"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control",
        implementations: { test: () => ({ async complete() {}, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({
        threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
        configuration: {
          ...testConfiguration,
          revision: 1,
          executionAccessContracts: ["secret@1"],
          modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }], deny: [] },
        },
      });
      await expect(host.complete(
        1,
        1,
        graph(),
        { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" },
        undefined,
        undefined,
        undefined,
        {
          configurationRevision: 2,
          configurationDigest: `sha256:${"a".repeat(64)}`,
          modelRules: {
            allow: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }],
            deny: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }],
          },
        },
      )).rejects.toThrow("not compatible with this configuration");
      await expect(host.complete(
        1,
        1,
        graph(),
        { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" },
      )).rejects.toThrow("Current harness execution policy is required");
      expect(fetchMock).not.toHaveBeenCalled();
      await host.close();
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects admission policy omission after observing a dynamic policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-current-admission-policy-"));
    const release = vi.fn();
    const acquire = vi.fn(async () => ({
      access: {
        kind: "secret" as const,
        contract: "secret@1" as const,
        providerId: "openai-work",
        adapterId: "openai-api",
        adapterImplementationVersion: "1",
        endpoint: "https://api.openai.test",
        fields: { "api-key": "secret" },
      },
      release,
    }));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control", accessBroker: { acquire },
        implementations: { test: () => ({ async complete() {}, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({
        threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
        configuration: {
          ...testConfiguration,
          revision: 1,
          executionAccessContracts: ["secret@1"],
          modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }], deny: [] },
        },
      });
      const model = { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" };
      const policy = {
        configurationRevision: 2,
        configurationDigest: `sha256:${"a".repeat(64)}`,
        modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }], deny: [] },
      };
      const admission = await host.admitProviderExecution(1, model, new AbortController().signal, policy);
      await host.releaseProviderExecution(admission.executionLeaseId);

      await expect(host.admitProviderExecution(1, model, new AbortController().signal))
        .rejects.toThrow("Current harness execution policy is required");
      expect(acquire).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      await host.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts an HTTP harness policy whose optional modelRules field is omitted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-policy-without-rules-"));
    const release = vi.fn();
    let running: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
    try {
      running = await startHarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        accessBroker: { async acquire(model) {
          return {
            access: {
              kind: "secret", contract: "secret@1", providerId: model.providerId, adapterId: model.adapterId!,
              adapterImplementationVersion: "1", endpoint: "https://api.openai.test", fields: { "api-key": "opaque" },
            },
            release,
          };
        } },
        implementations: { test: () => ({ async complete() {}, state: emptyState }) },
      });
      await running.host.createSession({
        threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
        configuration: {
          ...testConfiguration,
          revision: 1,
          modelCompatibility: [{ providerId: "openai-work" }],
          executionAccessContracts: ["secret@1"],
        },
      });

      const admission = await fetch(`${running.url}/sessions/1/execution-leases`, {
        method: "POST",
        headers: { authorization: "Bearer control", "content-type": "application/json" },
        body: JSON.stringify({
          model: { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" },
          harnessPolicy: {
            configurationRevision: 2,
            configurationDigest: `sha256:${"a".repeat(64)}`,
          },
        }),
      });
      expect(admission.status).toBe(201);
      const admitted = await admission.json() as { executionLeaseId: string; adapterImplementationVersion: string };
      expect(admitted.adapterImplementationVersion).toBe("1");
      const released = await fetch(`${running.url}/sessions/1/execution-leases/${admitted.executionLeaseId}`, {
        method: "DELETE",
        headers: { authorization: "Bearer control" },
      });
      expect(released.status).toBe(200);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await running?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leases execution-scoped provider access and releases it when the harness fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-access-broker-"));
    const release = vi.fn();
    const acquire = vi.fn(async () => ({
      access: {
        kind: "secret" as const,
        contract: "secret@1" as const,
        providerId: "openai-work",
        adapterId: "openai-api",
        adapterImplementationVersion: "1",
        endpoint: "https://api.openai.test",
        fields: { "api-key": "never-persist-me" },
      },
      release,
    }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control", accessBroker: { acquire },
        implementations: { test: () => ({ async complete(context) {
          expect(context.access?.kind).toBe("secret");
          throw new Error("provider failed");
        }, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({
        threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
        configuration: {
          ...testConfiguration,
          // Migrated configurations can retain this projection for old readers;
          // adapter-aware modelRules are authoritative in the host.
          modelCompatibility: [{ providerId: "codex" }],
          modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: ".*" }], deny: [] },
          executionAccessContracts: ["secret@1"],
        },
      });
      await expect(host.complete(1, 1, graph(), { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" }))
        .rejects.toThrow("provider failed");
      expect(acquire).toHaveBeenCalledWith(
        { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" },
        ["secret@1"],
        expect.any(AbortSignal),
      );
      expect(release).toHaveBeenCalledOnce();
      expect(await readFile(join(directory, "sessions.json"), "utf8")).not.toContain("never-persist-me");
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("holds trusted pre-admission through attempt setup and consumes its effective adapter version once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-pre-admission-"));
    const release = vi.fn();
    const acquire = vi.fn(async () => ({
      access: {
        kind: "secret" as const,
        contract: "secret@1" as const,
        providerId: "openai-work",
        adapterId: "openai-api",
        adapterImplementationVersion: "7",
        endpoint: "https://api.openai.test",
        fields: { "api-key": "secret" },
      },
      release,
    }));
    let accepted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? accepted
        ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control", accessBroker: { acquire },
        implementations: { test: () => ({ async complete(context) {
          expect(context.access?.adapterImplementationVersion).toBe("7");
          accepted = true;
        }, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({
        threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
        configuration: {
          ...testConfiguration,
          modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }], deny: [] },
          executionAccessContracts: ["secret@1"],
        },
      });
      const model = { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" };
      const admission = await host.admitProviderExecution(1, model, new AbortController().signal);
      expect(admission.adapterImplementationVersion).toBe("7");
      expect(release).not.toHaveBeenCalled();
      await expect(host.complete(1, 1, graph(), model, undefined, undefined, admission.executionLeaseId)).resolves.toMatchObject({ output: completion });
      expect(acquire).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      accepted = false;
      await expect(host.complete(1, 1, graph(), model, undefined, undefined, admission.executionLeaseId))
        .rejects.toThrow("invalid or expired");
      expect(await host.releaseProviderExecution(admission.executionLeaseId)).toBe(true);
      expect(release).toHaveBeenCalledOnce();
      expect(await host.releaseProviderExecution(admission.executionLeaseId)).toBe(false);

      accepted = false;
      const cancelled = await host.admitProviderExecution(1, model, new AbortController().signal);
      expect(await host.releaseProviderExecution(cancelled.executionLeaseId)).toBe(true);
      expect(release).toHaveBeenCalledTimes(2);
      await expect(host.complete(1, 1, graph(), model, undefined, undefined, cancelled.executionLeaseId))
        .rejects.toThrow("invalid or expired");
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("admits the complete ordered family, deduplicates access by provider definition, and aliases orchestrator access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-family-admission-"));
    const releases: string[] = [];
    const acquired: string[] = [];
    let accepted = false;
    let observedContext: HarnessRunContext | undefined;
    const plan: HarnessModelPlan = {
      familyId: 17,
      familyRevision: 3,
      orchestrator: { providerId: "anthropic-work", adapterId: "anthropic-api", accessContract: "secret@1", modelId: "claude-opus" },
      roster: [
        { providerId: "openai-work", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt-large" },
        { providerId: "openai-work", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt-small" },
        { providerId: "anthropic-work", adapterId: "anthropic-api", accessContract: "secret@1", modelId: "claude-opus" },
      ],
    };
    const policy = {
      configurationRevision: 2,
      configurationDigest: `sha256:${"a".repeat(64)}`,
      executionAccessContracts: ["secret@1"],
      modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: ".*" }, { adapterId: "anthropic-api", modelIdRegex: ".*" }], deny: [] },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? accepted
        ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : graphReadResponse(url)));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control",
        accessBroker: { async acquire(route) {
          acquired.push(route.providerId);
          const version = route.providerId === "openai-work" ? "openai-adapter@7" : "anthropic-adapter@4";
          return {
            access: {
              kind: "secret", contract: "secret@1", providerId: route.providerId, adapterId: route.adapterId!,
              adapterImplementationVersion: version, endpoint: `https://${route.providerId}.test`, fields: { "api-key": route.providerId },
            },
            release() { releases.push(route.providerId); },
          };
        } },
        implementations: { test: () => ({ async complete(context) {
          observedContext = context;
          expect(context.model).toEqual(plan.orchestrator);
          expect(context.access?.providerId).toBe("anthropic-work");
          expect(context.accessBundle?.byProviderId["openai-work"]?.providerId).toBe("openai-work");
          expect(context.accessBundle?.byProviderId["anthropic-work"]?.providerId).toBe("anthropic-work");
          expect(Object.isFrozen(context.modelPlan)).toBe(true);
          expect(Object.isFrozen(context.modelPlan?.roster)).toBe(true);
          expect(Object.isFrozen(context.accessBundle?.byProviderId)).toBe(true);
          accepted = true;
        }, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({
        threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
        configuration: {
          ...testConfiguration,
          revision: 1,
          modelRules: policy.modelRules,
          executionAccessContracts: ["secret@1"],
        },
      });

      const admission = await host.admitModelPlanExecution(
        1, 29, "attempt-family-29", plan, new AbortController().signal, policy,
      );
      expect(acquired).toEqual(["openai-work", "anthropic-work"]);
      expect(admission.admittedPlan.roster.map((route) => route.adapterImplementationVersion)).toEqual([
        "openai-adapter@7", "openai-adapter@7", "anthropic-adapter@4",
      ]);
      expect(admission.admittedPlan.orchestrator.adapterImplementationVersion).toBe("anthropic-adapter@4");
      expect(admission.admittedPlan.harnessPolicyDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(admission.admittedPlan.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(await readFile(join(directory, "sessions.json"), "utf8")).not.toContain("api-key");
      expect(releases).toEqual([]);

      await expect(host.complete(
        1, 29, graph(), plan.orchestrator, undefined, undefined,
        admission.executionLeaseId, policy, plan, "attempt-family-29",
      )).resolves.toMatchObject({ output: completion });
      expect(observedContext?.modelPlan).toEqual(admission.admittedPlan);
      expect(releases).toEqual([]);
      accepted = false;
      await expect(host.complete(
        1, 29, graph(), plan.orchestrator, undefined, undefined,
        admission.executionLeaseId, policy, plan, "attempt-family-29",
      )).rejects.toThrow("invalid or expired");
      expect(await host.releaseProviderExecution(admission.executionLeaseId)).toBe(true);
      expect(releases).toEqual(["anthropic-work", "openai-work"]);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back already-acquired family access when a later provider cannot be acquired", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-family-rollback-"));
    const release = vi.fn();
    const plan: HarnessModelPlan = {
      familyId: 1,
      familyRevision: 1,
      orchestrator: { providerId: "provider-a", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt" },
      roster: [
        { providerId: "provider-a", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt" },
        { providerId: "provider-b", adapterId: "anthropic-api", accessContract: "secret@1", modelId: "claude" },
      ],
    };
    const policy = {
      configurationRevision: 2,
      configurationDigest: `sha256:${"b".repeat(64)}`,
      executionAccessContracts: ["secret@1"],
      modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: ".*" }, { adapterId: "anthropic-api", modelIdRegex: ".*" }], deny: [] },
    };
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control",
        accessBroker: { async acquire(route) {
          if (route.providerId === "provider-b") throw new Error("provider-b unavailable");
          return {
            access: {
              kind: "secret", contract: "secret@1", providerId: route.providerId, adapterId: route.adapterId!,
              adapterImplementationVersion: "1", endpoint: "https://provider-a.test", fields: { "api-key": "secret" },
            },
            release,
          };
        } },
        implementations: { test: () => ({ async complete() {}, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({
        threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
        configuration: { ...testConfiguration, revision: 1, modelRules: policy.modelRules, executionAccessContracts: ["secret@1"] },
      });
      await expect(host.admitModelPlanExecution(
        1, 1, "attempt-rollback", plan, new AbortController().signal, policy,
      )).rejects.toThrow("provider-b unavailable");
      expect(release).toHaveBeenCalledOnce();
      await host.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds a family admission to its interaction, attempt, plan, and harness policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-family-binding-"));
    const release = vi.fn();
    const plan: HarnessModelPlan = {
      familyId: 1,
      familyRevision: 1,
      orchestrator: { providerId: "provider-a", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt" },
      roster: [{ providerId: "provider-a", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt" }],
    };
    const policy = {
      configurationRevision: 2,
      configurationDigest: `sha256:${"c".repeat(64)}`,
      executionAccessContracts: ["secret@1"],
      modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: ".*" }], deny: [] },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : graphReadResponse(url)));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control",
        accessBroker: { async acquire(route) {
          return {
            access: {
              kind: "secret", contract: "secret@1", providerId: route.providerId, adapterId: route.adapterId!,
              adapterImplementationVersion: "1", endpoint: "https://provider-a.test", fields: { "api-key": "secret" },
            },
            release,
          };
        } },
        implementations: { test: () => ({ async complete() {}, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({
        threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
        configuration: { ...testConfiguration, revision: 1, modelRules: policy.modelRules, executionAccessContracts: ["secret@1"] },
      });
      await expect(host.admitModelPlanExecution(
        1, 44, "attempt-missing-contracts", plan, new AbortController().signal,
        { configurationRevision: 2, configurationDigest: policy.configurationDigest, modelRules: policy.modelRules },
      )).rejects.toThrow("requires executionAccessContracts");
      await expect(host.admitModelPlanExecution(
        1, 44, "attempt-mismatched-contracts", plan, new AbortController().signal,
        { ...policy, executionAccessContracts: ["managed-runtime@1"] },
      )).rejects.toThrow("do not match the pinned harness configuration");
      const admission = await host.admitModelPlanExecution(
        1, 44, "attempt-bound", plan, new AbortController().signal, policy,
      );
      await host.createSession({
        threadId: 2, permissionProfileId: "auto", workingDirectory: directory,
        configuration: {
          ...testConfiguration,
          revision: 1,
          modelRules: policy.modelRules,
          executionAccessContracts: ["secret@1", "managed-runtime@1"],
        },
      });
      const expandedPolicyAdmission = await host.admitModelPlanExecution(
        2, 44, "attempt-expanded-contracts", plan, new AbortController().signal,
        { ...policy, executionAccessContracts: ["secret@1", "managed-runtime@1"] },
      );
      expect(expandedPolicyAdmission.admittedPlan.harnessPolicyDigest)
        .not.toBe(admission.admittedPlan.harnessPolicyDigest);
      expect(await host.releaseProviderExecution(expandedPolicyAdmission.executionLeaseId)).toBe(true);
      await expect(host.complete(
        1, 44, graph(), plan.orchestrator, undefined, undefined,
        admission.executionLeaseId, policy, plan, "attempt-other",
      )).rejects.toThrow("invalid or expired");
      await expect(host.complete(
        1, 45, graph(), plan.orchestrator, undefined, undefined,
        admission.executionLeaseId, policy, plan, "attempt-bound",
      )).rejects.toThrow("invalid or expired");
      await expect(host.complete(
        1, 44, graph(), plan.orchestrator, undefined, undefined,
        admission.executionLeaseId, policy, { ...plan, familyRevision: 2 }, "attempt-bound",
      )).rejects.toThrow("invalid or expired");
      await expect(host.complete(
        1, 44, graph(), plan.orchestrator, undefined, undefined,
        admission.executionLeaseId, { ...policy, configurationDigest: `sha256:${"d".repeat(64)}` }, plan, "attempt-bound",
      )).rejects.toThrow(/stale or conflicts|invalid or expired/u);
      expect(release).toHaveBeenCalledOnce();
      expect(await host.releaseProviderExecution(admission.executionLeaseId)).toBe(true);
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not release a claimed lease on execution or terminal-ack timeouts", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-lease-timeouts-"));
    const release = vi.fn();
    let finishHarness!: () => void;
    const harnessFinished = new Promise<void>((resolve) => { finishHarness = resolve; });
    let harnessStarted!: () => void;
    const started = new Promise<void>((resolve) => { harnessStarted = resolve; });
    let accepted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? accepted
        ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control",
        accessBroker: { async acquire() {
          return {
            access: {
              kind: "secret", contract: "secret@1", providerId: "openai-work", adapterId: "openai-api",
              adapterImplementationVersion: "7", endpoint: "https://api.openai.test", fields: { "api-key": "opaque" },
            },
            release,
          };
        } },
        implementations: { test: () => ({ async complete() {
          harnessStarted();
          await harnessFinished;
          accepted = true;
        }, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({
        threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
        configuration: {
          ...testConfiguration,
          modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }], deny: [] },
          executionAccessContracts: ["secret@1"],
        },
      });
      const model = { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" };
      const admission = await host.admitProviderExecution(1, model, new AbortController().signal);
      const running = host.complete(1, 1, graph(), model, undefined, undefined, admission.executionLeaseId);
      await started;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(release).not.toHaveBeenCalled();

      finishHarness();
      await running;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_001);
      expect(release).not.toHaveBeenCalled();
      expect(await host.releaseProviderExecution(admission.executionLeaseId)).toBe(true);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("aborts and settles an active family completion on close without releasing before durable acknowledgement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-family-close-"));
    const release = vi.fn();
    let harnessStarted!: () => void;
    const started = new Promise<void>((resolve) => { harnessStarted = resolve; });
    const plan = {
      familyId: 1,
      familyRevision: 1,
      orchestrator: { providerId: "provider-a", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt" },
      roster: [{ providerId: "provider-a", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt" }],
    };
    const policy = {
      configurationRevision: 2,
      configurationDigest: `sha256:${"e".repeat(64)}`,
      executionAccessContracts: ["secret@1"],
      modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt" }], deny: [] },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : graphReadResponse(url)));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"), controlToken: "control",
        accessBroker: { async acquire() {
          return {
            access: {
              kind: "secret", contract: "secret@1", providerId: "provider-a", adapterId: "openai-api",
              adapterImplementationVersion: "1", endpoint: "https://provider-a.test", fields: { "api-key": "opaque" },
            },
            release,
          };
        } },
        implementations: { test: () => ({ async complete(_context, signal) {
          harnessStarted();
          await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(signal?.reason ?? new Error("aborted"));
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        }, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({
        threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
        configuration: { ...testConfiguration, revision: 1, modelRules: policy.modelRules, executionAccessContracts: ["secret@1"] },
      });
      const admission = await host.admitModelPlanExecution(
        1, 9, "attempt-close", plan, new AbortController().signal, policy,
      );
      const completionRun = host.complete(
        1, 9, graph(), plan.orchestrator, undefined, undefined,
        admission.executionLeaseId, policy, plan, "attempt-close",
      ).then(() => undefined, (error: unknown) => error);
      await started;
      await host.close();
      expect(await completionRun).toBeInstanceOf(Error);
      expect(release).not.toHaveBeenCalled();
      expect(await host.releaseProviderExecution(admission.executionLeaseId)).toBe(true);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes complete calls while preserving each call's graph scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-serialized-rotation-"));
    let completionStarted!: () => void;
    let finishCompletion!: () => void;
    const started = new Promise<void>((resolveStarted) => { completionStarted = resolveStarted; });
    const finish = new Promise<void>((resolveFinish) => { finishCompletion = resolveFinish; });
    const adopted: string[] = [];
    const accepted = new Set<number>();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => url.endsWith("/output")
      ? (accepted.has(Number(/nodes\/(\d+)/.exec(url)?.[1]))
        ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } }))
      : graphReadResponse(url, new Headers(init?.headers).get("authorization") === "Bearer second-token" ? 2 : 1)));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({
          async complete(context) {
            adopted.push(context.graph.acquireCapability().token);
            if (adopted.length === 1) { completionStarted(); await finish; }
            accepted.add(context.inputGraph.id);
          },
          state: emptyState,
        }) },
      });
      await host.initialize();
      const first = { threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory };
      await host.createSession(first);

      const completing = host.complete(1, 1, graph(1, "first-token"));
      await started;
      const queued = host.complete(1, 2, graph(2, "second-token"));
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));
      expect(adopted).toEqual(["first-token"]);

      finishCompletion();
      await completing;
      await queued;
      expect(adopted).toEqual(["first-token", "second-token"]);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets provider-owned invoked completions run concurrently and cancels one exact completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-recursive-concurrency-"));
    const started = new Set<number>();
    const accepted = new Set<number>();
    const releases = new Map<number, () => void>();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/output")) {
        const nodeId = Number(/nodes\/(\d+)/.exec(url)?.[1]);
        return accepted.has(nodeId)
          ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      const token = new Headers(init?.headers).get("authorization");
      const nodeId = token === "Bearer child-b-token" ? 3 : 2;
      return graphReadResponse(url, nodeId, [], nodeId + 100);
    }));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({
          supportsInvokedComplete: true,
          complete(context, signal) {
            const id = context.inputGraph.id;
            started.add(id);
            return new Promise<void>((resolve, reject) => {
              releases.set(id, () => { accepted.add(id); resolve(); });
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
          state: emptyState,
        }) },
      });
      await host.initialize();
      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });

      const first = host.complete(1, invoked(graph(2, "child-a-token")));
      const second = host.complete(1, invoked(graph(3, "child-b-token")));
      await vi.waitFor(() => expect([...started].sort()).toEqual([2, 3]));

      expect(host.cancel(1, 2)).toBe(true);
      releases.get(3)!();
      await expect(first).rejects.toThrow("cancelled for thread 1");
      await expect(second).resolves.toMatchObject({ output: completion });
      expect(host.cancel(1, 3)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers an in-flight invoked completion without starting the provider twice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-recursive-retry-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let starts = 0;
    let accepted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? (accepted
        ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } }))
      : (() => {
          const nodeId = Number(/nodes\/(\d+)/u.exec(url)?.[1] ?? 2);
          return graphReadResponse(url, nodeId, [], nodeId + 100);
        })()));
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: { test: () => ({
        supportsInvokedComplete: true,
        async complete() {
          starts += 1;
          await gate;
          accepted = true;
        },
        state: emptyState,
      }) },
    });
    try {
      await host.initialize();
      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });
      const capability = graph(2, "child-token");
      const first = host.complete(1, invoked(capability));
      const retry = host.complete(1, invoked(capability));
      await vi.waitFor(() => expect(starts).toBe(1));
      release();
      await expect(Promise.all([first, retry])).resolves.toHaveLength(2);
      expect(starts).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays a settled invoked failure without starting the provider twice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-recursive-settled-retry-"));
    let starts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : graphReadResponse(url, 2, [], 102)));
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: { test: () => ({
        supportsInvokedComplete: true,
        async complete() {
          starts += 1;
          throw new Error("invoked provider failed");
        },
        state: emptyState,
      }) },
    });
    try {
      await host.initialize();
      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });
      const capability = graph(2, "child-token");

      const first = host.complete(1, invoked(capability));
      await expect(first).rejects.toThrow("invoked provider failed");
      const retry = host.complete(1, invoked(capability));

      await expect(retry).rejects.toThrow("invoked provider failed");
      expect(starts).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers an accepted invoked result before requiring a new provider attachment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-invoked-accepted-recovery-"));
    let starts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const nodeId = Number(/nodes\/(\d+)/u.exec(url)?.[1] ?? 2);
      if (url.endsWith("/output")) {
        return nodeId === 2
          ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return graphReadResponse(url, nodeId, [], nodeId + 100);
    }));
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: { test: () => ({
        async complete() { starts += 1; },
        state: emptyState,
      }) },
    });
    try {
      await host.initialize();
      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });

      await expect(host.complete(1, invoked(graph(3, "unsupported-token"))))
        .rejects.toThrow("does not support agent-invoked Complete");
      await expect(host.complete(1, invoked(graph(2, "recovered-token"))))
        .resolves.toMatchObject({ output: completion });
      expect(starts).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a conflicting binding instead of transferring an in-flight invoked result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-recursive-binding-conflict-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let starts = 0;
    let accepted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? (accepted
        ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } }))
      : graphReadResponse(url, 2, [], 102)));
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: { test: () => ({
        supportsInvokedComplete: true,
        async complete() {
          starts += 1;
          await gate;
          accepted = true;
        },
        state: emptyState,
      }) },
    });
    try {
      await host.initialize();
      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });
      await expect(host.complete(1, {
        capability: graph(4, "root-smuggle-token"),
        origin: ({ kind: "root", sourceCompletionId: 1, actionId: 104 } as unknown as HarnessInvokedCompletion["origin"]),
      })).rejects.toThrow("invalid trusted origin provenance");
      await expect(host.complete(1, invoked(graph(3, "forged-token"), 1, 999)))
        .rejects.toThrow("does not match its graph-owned action lease");
      expect(starts).toBe(0);
      const running = host.complete(1, invoked(graph(2, "child-token")));
      await vi.waitFor(() => expect(starts).toBe(1));

      const reorderedRetry = host.complete(1, {
        capability: { nodeId: 2, token: "child-token", url: "http://127.0.0.1:43123" },
        origin: { actionId: 102, sourceCompletionId: 1, kind: "invoke" },
      });

      await expect(host.complete(1, invoked(graph(2, "foreign-token"))))
        .rejects.toThrow("different graph binding");
      await expect(host.complete(1, invoked(graph(2, "child-token"), 1, 999)))
        .rejects.toThrow("different graph binding");
      await expect(host.complete(1, {
        ...invoked(graph(2, "child-token")),
        model: { providerId: "provider", adapterId: "openai-api", modelId: "different-model" },
      })).rejects.toThrow("different graph binding");

      release();
      await expect(Promise.all([running, reorderedRetry])).resolves.toHaveLength(2);
      expect(starts).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for invoked completion cleanup before disposing the provider session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-recursive-close-"));
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let unwound = false;
    let disposed = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : graphReadResponse(url, 2, [], 102)));
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: { test: () => ({
        supportsInvokedComplete: true,
        complete(_context, signal) {
          started();
          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              setTimeout(() => {
                unwound = true;
                reject(signal.reason);
              }, 10);
            }, { once: true });
          });
        },
        state: emptyState,
        dispose() {
          expect(unwound).toBe(true);
          disposed = true;
        },
      }) },
    });
    try {
      await host.initialize();
      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });
      const running = host.complete(1, invoked(graph(2, "child-token")));
      await didStart;
      const closing = host.close();
      await expect(running).rejects.toThrow("Harness host closed");
      await expect(closing).resolves.toBeUndefined();
      expect(disposed).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases the per-thread queue when harness state capture throws", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-queue-"));
    let stateCalls = 0;
    let accepted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? (accepted
        ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } }))
      : graphReadResponse(url)));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({
          async complete() { accepted = true; },
          state() { if (stateCalls++ === 1) throw new Error("state failed"); return emptyState(); },
        }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

      await expect(host.complete(1, 1, graph())).rejects.toThrow("state failed");
      await expect(host.complete(1, 2, graph())).resolves.toMatchObject({ output: completion });
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries persistence when a live session is registered again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-persist-"));
    const blocker = join(directory, "blocked");
    const stateFile = join(blocker, "sessions.json");
    const host = new HarnessHost({
      stateFile,
      controlToken: "control",
      implementations: { test: () => ({ async complete() {}, state: emptyState }) },
    });
    const descriptor = { threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory };
    try {
      await host.initialize();
      await writeFile(blocker, "not a directory", "utf8");
      await expect(host.createSession(descriptor)).rejects.toThrow();
      await rm(blocker);
      await mkdir(blocker);

      await host.createSession(descriptor);

      expect(JSON.parse(await readFile(stateFile, "utf8")).sessions).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stores resumable state without graph capabilities and with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-mode-"));
    const stateFile = join(directory, "sessions.json");
    try {
      const host = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { test: () => ({ async complete() {}, state: () => ({ providerSessionId: "session" }) }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

      expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
      const persisted = await readFile(stateFile, "utf8");
      expect(persisted).not.toContain("secret");
      expect(JSON.parse(persisted)).toEqual({
        schemaVersion: 6,
        sessions: [{
          threadId: 1, permissionProfileId: "auto",
          configuration: testConfiguration,
          workingDirectory: directory,
          state: { providerSessionId: "session" },
        }],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [4, "codex-basic", "medium", 1],
    [4, "codex-basic", "medium", 2],
    [4, "codex-basic-high", "high", 1],
    [4, "codex-basic-high", "high", 2],
    [5, "codex-basic", "medium", 1],
    [5, "codex-basic", "medium", 2],
    [5, "codex-basic-high", "high", 1],
    [5, "codex-basic-high", "high", 2],
  ])("migrates schema-v%i %s with %s effort at revision %i when Desktop registers the product configuration", async (schemaVersion, legacyName, legacyEffort, legacyRevision) => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-state-product-codex-"));
    const stateFile = join(directory, "sessions.json");
    const legacy: HarnessConfiguration = {
      ...testConfiguration,
      name: legacyName,
      implementation: "codex.basic",
      revision: legacyRevision,
      executionAccessContracts: ["managed-runtime@1", "secret@1"],
      settings: { modelReasoningEffort: legacyEffort, skipGitRepoCheck: true },
    };
    const current: HarnessConfiguration = {
      ...legacy,
      name: "codex-basic",
      revision: 3,
      settings: {
        modelReasoningEffort: "medium",
        promptProfile: "layered-navigation-multi-agent-v1",
        skipGitRepoCheck: true,
      },
    };
    const serialized = JSON.stringify({
      schemaVersion,
      sessions: [{
        threadId: 1,
        configuration: legacy,
        permissionProfileId: "auto",
        workingDirectory: directory,
        state: { providerSessionId: "existing-session" },
      }],
    });
    let restoredState: HarnessSessionState | undefined;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const host = new HarnessHost({
      stateFile,
      controlToken: "control",
      implementations: { "codex.basic": (context) => {
        restoredState = context.savedState;
        return { async complete() {}, state: () => context.savedState ?? emptyState() };
      } },
    });
    try {
      await writeFile(stateFile, serialized, { mode: 0o600 });

      await host.initialize();

      expect(await readFile(`${stateFile}.v${schemaVersion}.backup`, "utf8")).toBe(serialized);
      expect(warning).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
        schemaVersion: 6,
        sessions: [{ threadId: 1, configuration: legacy, state: { providerSessionId: "existing-session" } }],
      });

      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: current,
        workingDirectory: directory,
      });

      expect(warning).toHaveBeenCalledWith(
        "Migrating retired product Codex configuration for harness thread 1 during registration",
      );
      expect(restoredState).toEqual({ providerSessionId: "existing-session" });
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
        schemaVersion: 6,
        sessions: [{ threadId: 1, configuration: current, state: { providerSessionId: "existing-session" } }],
      });
    } finally {
      warning.mockRestore();
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["codex-basic", "medium"],
    ["codex-basic-high", "high"],
  ])("migrates deferred schema-v5 %s sessions to the product Codex configuration", async (legacyName, legacyEffort) => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-state-v5-deferred-product-codex-"));
    const stateFile = join(directory, "sessions.json");
    const current: HarnessConfiguration = {
      ...testConfiguration,
      name: "codex-basic",
      implementation: "codex.basic",
      revision: 3,
      executionAccessContracts: ["managed-runtime@1", "secret@1"],
      settings: {
        modelReasoningEffort: "medium",
        promptProfile: "layered-navigation-multi-agent-v1",
        skipGitRepoCheck: true,
      },
    };
    const serialized = JSON.stringify({
      schemaVersion: 5,
      sessions: [],
      legacySessions: [{
        threadId: 1,
        configuration: {
          schemaVersion: 1,
          name: legacyName,
          implementation: "codex.basic",
          implementationVersion: 1,
          settings: { modelReasoningEffort: legacyEffort, skipGitRepoCheck: true },
        },
        workingDirectory: directory,
        state: { providerSessionId: "existing-session" },
      }],
    });
    let restoredState: HarnessSessionState | undefined;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const host = new HarnessHost({
      stateFile,
      controlToken: "control",
      implementations: { "codex.basic": (context) => {
        restoredState = context.savedState;
        return { async complete() {}, state: () => context.savedState ?? emptyState() };
      } },
    });
    try {
      await writeFile(stateFile, serialized, { mode: 0o600 });

      await host.initialize();

      expect(await readFile(`${stateFile}.v5.backup`, "utf8")).toBe(serialized);
      expect(warning).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
        schemaVersion: 6,
        legacySessions: [{
          threadId: 1,
          configuration: {
            name: legacyName,
            settings: { modelReasoningEffort: legacyEffort, skipGitRepoCheck: true },
          },
          state: { providerSessionId: "existing-session" },
        }],
      });

      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: current,
        workingDirectory: directory,
      });

      expect(warning).toHaveBeenCalledWith(
        "Migrating deferred product Codex configuration for harness thread 1 during registration",
      );
      expect(restoredState).toEqual({ providerSessionId: "existing-session" });
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
        schemaVersion: 6,
        sessions: [{ threadId: 1, configuration: current, state: { providerSessionId: "existing-session" } }],
      });
      expect(JSON.parse(await readFile(stateFile, "utf8"))).not.toHaveProperty("legacySessions");
    } finally {
      warning.mockRestore();
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves an Eval codex-basic-high provider session during schema-v5 migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-state-v5-eval-codex-high-"));
    const stateFile = join(directory, "sessions.json");
    const high: HarnessConfiguration = {
      ...testConfiguration,
      name: "codex-basic-high",
      implementation: "codex.basic",
      revision: 2,
      executionAccessContracts: ["managed-runtime@1", "secret@1"],
      settings: { modelReasoningEffort: "high", skipGitRepoCheck: true },
    };
    const serialized = JSON.stringify({
      schemaVersion: 5,
      sessions: [{
        threadId: 1,
        configuration: high,
        permissionProfileId: "auto",
        workingDirectory: directory,
        state: { providerSessionId: "eval-session" },
      }],
    });
    let restoredState: HarnessSessionState | undefined;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const host = new HarnessHost({
      stateFile,
      controlToken: "control",
      implementations: { "codex.basic": (context) => {
        restoredState = context.savedState;
        return { async complete() {}, state: () => context.savedState ?? emptyState() };
      } },
    });
    try {
      await writeFile(stateFile, serialized, { mode: 0o600 });
      await host.initialize();
      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: high,
        workingDirectory: directory,
      });

      expect(warning).not.toHaveBeenCalled();
      expect(restoredState).toEqual({ providerSessionId: "eval-session" });
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
        schemaVersion: 6,
        sessions: [{ threadId: 1, configuration: high, state: { providerSessionId: "eval-session" } }],
      });
    } finally {
      warning.mockRestore();
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes schema-v4 provider state when only catalog model compatibility was added", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-model-metadata-"));
    const stateFile = join(directory, "sessions.json");
    const currentConfiguration: HarnessConfiguration = {
      ...testConfiguration,
      modelCompatibility: [{ providerId: "codex" }],
      executionAccessContracts: ["managed-runtime@1"],
    };
    let restoredState: HarnessSessionState | undefined;
    const host = new HarnessHost({
      stateFile,
      controlToken: "control",
      implementations: { test: (context) => {
        restoredState = context.savedState;
        return { async complete() {}, state: () => context.savedState ?? emptyState() };
      } },
    });
    try {
      await writeFile(stateFile, JSON.stringify({
        schemaVersion: 4,
        sessions: [{
          threadId: 1,
          configuration: { ...testConfiguration, executionAccessContracts: ["managed-runtime@1"] },
          permissionProfileId: "auto",
          workingDirectory: directory,
          state: { providerSessionId: "existing-session" },
        }],
      }), { mode: 0o600 });
      await host.initialize();

      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: currentConfiguration,
        workingDirectory: directory,
      });

      expect(restoredState).toEqual({ providerSessionId: "existing-session" });
      expect(JSON.parse(await readFile(stateFile, "utf8")).sessions[0].configuration)
        .toEqual(currentConfiguration);
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates pre-access-contract schema-v4 sessions without resuming ambient provider state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-state-v4-pre-access-"));
    const stateFile = join(directory, "sessions.json");
    const previousConfiguration = {
      ...testConfiguration,
      modelCompatibility: [{ providerId: "codex" }],
    };
    const currentConfiguration: HarnessConfiguration = {
      ...previousConfiguration,
      modelRules: { allow: [{ adapterId: "codex-subscription", modelIdRegex: ".*" }], deny: [] },
      executionAccessContracts: ["managed-runtime@1"],
    };
    const serialized = JSON.stringify({
      schemaVersion: 4,
      sessions: [{
        threadId: 1,
        configuration: previousConfiguration,
        permissionProfileId: "auto",
        workingDirectory: directory,
        state: { providerSessionId: "ambient-session" },
      }],
    });
    let restoredState: HarnessSessionState | undefined;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const host = new HarnessHost({
      stateFile,
      controlToken: "control",
      implementations: { test: (context) => {
        restoredState = context.savedState;
        return { async complete() {}, state: emptyState };
      } },
    });
    try {
      await writeFile(stateFile, serialized, { mode: 0o600 });

      await host.initialize();

      expect(await readFile(`${stateFile}.v4.backup`, "utf8")).toBe(serialized);
      expect(warning).toHaveBeenCalledWith(
        "Discarding pre-access-contract provider state for harness thread 1 during schema v4 migration",
      );
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({
        schemaVersion: 6,
        sessions: [],
      });

      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: currentConfiguration,
        workingDirectory: directory,
      });

      expect(restoredState).toBeUndefined();
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({
        schemaVersion: 6,
        sessions: [{
          threadId: 1,
          configuration: currentConfiguration,
          permissionProfileId: "auto",
          workingDirectory: directory,
          state: {},
        }],
      });
    } finally {
      warning.mockRestore();
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects schema-v4 model policy corruption outside the pre-access-contract shape", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-state-v4-invalid-policy-"));
    const stateFile = join(directory, "sessions.json");
    const host = new HarnessHost({ stateFile, controlToken: "control", implementations: {} });
    try {
      await writeFile(stateFile, JSON.stringify({
        schemaVersion: 4,
        sessions: [{
          threadId: 1,
          configuration: {
            ...testConfiguration,
            modelCompatibility: [{ providerId: "codex" }],
            modelRules: { allow: [], deny: [] },
          },
          permissionProfileId: "auto",
          workingDirectory: directory,
          state: { providerSessionId: "untrusted-session" },
        }],
      }), { mode: 0o600 });

      await expect(host.initialize()).rejects.toThrow("require executionAccessContracts");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates schema-v3 state on startup and safely resumes matching Auto sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-state-v3-"));
    const stateFile = join(directory, "sessions.json");
    const serialized = JSON.stringify({
      schemaVersion: 3,
      sessions: [{
        threadId: 1,
        configuration: {
          schemaVersion: 1,
          name: testConfiguration.name,
          implementation: testConfiguration.implementation,
          implementationVersion: 1,
          settings: {},
        },
        workingDirectory: directory,
        state: { providerSessionId: "legacy-session" },
      }],
    });
    let restoredState: HarnessSessionState | undefined;
    const host = new HarnessHost({
      stateFile,
      controlToken: "control",
      implementations: { test: (context) => {
        restoredState = context.savedState;
        return { async complete() {}, state: () => context.savedState ?? emptyState() };
      } },
    });
    try {
      await writeFile(stateFile, serialized, { mode: 0o600 });

      await host.initialize();

      expect(await readFile(`${stateFile}.v3.backup`, "utf8")).toBe(serialized);
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({
        schemaVersion: 6,
        sessions: [],
        legacySessions: [{
          threadId: 1,
          configuration: legacyConfiguration(testConfiguration),
          workingDirectory: directory,
          state: { providerSessionId: "legacy-session" },
        }],
      });

      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });

      expect(restoredState).toEqual({ providerSessionId: "legacy-session" });
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({
        schemaVersion: 6,
        sessions: [{
          threadId: 1,
          configuration: testConfiguration,
          permissionProfileId: "auto",
          workingDirectory: directory,
          state: { providerSessionId: "legacy-session" },
        }],
      });
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not carry schema-v3 provider state into a different permission profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-state-v3-profile-"));
    const stateFile = join(directory, "sessions.json");
    let restoredState: HarnessSessionState | undefined;
    const host = new HarnessHost({
      stateFile,
      controlToken: "control",
      implementations: { test: (context) => {
        restoredState = context.savedState;
        return { async complete() {}, state: emptyState };
      } },
    });
    try {
      await writeFile(stateFile, JSON.stringify({
        schemaVersion: 3,
        sessions: [{
          threadId: 1,
          configuration: legacyConfiguration(testConfiguration),
          workingDirectory: directory,
          state: { providerSessionId: "legacy-session" },
        }],
      }), { mode: 0o600 });
      await host.initialize();

      await host.createSession({
        threadId: 1,
        permissionProfileId: "full",
        configuration: testConfiguration,
        workingDirectory: directory,
      });

      expect(restoredState).toBeUndefined();
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
        schemaVersion: 6,
        sessions: [{ threadId: 1, permissionProfileId: "full", state: {} }],
      });
      expect(JSON.parse(await readFile(stateFile, "utf8"))).not.toHaveProperty("legacySessions");
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes schema-v3 provider state with the sole bound Full profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-state-v3-full-"));
    const stateFile = join(directory, "sessions.json");
    const configuration = {
      ...testConfiguration,
      name: "prime-agent-basic",
      permissionBindings: { full: {} },
    };
    let restoredState: HarnessSessionState | undefined;
    const host = new HarnessHost({
      stateFile,
      controlToken: "control",
      implementations: { test: (context) => {
        restoredState = context.savedState;
        return { async complete() {}, state: () => context.savedState ?? emptyState() };
      } },
    });
    try {
      await writeFile(stateFile, JSON.stringify({
        schemaVersion: 3,
        sessions: [{
          threadId: 1,
          configuration: legacyConfiguration(configuration),
          workingDirectory: directory,
          state: { providerSessionId: "legacy-prime-session" },
        }],
      }), { mode: 0o600 });
      await host.initialize();

      await host.createSession({
        threadId: 1,
        permissionProfileId: "full",
        configuration,
        workingDirectory: directory,
      });

      expect(restoredState).toEqual({ providerSessionId: "legacy-prime-session" });
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
        schemaVersion: 6,
        sessions: [{ threadId: 1, permissionProfileId: "full" }],
      });
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not resume schema-v3 provider state after configuration settings change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-state-v3-settings-"));
    const stateFile = join(directory, "sessions.json");
    const currentConfiguration = { ...testConfiguration, settings: { model: "new" } };
    let restoredState: HarnessSessionState | undefined;
    const host = new HarnessHost({
      stateFile,
      controlToken: "control",
      implementations: { test: (context) => {
        restoredState = context.savedState;
        return { async complete() {}, state: emptyState };
      } },
    });
    try {
      await writeFile(stateFile, JSON.stringify({
        schemaVersion: 3,
        sessions: [{
          threadId: 1,
          configuration: { ...legacyConfiguration(testConfiguration), settings: { model: "old" } },
          workingDirectory: directory,
          state: { providerSessionId: "legacy-session" },
        }],
      }), { mode: 0o600 });
      await host.initialize();

      await host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: currentConfiguration,
        workingDirectory: directory,
      });

      expect(restoredState).toBeUndefined();
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
        schemaVersion: 6,
        sessions: [{
          threadId: 1,
          configuration: currentConfiguration,
          permissionProfileId: "auto",
          state: {},
        }],
      });
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("skips an invalid schema-v3 entry without blocking valid session migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-state-v3-invalid-"));
    const stateFile = join(directory, "sessions.json");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const host = new HarnessHost({ stateFile, controlToken: "control", implementations: {} });
    try {
      await writeFile(stateFile, JSON.stringify({
        schemaVersion: 3,
        sessions: [
          { threadId: "invalid", configuration: {}, workingDirectory: directory },
          { threadId: 2, configuration: legacyConfiguration(testConfiguration), workingDirectory: directory },
        ],
      }), { mode: 0o600 });

      await host.initialize();

      expect(warning).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(stateFile, "utf8")).legacySessions).toEqual([{
        threadId: 2,
        configuration: legacyConfiguration(testConfiguration),
        workingDirectory: directory,
      }]);
    } finally {
      warning.mockRestore();
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsupported pre-v3 host state instead of guessing how to migrate it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-state-migration-"));
    const stateFile = join(directory, "sessions.json");
    try {
      await writeFile(stateFile, JSON.stringify({
        schemaVersion: 1,
        sessions: [{
          threadId: 1, permissionProfileId: "auto",
          harnessKey: "codex.basic",
          workingDirectory: directory,
          graph: { url: "http://127.0.0.1:1", token: "legacy-secret", nodeId: 1 },
          state: { codexThreadId: "codex-thread" },
        }],
      }), { mode: 0o600 });
      const host = new HarnessHost({ stateFile, controlToken: "control", implementations: {} });

      await expect(host.initialize()).rejects.toThrow("expected schema version 3, 4, 5, or 6");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes authenticated cancellation through the host API", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-cancel-route-"));
    let running: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
    try {
      running = await startHarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: {},
      });
      const response = await fetch(`${running.url}/sessions/1/cancel`, {
        method: "POST",
        headers: { authorization: "Bearer control" },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ cancelled: false });
      const invalid = await fetch(`${running.url}/sessions/1/cancel?completionId=not-a-number`, {
        method: "POST",
        headers: { authorization: "Bearer control" },
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "invalid_completion_id" });
    } finally {
      await running?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not report host readiness before trace spool startup cleanup succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-trace-readiness-"));
    const spool = join(directory, "spool");
    try {
      await writeFile(spool, "not a directory\n");
      await expect(startHarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: {},
        trace: {
          directory: spool,
          policy: {
            mode: "required",
            requiredFeatures: {},
            includeNativeArtifacts: false,
            maxBytesPerTurn: 1_000,
            maxEventsPerTurn: 10,
          },
        },
      })).rejects.toThrow("spool must be a real directory");
      await expect(readFile(spool, "utf8")).resolves.toBe("not a directory\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("makes concurrent initialization and close terminal before trace cleanup can mutate again", async () => {
    for (const force of [false, true]) {
      const directory = await mkdtemp(join(tmpdir(), `relayer-harness-trace-${force ? "force" : "close"}-race-`));
      const spool = join(directory, "spool");
      const abandoned = join(spool, "abandoned.txt");
      try {
        await mkdir(spool, { mode: 0o700 });
        await writeFile(abandoned, "cleanup-owned\n");
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: {},
          trace: {
            directory: spool,
            policy: {
              mode: "required",
              requiredFeatures: {},
              includeNativeArtifacts: false,
              maxBytesPerTurn: 1_000,
              maxEventsPerTurn: 10,
            },
          },
        });

        const initializing = host.initialize();
        expect(host.initialize()).toBe(initializing);
        const closing = force ? host.forceClose() : host.close();
        expect(force ? host.forceClose() : host.close()).toBe(closing);
        await expect(initializing).rejects.toThrow("closed");
        await closing;
        await expect(readFile(abandoned, "utf8")).rejects.toThrow();
        const sentinel = join(spool, "post-close-sentinel.txt");
        await writeFile(sentinel, "survives\n");
        await Promise.resolve();
        await expect(readFile(sentinel, "utf8")).resolves.toBe("survives\n");
        await expect(host.createSession({
          threadId: 1,
          permissionProfileId: "auto",
          configuration: testConfiguration,
          workingDirectory: directory,
        })).rejects.toThrow("closed");
        await expect(host.complete(1, 1, graph())).rejects.toThrow("closed");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("does not migrate legacy state after concurrent close wins initialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-close-migration-race-"));
    const stateFile = join(directory, "sessions.json");
    const serialized = `${JSON.stringify({ schemaVersion: 3, sessions: [] }, null, 2)}\n`;
    try {
      await writeFile(stateFile, serialized, { mode: 0o600 });
      const host = new HarnessHost({ stateFile, controlToken: "control", implementations: {} });
      const initializing = host.initialize();
      const closing = host.close();
      await expect(initializing).rejects.toThrow("closed");
      await closing;
      await expect(readFile(`${stateFile}.v3.backup`, "utf8")).rejects.toThrow();
      await expect(readFile(stateFile, "utf8")).resolves.toBe(serialized);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("publishes the canonical force promise before synchronous provider reentry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-force-reentry-"));
    let host!: HarnessHost;
    let reentered: Promise<void> | undefined;
    let markDisposed!: () => void;
    const disposed = new Promise<void>((resolve) => { markDisposed = resolve; });
    const dispose = vi.fn(() => { markDisposed(); });
    try {
      host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({
          async complete() {},
          state: emptyState,
          forceShutdown() { reentered = host.forceClose(); },
          dispose,
        }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

      const forcing = host.forceClose();
      expect(reentered).toBe(forcing);
      expect(host.forceClose()).toBe(forcing);
      await forcing;
      await disposed;
      expect(dispose).toHaveBeenCalledOnce();
      await expect(host.createSession({
        threadId: 2,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      })).rejects.toThrow("closed");
    } finally {
      await host?.forceClose().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("force-disposes a harness whose pending registration resolves after force close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-pending-force-close-"));
    let resolveHarness!: (harness: Harness) => void;
    let markFactoryStarted!: () => void;
    const factoryStarted = new Promise<void>((resolve) => { markFactoryStarted = resolve; });
    const forceShutdown = vi.fn();
    const pendingHarness = new Promise<Harness>((resolve) => { resolveHarness = resolve; });
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: { test: () => { markFactoryStarted(); return pendingHarness; } },
    });
    try {
      await host.initialize();
      const registering = host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });

      await factoryStarted;
      await host.forceClose();
      resolveHarness({ async complete() {}, state: emptyState, forceShutdown });

      await expect(registering).rejects.toThrow("force-closed while the session was starting");
      expect(forceShutdown).toHaveBeenCalledOnce();
    } finally {
      resolveHarness?.({ async complete() {}, state: emptyState, forceShutdown });
      await host.forceClose().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("contains a late force-dispose throw and performs bounded fallback cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-late-force-throw-"));
    let resolveHarness!: (harness: Harness) => void;
    let markFactoryStarted!: () => void;
    const factoryStarted = new Promise<void>((resolve) => { markFactoryStarted = resolve; });
    const pendingHarness = new Promise<Harness>((resolve) => { resolveHarness = resolve; });
    const forceShutdown = vi.fn(() => { throw new Error("late force cleanup failed"); });
    const dispose = vi.fn(() => new Promise<void>(() => {}));
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: { test: () => { markFactoryStarted(); return pendingHarness; } },
    });
    try {
      await host.initialize();
      const registering = host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });
      await factoryStarted;
      await host.forceClose();

      resolveHarness({ async complete() {}, state: emptyState, forceShutdown, dispose });

      await expect(registering).rejects.toThrow("Harness host force-closed while the session was starting");
      expect(forceShutdown).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      await expect(host.forceClose()).resolves.toBeUndefined();
    } finally {
      resolveHarness?.({ async complete() {}, state: emptyState, forceShutdown, dispose });
      await host.forceClose().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets a late Prime harness complete graceful fallback after forced native disposal throws", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-late-prime-force-throw-"));
    let resolveHarness!: (harness: Harness) => void;
    let markFactoryStarted!: () => void;
    let markFallbackFinished!: () => void;
    const factoryStarted = new Promise<void>((resolve) => { markFactoryStarted = resolve; });
    const fallbackFinished = new Promise<void>((resolve) => { markFallbackFinished = resolve; });
    const pendingHarness = new Promise<Harness>((resolve) => { resolveHarness = resolve; });
    let nativeAttempts = 0;
    const nativeDispose = vi.fn(() => {
      nativeAttempts += 1;
      if (nativeAttempts === 1) throw new Error("late Prime native cleanup failed");
    });
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: nativeDispose,
      disposeAsync: vi.fn(async () => {
        session.dispose();
        markFallbackFinished();
      }),
    };
    const harness = await PrimeAgentHarness.create({
      threadId: 1,
      workingDirectory: directory,
      permissionProfileId: "full",
      permissionBinding: {},
      configuration: {
        schemaVersion: 1,
        name: "prime-agent-test",
        implementation: "prime.agent",
        implementationVersion: 1,
        permissionBindings: { full: {} },
        settings: {},
      },
    }, { loadModule: async () => ({
      SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({ modelRegistry: { find: vi.fn() } })),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never });
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: { test: () => { markFactoryStarted(); return pendingHarness; } },
    });
    try {
      await host.initialize();
      const registering = host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });
      await factoryStarted;
      await host.forceClose();

      resolveHarness(harness);

      await expect(registering).rejects.toThrow("Harness host force-closed while the session was starting");
      await fallbackFinished;
      expect(session.abort).toHaveBeenCalledOnce();
      expect(session.disposeAsync).toHaveBeenCalledOnce();
      expect(nativeDispose).toHaveBeenCalledTimes(2);
    } finally {
      resolveHarness?.(harness);
      await host.forceClose().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back to bounded disposal when a late harness has no force disposer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-pending-force-fallback-"));
    let resolveHarness!: (harness: Harness) => void;
    let markFactoryStarted!: () => void;
    const factoryStarted = new Promise<void>((resolve) => { markFactoryStarted = resolve; });
    const pendingHarness = new Promise<Harness>((resolve) => { resolveHarness = resolve; });
    const dispose = vi.fn(() => new Promise<void>(() => {}));
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: { test: () => { markFactoryStarted(); return pendingHarness; } },
    });
    try {
      await host.initialize();
      const registering = host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });
      await factoryStarted;
      await host.forceClose();

      resolveHarness({ async complete() {}, state: emptyState, dispose });

      await expect(registering).rejects.toThrow("force-closed while the session was starting");
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      resolveHarness?.({ async complete() {}, state: emptyState, dispose });
      await host.forceClose().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a late graceful disposal reachable by force close until it drains", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-late-grace-force-"));
    let resolveHarness!: (harness: Harness) => void;
    let markFactoryStarted!: () => void;
    let markDisposeStarted!: () => void;
    let releaseDispose!: () => void;
    const factoryStarted = new Promise<void>((resolve) => { markFactoryStarted = resolve; });
    const disposeStarted = new Promise<void>((resolve) => { markDisposeStarted = resolve; });
    const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
    const pendingHarness = new Promise<Harness>((resolve) => { resolveHarness = resolve; });
    const forceShutdown = vi.fn(() => releaseDispose());
    const dispose = vi.fn(async () => { markDisposeStarted(); await disposeGate; });
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: { test: () => { markFactoryStarted(); return pendingHarness; } },
    });
    try {
      await host.initialize();
      const registering = host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });
      await factoryStarted;
      await host.close();
      resolveHarness({ async complete() {}, state: emptyState, dispose, forceShutdown });
      await disposeStarted;

      await host.forceClose();
      await expect(registering).rejects.toThrow("closed while the session was starting");

      expect(dispose).toHaveBeenCalledOnce();
      expect(forceShutdown).toHaveBeenCalledOnce();
    } finally {
      releaseDispose?.();
      resolveHarness?.({ async complete() {}, state: emptyState, dispose, forceShutdown });
      await host.forceClose().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("force-closes the listener and active sockets while graceful harness disposal is stalled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-force-close-"));
    let running: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
    let releaseDispose!: () => void;
    let markDisposeStarted!: () => void;
    const disposeStarted = new Promise<void>((resolveStarted) => { markDisposeStarted = resolveStarted; });
    const disposeGate = new Promise<void>((resolveDispose) => { releaseDispose = resolveDispose; });
    const forceShutdown = vi.fn();
    const dispose = vi.fn(async () => {
      markDisposeStarted();
      await disposeGate;
    });
    try {
      running = await startHarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({
          async complete() {},
          state: emptyState,
          dispose,
          forceShutdown,
        }) },
      });
      await running.host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: testConfiguration,
        workingDirectory: directory,
      });
      const address = new URL(running.url);
      const socket = connect(Number(address.port), address.hostname);
      await new Promise<void>((resolveConnect, reject) => {
        socket.once("connect", resolveConnect);
        socket.once("error", reject);
      });
      const socketClosed = new Promise<void>((resolveClose) => socket.once("close", () => resolveClose()));
      socket.write("POST /sessions HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{");

      const closing = running.close();
      await disposeStarted;
      const forced = running.forceClose();
      const forcedAgain = running.forceClose();
      expect(forceShutdown).toHaveBeenCalledOnce();
      await socketClosed;
      await expect(fetch(`${running.url}/sessions`, { method: "POST" })).rejects.toThrow();
      releaseDispose();
      await Promise.all([forced, forcedAgain]);
      await closing;
      expect(dispose).toHaveBeenCalledOnce();
      expect(forceShutdown).toHaveBeenCalledOnce();
    } finally {
      releaseDispose?.();
      await running?.forceClose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps one HTTP completion waiting while its approval decision bypasses the session lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-approval-route-"));
    const nativeFetch = globalThis.fetch;
    let running: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
    let accepted = false;
    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => { approvalStarted = resolve; });
    const observedDecisions: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith("http://127.0.0.1:43123")) return nativeFetch(input, init);
      if (url.endsWith("/output")) {
        return accepted
          ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    try {
      running = await startHarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({
          async complete(context) {
            const waiting = context.approvals.request({
              providerItemId: "private-provider-item",
              title: "Run tests",
              reason: "Verify the requested change.",
              action: { kind: "command", command: "npm test", workingDirectory: directory },
              scopeKeys: ["command:npm test", `cwd:${directory}`],
              scopeDescription: `Run npm test in ${directory} for this session.`,
            });
            approvalStarted();
            observedDecisions.push(await waiting);
            accepted = true;
          },
          state: emptyState,
        }) },
      });
      await running.host.createSession({
        threadId: 1,
        permissionProfileId: "ask",
        configuration: testConfiguration,
        workingDirectory: directory,
      });

      const completing = fetch(`${running.url}/sessions/1/complete`, {
        method: "POST",
        headers: { authorization: "Bearer control", "content-type": "application/json" },
        body: JSON.stringify({ interactionId: 91, graph: graph() }),
      });
      await started;
      const snapshotResponse = await fetch(`${running.url}/sessions/1/approval-events?after=0`, {
        headers: { authorization: "Bearer control" },
      });
      const snapshot = await snapshotResponse.json() as {
        harnessSessionId: string;
        latestSequence: number;
        pendingRequests: { requestId: string; correlation: { interactionId: number } }[];
      };
      expect(snapshotResponse.status).toBe(200);
      expect(snapshot).toMatchObject({
        latestSequence: 1,
        pendingRequests: [{ correlation: { interactionId: 91 } }],
      });
      expect(JSON.stringify(snapshot)).not.toContain("private-provider-item");

      const requestId = snapshot.pendingRequests[0]!.requestId;
      const decisionResponse = await fetch(`${running.url}/sessions/1/approvals/${requestId}/decision`, {
        method: "POST",
        headers: { authorization: "Bearer control", "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve_once", rationale: "Reviewed in Relayer." }),
      });
      expect(decisionResponse.status).toBe(200);
      expect(await decisionResponse.json()).toMatchObject({
        requestId,
        correlation: { threadId: 1, interactionId: 91, harnessSessionId: snapshot.harnessSessionId },
        outcome: "approved",
        actor: "user",
        decision: "approve_once",
      });

      const completionResponse = await completing;
      expect(completionResponse.status).toBe(200);
      expect(await completionResponse.json()).toMatchObject({ output: completion });
      expect(observedDecisions).toEqual([expect.objectContaining({ requestId, decision: "approve_once", actor: "user" })]);

      const terminalSnapshot = await fetch(`${running.url}/sessions/1/approval-events?after=1`, {
        headers: { authorization: "Bearer control" },
      });
      expect(await terminalSnapshot.json()).toMatchObject({
        latestSequence: 2,
        pendingRequests: [],
        events: [{ sequence: 2, type: "resolved", resolution: { requestId, outcome: "approved" } }],
      });
      const duplicate = await fetch(`${running.url}/sessions/1/approvals/${requestId}/decision`, {
        method: "POST",
        headers: { authorization: "Bearer control", "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve_once" }),
      });
      expect(duplicate.status).toBe(409);

      const persisted = await readFile(join(directory, "sessions.json"), "utf8");
      expect(persisted).not.toContain(snapshot.harnessSessionId);
      expect(persisted).not.toContain(requestId);
    } finally {
      await running?.close();
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("aborts a waiting approval when its HTTP response closes and releases the session lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-approval-disconnect-"));
    const nativeFetch = globalThis.fetch;
    let running: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
    let accepted = false;
    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => { approvalStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith("http://127.0.0.1:43123")) return nativeFetch(input, init);
      if (url.endsWith("/output")) {
        return accepted
          ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    try {
      running = await startHarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({
          async complete(context) {
            const waiting = context.approvals.request({
              providerItemId: "provider-disconnect",
              title: "Run tests",
              reason: "Verify the requested change.",
              action: { kind: "command", command: "npm test", workingDirectory: directory },
              scopeKeys: ["command:npm test", `cwd:${directory}`],
              scopeDescription: `Run npm test in ${directory} for this session.`,
            });
            approvalStarted();
            await waiting;
          },
          state: emptyState,
        }) },
      });
      await running.host.createSession({
        threadId: 1,
        permissionProfileId: "ask",
        configuration: testConfiguration,
        workingDirectory: directory,
      });
      const controller = new AbortController();
      const completing = fetch(`${running.url}/sessions/1/complete`, {
        method: "POST",
        headers: { authorization: "Bearer control", "content-type": "application/json" },
        body: JSON.stringify({ interactionId: 91, graph: graph() }),
        signal: controller.signal,
      });
      await started;
      expect(running.host.approvalEvents(1).pendingRequests).toHaveLength(1);

      controller.abort();
      await expect(completing).rejects.toThrow();
      await vi.waitFor(() => expect(running!.host.approvalEvents(1)).toMatchObject({
        pendingRequests: [],
        events: [
          { type: "requested" },
          { type: "resolved", resolution: { outcome: "aborted", actor: "host" } },
        ],
      }));

      accepted = true;
      await expect(running.host.complete(1, 92, graph())).resolves.toMatchObject({ output: completion });
    } finally {
      await running?.close();
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates a new ephemeral approval session ID when a persisted harness is registered again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-approval-session-"));
    const stateFile = join(directory, "sessions.json");
    const descriptor = { threadId: 1, permissionProfileId: "ask", configuration: testConfiguration, workingDirectory: directory };
    try {
      const first = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { test: () => ({ async complete() {}, state: emptyState }) },
      });
      await first.initialize();
      await first.createSession(descriptor);
      const firstSessionId = first.approvalEvents(1).harnessSessionId;
      await first.close();

      const restored = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { test: () => ({ async complete() {}, state: emptyState }) },
      });
      await restored.initialize();
      await restored.createSession(descriptor);

      expect(restored.approvalEvents(1).harnessSessionId).not.toBe(firstSessionId);
      expect(await readFile(stateFile, "utf8")).not.toContain(firstSessionId);
      await restored.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects graph capabilities outside the authenticated loopback server", async () => {
    const host = new HarnessHost({ stateFile: "/tmp/unused-harness-state.json", controlToken: "control", implementations: {} });
    await expect(host.complete(1, 1, { url: "https://example.com", token: "secret", nodeId: 1 })).rejects.toThrow("127.0.0.1 HTTP");
  });

  it("uses the product stable-ID rules for interaction model identities", async () => {
    const host = new HarnessHost({ stateFile: "/tmp/unused-harness-state.json", controlToken: "control", implementations: {} });
    const capability = graph();
    await expect(host.complete(1, 1, capability, { providerId: "codex", modelId: "🧠".repeat(200) }))
      .rejects.toThrow("Unknown harness thread");
    await expect(host.complete(1, 1, capability, { providerId: "codex", modelId: "\uFEFFmodel\uFEFF" }))
      .rejects.toThrow("Unknown harness thread");
    await expect(host.complete(1, 1, capability, { providerId: " codex", modelId: "model" }))
      .rejects.toThrow("invalid model selection");
    await expect(host.complete(1, 1, capability, { providerId: "codex", modelId: "model\n" }))
      .rejects.toThrow("invalid model selection");
    await expect(host.complete(1, 1, capability, { providerId: "codex", modelId: "model\uD800" }))
      .rejects.toThrow("invalid model selection");
    await expect(host.complete(1, 1, capability, { providerId: "codex", modelId: "m".repeat(201) }))
      .rejects.toThrow("invalid model selection");
    await expect(host.complete(1, 1, capability, { providerId: "codex", modelId: "🧠".repeat(201) }))
      .rejects.toThrow("invalid model selection");
  });

  it("reports an IPv6 URL when bound to an IPv6 host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-ipv6-"));
    let running: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
    try {
      running = await startHarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        host: "::1",
        implementations: {},
      });
      expect(running.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    } finally {
      await running?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
