import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayerReview, NodeReview, TurnReview } from "../src/simulated-user/contracts.js";
import { inventoryReviewSubjects } from "../src/simulated-user/inventory.js";
import { IncrementalReviewStore } from "../src/simulated-user/review-store.js";
import { RecursivePresentationReviewStore } from "../src/simulated-user/recursive-review.js";
import {
  SIMULATED_USER_MCP_TOOL_NAMES,
  startSimulatedUserReviewMcpServer,
  type ReviewSessionController,
  type SimulatedUserMcpServerHandle,
} from "../src/simulated-user/mcp-server.js";

const openServers: SimulatedUserMcpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe("simulated-user MCP server", () => {
  it("binds to loopback, requires its bearer token, and exposes exactly six review tools", async () => {
    const server = await startServer();
    expect(server.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const unauthorized = await fetch(server.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

    const { client, transport } = await connectClient(server);
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual(SIMULATED_USER_MCP_TOOL_NAMES);
    expect(tools.tools.every((tool) => !["shell", "openLayer", "scroll"].includes(tool.name))).toBe(true);
    await transport.close();
  });

  it("returns image tiles while tracing only structured screenshot metadata", async () => {
    const screenshot = vi.fn<ReviewSessionController["screenshot"]>(async () => ({
      output: {
        ok: true,
        screenshot: {
          schemaVersion: 1,
          screenshotId: "shot-1",
          executionId: "execution-1",
          threadId: "thread-1",
          turnId: "turn-1",
          layerId: "layer-1",
          selectedNodeId: null,
          activatedActionId: null,
          navigationPath: [{ layerId: "layer-1", viaActionId: null }],
          label: "First impression",
          mode: "visible",
          viewport: { width: 1000, height: 700, deviceScaleFactor: 2 },
          captureTarget: { kind: "viewport" },
          tileCount: 1,
          tiles: [{ index: 0, width: 1000, height: 700, contentDigest: `sha256:${"a".repeat(64)}` }],
          contentDigest: `sha256:${"b".repeat(64)}`,
        },
        elements: [{ elementRef: "node-1", role: "button", name: "Open node", disabled: false }],
      },
      images: [{ mimeType: "image/png", data: Buffer.from("image").toString("base64") }],
    }));
    const server = await startServer({ screenshot });
    const { client, transport } = await connectClient(server);
    const result = await client.callTool({
      name: "screenshot",
      arguments: { target: { kind: "viewport" }, mode: "visible", label: "First impression" },
    }, CallToolResultSchema);

    expect(result.isError).not.toBe(true);
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content as { readonly type: string }[]).map(({ type }) => type)).toEqual(["text", "image"]);
    expect(result.structuredContent).toMatchObject({ ok: true, screenshot: { screenshotId: "shot-1" } });
    expect(server.trace()).toMatchObject([{ sequence: 1, tool: "screenshot", status: "completed" }]);
    expect(JSON.stringify(server.trace())).not.toContain(Buffer.from("image").toString("base64"));
    await transport.close();
  });

  it("routes incremental review writes through the injected store", async () => {
    const reviewLayer = vi.fn(() => ({ revision: 1 }));
    const server = await startServer(undefined, { reviewLayer });
    const { client, transport } = await connectClient(server);
    const review = validLayerReview();
    const result = await client.callTool({ name: "reviewLayer", arguments: { review } });

    expect(result.structuredContent).toEqual({ ok: true, disposition: "created", layerId: "layer-1" });
    expect(reviewLayer).toHaveBeenCalledWith(review);
    expect(server.trace()).toMatchObject([{ tool: "reviewLayer", status: "completed" }]);
    await transport.close();
  });

  it("returns contract-shaped exploration failures and records them in the tool trace", async () => {
    const server = await startServer({
      interact: async () => { throw new Error("Unknown or invisible review control: missing"); },
      history: async () => { throw new Error("History delta -1 is outside the review session history."); },
    });
    const { client, transport } = await connectClient(server);

    const interact = await client.callTool({ name: "interact", arguments: { elementRef: "missing", activate: true } });
    expect(interact.structuredContent).toMatchObject({
      ok: false,
      error: { kind: "tool_error", tool: "interact", code: "unknown_element" },
    });
    const history = await client.callTool({ name: "history", arguments: { delta: -1 } });
    expect(history.structuredContent).toMatchObject({
      ok: false,
      error: { kind: "tool_error", tool: "history", code: "history_out_of_range" },
    });
    expect(server.trace().map(({ tool, status }) => `${tool}:${status}`)).toEqual([
      "interact:failed",
      "history:failed",
    ]);
    await transport.close();
  });

  it("rejects unjustified null ratings without mutating the store and accepts a justified retry", async () => {
    const reviewLayer = vi.fn(() => ({ revision: 1 }));
    const server = await startServer(undefined, { reviewLayer });
    const { client, transport } = await connectClient(server);
    const baseReview = validLayerReview();
    const invalidReview: LayerReview = {
      ...baseReview,
      ratings: { ...baseReview.ratings, purpose_clarity: null },
    };

    const rejected = await client.callTool({ name: "reviewLayer", arguments: { review: invalidReview } });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({
      ok: false,
      error: {
        kind: "review_validation_error",
        tool: "reviewLayer",
        issues: [{
          code: "unjustified_null_rating",
          path: ["review", "ratings", "purpose_clarity"],
        }],
      },
    });
    expect(reviewLayer).not.toHaveBeenCalled();

    const accepted = await client.callTool({
      name: "reviewLayer",
      arguments: {
        review: {
          ...invalidReview,
          nullRatingJustifications: { purpose_clarity: "The purpose is not visible in the captured viewport." },
        },
      },
    });
    expect(accepted.isError).not.toBe(true);
    expect(reviewLayer).toHaveBeenCalledTimes(1);
    expect(server.trace().map(({ status }) => status)).toEqual(["failed", "completed"]);
    await transport.close();
  });

  it("keeps an incomplete submit recoverable and finalizes after exact coverage is supplied", async () => {
    const inventory = inventoryReviewSubjects({
      turnId: "turn-1",
      rootLayerId: "layer-1",
      layers: [{ id: "layer-1", nodeIds: ["node-1"], actions: [] }],
    });
    const reviewStore = new IncrementalReviewStore<LayerReview, NodeReview, TurnReview>({ inventory });
    const server = await startSimulatedUserReviewMcpServer({
      controller: unusedController(),
      reviewStore,
      bearerToken: "test-token-with-at-least-24-characters",
    });
    openServers.push(server);
    const { client, transport } = await connectClient(server);

    const rejected = await client.callTool({ name: "submitReview", arguments: { review: validTurnReview() } });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({
      ok: false,
      error: {
        issues: [{ code: "incomplete_coverage" }],
        missingSubjects: [
          { kind: "layer", subjectId: "layer-1" },
          { kind: "node", subjectId: "node-1", layerId: "layer-1", nodeId: "node-1" },
        ],
      },
    });
    expect(reviewStore.finalizedResult()).toBeUndefined();

    await client.callTool({ name: "reviewLayer", arguments: { review: validLayerReview() } });
    await client.callTool({ name: "reviewNode", arguments: { review: validNodeReview() } });
    const accepted = await client.callTool({ name: "submitReview", arguments: { review: validTurnReview() } });

    expect(accepted.structuredContent).toEqual({ ok: true, finalized: true, turnId: "turn-1" });
    expect(reviewStore.finalizedResult()?.coverage.complete).toBe(true);
    expect(server.trace().map(({ tool, status }) => `${tool}:${status}`)).toEqual([
      "submitReview:failed",
      "reviewLayer:completed",
      "reviewNode:completed",
      "submitReview:completed",
    ]);
    await transport.close();
  });

  it("accepts and persists a first-class missing action opportunity through the recursive review tool", async () => {
    const inventory = inventoryReviewSubjects({
      turnId: "turn-1",
      rootLayerId: "layer-1",
      layers: [{ id: "layer-1", nodeIds: ["node-1"], actions: [] }],
    });
    const reviewStore = new RecursivePresentationReviewStore({ inventory });
    const server = await startSimulatedUserReviewMcpServer({
      controller: unusedController(),
      reviewStore,
      bearerToken: "test-token-with-at-least-24-characters",
    });
    openServers.push(server);
    const { client, transport } = await connectClient(server);

    const result = await client.callTool({
      name: "reviewNode",
      arguments: { review: {
        layerId: "layer-1",
        nodeId: "node-1",
        evidence: { context: ["shot-node"], detail: ["shot-node"] },
        score: { nodeId: "node-1", content: 4, actionAllocation: 2, actionDelivery: null, recursiveQuality: null },
        semantic: {
          nodeId: "node-1",
          meaning: "The node reports a completed repair.",
          delivered: "The result is visible.",
          limitations: "The failure mechanism is not explained.",
          effectOnLayer: "The root remains shallow.",
          evidence: ["shot-node"],
        },
        allocationSteps: [{
          step: 0,
          ranking: [
            { choice: "expand", rank: 1 },
            { choice: "stop", rank: 2 },
            { choice: "reference", rank: 3 },
            { choice: "invoke", rank: 4 },
          ],
          preferredChoice: "expand",
          authoredChoice: "stop",
          authoredActionId: null,
          margin: "clearly_better",
          selectionFinding: "A causal explanation is materially missing.",
          evidence: ["shot-node"],
        }],
        missingActionOpportunities: [{
          allocationStep: 0,
          preferredChoice: "expand",
          importance: "material",
          unansweredQuestion: "How does the invalid value reach the response boundary?",
          expectedContribution: "Trace the causal path and repaired boundary.",
          artifactEvidence: ["src/utils/sanitize.ts", "src/response.ts"],
          evidence: ["shot-node"],
        }],
        actions: [],
        findings: [],
      } },
    });

    expect(result.structuredContent).toMatchObject({ ok: true, nodeId: "node-1" });
    expect(reviewStore.snapshot().nodes[0]?.history.current.missingActionOpportunities).toEqual([expect.objectContaining({
      preferredChoice: "expand",
      importance: "material",
    })]);
    await transport.close();
  });
});

async function startServer(
  controllerOverrides: Partial<ReviewSessionController> = {},
  storeOverrides: Partial<{
    reviewLayer(review: LayerReview): { revision: number };
    reviewNode(review: NodeReview): { revision: number };
    submitReview(review: TurnReview): unknown;
  }> = {},
): Promise<SimulatedUserMcpServerHandle> {
  const controller: ReviewSessionController = {
    screenshot: async () => { throw new Error("unexpected screenshot"); },
    interact: async () => ({
      ok: true,
      state: {
        turnId: "turn-1",
        layerId: "layer-1",
        selectedNodeId: null,
        activatedActionId: null,
        navigationPath: [{ layerId: "layer-1", viaActionId: null }],
      },
    }),
    history: async () => ({
      ok: true,
      state: {
        turnId: "turn-1",
        layerId: "layer-1",
        selectedNodeId: null,
        activatedActionId: null,
        navigationPath: [{ layerId: "layer-1", viaActionId: null }],
      },
    }),
    ...controllerOverrides,
  };
  const reviewStore = {
    reviewLayer: () => ({ revision: 1 }),
    reviewNode: () => ({ revision: 1 }),
    submitReview: () => ({}),
    ...storeOverrides,
  };
  const server = await startSimulatedUserReviewMcpServer({
    controller,
    reviewStore,
    bearerToken: "test-token-with-at-least-24-characters",
  });
  openServers.push(server);
  return server;
}

async function connectClient(server: SimulatedUserMcpServerHandle): Promise<{
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
}> {
  const transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
    requestInit: { headers: { authorization: `Bearer ${server.bearerToken}` } },
  });
  const client = new Client({ name: "simulated-user-test", version: "1.0.0" });
  await client.connect(transport as unknown as Transport);
  return { client, transport };
}

function validLayerReview(): LayerReview {
  return {
    layerId: "layer-1",
    evidence: { viewport: ["shot-1"] },
    ratings: {
      purpose_clarity: 4,
      cohesion: 4,
      visual_organization: 3,
      relationship_clarity: 3,
      coverage: 4,
    },
    summary: "Clear and cohesive.",
    findings: [],
  };
}

function validNodeReview(): NodeReview {
  return {
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
    summary: "Useful and clear.",
    findings: [],
  };
}

function validTurnReview(): TurnReview {
  return {
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
  };
}

function unusedController(): ReviewSessionController {
  return {
    screenshot: async () => { throw new Error("unexpected screenshot"); },
    interact: async () => { throw new Error("unexpected interact"); },
    history: async () => { throw new Error("unexpected history"); },
  };
}
