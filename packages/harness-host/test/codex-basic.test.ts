import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadHarnessConfiguration } from "../src/configuration.js";
import { createNoopHarnessTraceSink, HarnessTraceStore } from "../src/trace.js";
import type { CodexAppServerTurnOptions } from "../src/implementations/codex-app-server.js";
import { buildLayeredNavigationPrompt, CodexBasicHarness, type CodexBasicDependencies } from "../src/implementations/codex-basic.js";
import type { HarnessConfiguration, HarnessRunContext, HarnessTraceEvent, HarnessTraceEventInput, HarnessTracePolicy, HarnessTraceSink } from "../src/types.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const browserMcpRuntime = {
  executable: "/Applications/Relayer.app/Contents/MacOS/Relayer",
  script: "/Applications/Relayer.app/Contents/Resources/app.asar.unpacked/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
  connectionArgs: ["--browserUrl", "http://127.0.0.1:9222", "--no-usage-statistics", "--no-performance-crux"],
} as const;

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
  it("renders V1 after generic guidance and leaves neutral V0 at baseline", () => {
    const baseline = buildLayeredNavigationPrompt(runContext(1, "token"), "@relayer/graph-client");
    const neutral = buildLayeredNavigationPrompt(personalPresentationRunContext(false), "@relayer/graph-client");
    const treatment = buildLayeredNavigationPrompt(personalPresentationRunContext(true), "@relayer/graph-client");
    const codexProviderPrompt = buildLayeredNavigationPrompt(personalPresentationRunContext(true), "@relayer/graph-client", undefined, false);

    expect(neutral).toBe(baseline);
    expect(treatment).toContain("Personal graph presentation preferences:");
    expect(treatment).toContain("Decision-useful center: The user prefers central layers");
    expect(treatment).toContain("every native child that can author graph content");
    expect(treatment.indexOf("Graph presentation guidance:")).toBeLessThan(
      treatment.indexOf("Personal graph presentation preferences:"),
    );
    expect(treatment.indexOf("Personal graph presentation preferences:")).toBeLessThan(
      treatment.indexOf("Normalized interaction input:"),
    );
    expect(codexProviderPrompt).toBe(baseline);
  });

  it("reuses a native Codex thread only while its pinned presentation version is unchanged", async () => {
    const submitted: CodexAppServerTurnOptions[] = [];
    const trace = recordingTrace();
    const harness = harnessFixture("auto", async (options) => {
      submitted.push(options);
      options.onThreadId("thread-1");
      return { threadId: "thread-1", turnId: "turn-1", status: "completed" };
    });

    await harness.complete({ ...personalPresentationRunContext(true), trace: trace.sink });
    await harness.complete(personalPresentationRunContext(true));
    await harness.complete(personalPresentationRunContext(false));

    expect(submitted[0]?.threadParams.developerInstructions).toContain("If you are the root agent");
    expect(submitted[0]?.threadParams.developerInstructions).toContain("only when assigning a native child to author graph content");
    expect(submitted[0]?.threadParams.developerInstructions).toContain("Never include that block in an unrelated delegate's task");
    expect(submitted[0]?.threadParams.developerInstructions).toContain("only when that exact rendered block is present in your assigned task");
    expect(submitted[0]?.threadParams.developerInstructions).toContain("every native child that can author graph content");
    expect(submitted[0]?.threadParams.developerInstructions).not.toContain("Personal graph presentation preferences:");
    expect(submitted[0]?.threadParams.developerInstructions).not.toContain("Decision-useful center");
    expect(submitted[0]?.prompt).toContain("Personal graph presentation preferences:");
    expect(submitted[0]?.prompt.indexOf("Graph presentation guidance:")).toBeLessThan(
      submitted[0]!.prompt.indexOf("Personal graph presentation preferences:"),
    );
    expect(submitted[0]?.prompt.indexOf("Personal graph presentation preferences:")).toBeLessThan(
      submitted[0]!.prompt.indexOf("Normalized interaction input:"),
    );
    const tracedPrompt = trace.events.find((event) => event.type === "prompt")?.data.text;
    expect(tracedPrompt).not.toContain("Personal graph presentation preferences:");
    expect(tracedPrompt).not.toContain("Decision-useful center");
    expect(submitted[1]?.savedThreadId).toBe("thread-1");
    expect(submitted[2]?.savedThreadId).toBeUndefined();
    expect(submitted[2]?.threadParams.developerInstructions).toBeNull();
  });

  it("rotates a legacy saved Codex thread whose presentation version is unknown", async () => {
    let submitted: CodexAppServerTurnOptions | undefined;
    const harness = new CodexBasicHarness({
      ...context("auto"),
      savedState: { codexThreadId: "legacy-thread" },
    }, {
      codexPathOverride: "/managed/codex",
      runAppServerTurn: async (options) => {
        submitted = options;
        options.onThreadId("replacement-thread");
        return { threadId: "replacement-thread", turnId: "turn-1", status: "completed" };
      },
    });

    await harness.complete(runContext(1, "token"));

    expect(submitted?.savedThreadId).toBeUndefined();
    expect(harness.state()).toEqual({
      codexThreadId: "replacement-thread",
      codexThreadPersonalPresentationVersionId: null,
    });
  });

  it("requires an explicit Codex executable before submitting an app-server turn", async () => {
    const runAppServerTurn = vi.fn(async () => ({
      threadId: "unreachable",
      turnId: "unreachable",
      status: "completed" as const,
    }));
    const harness = new CodexBasicHarness(context("auto"), { runAppServerTurn });

    await expect(harness.complete(runContext(1, "token")))
      .rejects.toThrow("codex.basic requires an explicit managed Codex executable");

    expect(runAppServerTurn).not.toHaveBeenCalled();
  });

  it("can resolve an explicit managed runtime lazily for internal Eval", async () => {
    const runAppServerTurn = vi.fn(async (options: CodexAppServerTurnOptions) => {
      options.onThreadId("eval-thread");
      return { threadId: "eval-thread", turnId: "turn-1", status: "completed" as const };
    });
    const resolveCodexRuntime = vi.fn(async () => ({
      executable: "/managed/eval/codex",
      environment: { PATH: "/managed/eval/codex-path:/usr/bin" },
    }));
    const harness = new CodexBasicHarness(context("auto"), { runAppServerTurn, resolveCodexRuntime });

    await harness.complete(runContext(1, "token"));

    expect(resolveCodexRuntime).toHaveBeenCalledOnce();
    expect(runAppServerTurn).toHaveBeenCalledWith(expect.objectContaining({
      codexPathOverride: "/managed/eval/codex",
      environment: expect.objectContaining({ PATH: "/managed/eval/codex-path:/usr/bin" }),
    }));
  });

  it("does not retain a force-shutdown controller when lazy executable resolution fails", async () => {
    const harness = new CodexBasicHarness(context("auto"), {
      resolveCodexRuntime: async () => { throw new Error("managed runtime unavailable"); },
    });

    await expect(harness.complete(runContext(1, "token"))).rejects.toThrow("managed runtime unavailable");

    expect((harness as unknown as { activeForceShutdowns: Set<AbortController> }).activeForceShutdowns.size).toBe(0);
  });

  it("force-disposes the active provider turn exactly once", async () => {
    let submitted: CodexAppServerTurnOptions | undefined;
    const harness = harnessFixture("auto", (options) => {
      submitted = options;
      return new Promise((_resolve, reject) => {
        options.forceSignal?.addEventListener("abort", () => reject(options.forceSignal?.reason), { once: true });
      });
    });

    const completing = harness.complete(runContext(1, "token"));
    await vi.waitFor(() => expect(submitted).toBeDefined());
    harness.forceShutdown();
    harness.forceShutdown();

    await expect(completing).rejects.toThrow("force-disposed");
    expect(submitted?.forceSignal?.aborted).toBe(true);
  });

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

  it("rejects non-absolute browser MCP launch paths before starting Codex", () => {
    expect(() => new CodexBasicHarness(context("ask"), {
      browserMcpRuntime: { ...browserMcpRuntime, script: "node_modules/chrome-devtools-mcp.js" },
    })).toThrow("requires absolute executable and script paths");
  });

  it("rejects an empty browser MCP attachment route before starting Codex", () => {
    expect(() => new CodexBasicHarness(context("ask"), {
      browserMcpRuntime: { ...browserMcpRuntime, connectionArgs: [] },
    })).toThrow("requires non-empty connection arguments");
  });

  it("retains a provider thread ID when the first app-server turn fails", async () => {
    let submitted: CodexAppServerTurnOptions | undefined;
    const harness = harnessFixture("auto", async (options) => {
      submitted = options;
      options.onThreadId("codex-thread-after-start");
      throw new Error("turn failed");
    });

    await expect(harness.complete(runContext(1, "token"))).rejects.toThrow("turn failed");

    expect(harness.state()).toEqual({
      codexThreadId: "codex-thread-after-start",
      codexThreadPersonalPresentationVersionId: null,
    });
    expect(submitted?.prompt).toContain("Relayer graph affordances:");
    expect(submitted?.prompt).toContain("Each layer should explain its scope as a coherent whole");
    expect(submitted?.prompt).toContain('Choose "expand" when another layer should deepen one part');
    expect(submitted?.prompt).toContain('Choose "reference" for supporting evidence or reusable context');
    expect(submitted?.prompt).toContain("A layer reached as a reference may author only further reference actions");
    expect(submitted?.prompt).toContain('Choose "invoke" when the useful next step requires a new agent interaction');
    expect(submitted?.prompt).toContain('choosing "stop" means leaving the node without a further action');
    expect(submitted?.prompt).toContain("It is not GraphComplete's stopped lifecycle state");
    expect(submitted?.prompt).toContain("does not stop the interaction");
    expect(submitted?.prompt).toContain("pass the program through standard input");
    expect(submitted?.prompt).toContain("never place authored graph code in a --eval argument");
    expect(submitted?.prompt).toContain("do not create a script in either the project checkout or a temporary directory");
    expect(submitted?.prompt).toContain('kind: "navigate", relation: "expand", label: "Response"');
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
      developerInstructions: null,
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

  it("pins the minimal-environment graph-authoring launcher in every authoring prompt", async () => {
    vi.stubEnv("RELAYER_GRAPH_AUTHORING_NODE", "/stale/raw/node");
    try {
      for (const promptProfile of [undefined, "layered-navigation-v1"] as const) {
        let submittedPrompt = "";
        let submittedEnvironment: Record<string, string> = {};
        const harness = new CodexBasicHarness({
          ...context("auto"),
          configuration: {
            ...codexBasicConfiguration,
            settings: { ...codexBasicConfiguration.settings, ...(promptProfile ? { promptProfile } : {}) },
          },
        }, {
          codexPathOverride: "/managed/codex",
          graphAuthoringLauncherPath: "/immutable/runtime/graph-authoring-launcher",
          runAppServerTurn: async (options) => {
            submittedPrompt = options.prompt;
            submittedEnvironment = options.environment;
            options.onThreadId("codex-thread");
            return { threadId: "codex-thread", turnId: "turn-1", status: "completed" };
          },
        });

        await harness.complete(runContext(1, "token"));

        expect(submittedPrompt).toContain('Run exactly "/immutable/runtime/graph-authoring-launcher" with no arguments');
        expect(submittedPrompt).toContain("including the displayed double quotes");
        expect(submittedPrompt).toContain("shell-native single-quoted here-document");
        expect(submittedPrompt).toContain("delimited by exactly RELAYER_GRAPH_PROGRAM");
        expect(submittedPrompt).toContain("do not resolve the launcher or Node.js from PATH");
        expect(submittedPrompt).toContain("Request Codex sandbox escalation for this exact launcher command");
        expect(submittedPrompt).toContain("applies its own narrower graph sandbox");
        expect(submittedPrompt).toContain("the launcher heredoc is the only permitted shell action");
        expect(submittedPrompt).toContain("Do not run sed, rg, cat, find, or any other inspection command");
        expect(submittedPrompt).toContain("This restriction applies only to the graph-authoring path");
        expect(submittedPrompt).toContain("ordinary Codex workspace tools under the configured permission policy");
        expect(submittedPrompt).toContain("LayerLayoutObject accepts exactly one argument: the placements array");
        expect(submittedPrompt).toContain("never assign layout.version");
        expect(submittedEnvironment.RELAYER_GRAPH_AUTHORING_NODE).toBeUndefined();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a shell-active graph-authoring launcher path", async () => {
    const harness = new CodexBasicHarness(context("auto"), {
      codexPathOverride: "/managed/codex",
      graphAuthoringLauncherPath: "/immutable/runtime/$(touch marker)",
      runAppServerTurn: async () => ({ threadId: "unused", turnId: "unused", status: "completed" }),
    });
    await expect(harness.complete(runContext(1, "token"))).rejects.toThrow("launcher must be a shell-safe absolute path");
  });

  it("allows the default graph-authoring Node executable to resolve from PATH", async () => {
    for (const promptProfile of [undefined, "layered-navigation-v1"] as const) {
      let submittedPrompt = "";
      let submittedEnvironment: Record<string, string> = {};
      const harness = new CodexBasicHarness({
        ...context("auto"),
        configuration: {
          ...codexBasicConfiguration,
          settings: { ...codexBasicConfiguration.settings, ...(promptProfile ? { promptProfile } : {}) },
        },
      }, {
        codexPathOverride: "/managed/codex",
        runAppServerTurn: async (options) => {
          submittedPrompt = options.prompt;
          submittedEnvironment = options.environment;
          options.onThreadId("codex-thread");
          return { threadId: "codex-thread", turnId: "turn-1", status: "completed" };
        },
      });

      await harness.complete(runContext(1, "token"));

      expect(submittedPrompt).toContain("Run exactly node --input-type=module");
      expect(submittedPrompt).toContain("delimited by exactly RELAYER_GRAPH_PROGRAM");
      expect(submittedPrompt).toContain("do not create a script in either the project checkout or a temporary directory");
      expect(submittedPrompt).not.toContain("do not resolve Node.js from PATH");
      expect(submittedEnvironment).not.toHaveProperty("RELAYER_GRAPH_AUTHORING_NODE");
    }
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
    }, { codexPathOverride: "/managed/codex", runAppServerTurn: async (options) => {
      submittedPrompt = options.prompt;
      options.onThreadId("layered-thread");
      return { threadId: "layered-thread", turnId: "turn-1", status: "completed" };
    } });

    await harness.complete(runContext(1, "token"));

    expect(submittedPrompt).toContain('"expand" continues the explanation');
    expect(submittedPrompt).toContain('"reference" opens supporting evidence');
    expect(submittedPrompt).toContain("Each layer should explain its scope as a coherent whole");
    expect(submittedPrompt).toContain('choosing "stop" means leaving the node without a further action');
    expect(submittedPrompt).toContain("It is not GraphComplete's stopped lifecycle state");
    expect(submittedPrompt).toContain("Complete the underlying user task in the working directory");
    expect(submittedPrompt).toContain("Use the harness's ordinary workspace tools and reasoning as needed");
    expect(submittedPrompt).toContain("the graph is the presentation of the work, not a substitute for doing it");
    expect(submittedPrompt).toContain("does not by itself complete the underlying user task");
    expect(submittedPrompt).toContain("Do not submit a plan as though it were completed work");
    expect(submittedPrompt).toContain("verify that requested workspace effects have actually occurred");
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
    expect(submittedPrompt).not.toContain("native delegation");
    expect(submittedPrompt).not.toContain("Codex native subagents");
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
    }, { codexPathOverride: "/managed/codex", runAppServerTurn: async (options) => {
      prompts.push(options.prompt);
      options.onThreadId("layered-thread");
      return { threadId: "layered-thread", turnId: "turn-1", status: "completed" };
    } });

    await createHarness("layered-navigation-v1").complete(runContext(1, "token"));
    await createHarness("layered-navigation-multi-agent-v1").complete(runContext(1, "token"));

    const delegationGuidance = "Codex native subagents are available when useful. Subagents may directly author, revise, and submit graph objects using the available graph capability. Use the configured model family as appropriate; coordination remains native to Codex.";
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("native delegation");
    expect(prompts[0]).not.toContain("Codex native subagents");
    expect(prompts[1]).toBe(`${prompts[0]}\n\n${delegationGuidance}`);
  });

  it("delivers ordered normalized context and child re-read guidance without occurrence authority", async () => {
    let prompt = "";
    const harness = harnessFixture("auto", async (options) => {
      prompt = options.prompt;
      options.onThreadId("context-thread");
      return { threadId: "context-thread", turnId: "turn-1", status: "completed" };
    });

    await harness.complete(attachedRunContext(1, "token"));

    expect(prompt).toContain('"message": "Question"');
    expect(prompt.indexOf('"title": "First target"')).toBeLessThan(prompt.indexOf('"title": "Second target"'));
    expect(prompt.indexOf('"first annotation"')).toBeLessThan(prompt.indexOf('"second annotation"'));
    expect(prompt).toContain("product assigns no semantic precedence");
    expect(prompt).toContain("including in native child agents");
    expect(prompt).toContain("graph.getInteractionInput()");
    expect(prompt).not.toContain("sourceNodeId");
    expect(prompt).not.toContain("sourceLayerId");
  });

  it("teaches capability-scoped bounded search and typed references through executable JavaScript", () => {
    const disabledPrompt = buildLayeredNavigationPrompt(runContext(1, "token"), "@relayer/graph-client");
    const prompt = buildLayeredNavigationPrompt(runContext(1, "token"), "@relayer/graph-client", undefined, true, true);
    const searchGuidance = prompt.slice(
      prompt.indexOf("Graph search is available"),
      prompt.indexOf("Navigation has two meanings:"),
    );

    expect(disabledPrompt).not.toContain("Graph search is available");
    expect(disabledPrompt).not.toContain("await graph.search(request, options)");
    expect(searchGuidance).toContain("await graph.search(request, options)");
    expect(searchGuidance).toContain("It is not a provider-native tool or MCP function");
    expect(searchGuidance).toContain("queryContractVersion: 1");
    expect(searchGuidance).toContain("whole-target Content or Layer scans");
    expect(searchGuidance).toContain("one- or two-relationship MATCH patterns");
    expect(searchGuidance).toContain("parameters: { anchor: { type: \"string\", value: \"Queue\" }, count: { type: \"integer\", value: \"2\" } }");
    expect(searchGuidance).toContain("at most 5 rows");
    expect(searchGuidance).toContain("hard maximum of 8");
    expect(searchGuidance).toContain("bounded to 16 KiB");
    expect(searchGuidance).toContain("GraphQueryError values with stable status, code, phase, and path fields");
    expect(searchGuidance).toContain("never on message text");
    expect(searchGuidance).toContain("priorLayer?.type !== \"layer\"");
    expect(searchGuidance).toContain("target: priorLayerId");
    expect(searchGuidance).toContain("let graph.addAction revalidate visibility");
    expect(searchGuidance).not.toMatch(/graph\.search\(\{[^}]*\b(?:target|thread|project|scope|permit|credential|database)\s*:/s);
  });

  it("uses the picker-selected root model and native delegation in the product configuration", async () => {
    const configuration = await loadHarnessConfiguration(join(repositoryRoot, "harnesses/codex-basic.yaml"));
    let submitted: CodexAppServerTurnOptions | undefined;
    const harness = new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "auto",
      permissionBinding: configuration.permissionBindings.auto!,
      workingDirectory: repositoryRoot,
      configuration,
    }, { codexPathOverride: "/managed/codex", runAppServerTurn: async (options) => {
      submitted = options;
      options.onThreadId("selected-model-thread");
      return { threadId: "selected-model-thread", turnId: "turn-1", status: "completed" };
    } });

    await harness.complete({
      ...runContext(1, "token"),
      model: { providerId: "codex", adapterId: "codex-subscription", modelId: "gpt-picker-selected" },
      access: codexAccess(),
    });

    expect(submitted?.threadParams).toMatchObject({ model: "gpt-picker-selected" });
    expect(submitted?.turnParams).toMatchObject({ model: "gpt-picker-selected", effort: "medium" });
    expect(submitted?.prompt).toContain("Codex native subagents are available when useful");
    expect(configuration.settings).not.toHaveProperty("model");
    expect(configuration.modelCompatibility?.[0]).not.toHaveProperty("preferredModelId");
  });

  it.each(["codex-basic", "codex-basic-high"])("leaves browser MCP approval routing to each %s product profile", async (name) => {
    const configuration = await loadHarnessConfiguration(join(repositoryRoot, `harnesses/${name}.yaml`));
    expect(Object.keys(configuration.permissionBindings)).toEqual(["ask", "auto", "full"]);
    const cases = [
      ["ask", { approvalPolicy: "on-request", approvalsReviewer: "user" }],
      ["auto", { approvalPolicy: "on-request", approvalsReviewer: "auto_review" }],
      ["full", { approvalPolicy: "never" }],
    ] as const;
    for (const [permissionProfileId, nativeApproval] of cases) {
      let submitted: CodexAppServerTurnOptions | undefined;
      const harness = new CodexBasicHarness({
        threadId: 1,
        permissionProfileId,
        permissionBinding: configuration.permissionBindings[permissionProfileId]!,
        workingDirectory: repositoryRoot,
        configuration,
      }, {
        browserMcpRuntime,
        codexPathOverride: "/managed/codex",
        runAppServerTurn: async (options) => {
          submitted = options;
          options.onThreadId("browser-thread");
          return { threadId: "browser-thread", turnId: "turn-1", status: "completed" };
        },
      });

      await harness.complete({ ...runContext(1, "token"), access: codexAccess() });

      expect(submitted?.threadParams).toMatchObject(nativeApproval);
      if (permissionProfileId === "full") {
        expect(submitted?.threadParams).not.toHaveProperty("approvalsReviewer");
      }
      expect(submitted?.threadParams.config).toEqual({
        skip_git_repo_check: true,
        features: { tool_call_mcp_elicitation: false },
        mcp_servers: {
          "chrome-devtools": {
            command: browserMcpRuntime.executable,
            args: [browserMcpRuntime.script, ...browserMcpRuntime.connectionArgs],
            env: { ELECTRON_RUN_AS_NODE: "1" },
            enabled: true,
            required: false,
            startup_timeout_sec: 20,
            tool_timeout_sec: 20,
            default_tools_approval_mode: "prompt",
          },
        },
      });
    }
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

    await harness.complete({ ...runContext(1, "first-token"), model: { providerId: "codex", modelId: "gpt-first" }, access: codexAccess() });
    await harness.complete({ ...runContext(2, "second-token"), model: { providerId: "codex", modelId: "gpt-second" }, access: codexAccess() });

    expect(submissions.map(({ environment, savedThreadId }) => [environment.RELAYER_GRAPH_TOKEN, environment.RELAYER_NODE_ID, savedThreadId])).toEqual([
      ["first-token", "1", undefined],
      ["second-token", "2", "codex-thread-1"],
    ]);
    expect(submissions.map(({ threadParams, turnParams }) => [threadParams.model, turnParams.model])).toEqual([
      ["gpt-first", "gpt-first"],
      ["gpt-second", "gpt-second"],
    ]);
    expect(harness.state()).toEqual({
      codexThreadId: "codex-thread-1",
      codexThreadPersonalPresentationVersionId: null,
    });
  });

  it("passes only the selected execution-scoped provider secret to Codex", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-anthropic-secret");
    vi.stubEnv("CODEX_HOME", "/ambient/codex-home");
    let submitted: CodexAppServerTurnOptions | undefined;
    try {
      const harness = harnessFixture("auto", async (options) => {
        submitted = options;
        options.onThreadId("api-thread");
        return { threadId: "api-thread", turnId: "turn-1", status: "completed" };
      });
      await harness.complete({
        ...runContext(1, "token"),
        model: { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" },
        access: {
          kind: "secret", contract: "secret@1", providerId: "openai-work", adapterId: "openai-api",
          adapterImplementationVersion: "1", endpoint: "https://api.openai.test/v1", fields: { "api-key": "selected-secret" },
        },
      });

      expect(submitted?.environment.OPENAI_API_KEY).toBe("selected-secret");
      expect(submitted?.environment.OPENAI_BASE_URL).toBe("https://api.openai.test/v1");
      expect(submitted?.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(submitted?.environment).not.toHaveProperty("CODEX_HOME");
      expect(submitted?.threadParams).toMatchObject({
        modelProvider: "relayer_execution_provider",
        config: {
          model_providers: {
            relayer_execution_provider: {
              name: "Relayer execution provider",
              base_url: "https://api.openai.test/v1",
              env_key: "OPENAI_API_KEY",
              wire_api: "responses",
              requires_openai_auth: false,
              supports_websockets: false,
            },
          },
        },
      });
      expect(JSON.stringify(submitted?.threadParams)).not.toContain("selected-secret");
      expect(submitted?.codexConfigOverrides).toEqual([
        'model_provider="relayer_execution_provider"',
        'model_providers.relayer_execution_provider.name="Relayer execution provider"',
        'model_providers.relayer_execution_provider.base_url="https://api.openai.test/v1"',
        'model_providers.relayer_execution_provider.env_key="OPENAI_API_KEY"',
        'model_providers.relayer_execution_provider.wire_api="responses"',
        "model_providers.relayer_execution_provider.requires_openai_auth=false",
        "model_providers.relayer_execution_provider.supports_websockets=false",
        'shell_environment_policy.inherit="all"',
        "shell_environment_policy.ignore_default_excludes=true",
        'shell_environment_policy.filters.OPENAI_API_KEY="exclude"',
        'shell_environment_policy.filters.OPENAI_BASE_URL="exclude"',
      ]);
      expect(JSON.stringify(submitted?.codexConfigOverrides)).not.toContain("selected-secret");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["openrouter", "vercel-ai-router"])("rejects %s before starting Codex", async (adapterId) => {
    const runAppServerTurn = vi.fn();
    const harness = harnessFixture("auto", runAppServerTurn);

    await expect(harness.complete({
      ...runContext(1, "token"),
      model: {
        providerId: `${adapterId}-provider`,
        adapterId,
        modelId: "provider/model",
      },
      access: {
        kind: "secret",
        contract: "secret@1",
        providerId: `${adapterId}-provider`,
        adapterId,
        adapterImplementationVersion: "1",
        endpoint: "https://provider.test/v1",
        fields: { "api-key": "selected-secret" },
      },
    })).rejects.toThrow(`codex.basic cannot run provider adapter ${adapterId}`);

    expect(runAppServerTurn).not.toHaveBeenCalled();
  });

  it("uses the managed Codex runtime attached to secret provider access", async () => {
    let submitted: CodexAppServerTurnOptions | undefined;
    const harness = new CodexBasicHarness(context("auto"), {
      runAppServerTurn: async (options) => {
        submitted = options;
        options.onThreadId("api-thread");
        return { threadId: "api-thread", turnId: "turn-1", status: "completed" };
      },
    });

    await harness.complete({
      ...runContext(1, "token"),
      model: { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" },
      access: {
        kind: "secret", contract: "secret@1", providerId: "openai-work", adapterId: "openai-api",
        adapterImplementationVersion: "1", endpoint: "https://api.openai.test/v1", fields: { "api-key": "selected-secret" },
        runtime: {
          runtimeId: "codex", version: "0.147.0", executable: "/managed/codex",
          environment: { CODEX_HOME: "/isolated/codex-home", RELAYER_CODEX_BINARY: "/managed/codex" },
        },
      },
    });

    expect(submitted?.codexPathOverride).toBe("/managed/codex");
    expect(submitted?.environment.CODEX_HOME).toBe("/isolated/codex-home");
  });

  it("allows only Codex runtime keys from managed access and preserves graph authority", async () => {
    let submitted: CodexAppServerTurnOptions | undefined;
    const harness = harnessFixture("auto", async (options) => {
      submitted = options;
      options.onThreadId("managed-thread");
      return { threadId: "managed-thread", turnId: "turn-1", status: "completed" };
    });
    await harness.complete({
      ...runContext(1, "authoritative-graph-token"),
      model: { providerId: "codex", adapterId: "codex-subscription", modelId: "gpt-5.2" },
      access: {
        ...codexAccess(),
        environment: {
          CODEX_HOME: "/isolated/codex-home",
          OPENAI_API_KEY: "injected-unrelated-secret",
          RELAYER_GRAPH_TOKEN: "injected-graph-token",
          RELAYER_GRAPH_URL: "https://attacker.invalid",
        },
      },
    });

    expect(submitted?.environment.CODEX_HOME).toBe("/isolated/codex-home");
    expect(submitted?.environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(submitted?.environment.RELAYER_GRAPH_TOKEN).toBe("authoritative-graph-token");
    expect(submitted?.environment.RELAYER_GRAPH_URL).toBe("http://127.0.0.1:43123");
  });

  it("rejects a provider model that codex.basic cannot execute before starting a thread", async () => {
    const runAppServerTurn = vi.fn<NonNullable<CodexBasicDependencies["runAppServerTurn"]>>();
    const harness = new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "auto",
      permissionBinding: codexBasicConfiguration.permissionBindings.auto!,
      workingDirectory: process.cwd(),
      configuration: codexBasicConfiguration,
    }, { codexPathOverride: "/managed/codex", runAppServerTurn });

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

  it("redacts propagated personal presentation guidance from Codex collaboration traces", async () => {
    const trace = recordingTrace();
    const preferenceDetail = "The user prefers central layers that are immediately decision-useful. Never repeat OPENAI_API_KEY=secret.";
    const rendered = `Personal graph presentation preferences:\n\nDecision-useful center: ${preferenceDetail}`;
    const harness = harnessFixture("auto", async (options) => {
      options.onThreadId("streamed-thread");
      options.onNotification?.("item/started", { item: {
        id: "graph-child",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        prompt: `Author graph content.\n\n${rendered}`,
      } });
      options.onNotification?.("item/started", { item: {
        id: "research-child",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        prompt: "Research the implementation without authoring graph content.",
      } });
      options.onNotification?.("item/completed", { item: {
        id: "partial-echo",
        type: "agentMessage",
        text: `Applied Decision-useful center. ${preferenceDetail}`,
      } });
      options.onNotification?.("item/completed", { item: {
        id: "unrelated-command",
        type: "commandExecution",
        aggregatedOutput: "Decision-useful center",
      } });
      options.onNotification?.("item/started", { item: {
        id: "graph-command",
        type: "commandExecution",
        command: "node --input-type=module <<'RELAYER_GRAPH_PROGRAM'\n// Decision-useful center\nawait graph.submit(1);\nRELAYER_GRAPH_PROGRAM",
        aggregatedOutput: "Decision-useful center",
      } });
      options.onNotification?.("item/started", { item: {
        id: "unrelated-node-heredoc",
        type: "commandExecution",
        command: "node --input-type=module <<'NODE'\nconsole.log('Decision-useful center')\nNODE",
        aggregatedOutput: "Decision-useful center",
      } });
      options.onNotification?.("item/agentMessage/delta", {
        itemId: "agent-delta",
        delta: "Decision-useful center",
      });
      options.onNotification?.("item/commandExecution/outputDelta", {
        itemId: "graph-command",
        delta: "Decision-useful center",
      });
      return { threadId: "streamed-thread", turnId: "turn-1", status: "completed" };
    });
    const baseContext = personalPresentationRunContext(true);
    const presentation = baseContext.personalPresentation!;
    const firstLayer = presentation.graph.layers[0]!;
    const firstNode = firstLayer.nodes[0]!;
    const context: HarnessRunContext = {
      ...baseContext,
      personalPresentation: {
        ...presentation,
        graph: {
          ...presentation.graph,
          layers: [{
            ...firstLayer,
            nodes: [{
              ...firstNode,
              title: ` ${firstNode.title} `,
              detail: ` ${preferenceDetail} `,
            }],
          }],
        },
      },
    };

    await harness.complete({ ...context, trace: trace.sink });

    const echoEvents = trace.events.filter((event) => !["unrelated-command", "unrelated-node-heredoc"].includes(event.providerEventId ?? ""));
    const serializedEchoes = JSON.stringify(echoEvents);
    expect(serializedEchoes).not.toContain("Decision-useful center");
    expect(serializedEchoes).not.toContain("The user prefers central layers that are immediately decision-useful.");
    expect(serializedEchoes).not.toContain("OPENAI_API_KEY");
    expect(serializedEchoes.match(/\[redacted-personal-presentation\]/g)?.length).toBeGreaterThanOrEqual(3);
    const unrelatedCommand = trace.events.find((event) => event.type === "provider.event"
      && event.providerEventId === "unrelated-command");
    expect(JSON.stringify(unrelatedCommand?.data)).toContain("Decision-useful center");
    const unrelatedNodeHeredoc = trace.events.find((event) => event.type === "provider.event"
      && event.providerEventId === "unrelated-node-heredoc");
    expect(JSON.stringify(unrelatedNodeHeredoc?.data)).toContain("Decision-useful center");
    const agentDelta = trace.events.find((event) => event.type === "provider.event"
      && event.data.method === "item/agentMessage/delta");
    expect(JSON.stringify(agentDelta?.data)).toContain("[redacted-personal-presentation]");
    expect(JSON.stringify(agentDelta?.data)).not.toContain("Decision-useful center");
    const commandDelta = trace.events.find((event) => event.type === "provider.event"
      && event.data.method === "item/commandExecution/outputDelta");
    expect(JSON.stringify(commandDelta?.data)).toContain("[redacted-personal-presentation]");
    expect(JSON.stringify(commandDelta?.data)).not.toContain("Decision-useful center");
    const graphChild = trace.events.find((event) => event.type === "tool.call.started"
      && event.data.providerItemId === "graph-child");
    expect(graphChild?.data.delegationPrompt).toContain("[redacted-personal-presentation]");
    const researchChild = trace.events.find((event) => event.type === "tool.call.started"
      && event.data.providerItemId === "research-child");
    expect(researchChild?.data.delegationPrompt).toBe("Research the implementation without authoring graph content.");
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

  it("binds redacted command actions to the exact pre-redaction absolute executable", async () => {
    const trace = recordingTrace();
    const executable = "/private/var/folders/xy/private-token/T/runtime-snapshot/rg";
    const command = `${executable} -n needle /private/var/folders/xy/private-token/T/runtime-snapshot/graph-client`;
    const harness = harnessFixture("auto", async (options) => {
      options.onThreadId("streamed-thread");
      options.onNotification?.("item/started", { item: {
        id: "inspection-1",
        type: "commandExecution",
        command,
        commandActions: [{ command, relayerExecutableAuthoritySha256: "provider-forged", relayerCommandWordAuthoritySha256: ["provider-forged"] }],
      } });
      options.onNotification?.("item/completed", { item: {
        id: "inspection-1",
        type: "commandExecution",
        command,
        commandActions: [{ command }],
      } });
      return { threadId: "streamed-thread", turnId: "turn-1", status: "completed" };
    });

    await expect(harness.complete(runContext(1, "token", trace.sink))).resolves.toBeUndefined();

    const events = trace.events.filter((candidate) => candidate.type === "provider.event");
    expect(events).toHaveLength(2);
    for (const event of events) {
      const params = event.data.params as Record<string, unknown>;
      const item = params.item as Record<string, unknown>;
      const [action] = item.commandActions as Array<Record<string, unknown>>;
      expect(action?.command).toBe("/private/var/folders/[redacted]/T/runtime-snapshot/rg -n needle /private/var/folders/[redacted]/T/runtime-snapshot/graph-client");
      expect(action?.relayerExecutableAuthoritySha256).toBe(createHash("sha256").update(executable).digest("hex"));
      expect(action?.relayerCommandWordAuthoritySha256).toEqual(command.split(" ").map((word) => (
        word.startsWith("/") ? createHash("sha256").update(word).digest("hex") : null
      )));
      expect(JSON.stringify(event)).not.toContain("private-token");
      expect(JSON.stringify(event)).not.toContain("provider-forged");
    }
  });

  it.each(["quoted", "unquoted"])("binds the %s graph-authoring launcher before trace redaction", async (form) => {
    const trace = recordingTrace();
    const launcher = "/private/var/folders/xy/private-token/T/runtime-snapshot/graph-authoring-launcher";
    const command = `${form === "quoted" ? JSON.stringify(launcher) : launcher} <<'EOF'\nawait graph.submit(1);\nEOF`;
    const harness = harnessFixture("auto", async (options) => {
      options.onThreadId("streamed-thread");
      options.onNotification?.("item/started", { item: {
        id: "graph-1",
        type: "commandExecution",
        command,
        commandActions: [{ command, relayerGraphAuthoringLauncherSha256: "provider-forged" }],
      } });
      return { threadId: "streamed-thread", turnId: "turn-1", status: "completed" };
    });

    await harness.complete(runContext(1, "token", trace.sink));
    const event = trace.events.find((candidate) => candidate.type === "provider.event");
    const item = (event?.data.params as Record<string, unknown>).item as Record<string, unknown>;
    const [action] = item.commandActions as Array<Record<string, unknown>>;
    expect(action?.relayerGraphAuthoringLauncherSha256).toBe(createHash("sha256").update(launcher).digest("hex"));
    expect(JSON.stringify(event)).not.toContain("private-token");
    expect(JSON.stringify(event)).not.toContain("provider-forged");
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
  return new CodexBasicHarness(context(permissionProfileId), {
    codexPathOverride: "/managed/codex",
    runAppServerTurn,
  });
}

function runContext(id: number, token: string, trace: HarnessTraceSink = createNoopHarnessTraceSink()): HarnessRunContext {
  const inputGraph = { id, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" as const };
  return {
    inputGraph,
    interactionInput: { interaction: inputGraph, contexts: [] },
    graph: {
      interactionNodeId: id,
      acquireCapability: () => ({ url: "http://127.0.0.1:43123", token, nodeId: id }),
    },
    trace,
    approvals: { request: async () => { throw new Error("unused approval channel"); } },
  };
}

function personalPresentationRunContext(preference: boolean): HarnessRunContext {
  const context = runContext(1, "token");
  const versionInteractionNodeId = preference ? 90 : 100;
  const rootLayerId = versionInteractionNodeId + 1;
  return {
    ...context,
    personalPresentation: {
      attachment: { interactionNodeId: 1, versionInteractionNodeId, rootLayerId },
      graph: {
        nodeId: versionInteractionNodeId,
        rootLayerId,
        rootAction: { id: rootLayerId + 1, sourceNodeId: versionInteractionNodeId, kind: "navigate", relation: "expand", label: "Personal presentation", variant: "pill", targetLayerId: rootLayerId, state: "accepted" },
        layers: [{
          layer: { id: rootLayerId, nodes: [rootLayerId + 2], edges: [], state: "accepted" },
          nodes: [{
            id: rootLayerId + 2,
            kind: preference ? "presentation-preference" : "personal-presentation-manifest",
            icon: preference ? "compass" : "settings",
            title: preference ? "Decision-useful center" : "Neutral personal presentation",
            detail: preference ? "The user prefers central layers that are immediately decision-useful." : "No additional guidance.",
            state: "accepted",
          }],
          edges: [],
          actions: [],
        }],
      },
    },
  };
}

function codexAccess() {
  return {
    kind: "managed-runtime" as const,
    contract: "managed-runtime@1" as const,
    providerId: "codex",
    adapterId: "codex-subscription",
    adapterImplementationVersion: "1",
    runtimeId: "codex",
    version: "0.147.0",
    executable: "/managed/codex",
    environment: {},
  };
}

function attachedRunContext(id: number, token: string): HarnessRunContext {
  const context = runContext(id, token);
  return {
    ...context,
    interactionInput: {
      interaction: context.inputGraph,
      contexts: [
        {
          type: "interaction.context",
          targetNode: { id: 20, kind: "concept", icon: "box", title: "First target", detail: "First detail", state: "accepted" },
          annotations: ["first annotation", "second annotation"],
        },
        {
          type: "interaction.context",
          targetNode: { id: 21, kind: "concept", icon: "box", title: "Second target", detail: "Second detail", state: "accepted" },
          annotations: ["third annotation"],
        },
      ],
    },
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
