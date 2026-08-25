import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadHarnessConfiguration } from "../src/configuration.js";
import { createNoopHarnessTraceSink, HarnessTraceStore } from "../src/trace.js";
import type { CodexAppServerTurnOptions } from "../src/implementations/codex-app-server.js";
import { CodexBasicHarness, type CodexBasicDependencies } from "../src/implementations/codex-basic.js";
import type { HarnessConfiguration, HarnessRunContext, HarnessTraceEvent, HarnessTraceEventInput, HarnessTracePolicy, HarnessTraceSink } from "../src/types.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

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
    expect(submitted?.prompt).toContain('new NodeObject("info", "Summary", "...", "concept", "summary-node")');
    expect(submitted?.prompt).not.toContain('new NodeObject("lightbulb"');
    expect(submitted?.prompt).toContain('new EdgeObject([summaryNode, detailNode], "summary-detail-edge")');
    expect(submitted?.prompt).toContain('new LayerObject(nodes, edges, layout, "response-layer")');
    expect(submitted?.prompt).toContain('relation: "expand"');
    expect(submitted?.prompt).toContain("sourceLayer: layer");
    expect(submitted?.prompt).toContain('clientKey: "root-response"');
    expect(submitted?.prompt).toContain("rerun it with the same clientKey values");
    expect(submitted?.prompt).toContain("An action's clientKey is scoped to its source node");
    expect(submitted?.prompt).toContain("keep every draft action on the same source node during repair");
    expect(submitted?.prompt).toContain("Do not add fake navigate or reference actions");
    expect(submitted?.prompt).toContain("graph.discardLayer(layer)");
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
    expect(submittedPrompt).toContain("graph.getNode(1)");
    expect(submittedPrompt).toContain("graph.getNeighbors(1)");
    expect(submittedPrompt).toContain("ordinary graph.submit(1) automatically fulfills any lease");
    expect(submittedPrompt).toContain("There is no separate resolveAction call");
    expect(submittedPrompt).toContain("Never mention or expose the size justification");
    expect(submittedPrompt).toContain("Every new root, expansion, and reference layer requires a version-1 LayerLayoutObject");
    expect(submittedPrompt).toContain("align comparisons deliberately");
    expect(submittedPrompt).toContain('new NodeObject("info", "Summary", "...", "concept", "summary-node")');
    expect(submittedPrompt).not.toContain('new NodeObject("lightbulb"');
    expect(submittedPrompt).toContain('clientKey: "root-response"');
    expect(submittedPrompt).toContain('clientKey: "node-detail"');
    expect(submittedPrompt).toContain('clientKey: "node-evidence"');
    expect(submittedPrompt).toContain('clientKey: "node-follow-up"');
    expect(submittedPrompt).toContain("rerun it with the same clientKey values");
    expect(submittedPrompt).toContain("An action's clientKey is scoped to its source node");
    expect(submittedPrompt).toContain("keep every draft action on the same source node during repair");
    expect(submittedPrompt).toContain("Do not add fake navigate or reference actions");
    expect(submittedPrompt).toContain("graph.discardLayer(layer)");
    expect(submittedPrompt).not.toContain("The required order is:");
  });

  it("appends only the native delegation guidance for the multi-agent profile", async () => {
    const prompts: string[] = [];
    const createHarness = (promptProfile: "layered-navigation-v1" | "layered-navigation-multi-agent-v1") => new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "auto",
      permissionBinding: codexBasicConfiguration.permissionBindings.auto!,
      workingDirectory: process.cwd(),
      configuration: {
        ...codexBasicConfiguration,
        name: `codex-${promptProfile}`,
        settings: { ...codexBasicConfiguration.settings, promptProfile },
      },
    }, { runAppServerTurn: async (options) => {
      prompts.push(options.prompt);
      options.onThreadId("layered-thread");
      return { threadId: "layered-thread", turnId: "turn-1", status: "completed" };
    } });

    await createHarness("layered-navigation-v1").complete(runContext(1, "token"));
    await createHarness("layered-navigation-multi-agent-v1").complete(runContext(1, "token"));

    const delegationGuidance = "Codex native subagents are available when useful. Subagents may directly author, revise, and submit graph objects using the available graph capability. Use the configured model family as appropriate; coordination remains native to Codex.";
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(`${prompts[0]}\n\n${delegationGuidance}`);
  });

  it("uses the picker-selected root model with the actual multi-agent configuration", async () => {
    const configuration = await loadHarnessConfiguration(join(repositoryRoot, "harnesses/codex-multi-agent-layered-navigation.yaml"));
    let submitted: CodexAppServerTurnOptions | undefined;
    const harness = new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "auto",
      permissionBinding: configuration.permissionBindings.auto!,
      workingDirectory: repositoryRoot,
      configuration,
    }, { runAppServerTurn: async (options) => {
      submitted = options;
      options.onThreadId("selected-model-thread");
      return { threadId: "selected-model-thread", turnId: "turn-1", status: "completed" };
    } });

    await harness.complete({
      ...runContext(1, "token"),
      model: { providerId: "codex", modelId: "gpt-picker-selected" },
    });

    expect(submitted?.threadParams).toMatchObject({ model: "gpt-picker-selected" });
    expect(submitted?.turnParams).toMatchObject({ model: "gpt-picker-selected", effort: "medium" });
    expect(configuration.settings).not.toHaveProperty("model");
    expect(configuration.modelCompatibility?.[0]).not.toHaveProperty("preferredModelId");
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

  it("normalizes Codex collaboration variants as root coordination-operation spans", async () => {
    const notifications = [
      ["item/started", { item: {
        id: "spawn-1", type: "collabAgentToolCall", tool: "spawnAgent", status: "inProgress",
        senderThreadId: "root", receiverThreadIds: ["child-1", "child-2"],
        prompt: "Inspect OPENAI_API_KEY=secret", model: "gpt-child", reasoningEffort: "high",
        agentsStates: { "child-1": "pending", "child-2": "pending" },
      } }],
      ["item/completed", { item: {
        id: "spawn-1", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
        senderThreadId: "root", receiverThreadIds: ["child-1", "child-2"],
        prompt: "Inspect OPENAI_API_KEY=secret", model: "gpt-child", reasoningEffort: "high",
        agentsStates: {
          "child-1": { status: "completed", message: "Full child result stays provider-native" },
          "child-2": "running",
        },
      } }],
      ["item.completed", { item: {
        id: "send-1", type: "collab_tool_call", tool: "send_input", status: "failed",
        sender_thread_id: "root", receiver_thread_ids: ["child-1"], delegation_prompt: "Check again",
      } }],
      ["item/started", { item: {
        id: "resume-1", type: "collabToolCall", operation: "resumeAgent", status: "inProgress",
        senderThreadId: "root", receiverThreadIds: ["child-1"],
      } }],
      ["item/completed", { item: {
        id: "resume-1", type: "collabToolCall", operation: "resumeAgent", status: "completed",
        senderThreadId: "root", receiverThreadIds: ["child-1"],
      } }],
      ["item/completed", { item: {
        type: "collabAgentToolCall", tool: "wait", status: "completed",
        senderThreadId: "root", receiverThreadIds: ["child-1", "child-2"],
      } }],
      ["item/started", { item: {
        id: "close-1", type: "collabAgentToolCall", tool: "closeAgent", status: "inProgress",
        senderThreadId: "root", receiverThreadIds: ["child-1"],
      } }],
      ["item/completed", { item: {
        id: "close-1", type: "collabAgentToolCall", tool: "closeAgent", status: "completed",
        senderThreadId: "root", receiverThreadIds: ["child-1"],
      } }],
      ["item/started", { item: {
        id: "future-1", type: "collabAgentToolCall", tool: "handoffAgent", status: "inProgress",
        senderThreadId: "root", receiverThreadIds: ["child-3"],
      } }],
      ["item/completed", { item: {
        id: "future-1", type: "collabAgentToolCall", tool: "handoffAgent", status: "completed",
        senderThreadId: "root", receiverThreadIds: ["child-3"],
      } }],
    ] as const;
    const trace = recordingTrace();
    const harness = harnessFixture("auto", async (options) => {
      options.onThreadId("streamed-thread");
      for (const [method, params] of notifications) options.onNotification?.(method, params);
      return { threadId: "streamed-thread", turnId: "turn-1", status: "completed" };
    });

    await harness.complete(runContext(1, "token", trace.sink));

    expect(trace.events.filter((event) => event.type === "provider.event")).toHaveLength(notifications.length);
    const spawnStarted = trace.events.find((event) => event.type === "tool.call.started" && event.data.providerItemId === "spawn-1");
    expect(spawnStarted?.data).toMatchObject({
      itemType: "collaboration_operation",
      operation: "spawn_agent",
      senderThreadId: "root",
      receiverThreadIds: ["child-1", "child-2"],
      delegationPrompt: "Inspect credential=[redacted]",
      model: "gpt-child",
      reasoningEffort: "high",
      status: "in_progress",
    });
    const spawnCompleted = trace.events.find((event) => event.type === "tool.call.completed" && event.data.providerItemId === "spawn-1");
    expect(spawnCompleted?.data.agentStates).toEqual({
      "child-1": { status: "completed" },
      "child-2": "running",
    });
    expect(JSON.stringify(spawnCompleted?.data)).not.toContain("Full child result");
    const recovered = trace.events.filter((event) => event.spanId !== undefined && event.data.providerItemId === "send-1");
    expect(recovered.map((event) => event.type)).toEqual(["tool.call.started", "tool.call.completed"]);
    expect(recovered[0]?.data).toMatchObject({ operation: "send_input", missingStart: true, delegationPrompt: "Check again" });
    expect(trace.events.find((event) => event.type === "span.completed" && event.spanId === recovered[0]?.spanId)?.data).toEqual({ status: "failed", missingStart: true });
    expect(trace.events.find((event) => event.type === "tool.call.started" && event.data.providerItemId === "resume-1")?.data.operation).toBe("resume_agent");
    expect(trace.events.find((event) => event.type === "tool.call.started" && event.data.providerItemId === "close-1")?.data.operation).toBe("close_agent");
    expect(trace.events.find((event) => event.type === "tool.call.started" && event.data.providerItemId === "future-1")?.data).toMatchObject({
      operation: "unknown",
      providerOperation: "handoffAgent",
    });
    const wait = trace.events.find((event) => event.type === "tool.call.completed" && event.data.missingProviderItemId === true);
    expect(wait?.spanId).toBeUndefined();
    expect(wait?.data).toMatchObject({ operation: "wait", receiverThreadIds: ["child-1", "child-2"] });
    const firstSpawnProviderIndex = trace.events.findIndex((event) => event.type === "provider.event" && event.providerEventId === "spawn-1");
    const firstSpawnToolIndex = trace.events.findIndex((event) => event.type === "tool.call.started" && event.data.providerItemId === "spawn-1");
    expect(firstSpawnProviderIndex).toBeLessThan(firstSpawnToolIndex);
    expect(JSON.stringify(trace.events[firstSpawnProviderIndex]?.data)).not.toContain("secret");
    expect(trace.openedStreams).toBe(0);
  });

  it("preserves malformed collaboration notifications as raw events without changing completion", async () => {
    const trace = recordingTrace();
    const harness = harnessFixture("auto", async (options) => {
      options.onThreadId("streamed-thread");
      options.onNotification?.("item/started", { item: { id: "malformed-1", type: "collabAgentToolCall", tool: { future: true } } });
      options.onNotification?.("item/completed", { item: { id: "ordinary-1", type: "commandExecution", command: "pwd" } });
      return { threadId: "streamed-thread", turnId: "turn-1", status: "completed" };
    });

    await expect(harness.complete(runContext(1, "token", trace.sink))).resolves.toBeUndefined();

    expect(trace.events.filter((event) => event.type === "provider.event")).toHaveLength(2);
    expect(trace.events.filter((event) => event.type.startsWith("tool.call"))).toHaveLength(0);
  });

  it("preserves a partial unmatched collaboration span when the real trace store seals the run complete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-codex-collaboration-trace-"));
    const exportDirectory = join(directory, "exported");
    try {
      let nextId = 0;
      const store = new HarnessTraceStore({
        directory: join(directory, "spool"),
        policy: tracePolicy(),
        createId: () => `trace-object-${++nextId}`,
      });
      const harness = harnessFixture("auto", async (options) => {
        options.onThreadId("streamed-thread");
        options.onNotification?.("item/started", { item: {
          id: "spawn-unmatched",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: "root",
          receiverThreadIds: ["child-1"],
          prompt: "Inspect the trace contract",
        } });
        options.onNotification?.("turn/completed", { turn: { id: "turn-1", status: "completed" } });
        return { threadId: "streamed-thread", turnId: "turn-1", status: "completed" };
      });
      const active = store.start({
        threadId: 1,
        interactionNodeId: 1,
        productInteractionId: 99,
        implementation: "codex.basic",
        configurationName: "codex-multi-agent-layered-navigation",
        support: harness.traceSupport(),
      });

      await harness.complete(runContext(1, "token", active.sink));
      const descriptor = await active.seal("complete");
      await store.export(99, exportDirectory, {
        runId: "run-1",
        executionId: "execution-1",
        interactionId: "99",
        harnessConfigurationName: "codex-multi-agent-layered-navigation",
      });
      const events = (await readFile(join(exportDirectory, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as HarnessTraceEvent);
      const operationStart = events.find((event) => event.type === "span.started" && event.data.providerSpanId === "spawn-unmatched");

      expect(descriptor.status).toBe("complete");
      expect(operationStart?.spanId).toBeDefined();
      expect(events.find((event) => event.type === "span.completed" && event.spanId === operationStart?.spanId)?.data).toEqual({
        status: "partial",
        providerItemId: "spawn-unmatched",
        reason: "Codex collaboration operation did not report completion",
      });
      expect(events.find((event) => event.type === "run.completed")?.data).toEqual({ status: "complete" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

function recordingTrace(): { sink: HarnessTraceSink; events: HarnessTraceEventInput[]; readonly openedStreams: number } {
  const events: HarnessTraceEventInput[] = [];
  const noop = createNoopHarnessTraceSink();
  let nextSpanId = 0;
  let openedStreams = 0;
  return {
    sink: {
      ...noop,
      emit: (event) => { events.push({ ...event, streamId: noop.rootStreamId }); },
      openStream: (input) => {
        openedStreams += 1;
        return noop.openStream(input);
      },
      openSpan: (input) => {
        const spanId = `span-${++nextSpanId}`;
        events.push({
          type: "span.started",
          streamId: noop.rootStreamId,
          spanId,
          data: { name: input.name, kind: input.kind, ...(input.providerSpanId === undefined ? {} : { providerSpanId: input.providerSpanId }) },
        });
        return {
          id: spanId,
          emit: (event) => { events.push({ ...event, streamId: noop.rootStreamId, spanId }); },
          end: (status, data = {}) => { events.push({ type: "span.completed", streamId: noop.rootStreamId, spanId, data: { status, ...data } }); },
        };
      },
    },
    events,
    get openedStreams() { return openedStreams; },
  };
}

function tracePolicy(): HarnessTracePolicy {
  return {
    mode: "required",
    requiredFeatures: {},
    includeNativeArtifacts: false,
    maxBytesPerTurn: 1_000_000,
    maxEventsPerTurn: 1_000,
  };
}
