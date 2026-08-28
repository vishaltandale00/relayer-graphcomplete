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
  runSimulatedUserJudge,
  sanitizeJudgeEnvironment,
  type JudgeThreadResult,
  type JudgeThreadFactory,
  type JudgeThreadStartRequest,
} from "../src/simulated-user/judge-runner.js";
import { inventoryReviewSubjects } from "../src/simulated-user/inventory.js";
import { GRAPH_PRESENTATION_RUBRIC_V10 } from "../src/simulated-user/rubric.js";
import { IncrementalReviewStore } from "../src/simulated-user/review-store.js";
import type { LayerReview, NodeReview, TurnReview } from "../src/simulated-user/contracts.js";

describe("simulated-user Codex judge runner", () => {
  it("requires first-class artifact-grounded findings for materially absent actions", () => {
    const inventory = inventoryReviewSubjects({
      turnId: "turn-1",
      rootLayerId: "layer-1",
      layers: [{ id: "layer-1", nodeIds: ["node-1"], actions: [] }],
    });
    const prompt = buildRecursivePresentationJudgePrompt(
      "Explain the completed repair.",
      GRAPH_PRESENTATION_RUBRIC_V10,
      inventory,
    );

    expect(prompt).toContain("A flat graph does not escape recursive judgment");
    expect(prompt).toContain("missingActionOpportunity");
    expect(prompt).toContain("distinct unanswered user question");
    expect(prompt).toContain("Generic requests for more detail");
    expect(prompt).toContain("caps final recursive_coherence, navigation_value, and presentation_quality at 6");
    expect(prompt).toContain("Read-only shell and filesystem inspection are available");
    expect(prompt).toContain("what would a user reasonably want to inspect next");
    expect(prompt).toContain("what would a user reasonably want to do next");
    expect(prompt).toContain("Do not impose a minimum number of actions");
    expect(prompt).toContain("a visually arbitrary row, line, ring, or hub");
    expect(prompt).toContain("Embedded screenshots and image banners are not currently supported");
    expect(prompt).toContain("This is the human-experience judge, not the function or task-outcome judge");
    expect(prompt).toContain("can neither earn nor remove human-experience credit");
    expect(prompt).toContain("deserves little relationship_clarity credit");
    expect(prompt).toContain("Never lower the ceiling for artifact defects");
    expect(prompt).toContain("Score polish as a separate basic rendered-integrity dimension");
    expect(prompt).toContain("A default renderer can earn polish 4 while the graph remains semantically weak");
    expect(prompt).toContain("Never use polish to raise or offset content");
    expect(prompt).toContain("erase polish-only observations from the evidence");
    expect(prompt).toContain("A clean textual handoff split across static cards earns no semantic or interactive credit merely for polish");
    expect(prompt).toContain("Do not treat adjacency or reading order as relational evidence");
    expect(prompt).toContain("Two or more material missing opportunities cap all three at 4");
    expect(prompt).not.toContain("Shell, filesystem, web, network, graph mutation, and invoke execution are unavailable");
  });

  it("starts a locked-down injected Codex thread and records an immutable audit artifact", async () => {
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

    expect(startRequest?.threadOptions).toMatchObject({
      model: "gpt-test",
      modelReasoningEffort: "high",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      additionalDirectories: [],
    });
    expect(startRequest?.codexOptions.env).toEqual({
      HOME: "/Users/test",
      PATH: "/usr/bin",
      [SIMULATED_USER_MCP_TOKEN_ENV]: "test-token-with-at-least-24-characters",
    });
    expect(startRequest?.codexOptions.codexPathOverride).toBe("/managed/codex");
    expect(startRequest?.codexOptions.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(startRequest?.codexOptions.env).not.toHaveProperty("RELAYER_GRAPH_TOKEN");
    expect(startRequest?.codexOptions.config).toMatchObject({
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
    expect(result).toMatchObject({
      schemaVersion: 1,
      executionId: "execution-1",
      judge: { model: "gpt-test", modelReasoningEffort: "high" },
      prompt: { version: "simulated-user-judge-prompt-v10" },
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
    expect(result.prompt.text).toContain("Original user request:\nExplain the architecture.");
    expect(result.prompt.text).toContain("root and expansion layers have no different rules");
    expect(result.prompt.text).toContain("Do not regrade the reference destination node by node");
    expect(result.prompt.text).toContain("Need is independent of execution");
    expect(result.prompt.text).not.toContain(process.cwd());
    expect(result.prompt.text).not.toContain('"baseRevision": "base-commit"');
    expect(result.prompt.text).toContain("Changed src/file.ts and verified the focused suite.");
    expect(result.prompt.text).toContain("The rubric is the contract");
    expect(result.codexTrace).toEqual([{ id: "message-1", type: "agent_message", text: "Review submitted." }]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.codexTrace)).toBe(true);
    expect(Object.isFrozen(result.codexTrace[0])).toBe(true);
    expect(Object.isFrozen(result.review)).toBe(true);
  });

  it("allows read-only shell evidence while rejecting file, web, and non-review MCP activity", () => {
    const forbidden: ThreadItem[] = [
      { id: "file", type: "file_change", changes: [{ path: "x", kind: "add" }], status: "completed" },
      { id: "web", type: "web_search", query: "anything" },
      { id: "mcp", type: "mcp_tool_call", server: "other", tool: "read", arguments: {}, status: "completed" },
    ];
    for (const item of forbidden) expect(() => assertReviewOnlyCodexTrace([item])).toThrow(/forbidden/i);

    expect(() => assertReviewOnlyCodexTrace([{
      id: "shell",
      type: "command_execution",
      command: "git diff --stat HEAD^",
      aggregated_output: "src/file.ts | 2 ++",
      exit_code: 0,
      status: "completed",
    }])).not.toThrow();

    expect(() => assertReviewOnlyCodexTrace([{
      id: "allowed",
      type: "mcp_tool_call",
      server: SIMULATED_USER_MCP_SERVER_NAME,
      tool: "screenshot",
      arguments: {},
      status: "completed",
    }])).not.toThrow();
  });

  it("uses a strict environment allowlist", () => {
    expect(sanitizeJudgeEnvironment({
      HOME: "/home/test",
      PATH: "/bin",
      OPENAI_API_KEY: "secret",
      RELAYER_GRAPH_URL: "http://graph",
      RELAYER_GRAPH_TOKEN: "graph-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
    })).toEqual({ HOME: "/home/test", PATH: "/bin" });
    expect(() => sanitizeJudgeEnvironment({}, { OPENAI_API_KEY: "secret" })).toThrow("not allowlisted");
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
