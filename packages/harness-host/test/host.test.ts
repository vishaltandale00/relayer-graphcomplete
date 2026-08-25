import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HarnessExecutionFailure, HarnessHost, startHarnessHost } from "../src/host.js";
import type { HarnessConfiguration, HarnessFactoryContext, HarnessSessionState } from "../src/types.js";

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
      : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));

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
      : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
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
      expect(host.cancel(1)).toBe(true);
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
      : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
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
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/output")) {
        return new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ node: { id: Number(/nodes\/(\d+)/.exec(url)?.[1]), kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } });
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
      : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
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
    await writeFile(blockedTraceDirectory, "not a directory");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/output")) {
        return accepted
          ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } });
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
    const models: unknown[] = [];
    let revocationRequests = 0;
    let factoryCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const nodeId = Number(/nodes\/(\d+)/.exec(url)?.[1] ?? 1);
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
      return new Response(JSON.stringify({ node: { id: nodeId, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } });
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

  it("does not expire a claimed lease during a long execution and bounds the terminal acknowledgement", async () => {
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
      await vi.advanceTimersByTimeAsync(1);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
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
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? (accepted.has(Number(/nodes\/(\d+)/.exec(url)?.[1]))
        ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } }))
      : new Response(JSON.stringify({ node: { id: Number(/nodes\/(\d+)/.exec(url)?.[1]), kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
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

  it("releases the per-thread queue when harness state capture throws", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-queue-"));
    let stateCalls = 0;
    let accepted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? (accepted
        ? new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } }))
      : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
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
        schemaVersion: 4,
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
        schemaVersion: 4,
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
        schemaVersion: 4,
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
        schemaVersion: 4,
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
        schemaVersion: 4,
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
        schemaVersion: 4,
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

      await expect(host.initialize()).rejects.toThrow("expected schema version 3 or 4");
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
    } finally {
      await running?.close();
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
    try {
      running = await startHarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({
          async complete() {},
          state: emptyState,
          async dispose() {
            markDisposeStarted();
            await disposeGate;
          },
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
      running.forceClose();
      await socketClosed;
      await expect(fetch(`${running.url}/sessions`, { method: "POST" })).rejects.toThrow();
      releaseDispose();
      await closing;
    } finally {
      releaseDispose?.();
      running?.forceClose();
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
