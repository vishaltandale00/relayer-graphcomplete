import { describe, expect, it, vi } from "vitest";
import type { ThreadItem } from "@openai/codex-sdk";
import type { ReviewSessionController } from "../src/simulated-user/mcp-server.js";
import {
  SIMULATED_USER_MCP_SERVER_NAME,
  SIMULATED_USER_MCP_TOKEN_ENV,
} from "../src/simulated-user/mcp-server.js";
import {
  assertReviewOnlyCodexTrace,
  buildRecursivePresentationJudgePrompt,
  buildSimulatedUserJudgePrompt,
  runSimulatedUserJudge,
  sanitizeJudgeEnvironment,
  type JudgeThreadResult,
  type JudgeThreadFactory,
  type JudgeThreadStartRequest,
} from "../src/simulated-user/judge-runner.js";
import { inventoryReviewSubjects } from "../src/simulated-user/inventory.js";
import {
  GRAPH_PRESENTATION_RUBRIC_V10,
  GRAPH_PRESENTATION_RUBRIC_V11,
  SIMULATED_USER_RUBRIC_V1,
} from "../src/simulated-user/rubric.js";
import { IncrementalReviewStore } from "../src/simulated-user/review-store.js";
import { RecursivePresentationReviewStore } from "../src/simulated-user/recursive-review.js";
import type { LayerReview, NodeReview, TurnReview } from "../src/simulated-user/contracts.js";

describe("simulated-user Codex judge runner", () => {
  it("builds rubric-driven judge prompts for legacy, recursive, and judge-only reruns", () => {
    const inputInventory = inventoryReviewSubjects({
      turnId: "turn-input",
      rootLayerId: "layer-input",
      layers: [{
        id: "layer-input",
        nodeIds: ["node-input"],
        actions: [{
          id: "action-input",
          sourceNodeId: "node-input",
          kind: "input",
          control: "text",
          prompt: "What deployment window should we use?",
          options: [],
        }],
      }],
    });

    const legacyPrompt = buildSimulatedUserJudgePrompt("Prepare the deployment.", SIMULATED_USER_RUBRIC_V1, inputInventory);
    expect(legacyPrompt, "legacy judges are guided through required input-action coverage").toContain("every visible navigate, invoke, or input action");
    expect(legacyPrompt, "legacy judges name the input-action quality criteria").toContain("prompt answerability, option-set quality, and control fit");
    expect(legacyPrompt, "legacy judges see the structure.input disclosure").toContain("structure.input");

    const flatInventory = inventoryReviewSubjects({
      turnId: "turn-1",
      rootLayerId: "layer-1",
      layers: [{ id: "layer-1", nodeIds: ["node-1"], actions: [] }],
    });
    const recursivePrompt = buildRecursivePresentationJudgePrompt(
      "Explain the completed repair.",
      GRAPH_PRESENTATION_RUBRIC_V11,
      flatInventory,
      undefined,
      true,
    );

    const required = [
      "A flat graph does not escape recursive judgment",
      "missingActionOpportunity",
      "distinct unanswered user question",
      "Generic requests for more detail",
      "caps final recursive_coherence, navigation_value, and presentation_quality at 6",
      "Read-only shell and filesystem inspection are available",
      "what would a user reasonably want to inspect next",
      "what would a user reasonably want to do next",
      "Do not impose a minimum number of actions",
      "a visually arbitrary row, line, ring, or hub",
      "Embedded screenshots and image banners are not currently supported",
      "This is the human-experience judge, not the function or task-outcome judge",
      "can neither earn nor remove human-experience credit",
      "deserves little relationship_clarity credit",
      "Never lower the ceiling for artifact defects",
      "Score polish as a separate basic rendered-integrity dimension",
      "A default renderer may be polished while the graph remains semantically weak",
      "Never use polish to raise or offset content",
      "erase polish-only observations from the evidence",
      "A clean textual handoff split across static cards earns no semantic or interactive credit merely for polish",
      "Do not treat adjacency or reading order as relational evidence",
      "Two or more material missing opportunities cap all three at 4",
      "expand, reference, invoke, input, and stop",
      "before any answer is committed",
      "input-action-<presentingInteractionNodeId>-<presentingLayerId>-<actionId>",
      "never end the turn immediately after reviewNode",
      "asking for what the artifact already states",
      "asking to dodge a judgment the node should have made",
      "fragmenting one decision into a separate question per node",
      "Necessity is an allocation counterweight, not an input-action quality score",
      "single-select choices are mutually exclusive",
      "multi-select choices are distinct and non-overlapping",
    ] as const;
    const forbidden = [
      "`input-action-<actionId>`",
      "Shell, filesystem, web, network, graph mutation, and invoke execution are unavailable",
    ] as const;
    for (const phrase of required) {
      expect.soft(recursivePrompt, `recursive prompt requires first-class artifact-grounded findings: ${phrase}`).toContain(phrase);
    }
    for (const phrase of forbidden) {
      expect.soft(recursivePrompt, `recursive prompt must not contain: ${phrase}`).not.toContain(phrase);
    }
    expect(
      GRAPH_PRESENTATION_RUBRIC_V11.subjects.input_action.criteria.option_set_quality.description,
      "the option-set quality criterion pins single-select exclusivity",
    ).toContain("Single-select options should be mutually exclusive");
    expect(
      GRAPH_PRESENTATION_RUBRIC_V11.subjects.input_action.criteria.option_set_quality.description,
      "the option-set quality criterion pins multi-select distinctness",
    ).toContain("multi-select options should be distinct and non-overlapping");

    const occurrenceInventory = inventoryReviewSubjects({
      turnId: "turn-input",
      rootLayerId: "layer-input",
      layers: [{
        id: "layer-input",
        nodeIds: ["node-input"],
        actions: [{
          id: "63",
          sourceNodeId: "node-input",
          kind: "input",
          control: "text",
          prompt: "What deployment window should we use?",
          options: [],
          occurrence: { presentingInteractionNodeId: 41, presentingLayerId: 52, actionId: 63 },
        }],
      }],
    });

    const judgeOnlyPrompt = buildRecursivePresentationJudgePrompt(
      "Prepare the deployment.",
      GRAPH_PRESENTATION_RUBRIC_V11,
      occurrenceInventory,
      undefined,
      false,
    );
    expect(judgeOnlyPrompt, "judge-only reruns are announced").toContain("No input operator is available for this judge-only rerun");
    expect(judgeOnlyPrompt, "judge-only rerun instructions keep prior answers immutable").toContain("remain immutable");
    for (const phrase of ["provide one valid answer per action", "activate `send-interaction`", "commissions the answers"] as const) {
      expect(judgeOnlyPrompt, `judge-only reruns must not offer input-operator instructions: ${phrase}`).not.toContain(phrase);
    }
  });

  it("runs a locked-down judge thread and records an immutable audit artifact", async () => {
    const store = finalizedStore();
    let startRequest: JudgeThreadStartRequest | undefined;
    const factory: JudgeThreadFactory = {
      start(request) {
        startRequest = request;
        return {
          id: "codex-thread-1",
          run: vi.fn(async (): Promise<JudgeThreadResult> => ({
            items: [{ id: "message-1", type: "agent_message", text: "Review submitted." }],
            finalResponse: "Review submitted.",
            usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              cache_write_input_tokens: 0,
              output_tokens: 25,
              reasoning_output_tokens: 5,
            },
          })),
        };
      },
    };

    const result = await runSimulatedUserJudge({
      executionId: "execution-1",
      originalRequest: "Explain the architecture.",
      configuration: { model: "gpt-test", modelReasoningEffort: "high" },
      controller: unusedController(),
      reviewStore: store,
      environment: {
        PATH: "/usr/bin",
        HOME: "/Users/test",
        OPENAI_API_KEY: "must-not-leak",
        RELAYER_GRAPH_TOKEN: "must-not-leak",
        RANDOM_SECRET: "must-not-leak",
      },
      workingDirectory: process.cwd(),
      codexPathOverride: "/managed/codex",
      artifact: {
        kind: "git_workspace",
        workingDirectory: process.cwd(),
        baseRevision: "base-commit",
      },
      artifactEvidence: {
        schemaVersion: 1,
        source: "bounded_host_packet",
        summary: "Changed src/file.ts and verified the focused suite.",
        facts: ["src/file.ts changed", "focused tests passed"],
      },
      threadFactory: factory,
      mcpServer: { bearerToken: "test-token-with-at-least-24-characters" },
    });

    expect(startRequest?.threadOptions, "the judge thread is sandboxed read-only and offline").toMatchObject({
      model: "gpt-test",
      modelReasoningEffort: "high",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      additionalDirectories: [],
    });
    expect(startRequest?.codexOptions.env, "only allowlisted variables and the MCP token reach the judge").toEqual({
      HOME: "/Users/test",
      PATH: "/usr/bin",
      [SIMULATED_USER_MCP_TOKEN_ENV]: "test-token-with-at-least-24-characters",
    });
    expect(startRequest?.codexOptions.codexPathOverride, "the managed Codex path is honored").toBe("/managed/codex");
    expect(startRequest?.codexOptions.env, "API keys never reach the judge").not.toHaveProperty("OPENAI_API_KEY");
    expect(startRequest?.codexOptions.env, "graph tokens never reach the judge").not.toHaveProperty("RELAYER_GRAPH_TOKEN");
    expect(startRequest?.codexOptions.config, "the judge config exposes only the single review MCP server").toMatchObject({
      features: {
        apps: false,
        browser_use: false,
        computer_use: false,
        image_generation: false,
        shell_tool: true,
        skill_search: false,
        unified_exec: true,
        view_image: false,
      },
      mcp_servers: {
        [SIMULATED_USER_MCP_SERVER_NAME]: {
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
          bearer_token_env_var: SIMULATED_USER_MCP_TOKEN_ENV,
          enabled_tools: ["screenshot", "interact", "history", "reviewLayer", "reviewNode", "submitReview"],
        },
      },
    });
    expect(result, "the audit artifact is a versioned, execution-bound record").toMatchObject({
      schemaVersion: 1,
      executionId: "execution-1",
      judge: { model: "gpt-test", modelReasoningEffort: "high" },
      prompt: { version: "simulated-user-judge-prompt-v11" },
      rubric: { rubricVersion: "simulated-user-rubric-v1" },
      codexThreadId: "codex-thread-1",
      finalResponse: "Review submitted.",
      usage: { input_tokens: 100, output_tokens: 25 },
      enforcement: {
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        allowedMcpServer: SIMULATED_USER_MCP_SERVER_NAME,
        shellAccess: true,
      },
    });
    expect(result.prompt.text, "the prompt carries the original request").toContain("Original user request:\nExplain the architecture.");
    expect(result.prompt.text, "the prompt applies one recursive layer policy").toContain("root and expansion layers have no different rules");
    expect(result.prompt.text, "the prompt forbids regrading reference destinations").toContain("Do not regrade the reference destination node by node");
    expect(result.prompt.text, "the prompt separates need from execution").toContain("Need is independent of execution");
    expect(result.prompt.text, "the prompt never leaks the working directory").not.toContain(process.cwd());
    expect(result.prompt.text, "the prompt never leaks raw artifact revision data").not.toContain('"baseRevision": "base-commit"');
    expect(result.prompt.text, "the prompt carries the bounded artifact evidence").toContain("Changed src/file.ts and verified the focused suite.");
    expect(result.prompt.text, "the prompt binds the rubric as the contract").toContain("The rubric is the contract");
    expect(result.codexTrace, "the trace is the exact judge message list").toEqual([{ id: "message-1", type: "agent_message", text: "Review submitted." }]);
    expect(Object.isFrozen(result), "the audit artifact is immutable").toBe(true);
    expect(Object.isFrozen(result.codexTrace), "the trace is immutable").toBe(true);
    expect(Object.isFrozen(result.codexTrace[0]), "trace items are immutable").toBe(true);
    expect(Object.isFrozen(result.review), "the review record is immutable").toBe(true);

    const inventory = inventoryReviewSubjects({
      turnId: "turn-recursive",
      rootLayerId: "layer-recursive",
      layers: [{ id: "layer-recursive", nodeIds: ["node-recursive"], actions: [] }],
    });
    const recursiveStore = new RecursivePresentationReviewStore({ inventory });
    let capturedPrompt = "";
    const captureFactory: JudgeThreadFactory = {
      start() {
        return {
          id: "recursive-default",
          run: async (prompt) => {
            capturedPrompt = prompt;
            throw new Error("stop after prompt capture");
          },
        };
      },
    };

    await expect(runSimulatedUserJudge({
      executionId: "execution-recursive",
      originalRequest: "Ask only if blocked.",
      configuration: { model: "gpt-test", modelReasoningEffort: "high" },
      controller: unusedController(),
      reviewStore: recursiveStore,
      workingDirectory: process.cwd(),
      threadFactory: captureFactory,
      mcpServer: { bearerToken: "test-token-with-at-least-24-characters" },
    }), "the prompt capture factory stops the run").rejects.toThrow("stop after prompt capture");

    expect(capturedPrompt, "recursive stores default to the v11 rubric").toContain("Graph-presentation rubric (graph-presentation-rubric-v11)");
    expect(capturedPrompt, "recursive stores use the v6 judgment contract").toContain('"contractId": "recursive-presentation-judge-v6"');
    expect(capturedPrompt, "a recursive store without an operator is a judge-only rerun").toContain("No input operator is available for this judge-only rerun");
    expect(capturedPrompt, "judge-only reruns never offer answer instructions").not.toContain("provide one valid answer per action");
  });

  it("gates traces, environment, and rubric pairing before inference", async () => {
    const forbiddenItems: readonly [label: string, item: ThreadItem][] = [
      ["file changes", { id: "file", type: "file_change", changes: [{ path: "x", kind: "add" }], status: "completed" }],
      ["web search", { id: "web", type: "web_search", query: "anything" }],
      ["non-review MCP activity", { id: "mcp", type: "mcp_tool_call", server: "other", tool: "read", arguments: {}, status: "completed" }],
    ];
    for (const [label, item] of forbiddenItems) {
      expect(() => assertReviewOnlyCodexTrace([item]), `${label} are forbidden in a review-only trace`).toThrow(/forbidden/i);
    }
    expect(() => assertReviewOnlyCodexTrace([{
      id: "shell",
      type: "command_execution",
      command: "git diff --stat HEAD^",
      aggregated_output: "src/file.ts | 2 ++",
      exit_code: 0,
      status: "completed",
    }]), "read-only shell evidence is allowed").not.toThrow();
    expect(() => assertReviewOnlyCodexTrace([{
      id: "allowed",
      type: "mcp_tool_call",
      server: SIMULATED_USER_MCP_SERVER_NAME,
      tool: "screenshot",
      arguments: {},
      status: "completed",
    }]), "the review MCP server's own tools are allowed").not.toThrow();

    expect(sanitizeJudgeEnvironment({
      HOME: "/home/test",
      PATH: "/bin",
      OPENAI_API_KEY: "secret",
      RELAYER_GRAPH_URL: "http://graph",
      RELAYER_GRAPH_TOKEN: "graph-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
    }), "the judge environment keeps a strict allowlist").toEqual({ HOME: "/home/test", PATH: "/bin" });
    expect(
      () => sanitizeJudgeEnvironment({}, { OPENAI_API_KEY: "secret" }),
      "adding a non-allowlisted variable is rejected",
    ).toThrow("not allowlisted");

    const inventory = inventoryReviewSubjects({
      turnId: "turn-recursive",
      rootLayerId: "layer-recursive",
      layers: [{ id: "layer-recursive", nodeIds: ["node-recursive"], actions: [] }],
    });
    const mismatches: readonly [label: string, rubric: typeof GRAPH_PRESENTATION_RUBRIC_V10 | typeof GRAPH_PRESENTATION_RUBRIC_V11, store: () => unknown, message: string][] = [
      ["a historical rubric at the recursive v6 boundary", GRAPH_PRESENTATION_RUBRIC_V10, () => new RecursivePresentationReviewStore({ inventory }), "Recursive presentation contract v6 requires graph-presentation-rubric-v11"],
      ["the v11 recursive rubric with a legacy review store", GRAPH_PRESENTATION_RUBRIC_V11, () => finalizedStore(), "graph-presentation-rubric-v11 requires recursive presentation contract v6"],
    ];
    for (const [label, rubric, createStore, message] of mismatches) {
      const start = vi.fn<JudgeThreadFactory["start"]>();
      await expect(runSimulatedUserJudge({
        executionId: "execution-mismatch",
        originalRequest: "Review the response.",
        configuration: { model: "gpt-test", modelReasoningEffort: "high", rubric },
        controller: unusedController(),
        reviewStore: createStore() as never,
        workingDirectory: process.cwd(),
        threadFactory: { start },
        mcpServer: { bearerToken: "test-token-with-at-least-24-characters" },
      }), `${label} is rejected before inference`).rejects.toThrow(message);
      expect(start, `${label} never starts a Codex thread`).not.toHaveBeenCalled();
    }
  });
});

function finalizedStore(): IncrementalReviewStore<LayerReview, NodeReview, TurnReview> {
  const inventory = inventoryReviewSubjects({
    turnId: "turn-1",
    rootLayerId: "layer-1",
    layers: [{ id: "layer-1", nodeIds: ["node-1"], actions: [] }],
  });
  const store = new IncrementalReviewStore<LayerReview, NodeReview, TurnReview>({ inventory });
  store.reviewLayer({
    layerId: "layer-1",
    evidence: { viewport: ["shot-layer"] },
    ratings: {
      purpose_clarity: 4,
      cohesion: 4,
      visual_organization: 4,
      relationship_clarity: 4,
      coverage: 4,
    },
    summary: "Clear.",
    findings: [],
  });
  store.reviewNode({
    nodeId: "node-1",
    layerId: "layer-1",
    evidence: { context: ["shot-layer"], detail: ["shot-node"] },
    ratings: { layer_fit: 4, title_detail_alignment: 4, substance: 4, detail_presentation: 4 },
    actions: [],
    structure: {
      rating: 4,
      expansion: { need: "none", result: "absent" },
      references: { need: "none", result: "absent" },
      invoke: { need: "none", result: "absent" },
      reason: "A flat node is sufficient.",
      evidence: ["shot-node"],
    },
    summary: "Useful.",
    findings: [],
  });
  store.submitReview({
    turnId: "turn-1",
    evidence: { representative: ["shot-layer", "shot-node"] },
    ratings: {
      answer_quality: 4,
      recursive_coherence: 4,
      navigation_value: 4,
      presentation_quality: 4,
      follow_up_progress: null,
    },
    nullRatingJustifications: { follow_up_progress: "This is the first turn." },
    summary: "Strong overall.",
    findings: [],
    structure: {
      overall: "neutral",
      expansion: { need: "none", result: "absent" },
      references: { need: "none", result: "absent" },
      reason: "A flat response is sufficient.",
      evidence: ["shot-layer"],
    },
    scoreCeiling: {
      maximum: 4,
      reason: "No critical comprehension gap exists.",
      evidence: ["shot-layer"],
    },
  });
  return store;
}

function unusedController(): ReviewSessionController {
  return {
    screenshot: async () => { throw new Error("unexpected screenshot"); },
    interact: async () => { throw new Error("unexpected interact"); },
    history: async () => { throw new Error("unexpected history"); },
  };
}
