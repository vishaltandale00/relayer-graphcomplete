import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANCELLED_TURN_FORCE_STOP_MS, HarnessHost } from "../src/host.js";
import type { CodexAppServerTurnOptions } from "../src/implementations/codex-app-server.js";
import { CodexBasicHarness } from "../src/implementations/codex-basic.js";
import type { HarnessConfiguration, HarnessSessionState } from "../src/types.js";

// Every root run starts a fresh native session and never resumes one (#719), so a root turn the
// host force-closes leaves nothing behind for the next root run to continue.

const codexConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "codex-basic",
  implementation: "codex.basic",
  implementationVersion: 1,
  permissionBindings: { full: { sandboxMode: "danger-full-access", approvalPolicy: "never" } },
  settings: { model: "gpt-test", modelReasoningEffort: "medium", webSearchMode: "disabled", skipGitRepoCheck: true },
};
const node = (id: number) => ({ id, kind: "user-interaction", icon: "user", title: "Q", detail: "Q", state: "accepted" });
const graph = (nodeId: number) => ({ url: "http://127.0.0.1:43123", token: `token-${nodeId}`, nodeId });

describe("root runs when the host force-closes", () => {
  let directory: string | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("kills an in-flight Codex root turn on force close, and the restarted host's next root run starts fresh", async () => {
    directory = await mkdtemp(join(tmpdir(), "relayer-force-close-root-"));
    const accepted = stubGraph();
    const submissions: CodexAppServerTurnOptions[] = [];
    const makeHost = () => new HarnessHost({
      stateFile: join(directory!, "sessions.json"),
      controlToken: "control",
      implementations: { "codex.basic": (context) => new CodexBasicHarness(context, {
        codexPathOverride: "/managed/codex",
        runAppServerTurn: async (options: CodexAppServerTurnOptions) => {
          const nodeId = options.environment.RELAYER_NODE_ID!;
          submissions.push(options);
          const threadId = `thread-${nodeId}`;
          await options.onTurnId?.(threadId, `turn-${nodeId}`);
          // Quitting kills this turn's app-server. Its settlement never reaches the host.
          if (nodeId === "2") return new Promise<never>(() => {});
          accepted.add(Number(nodeId));
          return { threadId, turnId: `turn-${nodeId}`, status: "completed" };
        },
      }) },
    });
    const descriptor = { threadId: 1, permissionProfileId: "full", workingDirectory: directory, configuration: codexConfiguration };

    const first = makeHost();
    await first.initialize();
    await first.createSession(descriptor);
    await first.complete(1, 1, graph(1));
    expect(await persistedState()).toEqual({});
    void first.complete(1, 2, graph(2)).catch(() => undefined);
    await vi.waitFor(() => expect(submissions).toHaveLength(2));
    await first.forceClose();
    expect(submissions[1]?.forceSignal?.aborted).toBe(true);
    expect(await persistedState()).toEqual({});

    const second = makeHost();
    await second.initialize();
    await second.createSession(descriptor);
    await second.complete(1, 3, graph(3));
    await second.close();

    expect(submissions.map((options) => "savedThreadId" in options)).toEqual([false, false, false]);
    expect(await persistedState()).toEqual({});
  });

  it("still force-closes, and records the other threads, when one harness cannot report its state", async () => {
    directory = await mkdtemp(join(tmpdir(), "relayer-force-close-state-"));
    stubGraph();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let session: string | undefined = "root-session";
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: {
        broken: () => {
          let forced = false;
          return {
            complete: async () => undefined,
            forceShutdown() { forced = true; },
            state: (): HarnessSessionState => {
              if (forced) throw new Error("state unavailable after force shutdown");
              return {};
            },
          };
        },
        test: () => ({
          complete: async () => undefined,
          forceShutdown() { session = undefined; },
          state: (): HarnessSessionState => (session === undefined ? {} : { session }),
        }),
      },
    });
    const configuration = (implementation: string) => ({
      schemaVersion: 1 as const, name: implementation, implementation, implementationVersion: 1,
      permissionBindings: { auto: {} }, settings: {},
    });
    try {
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", workingDirectory: directory, configuration: configuration("test") });
      await host.createSession({ threadId: 2, permissionProfileId: "auto", workingDirectory: directory, configuration: configuration("broken") });

      await expect(host.forceClose()).resolves.toBeUndefined();

      expect(await persistedState()).toEqual({});
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  async function persistedState(): Promise<HarnessSessionState | undefined> {
    const saved = JSON.parse(await readFile(join(directory!, "sessions.json"), "utf8")) as { sessions: { state?: HarnessSessionState }[] };
    return saved.sessions[0]?.state;
  }
});

/** Polls without timers, so it also works while setTimeout is faked. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    try {
      if (await condition()) return;
    } catch {
      // The state file may be mid-rename; poll again.
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

/** Graph reads for a turn whose completion is not yet accepted, until the test accepts it. */
function stubGraph(): Set<number> {
  const accepted = new Set<number>();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const nodeId = Number(new Headers(init?.headers).get("authorization")!.replace("Bearer token-", ""));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/output")) {
      return accepted.has(nodeId)
        ? json({
          nodeId,
          rootAction: { id: 4, sourceNodeId: nodeId, sourceLayerId: null, kind: "navigate", relation: "expand", label: "R", variant: "pill", targetLayerId: 3, state: "accepted" },
          rootLayer: { layer: { id: 3, nodes: [2], edges: [], state: "accepted" }, nodes: [{ id: 2, kind: "concept", icon: "box", title: "A", detail: "D", state: "accepted" }], edges: [], actions: [] },
        })
        : json({ error: { code: "completion_not_found" } }, 404);
    }
    if (url.endsWith("/neighbors")) return json({ nodes: [] });
    if (url.endsWith("/personal-presentation")) return json({ error: { code: "personal_presentation_not_attached" } }, 404);
    if (url.endsWith("/input")) return json({ interaction: node(nodeId), contexts: [] });
    return json({ node: node(nodeId) });
  }));
  return accepted;
}
