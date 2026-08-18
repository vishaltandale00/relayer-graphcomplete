import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HarnessHost, startHarnessHost } from "../src/host.js";
import type { HarnessFactoryContext, HarnessSessionState } from "../src/types.js";

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

describe("HarnessHost", () => {
  it("persists resumable harness state even when completion fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-host-"));
    const stateFile = join(directory, "sessions.json");
    const graph = { url: "http://127.0.0.1:43123", token: "graph-token", nodeId: 1 };
    const descriptor = { threadId: 1, harnessKey: "test", workingDirectory: directory, graph };
    let restoredState: HarnessSessionState | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } })));

    try {
      const failing = new HarnessHost({
        stateFile,
        controlToken: "control",
        harnesses: {
          test: () => ({
            async complete() { throw new Error("model failed"); },
            setGraphCapability() {},
            state: () => ({ codexThreadId: "resume-after-failure" }),
          }),
        },
      });
      await failing.initialize();
      await failing.createSession(descriptor);
      await expect(failing.complete(descriptor.threadId)).rejects.toThrow("model failed");
      await expect(failing.createSession({ ...descriptor, harnessKey: "other" })).rejects.toThrow("already pinned");

      const restored = new HarnessHost({
        stateFile,
        controlToken: "control",
        harnesses: {
          test: (context: HarnessFactoryContext) => {
            restoredState = context.savedState;
            return {
              async complete() { throw new Error("unused"); },
              setGraphCapability() {},
              state: () => context.savedState ?? {},
            };
          },
        },
      });
      await restored.initialize();
      await restored.createSession(descriptor);
      expect(restoredState).toEqual({ codexThreadId: "resume-after-failure" });
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
        harnesses: { test: () => ({ async complete() { calls += 1; return completion; }, setGraphCapability() {}, state: () => ({}) }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, harnessKey: "test", workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "token", nodeId: 1 } });

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
        harnesses: { test: () => {
          factoryCalls += 1;
          return {
            async complete() { return output; },
            setGraphCapability(graph) { adopted.push(graph); },
            state: () => ({}),
          };
        } },
      });
      await host.initialize();
      const base = { threadId: 1, harnessKey: "test", workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "first-token", nodeId: 1 } };
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
        harnesses: { test: () => ({
          async complete() { completionStarted(); await finish; return completion; },
          setGraphCapability(graph) { adopted.push(graph.token); },
          state: () => ({}),
        }) },
      });
      await host.initialize();
      const first = { threadId: 1, harnessKey: "test", workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "first-token", nodeId: 1 } };
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
        harnesses: { test: () => ({
          async complete() { return completion; },
          setGraphCapability() {},
          state() { if (stateCalls++ === 0) throw new Error("state failed"); return {}; },
        }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, harnessKey: "test", workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "token", nodeId: 1 } });

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
      harnesses: { test: () => ({ async complete() { return completion; }, setGraphCapability() {}, state: () => ({}) }) },
    });
    const descriptor = { threadId: 1, harnessKey: "test", workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "token", nodeId: 1 } };
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

  it("stores capability state with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-mode-"));
    const stateFile = join(directory, "sessions.json");
    try {
      const host = new HarnessHost({
        stateFile,
        controlToken: "control",
        harnesses: { test: () => ({ async complete() { return completion; }, setGraphCapability() {}, state: () => ({}) }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, harnessKey: "test", workingDirectory: directory, graph: { url: "http://127.0.0.1:1", token: "secret", nodeId: 1 } });

      expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
    } finally {
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
        harnesses: {},
      });
      expect(running.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    } finally {
      await running?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
