import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HarnessActionLedgerRecorder,
  MAX_ACTION_LEDGER_ENTRIES,
  MAX_ACTION_SUMMARY_BYTES,
} from "../src/action-ledger.js";
import {
  CANCELLED_TURN_FORCE_STOP_MS,
  FORCE_STOPPED_TURN_SETTLE_MS,
  HarnessHost,
  harnessSettlementActionLedger,
  startHarnessHost,
} from "../src/host.js";
import type { CodexAppServerTurnOptions } from "../src/implementations/codex-app-server.js";
import { CodexBasicHarness } from "../src/implementations/codex-basic.js";
import type { HarnessConfiguration, HarnessRunContext, HarnessSessionState } from "../src/types.js";

// #584, PRD CONT-013: each settled attempt keeps at most 64 action summaries with kind, status,
// and exit code, and no tool output bytes. These cases cover the host-owned bound and the
// host's settlement report; each adapter's own event mapping is covered beside its harness.

describe("the bounded action ledger", () => {
  it("keeps the first 64 distinct actions in order and counts every later one once", () => {
    const recorder = new HarnessActionLedgerRecorder();
    for (let index = 0; index < MAX_ACTION_LEDGER_ENTRIES + 6; index += 1) {
      recorder.started(`item-${index}`, { kind: "command", summary: `step ${index}` });
    }
    // A later event for an action already counted as omitted is not a new omission.
    recorder.ended("item-70", { kind: "command", summary: "step 70", status: "completed", exitCode: 0 });
    recorder.ended("item-65", { kind: "command", summary: "step 65", status: "failed", exitCode: 1 });
    recorder.ended("item-3", { kind: "command", summary: "step 3", status: "failed", exitCode: 2 });

    const ledger = recorder.seal();

    expect(ledger.entries).toHaveLength(MAX_ACTION_LEDGER_ENTRIES);
    expect(ledger.entries[0]).toEqual({ kind: "command", summary: "step 0", status: "interrupted" });
    expect(ledger.entries[3]).toEqual({ kind: "command", summary: "step 3", status: "failed", exitCode: 2 });
    expect(ledger.entries.at(-1)?.summary).toBe("step 63");
    expect(ledger.omitted).toBe(7);
  });

  it("cuts a summary to 512 UTF-8 bytes on a character boundary, on one line", () => {
    const recorder = new HarnessActionLedgerRecorder();
    recorder.started("wide", { kind: "file_change", summary: `edit ${"é".repeat(400)}\nsecond line` });
    recorder.ended("control", { kind: "other", summary: "tab\there\u0007bell separator", status: "completed" });
    recorder.ended("empty", { kind: "web", summary: "   ", status: "completed" });

    const [wide, control, empty] = recorder.seal().entries;

    expect(Buffer.byteLength(wide!.summary, "utf8")).toBeLessThanOrEqual(MAX_ACTION_SUMMARY_BYTES);
    expect(wide!.summary.endsWith(" …")).toBe(true);
    expect(wide!.summary).not.toContain("�");
    expect(wide!.summary).not.toContain("second line");
    expect(control!.summary).toBe("tab here bell separator");
    expect(empty!.summary).toBe("web request");
  });

  it("redacts secrets with the trace redaction rules", () => {
    const recorder = new HarnessActionLedgerRecorder();
    recorder.ended("header", {
      kind: "command",
      summary: "curl -H 'Authorization: Bearer sk-live-abcdefghijklmnop' https://user:hunter2@example.test/api",
      status: "completed",
      exitCode: 0,
    });
    recorder.ended("env", { kind: "command", summary: "OPENAI_API_KEY=sk-proj-secretvalue npm test", status: "failed", exitCode: 1 });

    const serialized = JSON.stringify(recorder.seal());

    expect(serialized).not.toContain("sk-live-abcdefghijklmnop");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("sk-proj-secretvalue");
    expect(serialized).toContain("[redacted]");
  });

  it("settles still-running actions as interrupted and ignores everything after the seal", () => {
    const recorder = new HarnessActionLedgerRecorder();
    recorder.started("running", { kind: "command", summary: "npm run migrate" });
    recorder.started("done", { kind: "command", summary: "npm test" });
    recorder.ended("done", { kind: "command", summary: "npm test", status: "completed", exitCode: 0 });
    // A duplicate end does not rewrite an action's reported outcome.
    recorder.ended("done", { kind: "command", summary: "npm test", status: "failed", exitCode: 9 });

    const ledger = recorder.seal();
    recorder.ended("running", { kind: "command", summary: "npm run migrate", status: "completed", exitCode: 0 });
    recorder.started("late", { kind: "command", summary: "rm -rf build" });

    expect(recorder.seal()).toBe(ledger);
    expect(ledger).toEqual({
      entries: [
        { kind: "command", summary: "npm run migrate", status: "interrupted" },
        { kind: "command", summary: "npm test", status: "completed", exitCode: 0 },
      ],
      omitted: 0,
    });
  });
});

const graphUrl = "http://127.0.0.1:43123";
const graph = (nodeId: number) => ({ url: graphUrl, token: `token-${nodeId}`, nodeId });
const node = (id: number) => ({ id, kind: "user-interaction", icon: "user", title: "Q", detail: "Q", state: "accepted" });
const testConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "test",
  implementation: "test",
  implementationVersion: 1,
  permissionBindings: { auto: {} },
  settings: {},
};
const emptyState = (): HarnessSessionState => ({});

describe("the harness host's settlement report", () => {
  let directory: string | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("reports the ledger with an accepted, a failed, and a stopped root turn over its API", async () => {
    directory = await mkdtemp(join(tmpdir(), "relayer-action-ledger-route-"));
    const accepted = stubGraph();
    let stopStarted!: () => void;
    const stopRunning = new Promise<void>((resolve) => { stopStarted = resolve; });
    const running = await startHarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: { test: () => ({
        async complete(context: HarnessRunContext, signal?: AbortSignal) {
          const nodeId = context.inputGraph.id;
          context.actions?.started("test", { kind: "command", summary: `npm test ${nodeId}` });
          if (nodeId === 1) {
            context.actions?.ended("test", { kind: "command", summary: "npm test 1", status: "failed", exitCode: 1 });
            accepted.add(nodeId);
            return;
          }
          if (nodeId === 2) throw new Error("deterministic native failure");
          stopStarted();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        state: emptyState,
      }) },
    });
    const complete = (nodeId: number) => fetch(`${running.url}/sessions/1/complete`, {
      method: "POST",
      headers: { authorization: "Bearer control", "content-type": "application/json" },
      body: JSON.stringify({ interactionId: nodeId, graph: graph(nodeId) }),
    });
    try {
      await running.host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

      const acceptedResponse = await complete(1);
      expect(acceptedResponse.status).toBe(200);
      expect((await acceptedResponse.json()).actions).toEqual({
        entries: [{ kind: "command", summary: "npm test 1", status: "failed", exitCode: 1 }],
        omitted: 0,
      });

      // A replayed turn whose completion was already accepted runs nothing and reports no
      // ledger, which differs from a turn that ran and did nothing.
      const replayedResponse = await complete(1);
      expect(replayedResponse.status).toBe(200);
      expect(await replayedResponse.json()).not.toHaveProperty("actions");

      const failedResponse = await complete(2);
      expect(failedResponse.status).toBe(500);
      expect(await failedResponse.json()).toMatchObject({
        error: "deterministic native failure",
        actions: { entries: [{ kind: "command", summary: "npm test 2", status: "interrupted" }], omitted: 0 },
      });

      const stopped = complete(3);
      await stopRunning;
      const cancelled = await fetch(`${running.url}/sessions/1/cancel`, { method: "POST", headers: { authorization: "Bearer control" } });
      expect(await cancelled.json()).toEqual({ cancelled: true });
      const stoppedResponse = await stopped;
      expect(stoppedResponse.status).toBe(409);
      expect(await stoppedResponse.json()).toMatchObject({
        cancellationSettled: true,
        actions: { entries: [{ kind: "command", summary: "npm test 3", status: "interrupted" }], omitted: 0 },
      });
    } finally {
      await running.close();
    }
  });

  it("keeps a force-stopped Codex turn's partial ledger and nothing the killed turn reports later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    directory = await mkdtemp(join(tmpdir(), "relayer-action-ledger-force-"));
    stubGraph();
    let turn: CodexAppServerTurnOptions | undefined;
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      implementations: { "codex.basic": (context) => new CodexBasicHarness(context, {
        codexPathOverride: "/managed/codex",
        runAppServerTurn: async (options: CodexAppServerTurnOptions) => {
          turn = options;
          await options.onThreadId("thread-1");
          options.onTurnStarting?.("thread-1");
          await options.onTurnId?.("thread-1", "turn-1");
          options.onNotification?.("item/started", { item: { type: "commandExecution", id: "done", command: "npm test", status: "inProgress" } });
          options.onNotification?.("item/completed", { item: { type: "commandExecution", id: "done", command: "npm test", status: "completed", exitCode: 0, aggregatedOutput: "all passed" } });
          options.onNotification?.("item/started", { item: { type: "commandExecution", id: "stuck", command: "npm run migrate", status: "inProgress" } });
          // The killed app-server never settles this turn.
          return new Promise<never>(() => {});
        },
      }) },
    });
    await host.initialize();
    await host.createSession({
      threadId: 1,
      permissionProfileId: "full",
      workingDirectory: directory,
      configuration: {
        schemaVersion: 1,
        name: "codex-basic",
        implementation: "codex.basic",
        implementationVersion: 1,
        permissionBindings: { full: { sandboxMode: "danger-full-access", approvalPolicy: "never" } },
        settings: { model: "gpt-test", modelReasoningEffort: "medium", webSearchMode: "disabled", skipGitRepoCheck: true },
      },
    });
    const cancel = new AbortController();
    const settlement = host.complete(1, 1, graph(1), cancel.signal).then(
      () => { throw new Error("a force-stopped turn must not succeed"); },
      (error: unknown) => error,
    );
    await until(() => turn !== undefined);
    cancel.abort(new Error("Stopped by user"));
    await vi.advanceTimersByTimeAsync(CANCELLED_TURN_FORCE_STOP_MS);
    await vi.advanceTimersByTimeAsync(FORCE_STOPPED_TURN_SETTLE_MS);
    const error = await settlement;
    // The killed turn reports after the host settled it; the sealed ledger does not change.
    turn!.onNotification?.("item/completed", { item: { type: "commandExecution", id: "stuck", command: "npm run migrate", status: "completed", exitCode: 0 } });
    turn!.onNotification?.("item/started", { item: { type: "commandExecution", id: "late", command: "rm -rf build", status: "inProgress" } });
    await host.close();

    expect(harnessSettlementActionLedger(error)).toEqual({
      entries: [
        { kind: "command", summary: "npm test", status: "completed", exitCode: 0 },
        { kind: "command", summary: "npm run migrate", status: "interrupted" },
      ],
      omitted: 0,
    });
    expect(JSON.stringify(harnessSettlementActionLedger(error))).not.toContain("all passed");
  });
});

/** Polls without timers, so it also works while setTimeout is faked. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

/** Graph reads for a turn whose completion is not yet accepted, until the test accepts it. */
function stubGraph(): Set<number> {
  const accepted = new Set<number>();
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(graphUrl)) return nativeFetch(input, init);
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
