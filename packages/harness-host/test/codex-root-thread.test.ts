import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createNoopHarnessTraceSink } from "../src/trace.js";
import {
  runCodexAppServerTurn,
  type CodexAppServerSpawn,
} from "../src/implementations/codex-app-server.js";
import { CodexBasicHarness } from "../src/implementations/codex-basic.js";
import type {
  HarnessConfiguration,
  HarnessRunContext,
  HarnessSessionState,
  HarnessTraceEventInput,
  HarnessTraceSink,
} from "../src/types.js";

// The persistent root thread across root turns, through the real app-server transport.
// The emulated app-server keeps Codex 0.147.0's rollout rules: a thread has a rollout only
// in the CODEX_HOME whose turn/start ran on it, and thread/resume without one fails with
// "no rollout found for thread id ...".
//
// The providers are shaped like production's (provider-adapter-registry.mjs). The Codex
// subscription has its own CODEX_HOME. Each API-key provider has its own private CODEX_HOME,
// which a new conversation uses. A conversation saved before those homes keeps Codex's default
// home, which every API-key provider shares. The saved thread is bound to its Codex home, so
// providers that share a home keep resuming it (#584: native history is not discarded).
// Whenever native history cannot be resumed, the turn records a visible reset notice.

const configuration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "codex-basic",
  implementation: "codex.basic",
  implementationVersion: 1,
  permissionBindings: { full: { sandboxMode: "danger-full-access", approvalPolicy: "never" } },
  settings: { model: "gpt-test", modelReasoningEffort: "medium", webSearchMode: "disabled", skipGitRepoCheck: true },
};
const SUBSCRIPTION_HOME = "codex-home";
const DEFAULT_HOME = "default-home";
const providerHome = (providerId: string) => `${providerId}/codex-home`;

describe("Codex persistent root thread", () => {
  it("gives each API-key provider its own home in a new conversation, and starts fresh visibly across homes", async () => {
    const codex = new EmulatedCodex();
    const harness = codex.harness();
    const traces = [1, 2, 3, 4, 5].map(() => recordingTrace());

    await harness.complete(rootTurn(1, "codex", traces[0]!.sink));
    await harness.complete(rootTurn(2, "openai-work", traces[1]!.sink));
    await harness.complete(rootTurn(3, "openai-work", traces[2]!.sink));
    await harness.complete(rootTurn(4, "openrouter-work", traces[3]!.sink));
    await harness.complete(rootTurn(5, "codex", traces[4]!.sink));

    expect(codex.threadRequests).toEqual([
      `${SUBSCRIPTION_HOME} thread/start -> thread-1`,
      // Each provider's thread has its rollout only in that provider's own home.
      `${providerHome("openai-work")} thread/start -> thread-2`,
      `${providerHome("openai-work")} thread/resume thread-2`,
      `${providerHome("openrouter-work")} thread/start -> thread-3`,
      `${SUBSCRIPTION_HOME} thread/start -> thread-4`,
    ]);
    expect(traces.map(({ resets }) => resets())).toEqual([[], ["home_changed"], [], ["home_changed"], ["home_changed"]]);
    expect(harness.state()).toEqual(pinned("thread-4", SUBSCRIPTION_HOME));
  });

  it("keeps a legacy conversation's API-key thread in Codex's default home, resuming across providers", async () => {
    const codex = new EmulatedCodex();
    // An earlier release ran this conversation's API-key turns in Codex's default home.
    codex.rollouts.set("legacy-thread", DEFAULT_HOME);
    const harness = codex.harness({ savedState: { codexThreadId: "legacy-thread", codexThreadPersonalPresentationVersionId: null } });
    const traces = [1, 2, 3].map(() => recordingTrace());

    await harness.complete(rootTurn(1, "openai-work", traces[0]!.sink));
    await harness.complete(rootTurn(2, "openrouter-work", traces[1]!.sink));
    const restarted = codex.harness({ savedState: harness.state() });
    await restarted.complete(rootTurn(3, "openai-work", traces[2]!.sink));

    expect(codex.threadRequests).toEqual([
      `${DEFAULT_HOME} thread/resume legacy-thread`,
      `${DEFAULT_HOME} thread/resume legacy-thread`,
      `${DEFAULT_HOME} thread/resume legacy-thread`,
    ]);
    expect(traces.map(({ resets }) => resets())).toEqual([[], [], []]);
    expect(restarted.state()).toEqual(pinned("legacy-thread", DEFAULT_HOME, "legacy-shared"));
  });

  it("resumes a legacy API-key conversation in the shared default home when #597 requires continuity", async () => {
    const codex = new EmulatedCodex();
    // An earlier release ran the conversation's first turn: no home marker, Codex's default home.
    const earlier = codex.harness({ savedState: {} });
    await earlier.complete(rootTurn(1, "openai-work"));
    // Saved before the continuity identity existed, so the accepted-history anchor verifies it.
    const { codexSessionIdentity: _identity, ...saved } = earlier.state();
    expect(saved).not.toHaveProperty("codexProviderHome");

    const reopened = codex.harness({ savedState: saved });
    const trace = recordingTrace();
    await reopened.complete({
      ...rootTurn(2, "openai-work", trace.sink),
      requireNativeContinuity: true,
      nativeHistoryAnchor: { interactionNodeId: 1, message: "Q" },
    });
    // The next required turn is verified by the identity the resumed turn recorded.
    const restarted = codex.harness({ savedState: reopened.state() });
    await restarted.complete({ ...rootTurn(3, "openai-work"), requireNativeContinuity: true });

    expect(codex.threadRequests).toEqual([
      `${DEFAULT_HOME} thread/start -> thread-1`,
      `${DEFAULT_HOME} thread/resume thread-1`,
      `${DEFAULT_HOME} thread/resume thread-1`,
    ]);
    expect(trace.resets()).toEqual([]);
    expect(restarted.state()).toEqual(pinned("thread-1", DEFAULT_HOME, "legacy-shared"));
  });

  it("resumes a new API-key conversation in the provider's private home when #597 requires continuity", async () => {
    const codex = new EmulatedCodex();
    const harness = codex.harness();
    await harness.complete(rootTurn(1, "openai-work"));
    const restarted = codex.harness({ savedState: harness.state() });
    await restarted.complete({ ...rootTurn(2, "openai-work"), requireNativeContinuity: true });

    expect(codex.threadRequests).toEqual([
      `${providerHome("openai-work")} thread/start -> thread-1`,
      `${providerHome("openai-work")} thread/resume thread-1`,
    ]);
    expect(restarted.state()).toEqual(pinned("thread-1", providerHome("openai-work")));
  });

  it.each(["home", "missing-rollout"])("required continuity refuses %s reset before losing the saved pointer or starting a turn", async (reason) => {
    const codex = new EmulatedCodex();
    const harness = codex.harness();
    await harness.complete(rootTurn(1, "codex"));
    const saved = harness.state();
    if (reason === "missing-rollout") codex.rollouts.clear();
    const trace = recordingTrace();
    await expect(harness.complete({
      ...rootTurn(2, reason === "home" ? "openai-work" : "codex", trace.sink),
      requireNativeContinuity: true,
    })).rejects.toThrow(/history was preserved/);
    expect(harness.state()).toEqual(saved);
    expect(codex.turnStarts).toBe(1);
    expect(codex.threadRequests.filter(request => request.includes("thread/start"))).toHaveLength(1);
    expect(trace.resets()).toEqual([]);
  });

  it("does not pin a root thread whose turn was stopped before turn/start", async () => {
    const codex = new EmulatedCodex();
    const stop = new AbortController();
    const harness = codex.harness({
      // The user's Stop lands after thread/start answered and before turn/start is sent.
      afterThreadIdentity: (resumed) => { if (!resumed) stop.abort(new Error("Stopped by user")); },
    });

    await expect(harness.complete(rootTurn(1, "codex"), stop.signal)).rejects.toThrow("Stopped by user");
    expect(harness.state()).toEqual({ codexProviderHome: "isolated" });
    await harness.complete(rootTurn(2, "codex"));

    // thread-1 has no rollout, so the next root turn never tries to resume it.
    expect(codex.threadRequests).toEqual([
      `${SUBSCRIPTION_HOME} thread/start -> thread-1`,
      `${SUBSCRIPTION_HOME} thread/start -> thread-2`,
    ]);
    expect(harness.state()).toEqual(pinned("thread-2", SUBSCRIPTION_HOME));
  });

  it("forgets, visibly, a root thread whose turn a Stop killed while turn/start was pending", async () => {
    const codex = new EmulatedCodex();
    const harness = codex.harness();
    await harness.complete(rootTurn(1, "codex"));
    // turn/start is sent but not answered: the Stop kills the app-server mid-write.
    codex.hangTurnStart = true;
    const stop = new AbortController();

    const stopped = harness.complete(rootTurn(2, "codex"), stop.signal);
    await vi.waitFor(() => expect(codex.turnStarts).toBe(2));
    stop.abort(new Error("Stopped by user"));
    await expect(stopped).rejects.toThrow();
    expect(harness.state()).toEqual({ codexProviderHome: "isolated", codexRootResetReason: "stopped_during_start" });

    codex.hangTurnStart = false;
    const next = recordingTrace();
    await harness.complete(rootTurn(3, "codex", next.sink));
    expect(codex.threadRequests.at(-1)).toBe(`${SUBSCRIPTION_HOME} thread/start -> thread-2`);
    expect(next.resets()).toEqual(["stopped_during_start"]);
    expect(harness.state()).toEqual(pinned("thread-2", SUBSCRIPTION_HOME));
  });

  it("keeps a root thread resumable after a Stop once turn/start was accepted", async () => {
    const codex = new EmulatedCodex();
    const harness = codex.harness();
    await harness.complete(rootTurn(1, "codex"));
    codex.hangTurns = true;
    const stop = new AbortController();

    const stopped = harness.complete(rootTurn(2, "codex"), stop.signal);
    await vi.waitFor(() => expect(codex.turnStarts).toBe(2));
    stop.abort(new Error("Stopped by user"));
    await stopped.catch(() => undefined);
    expect(codex.interrupts).toEqual(["thread-1"]);
    expect(harness.state()).toEqual(pinned("thread-1", SUBSCRIPTION_HOME));

    codex.hangTurns = false;
    await harness.complete(rootTurn(3, "codex"));
    expect(codex.threadRequests).toEqual([
      `${SUBSCRIPTION_HOME} thread/start -> thread-1`,
      `${SUBSCRIPTION_HOME} thread/resume thread-1`,
      `${SUBSCRIPTION_HOME} thread/resume thread-1`,
    ]);
  });

  it("starts fresh in the same turn when the saved root thread has no rollout", async () => {
    const codex = new EmulatedCodex();
    // Saved by an earlier release: no provider definition, and the thread was never materialized.
    const harness = codex.harness({ savedState: { codexThreadId: "lost-thread", codexThreadPersonalPresentationVersionId: null } });
    const first = recordingTrace();

    await harness.complete(rootTurn(1, "codex", first.sink));
    await harness.complete(rootTurn(2, "codex"));

    // The turn does not fail, and it says its native history was unavailable.
    expect(first.resets()).toEqual(["no_rollout"]);
    expect(codex.threadRequests).toEqual([
      `${SUBSCRIPTION_HOME} thread/resume lost-thread (no rollout)`,
      `${SUBSCRIPTION_HOME} thread/start -> thread-1`,
      `${SUBSCRIPTION_HOME} thread/resume thread-1`,
    ]);
    expect(harness.state()).toEqual(pinned("thread-1", SUBSCRIPTION_HOME, "legacy-shared"));
  });

  it("keeps resuming a saved root thread from an earlier release and binds it to its provider", async () => {
    const codex = new EmulatedCodex();
    codex.rollouts.set("legacy-thread", SUBSCRIPTION_HOME);
    const harness = codex.harness({ savedState: { codexThreadId: "legacy-thread", codexThreadPersonalPresentationVersionId: null } });

    expect(harness.state()).toEqual({
      codexThreadId: "legacy-thread",
      codexThreadPersonalPresentationVersionId: null,
    });
    await harness.complete(rootTurn(1, "codex"));

    expect(codex.threadRequests).toEqual([`${SUBSCRIPTION_HOME} thread/resume legacy-thread`]);
    expect(harness.state()).toEqual(pinned("legacy-thread", SUBSCRIPTION_HOME, "legacy-shared"));
  });

  it("forgets the root thread when the harness is force-shut down during a root turn", async () => {
    const codex = new EmulatedCodex();
    const harness = codex.harness();
    await harness.complete(rootTurn(1, "codex"));
    codex.hangTurns = true;

    // An invoked child running at force shutdown leaves the root thread alone.
    const child = harness.complete({ ...rootTurn(2, "codex"), origin: { kind: "invoke", sourceCompletionId: 1, actionId: 7 } });
    await vi.waitFor(() => expect(codex.turnStarts).toBe(2));
    harness.forceShutdown();
    await expect(child).rejects.toThrow("force-closed");
    expect(harness.state()).toMatchObject({ codexThreadId: "thread-1" });

    // A root turn running at force shutdown was killed mid-conversation: its thread is forgotten.
    const root = harness.complete(rootTurn(3, "codex"));
    await vi.waitFor(() => expect(codex.turnStarts).toBe(3));
    harness.forceShutdown();
    await expect(root).rejects.toThrow("force-closed");
    // The reason survives a restart, so the next root turn can say why it starts fresh.
    expect(harness.state()).toEqual({ codexProviderHome: "isolated", codexRootResetReason: "force_stopped" });
    codex.hangTurns = false;
    const restarted = codex.harness({ savedState: harness.state() });
    const next = recordingTrace();
    await restarted.complete(rootTurn(4, "codex", next.sink));
    expect(next.resets()).toEqual(["force_stopped"]);
  });

  it.each(["force shutdown", "per-turn force-stop"] as const)(
    "keeps the root thread when a %s ends a root turn before its turn/start",
    async (kind) => {
      const codex = new EmulatedCodex();
      const harness = codex.harness();
      await harness.complete(rootTurn(1, "codex"));
      // thread/resume never answers: this turn never sends turn/start, so nothing wrote thread-1.
      codex.hangResume = true;
      const force = new AbortController();

      const root = harness.complete({ ...rootTurn(2, "codex"), forceSignal: force.signal });
      await vi.waitFor(() => expect(codex.threadRequests).toHaveLength(2));
      if (kind === "force shutdown") harness.forceShutdown();
      else force.abort(new Error("force-stopped after two minutes"));
      await expect(root).rejects.toThrow();

      expect(harness.state()).toEqual(pinned("thread-1", SUBSCRIPTION_HOME));
    },
  );
});

function pinned(
  threadId: string,
  codexHome: string,
  codexProviderHome: "isolated" | "legacy-shared" = "isolated",
): HarnessSessionState {
  return {
    // A legacy conversation keeps its saved state as written: no marker means legacy-shared.
    ...(codexProviderHome === "isolated" ? { codexProviderHome } : {}),
    codexSessionIdentity: expect.any(String),
    codexThreadId: threadId,
    codexThreadPersonalPresentationVersionId: null,
    // Without CODEX_HOME, Codex's default home is recorded by a stable name.
    codexThreadHome: codexHome === DEFAULT_HOME ? "codex-default-home" : codexHome,
  };
}

/** Records the visible native-session reset notices a turn emits. */
function recordingTrace(): { readonly sink: HarnessTraceSink; resets(): string[] } {
  const events: HarnessTraceEventInput[] = [];
  return {
    sink: { ...createNoopHarnessTraceSink(), emit: (event) => { events.push(event); } },
    resets: () => events
      .filter((event) => event.type === "warning" && typeof event.data.nativeSessionReset === "string")
      .map((event) => event.data.nativeSessionReset as string),
  };
}

function rootTurn(
  id: number,
  providerId: "codex" | "openai-work" | "openrouter-work",
  trace: HarnessTraceSink = createNoopHarnessTraceSink(),
): HarnessRunContext {
  const inputGraph = { id, kind: "user-interaction", icon: "user", title: "Q", detail: "Q", state: "accepted" as const };
  const turn = {
    origin: { kind: "root" as const },
    inputGraph,
    interactionInput: { interaction: inputGraph, contexts: [] },
    graph: { interactionNodeId: id, acquireCapability: () => ({ url: "http://127.0.0.1:1", token: `token-${id}`, nodeId: id }) },
    trace,
    approvals: { request: async () => { throw new Error("unused approval channel"); } },
  };
  if (providerId === "codex") {
    return {
      ...turn,
      model: { providerId, adapterId: "codex-subscription", modelId: "gpt-5.2" },
      // The subscription's managed runtime carries its own CODEX_HOME.
      access: {
        kind: "managed-runtime",
        contract: "managed-runtime@1",
        providerId,
        adapterId: "codex-subscription",
        adapterImplementationVersion: "1",
        runtimeId: "codex",
        version: "0.147.0",
        executable: process.execPath,
        environment: { CODEX_HOME: SUBSCRIPTION_HOME },
      },
    };
  }
  return {
    ...turn,
    model: { providerId, adapterId: "openai-api", modelId: "gpt-5.2" },
    // SecretApiProviderAdapter.executionAccess carries only the provider's private home.
    access: {
      kind: "secret",
      contract: "secret@1",
      providerId,
      adapterId: "openai-api",
      adapterImplementationVersion: "1",
      endpoint: "https://api.openai.test/v1",
      fields: { "api-key": `key-${providerId}` },
      environment: { CODEX_HOME: providerHome(providerId) },
    },
  };
}

/** Codex app-server processes sharing on-disk rollouts, keyed by CODEX_HOME. */
class EmulatedCodex {
  readonly rollouts = new Map<string, string>();
  /** Each thread's user messages, which thread/resume returns as its turns. */
  readonly history = new Map<string, string[]>();
  readonly threadRequests: string[] = [];
  readonly interrupts: string[] = [];
  turnStarts = 0;
  hangTurns = false;
  hangResume = false;
  hangTurnStart = false;
  private nextThread = 0;
  private nextTurn = 0;

  harness(options: {
    readonly savedState?: HarnessSessionState;
    readonly afterThreadIdentity?: (resumed: boolean) => void;
  } = {}): CodexBasicHarness {
    return new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "full",
      permissionBinding: configuration.permissionBindings.full!,
      workingDirectory: process.cwd(),
      configuration,
      ...(options.savedState === undefined ? {} : { savedState: options.savedState }),
    }, {
      codexPathOverride: process.execPath,
      runAppServerTurn: (turn) => runCodexAppServerTurn({
        ...turn,
        spawnProcess: this.spawn,
        shutdownGraceMs: 5,
        onThreadId: async (threadId) => {
          await turn.onThreadId(threadId);
          options.afterThreadIdentity?.(turn.savedThreadId === threadId);
        },
      }),
    });
  }

  private readonly spawn: CodexAppServerSpawn = (_command, _args, spawnOptions) => {
    // Without CODEX_HOME, Codex uses its default home.
    const home = spawnOptions.env?.CODEX_HOME ?? DEFAULT_HOME;
    return new EmulatedAppServer((message, server) => this.handle(home, message, server)) as unknown as ChildProcessWithoutNullStreams;
  };

  private handle(home: string, message: Record<string, any>, server: EmulatedAppServer): void {
    const { id, method, params } = message;
    if (method === "initialize") server.respond(id, {});
    if (method === "thread/start") {
      const threadId = `thread-${++this.nextThread}`;
      this.threadRequests.push(`${home} thread/start -> ${threadId}`);
      server.respond(id, { thread: { id: threadId } });
    }
    if (method === "thread/resume") {
      if (this.hangResume) {
        this.threadRequests.push(`${home} thread/resume ${params.threadId} (no answer)`);
        return;
      }
      if (this.rollouts.get(params.threadId) !== home) {
        this.threadRequests.push(`${home} thread/resume ${params.threadId} (no rollout)`);
        server.fail(id, `no rollout found for thread id ${params.threadId}`);
        return;
      }
      this.threadRequests.push(`${home} thread/resume ${params.threadId}`);
      const turns = (this.history.get(params.threadId) ?? []).map((text) => ({
        items: [{ type: "userMessage", content: [{ type: "text", text }] }],
      }));
      server.respond(id, { thread: { id: params.threadId, turns } });
    }
    if (method === "turn/start") {
      this.turnStarts += 1;
      if (this.hangTurnStart) return;
      // turn/start materializes the rollout in this home.
      if (!this.rollouts.has(params.threadId)) this.rollouts.set(params.threadId, home);
      this.history.set(params.threadId, [...(this.history.get(params.threadId) ?? []), params.input[0].text]);
      const turnId = `turn-${++this.nextTurn}`;
      server.respond(id, { turn: { id: turnId, status: "inProgress" } });
      if (!this.hangTurns) {
        setImmediate(() => server.notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: turnId, status: "completed", error: null },
        }));
      }
    }
    if (method === "turn/interrupt") {
      this.interrupts.push(params.threadId);
      server.respond(id, {});
      setImmediate(() => server.notify("turn/completed", {
        threadId: params.threadId,
        turn: { id: params.turnId, status: "interrupted", error: null },
      }));
    }
  }
}

class EmulatedAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  // No process id: termination goes through kill() below, never a real process group.
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private buffer = "";

  constructor(onMessage: (message: Record<string, any>, server: EmulatedAppServer) => void) {
    super();
    this.stdin.on("data", (chunk) => {
      this.buffer += chunk.toString();
      for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        onMessage(JSON.parse(line) as Record<string, any>, this);
      }
    });
    setImmediate(() => this.emit("spawn"));
  }

  respond(id: unknown, result: unknown): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id, result })}\n`));
  }

  fail(id: unknown, message: string): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id, error: { code: -32600, message } })}\n`));
  }

  notify(method: string, params: unknown): void {
    if (this.exitCode === null && this.signalCode === null) this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return true;
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  }
}
