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

// Root turns through the real app-server transport (#719). Every root turn starts a fresh Codex
// thread in its own app-server process and never resumes one, so a thread's root turns can run in
// parallel. The emulated app-server keeps Codex 0.147.0's rollout rules, so a thread/resume
// would succeed for a thread with a rollout in that CODEX_HOME: the tests observe that none is sent.
//
// The providers are shaped like production's (provider-adapter-registry.mjs). The Codex
// subscription has its own CODEX_HOME. API-key providers get no runtime and so no CODEX_HOME:
// they all share Codex's default home.

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

describe("Codex root turns", () => {
  it("starts every root turn in a fresh thread in its provider's home, ignoring legacy saved state, and points it at the accepted history", async () => {
    const codex = new EmulatedCodex();
    // Saved by a release that resumed root threads; its rollout still exists, so a resume would work.
    codex.rollouts.set("legacy-thread", SUBSCRIPTION_HOME);
    const harness = codex.harness({
      savedState: { codexThreadId: "legacy-thread", codexThreadHome: SUBSCRIPTION_HOME, codexThreadPersonalPresentationVersionId: null, codexRootResetReason: "force_stopped" },
    });
    expect(harness.state()).toEqual({});
    const traces = [1, 2, 3, 4].map(() => recordingTrace());

    await harness.complete({ ...rootTurn(1, "codex", traces[0]!.sink), threadHistory: [] });
    await harness.complete({ ...rootTurn(3, "codex", traces[1]!.sink), threadHistory: [{ interactionNodeId: 1, responseLayerId: 2 }] });
    await harness.complete({ ...rootTurn(5, "openai-work", traces[2]!.sink), threadHistory: [{ interactionNodeId: 1, responseLayerId: 2 }, { interactionNodeId: 3, responseLayerId: 4 }] });
    await harness.complete({ ...rootTurn(7, "openai-work", traces[3]!.sink), threadHistory: [] });

    expect(codex.threadRequests).toEqual([
      `${SUBSCRIPTION_HOME} thread/start -> thread-1`,
      `${SUBSCRIPTION_HOME} thread/start -> thread-2`,
      `${DEFAULT_HOME} thread/start -> thread-3`,
      `${DEFAULT_HOME} thread/start -> thread-4`,
    ]);
    // A follow-up such as "now change that" finds the earlier turn through the accepted graph alone.
    expect(codex.prompts[0]).toContain("This run starts a fresh session");
    expect(codex.prompts[1]).toContain(JSON.stringify([{ interactionNodeId: 1, responseLayerId: 2 }], null, 2));
    expect(codex.prompts[1]).toContain("await graph.getLayer(responseLayerId)");
    expect(codex.prompts[2]).toContain(JSON.stringify([{ interactionNodeId: 1, responseLayerId: 2 }, { interactionNodeId: 3, responseLayerId: 4 }], null, 2));
    // There is no root conversation to lose, so no turn reports a reset.
    expect(traces.flatMap(({ warnings }) => warnings())).toEqual([]);
    expect(harness.state()).toEqual({});
  });

  it("runs overlapping root turns in their own threads, and a Stop interrupts only its own turn", async () => {
    const codex = new EmulatedCodex();
    const harness = codex.harness();
    codex.hangTurns = true;
    const stop = new AbortController();

    const stopped = harness.complete(rootTurn(1, "codex"), stop.signal);
    const running = harness.complete(rootTurn(3, "codex"));
    await vi.waitFor(() => expect(codex.turnStarts).toBe(2));
    stop.abort(new Error("Stopped by user"));
    await stopped.catch(() => undefined);

    expect(codex.threadRequests).toEqual([
      `${SUBSCRIPTION_HOME} thread/start -> thread-1`,
      `${SUBSCRIPTION_HOME} thread/start -> thread-2`,
    ]);
    expect(codex.interrupts).toEqual(["thread-1"]);
    codex.completeHungTurns();
    await expect(running.attached).resolves.toMatchObject({ threadId: "thread-2" });
    await running;
    expect(harness.state()).toEqual({});
  });
});

/** Records the warning events a turn emits. */
function recordingTrace(): { readonly sink: HarnessTraceSink; warnings(): HarnessTraceEventInput[] } {
  const events: HarnessTraceEventInput[] = [];
  return {
    sink: { ...createNoopHarnessTraceSink(), emit: (event) => { events.push(event); } },
    warnings: () => events.filter((event) => event.type === "warning"),
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
    // SecretApiProviderAdapter.executionAccess returns no runtime, so no CODEX_HOME.
    access: {
      kind: "secret",
      contract: "secret@1",
      providerId,
      adapterId: "openai-api",
      adapterImplementationVersion: "1",
      endpoint: "https://api.openai.test/v1",
      fields: { "api-key": `key-${providerId}` },
    },
  };
}

/** Codex app-server processes sharing on-disk rollouts, keyed by CODEX_HOME. */
class EmulatedCodex {
  readonly rollouts = new Map<string, string>();
  readonly threadRequests: string[] = [];
  readonly prompts: string[] = [];
  readonly interrupts: string[] = [];
  turnStarts = 0;
  hangTurns = false;
  private readonly hungTurns: (() => void)[] = [];
  private nextThread = 0;
  private nextTurn = 0;

  completeHungTurns(): void {
    for (const complete of this.hungTurns.splice(0)) complete();
  }

  harness(options: { readonly savedState?: HarnessSessionState } = {}): CodexBasicHarness {
    return new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "full",
      permissionBinding: configuration.permissionBindings.full!,
      workingDirectory: process.cwd(),
      configuration,
      ...(options.savedState === undefined ? {} : { savedState: options.savedState }),
    }, {
      codexPathOverride: process.execPath,
      writeCodexApiKeyAuthFile: async () => undefined,
      removeCodexApiKeyAuthFile: async () => undefined,
      runAppServerTurn: (turn) => runCodexAppServerTurn({
        ...turn,
        spawnProcess: this.spawn,
        shutdownGraceMs: 5,
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
      // A rollout exists only in the home whose turn/start ran on the thread.
      this.threadRequests.push(`${home} thread/resume ${params.threadId}`);
      if (this.rollouts.get(params.threadId) === home) server.respond(id, { thread: { id: params.threadId } });
      else server.fail(id, `no rollout found for thread id ${params.threadId}`);
    }
    if (method === "turn/start") {
      this.turnStarts += 1;
      this.prompts.push(params.input[0].text);
      // turn/start materializes the rollout in this home.
      if (!this.rollouts.has(params.threadId)) this.rollouts.set(params.threadId, home);
      const turnId = `turn-${++this.nextTurn}`;
      server.respond(id, { turn: { id: turnId, status: "inProgress" } });
      const complete = () => setImmediate(() => server.notify("turn/completed", {
        threadId: params.threadId,
        turn: { id: turnId, status: "completed", error: null },
      }));
      if (this.hangTurns) this.hungTurns.push(complete);
      else complete();
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
