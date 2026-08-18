import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HarnessHost, startHarnessHost } from "../src/host.js";
import type { HarnessConfiguration, HarnessFactoryContext, HarnessSessionState } from "../src/types.js";

const completion = {
  nodeId: 1,
  rootAction: { id: 4, sourceNodeId: 1, kind: "navigate" as const, label: "Response", targetLayerId: 3, response: true, state: "accepted" as const },
  rootLayer: {
    layer: { id: 3, nodes: [2], edges: [], state: "accepted" as const },
    nodes: [{ id: 2, kind: "concept", icon: "box", title: "Answer", detail: "Detail", state: "accepted" as const }],
    edges: [],
    actions: [],
  },
};
const emptyState = (): HarnessSessionState => ({});
const testConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "test-default",
  implementation: "test",
  implementationVersion: 1,
  settings: {},
};

describe("HarnessHost", () => {
  it("persists resumable harness state even when completion fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-host-"));
    const stateFile = join(directory, "sessions.json");
    const graph = { url: "http://127.0.0.1:43123", token: "graph-token", nodeId: 1 };
    const descriptor = { threadId: 1, configuration: testConfiguration, workingDirectory: directory, graph };
    let restoredState: HarnessSessionState | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));

    try {
      const failing = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: {
          test: () => ({
            async complete() { throw new Error("model failed"); },
            setGraphCapability() {},
            state: () => ({ primeAgentSessionId: "resume-after-failure" }),
          }),
        },
      });
      await failing.initialize();
      await failing.createSession(descriptor);
      await expect(failing.complete(descriptor.threadId)).rejects.toThrow("model failed");
      await expect(failing.createSession({ ...descriptor, configuration: { ...testConfiguration, name: "other" } })).rejects.toThrow("already pinned");

      const restored = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: {
          test: (context: HarnessFactoryContext) => {
            restoredState = context.savedState;
            return {
              async complete() { throw new Error("unused"); },
              setGraphCapability() {},
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
            return { async complete() { return completion; }, setGraphCapability() {}, state: emptyState };
          },
        },
      });
      await host.initialize();
      const creating = host.createSession({
        threadId: 1,
        configuration: testConfiguration,
        workingDirectory: directory,
        graph: { url: "http://127.0.0.1:1", token: "token", nodeId: 1 },
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
          return { async complete() { return completion; }, setGraphCapability() {}, state: emptyState };
        } },
      });
      await host.initialize();
      const descriptor = { threadId: 1, configuration: testConfiguration, workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "token", nodeId: 1 } };

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
          return { async complete() { return completion; }, setGraphCapability() {}, state: emptyState, dispose };
        } },
      });
      await host.initialize();
      const creating = host.createSession({ threadId: 1, configuration: testConfiguration, workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "token", nodeId: 1 } });
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
          async complete() { return completion; },
          setGraphCapability() {},
          state: () => ({ invalid: Number.NaN }),
          dispose,
        }) },
      });
      await host.initialize();

      await expect(host.createSession({
        threadId: 1,
        configuration: testConfiguration,
        workingDirectory: directory,
        graph: { url: "http://127.0.0.1:1", token: "token", nodeId: 1 },
      })).rejects.toThrow("invalid implementation state");
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(host.sessionCount()).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a freshly minted graph capability before resuming saved state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-fresh-capability-"));
    const stateFile = join(directory, "sessions.json");
    const descriptor = {
      threadId: 1,
      configuration: testConfiguration,
      workingDirectory: directory,
      graph: { url: "http://127.0.0.1:1", token: "old-token", nodeId: 1 },
    };
    try {
      const first = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { test: () => ({ async complete() { return completion; }, setGraphCapability() {}, state: () => ({ sessionId: "saved" }) }) },
      });
      await first.initialize();
      await first.createSession(descriptor);

      let restoredState: HarnessSessionState | undefined;
      const restored = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { test: (context) => {
          restoredState = context.savedState;
          return { async complete() { return completion; }, setGraphCapability() {}, state: () => context.savedState ?? emptyState() };
        } },
      });
      await restored.initialize();
      await expect(restored.complete(1)).rejects.toThrow("requires a fresh graph capability");
      await restored.createSession({ ...descriptor, graph: { ...descriptor.graph, token: "new-token", nodeId: 2 } });
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
        implementations: { test: () => ({
          complete(_interaction, signal) {
            completionStarted();
            return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
          },
          setGraphCapability() {},
          state: emptyState,
        }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, configuration: testConfiguration, workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "token", nodeId: 1 } });

      const completing = host.complete(1);
      await started;
      expect(host.cancel(1)).toBe(true);
      await expect(completing).rejects.toThrow("cancelled for thread 1");
      expect(host.cancel(1)).toBe(false);
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
        implementations: { test: () => ({ async complete() { return completion; }, setGraphCapability() {}, state: emptyState, dispose }) },
      });
      await host.initialize();
      const descriptor = { threadId: 1, configuration: testConfiguration, workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "token", nodeId: 1 } };
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

  it("returns an accepted completion without rerunning the harness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-idempotent-"));
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({ async complete() { calls += 1; return completion; }, setGraphCapability() {}, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, configuration: testConfiguration, workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "token", nodeId: 1 } });

      await expect(host.complete(1)).resolves.toMatchObject({ output: completion });
      expect(calls).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rotates a live session capability without rebuilding its harness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-advance-"));
    const output = { ...completion, nodeId: 2 };
    const requested: { url: string; authorization: string | null }[] = [];
    const adopted: { url: string; token: string; nodeId: number }[] = [];
    let factoryCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requested.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(output), { status: 200, headers: { "content-type": "application/json" } });
    }));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => {
          factoryCalls += 1;
          return {
            async complete() { return output; },
            setGraphCapability(graph) { adopted.push(graph); },
            state: emptyState,
          };
        } },
      });
      await host.initialize();
      const base = { threadId: 1, configuration: testConfiguration, workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "first-token", nodeId: 1 } };
      await host.createSession(base);
      await host.createSession({ ...base, graph: { ...base.graph, token: "second-token", nodeId: 2 } });

      await expect(host.complete(1)).resolves.toMatchObject({ output });
      expect(factoryCalls).toBe(1);
      expect(adopted).toEqual([{ url: "http://127.0.0.1:1", token: "second-token", nodeId: 2 }]);
      expect(requested).toEqual([{
        url: "http://127.0.0.1:1/api/graph/nodes/2/output",
        authorization: "Bearer second-token",
      }]);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for an active completion before rotating its capability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-serialized-rotation-"));
    let completionStarted!: () => void;
    let finishCompletion!: () => void;
    const started = new Promise<void>((resolveStarted) => { completionStarted = resolveStarted; });
    const finish = new Promise<void>((resolveFinish) => { finishCompletion = resolveFinish; });
    const adopted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({
          async complete() { completionStarted(); await finish; return completion; },
          setGraphCapability(graph) { adopted.push(graph.token); },
          state: emptyState,
        }) },
      });
      await host.initialize();
      const first = { threadId: 1, configuration: testConfiguration, workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "first-token", nodeId: 1 } };
      await host.createSession(first);

      const completing = host.complete(1);
      await started;
      const rotating = host.createSession({ ...first, graph: { ...first.graph, token: "second-token", nodeId: 2 } });
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));
      expect(adopted).toEqual([]);

      finishCompletion();
      await completing;
      await rotating;
      expect(adopted).toEqual(["second-token"]);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases the per-thread queue when harness state capture throws", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-queue-"));
    let stateCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({
          async complete() { return completion; },
          setGraphCapability() {},
          state() { if (stateCalls++ === 1) throw new Error("state failed"); return emptyState(); },
        }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, configuration: testConfiguration, workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "token", nodeId: 1 } });

      await expect(host.complete(1)).rejects.toThrow("state failed");
      await expect(host.complete(1)).resolves.toMatchObject({ output: completion });
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
      implementations: { test: () => ({ async complete() { return completion; }, setGraphCapability() {}, state: emptyState }) },
    });
    const descriptor = { threadId: 1, configuration: testConfiguration, workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "token", nodeId: 1 } };
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
        implementations: { test: () => ({ async complete() { return completion; }, setGraphCapability() {}, state: () => ({ providerSessionId: "session" }) }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, configuration: testConfiguration, workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "secret", nodeId: 1 } });

      expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
      const persisted = await readFile(stateFile, "utf8");
      expect(persisted).not.toContain("secret");
      expect(JSON.parse(persisted)).toEqual({
        schemaVersion: 3,
        sessions: [{
          threadId: 1,
          configuration: testConfiguration,
          workingDirectory: directory,
          state: { providerSessionId: "session" },
        }],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects legacy host state instead of guessing how to migrate it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-state-migration-"));
    const stateFile = join(directory, "sessions.json");
    try {
      await writeFile(stateFile, JSON.stringify({
        schemaVersion: 1,
        sessions: [{
          threadId: 1,
          harnessKey: "codex.basic",
          workingDirectory: directory,
          graph: { url: "http://127.0.0.1:1", token: "legacy-secret", nodeId: 1 },
          state: { codexThreadId: "codex-thread" },
        }],
      }), { mode: 0o600 });
      const host = new HarnessHost({ stateFile, controlToken: "control", implementations: {} });

      await expect(host.initialize()).rejects.toThrow("expected schema version 3");
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
