import { describe, expect, it, vi } from "vitest";
import { createNoopHarnessTraceSink } from "../src/trace.js";
import type { CodexAppServerTurnOptions } from "../src/implementations/codex-app-server.js";
import { CodexBasicHarness, type CodexBasicDependencies } from "../src/implementations/codex-basic.js";
import type { HarnessConfiguration, HarnessRunContext, HarnessTraceEventInput, HarnessTraceSink } from "../src/types.js";

const codexBasicConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "codex-basic",
  implementation: "codex.basic",
  implementationVersion: 1,
  permissionBindings: {
    ask: { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user", networkAccessEnabled: true },
    auto: { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review", networkAccessEnabled: true },
    full: { sandboxMode: "danger-full-access", approvalPolicy: "never" },
  },
  settings: {
    model: "gpt-test",
    modelReasoningEffort: "medium",
    webSearchMode: "disabled",
    skipGitRepoCheck: true,
  },
};

describe("CodexBasicHarness", () => {
  it("rejects an unsupported implementation version", () => {
    expect(() => new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "auto",
      permissionBinding: codexBasicConfiguration.permissionBindings.auto!,
      workingDirectory: process.cwd(),
      configuration: { ...codexBasicConfiguration, implementationVersion: 2 },
      savedState: { codexThreadId: "codex-thread" },
    })).toThrow("Unsupported codex.basic implementation version: 2");
  });

  it("retains a provider thread ID when the first app-server turn fails", async () => {
    let submitted: CodexAppServerTurnOptions | undefined;
    const harness = harnessFixture("auto", async (options) => {
      submitted = options;
      options.onThreadId("codex-thread-after-start");
      throw new Error("turn failed");
    });

    await expect(harness.complete(runContext(1, "token"))).rejects.toThrow("turn failed");

    expect(harness.state()).toEqual({ codexThreadId: "codex-thread-after-start" });
    expect(submitted?.prompt).toContain("Relayer graph affordances:");
    expect(submitted?.prompt).toContain("system temporary directory, not in the project checkout");
    expect(submitted?.prompt).toContain("must use exactly one supported Relayer icon name");
    expect(submitted?.prompt).toContain("exactly one NodePlacementObject(node, x, y) per layer node");
    expect(submitted?.prompt).toContain("Place a one-node layer at (0.5, 0.5)");
    expect(submitted?.prompt).toContain("independently of the viewport");
    expect(submitted?.prompt).toContain("square-dashed-kanban");
    expect(submitted?.threadParams).toEqual({
      cwd: process.cwd(),
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
      model: "gpt-test",
      config: { skip_git_repo_check: true, web_search: "disabled" },
      serviceName: "relayer_graphcomplete",
    });
    expect(submitted?.turnParams).toMatchObject({
      cwd: process.cwd(),
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      model: "gpt-test",
      effort: "medium",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [process.cwd()],
        networkAccess: true,
      },
    });
  });

  it("passes the packaged executable override to the app-server transport", async () => {
    let submitted: CodexAppServerTurnOptions | undefined;
    const harness = new CodexBasicHarness(context("auto"), {
      codexPathOverride: "/Applications/Relayer.app/Contents/Resources/codex",
      runAppServerTurn: async (options) => {
        submitted = options;
        options.onThreadId("codex-thread");
        return { threadId: "codex-thread", turnId: "turn-1", status: "completed" };
      },
    });

    await harness.complete(runContext(1, "token"));

    expect(submitted).toMatchObject({
      codexPathOverride: "/Applications/Relayer.app/Contents/Resources/codex",
      environment: { RELAYER_GRAPH_TOKEN: "token", RELAYER_NODE_ID: "1" },
    });
  });

  it("selects the layered-navigation prompt only for the opt-in profile", async () => {
    let submittedPrompt = "";
    const harness = new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "auto",
      permissionBinding: codexBasicConfiguration.permissionBindings.auto!,
      workingDirectory: process.cwd(),
      configuration: {
        ...codexBasicConfiguration,
        name: "codex-layered-navigation-luna",
        settings: { ...codexBasicConfiguration.settings, promptProfile: "layered-navigation-v1" },
      },
    }, { runAppServerTurn: async (options) => {
      submittedPrompt = options.prompt;
      options.onThreadId("layered-thread");
      return { threadId: "layered-thread", turnId: "turn-1", status: "completed" };
    } });

    await harness.complete(runContext(1, "token"));

    expect(submittedPrompt).toContain('"expand" continues the explanation');
    expect(submittedPrompt).toContain('"reference" opens supporting evidence');
    expect(submittedPrompt).toContain("A flat answer is valid");
    expect(submittedPrompt).toContain("Author in whatever order fits the task");
    expect(submittedPrompt).toContain("final graph call must be await graph.submit(1)");
    expect(submittedPrompt).toContain("Never mention or expose the size justification");
    expect(submittedPrompt).toContain("Every new root, expansion, and reference layer requires a version-1 LayerLayoutObject");
    expect(submittedPrompt).toContain("align comparisons deliberately");
    expect(submittedPrompt).not.toContain("The required order is:");
  });

  it("translates the three product profiles without adding a fixture-only profile", async () => {
    const cases = [
      ["ask", { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user" }, { type: "workspaceWrite", networkAccess: true }],
      ["auto", { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review" }, { type: "workspaceWrite", networkAccess: true }],
      ["full", { sandbox: "danger-full-access", approvalPolicy: "never" }, { type: "dangerFullAccess" }],
    ] as const;
    expect(Object.keys(codexBasicConfiguration.permissionBindings)).toEqual(["ask", "auto", "full"]);
    for (const [permissionProfileId, expectedThread, expectedSandbox] of cases) {
      let submitted: CodexAppServerTurnOptions | undefined;
      const harness = harnessFixture(permissionProfileId, async (options) => {
        submitted = options;
        options.onThreadId("codex-thread");
        return { threadId: "codex-thread", turnId: "turn-1", status: "completed" };
      });

      await harness.complete(runContext(1, "token"));

      expect(submitted?.threadParams).toMatchObject(expectedThread);
      expect(submitted?.sandboxPolicy).toMatchObject(expectedSandbox);
    }
  });

  it("rotates graph credentials while resuming the same provider thread", async () => {
    const submissions: CodexAppServerTurnOptions[] = [];
    const harness = harnessFixture("auto", async (options) => {
      submissions.push(options);
      options.onThreadId(options.savedThreadId ?? "codex-thread-1");
      return { threadId: options.savedThreadId ?? "codex-thread-1", turnId: `turn-${submissions.length}`, status: "completed" };
    });

    await harness.complete({ ...runContext(1, "first-token"), model: { providerId: "codex", modelId: "gpt-first" } });
    await harness.complete({ ...runContext(2, "second-token"), model: { providerId: "codex", modelId: "gpt-second" } });

    expect(submissions.map(({ environment, savedThreadId }) => [environment.RELAYER_GRAPH_TOKEN, environment.RELAYER_NODE_ID, savedThreadId])).toEqual([
      ["first-token", "1", undefined],
      ["second-token", "2", "codex-thread-1"],
    ]);
    expect(submissions.map(({ threadParams, turnParams }) => [threadParams.model, turnParams.model])).toEqual([
      ["gpt-first", "gpt-first"],
      ["gpt-second", "gpt-second"],
    ]);
    expect(harness.state()).toEqual({ codexThreadId: "codex-thread-1" });
  });

  it("rejects a provider model that codex.basic cannot execute before starting a thread", async () => {
    const runAppServerTurn = vi.fn<NonNullable<CodexBasicDependencies["runAppServerTurn"]>>();
    const harness = new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "auto",
      permissionBinding: codexBasicConfiguration.permissionBindings.auto!,
      workingDirectory: process.cwd(),
      configuration: codexBasicConfiguration,
    }, { runAppServerTurn });

    await expect(harness.complete({
      ...runContext(1, "token"),
      model: { providerId: "future-provider", modelId: "future-model" },
    })).rejects.toThrow("codex.basic cannot run provider future-provider");
    expect(runAppServerTurn).not.toHaveBeenCalled();
  });

  it("normalizes the app-server event surface into the portable trace", async () => {
    const trace = recordingTrace();
    const harness = harnessFixture("auto", async (options) => {
      options.onThreadId("streamed-thread");
      options.onNotification?.("turn/started", { threadId: "streamed-thread", turn: { id: "turn-1" } });
      options.onNotification?.("item/completed", { item: { id: "message-1", type: "agentMessage", text: "Answer" } });
      options.onNotification?.("item/completed", { item: { id: "reasoning-1", type: "reasoning", text: "Checked the result" } });
      options.onNotification?.("turn/completed", { turn: { id: "turn-1", status: "completed", usage: { inputTokens: 2, outputTokens: 3 } } });
      return { threadId: "streamed-thread", turnId: "turn-1", status: "completed" };
    });

    await harness.complete(runContext(1, "token", trace.sink));

    expect(trace.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "provider.event", "model.call.started", "message", "reasoning.summary", "usage", "model.call.completed",
    ]));
    expect(harness.traceSupport()).toMatchObject({ messages: "full", reasoningSummaries: "full", childStreams: "none" });
  });
});

function context(permissionProfileId: "ask" | "auto" | "full") {
  return {
    threadId: 1,
    permissionProfileId,
    permissionBinding: codexBasicConfiguration.permissionBindings[permissionProfileId]!,
    workingDirectory: process.cwd(),
    configuration: codexBasicConfiguration,
  };
}

function harnessFixture(
  permissionProfileId: "ask" | "auto" | "full",
  runAppServerTurn: NonNullable<CodexBasicDependencies["runAppServerTurn"]>,
): CodexBasicHarness {
  return new CodexBasicHarness(context(permissionProfileId), { runAppServerTurn });
}

function runContext(id: number, token: string, trace: HarnessTraceSink = createNoopHarnessTraceSink()): HarnessRunContext {
  return {
    inputGraph: { id, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" },
    graph: {
      interactionNodeId: id,
      acquireCapability: () => ({ url: "http://127.0.0.1:43123", token, nodeId: id }),
    },
    trace,
    approvals: { request: async () => { throw new Error("unused approval channel"); } },
  };
}

function recordingTrace(): { sink: HarnessTraceSink; events: HarnessTraceEventInput[] } {
  const events: HarnessTraceEventInput[] = [];
  const noop = createNoopHarnessTraceSink();
  return { sink: { ...noop, emit: (event) => { events.push({ ...event, streamId: noop.rootStreamId }); } }, events };
}
