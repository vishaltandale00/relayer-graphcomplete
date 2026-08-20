import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HarnessHost, startHarnessHost } from "../src/host.js";
import type { HarnessConfiguration, HarnessFactoryContext, HarnessSessionState } from "../src/types.js";

const completion = {
  nodeId: 1,
  rootAction: { id: 4, sourceNodeId: 1, kind: "navigate" as const, label: "Response", variant: "pill" as const, targetLayerId: 3, response: true, state: "accepted" as const },
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

describe("HarnessHost", () => {
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
        implementations: {
          test: () => ({
            async complete() { throw new Error("model failed"); },
            state: () => ({ primeAgentSessionId: "resume-after-failure" }),
          }),
        },
      });
      await failing.initialize();
      await failing.createSession(descriptor);
      await expect(failing.complete(descriptor.threadId, capability)).rejects.toThrow("model failed");
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
      await expect(restored.complete(1, graph())).rejects.toThrow("must be registered");
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

      const completing = host.complete(1, graph());
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

      const active = host.complete(1, graph(1, "active-token"));
      await started;
      const queued = host.complete(1, graph(2, "queued-token"));
      const closing = host.close();

      await expect(active).rejects.toThrow("closed");
      await expect(queued).rejects.toThrow("closed");
      await closing;
      expect(calls).toEqual([1]);
      expect(dispose).toHaveBeenCalledTimes(1);
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

      await expect(host.complete(1, graph())).resolves.toMatchObject({ output: completion });
      expect(calls).toBe(0);
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
        implementations: { test: () => {
          factoryCalls += 1;
          return {
            async complete(context) {
              scopes.push(context.graph);
              adopted.push(context.graph.acquireCapability());
              accepted.add(context.inputGraph.id);
            },
            state: emptyState,
          };
        } },
      });
      await host.initialize();
      const base = { threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory };
      await host.createSession(base);

      await host.complete(1, graph(1, "first-token"));
      await expect(host.complete(1, graph(2, "second-token"))).resolves.toMatchObject({ output: { nodeId: 2 } });
      expect(factoryCalls).toBe(1);
      expect(adopted.map(({ token, nodeId }) => [token, nodeId])).toEqual([["first-token", 1], ["second-token", 2]]);
      expect(revocationRequests).toBe(0);
      expect(() => scopes[0]!.acquireCapability()).toThrow("no longer active");
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

      const completing = host.complete(1, graph(1, "first-token"));
      await started;
      const queued = host.complete(1, graph(2, "second-token"));
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

      await expect(host.complete(1, graph())).rejects.toThrow("state failed");
      await expect(host.complete(1, graph())).resolves.toMatchObject({ output: completion });
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
          configurationName: testConfiguration.name,
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
          configuration: { name: testConfiguration.name },
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
          { threadId: 2, configuration: { name: testConfiguration.name }, workingDirectory: directory },
        ],
      }), { mode: 0o600 });

      await host.initialize();

      expect(warning).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(stateFile, "utf8")).legacySessions).toEqual([{
        threadId: 2,
        configurationName: testConfiguration.name,
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

  it("rejects graph capabilities outside the authenticated loopback server", async () => {
    const host = new HarnessHost({ stateFile: "/tmp/unused-harness-state.json", controlToken: "control", implementations: {} });
    await expect(host.complete(1, { url: "https://example.com", token: "secret", nodeId: 1 })).rejects.toThrow("127.0.0.1 HTTP");
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
