import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  SIMULATED_USER_JUDGE_CONTRACT_V1,
  type HistoryToolInput,
  type HistoryToolOutput,
  type InteractToolInput,
  type InteractToolOutput,
  type LayerReview,
  type NodeReview,
  type ReviewLayerToolOutput,
  type ReviewNodeToolOutput,
  type ReviewToolFailure,
  type ReviewToolName,
  type ReviewValidationIssue,
  type ExplorationToolName,
  type SimulatedUserToolFailure,
  type ScreenshotToolInput,
  type ScreenshotToolOutput,
  type SimulatedUserToolName,
  type SubmitReviewToolOutput,
  type TurnReview,
} from "./contracts.js";
import { MissingReviewSubjectsError } from "./coverage.js";
import { ScreenshotEvidenceValidationError } from "./evidence-validator.js";
import {
  RecursivePresentationReviewStore,
  type RecursiveLayerResult,
  type RecursiveNodeReview,
  type RecursiveTurnReview,
} from "./recursive-review.js";

export const SIMULATED_USER_MCP_SERVER_NAME = "simulated_user_review" as const;
export const SIMULATED_USER_MCP_TOKEN_ENV = "RELAYER_SIMULATED_USER_MCP_TOKEN" as const;

export interface ScreenshotImageTile {
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
}

export interface ScreenshotControllerResult {
  readonly output: ScreenshotToolOutput;
  readonly images: readonly ScreenshotImageTile[];
}

export interface ReviewSessionController {
  screenshot(input: ScreenshotToolInput): Promise<ScreenshotControllerResult>;
  interact(input: InteractToolInput): Promise<InteractToolOutput>;
  history(input: HistoryToolInput): Promise<HistoryToolOutput>;
}

export interface SimulatedUserReviewStore {
  reviewLayer(review: LayerReview): { readonly revision: number };
  reviewNode(review: NodeReview): { readonly revision: number };
  submitReview(review: TurnReview): unknown;
}

export interface McpToolTraceEntry {
  readonly sequence: number;
  readonly tool: SimulatedUserToolName;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "completed" | "failed";
  readonly arguments: unknown;
  readonly output?: unknown;
  readonly error?: string;
}

export interface SimulatedUserMcpServerOptions {
  readonly controller: ReviewSessionController;
  readonly reviewStore: SimulatedUserReviewStore | RecursivePresentationReviewStore;
  readonly port?: number;
  readonly bearerToken?: string;
  readonly now?: () => Date;
}

export interface SimulatedUserMcpServerHandle {
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly serverName: typeof SIMULATED_USER_MCP_SERVER_NAME;
  trace(): readonly McpToolTraceEntry[];
  close(): Promise<void>;
}

const ratingSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.null()]);
const screenshotReferenceSchema = z.string().min(1);
const findingSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("strength"),
    text: z.string().min(1),
    evidence: z.array(screenshotReferenceSchema).min(1),
  }).strict(),
  z.object({
    type: z.literal("issue"),
    severity: z.enum(["minor", "material", "critical"]),
    text: z.string().min(1),
    evidence: z.array(screenshotReferenceSchema).min(1),
  }).strict(),
]);
const structureDimensionSchema = z.object({
  need: z.enum(["none", "helpful", "required"]),
  result: z.enum(["absent", "works", "mixed", "fails"]),
}).strict();

const layerRatingsSchema = z.object({
  purpose_clarity: ratingSchema,
  cohesion: ratingSchema,
  visual_organization: ratingSchema,
  relationship_clarity: ratingSchema,
  coverage: ratingSchema,
}).strict();
const nodeRatingsSchema = z.object({
  layer_fit: ratingSchema,
  title_detail_alignment: ratingSchema,
  substance: ratingSchema,
  detail_presentation: ratingSchema,
}).strict();
const navigateActionRatingsSchema = z.object({
  placement: ratingSchema,
  label_expectation: ratingSchema,
  destination_delivery: ratingSchema,
  added_value: ratingSchema,
}).strict();
const invokeActionRatingsSchema = z.object({
  placement: ratingSchema,
  label_expectation: ratingSchema,
  apparent_value: ratingSchema,
}).strict();
const turnRatingsSchema = z.object({
  answer_quality: ratingSchema,
  recursive_coherence: ratingSchema,
  navigation_value: ratingSchema,
  presentation_quality: ratingSchema,
  follow_up_progress: ratingSchema,
}).strict();

function optionalJustifications<Shape extends z.ZodRawShape>(shape: Shape): z.ZodOptional<z.ZodObject<{
  [Key in keyof Shape]: z.ZodOptional<z.ZodString>;
}>> {
  const entries = Object.fromEntries(Object.keys(shape).map((key) => [key, z.string().min(1).optional()]));
  return z.object(entries as { [Key in keyof Shape]: z.ZodOptional<z.ZodString> }).strict().optional();
}

const layerReviewSchema = z.object({
  layerId: z.string().min(1),
  evidence: z.object({ viewport: z.array(screenshotReferenceSchema).min(1) }).strict(),
  ratings: layerRatingsSchema,
  nullRatingJustifications: optionalJustifications(layerRatingsSchema.shape),
  summary: z.string().min(1),
  findings: z.array(findingSchema),
}).strict();

const navigateActionReviewSchema = z.object({
  actionId: z.string().min(1),
  kind: z.literal("navigate"),
  evidence: z.object({
    source: z.array(screenshotReferenceSchema).min(1),
    destination: z.array(screenshotReferenceSchema).min(1),
  }).strict(),
  ratings: navigateActionRatingsSchema,
  nullRatingJustifications: optionalJustifications(navigateActionRatingsSchema.shape),
  summary: z.string().min(1),
  findings: z.array(findingSchema),
}).strict();

const invokeActionReviewSchema = z.object({
  actionId: z.string().min(1),
  kind: z.literal("invoke"),
  evidence: z.object({ source: z.array(screenshotReferenceSchema).min(1) }).strict(),
  ratings: invokeActionRatingsSchema,
  nullRatingJustifications: optionalJustifications(invokeActionRatingsSchema.shape),
  summary: z.string().min(1),
  findings: z.array(findingSchema),
}).strict();

const nodeReviewSchema = z.object({
  nodeId: z.string().min(1),
  layerId: z.string().min(1),
  evidence: z.object({
    context: z.array(screenshotReferenceSchema).min(1),
    detail: z.array(screenshotReferenceSchema).min(1),
  }).strict(),
  ratings: nodeRatingsSchema,
  nullRatingJustifications: optionalJustifications(nodeRatingsSchema.shape),
  actions: z.array(z.discriminatedUnion("kind", [navigateActionReviewSchema, invokeActionReviewSchema])),
  structure: z.object({
    rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    expansion: structureDimensionSchema,
    references: structureDimensionSchema,
    invoke: structureDimensionSchema,
    reason: z.string().min(1),
    evidence: z.array(screenshotReferenceSchema).min(1),
  }).strict(),
  summary: z.string().min(1),
  findings: z.array(findingSchema),
}).strict();

const turnReviewSchema = z.object({
  turnId: z.string().min(1),
  evidence: z.object({ representative: z.array(screenshotReferenceSchema).min(1) }).strict(),
  ratings: turnRatingsSchema,
  nullRatingJustifications: optionalJustifications(turnRatingsSchema.shape),
  summary: z.string().min(1),
  findings: z.array(findingSchema),
  structure: z.object({
    overall: z.enum(["helps", "neutral", "mixed", "hurts"]),
    expansion: structureDimensionSchema,
    references: structureDimensionSchema,
    reason: z.string().min(1),
    evidence: z.array(screenshotReferenceSchema).min(1),
  }).strict(),
  scoreCeiling: z.object({
    maximum: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    reason: z.string().min(1),
    evidence: z.array(screenshotReferenceSchema).min(1),
  }).strict(),
}).strict();

const scoreValueSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const recursiveScoreSchema = z.object({
  nodeId: z.string().min(1),
  content: scoreValueSchema,
  actionAllocation: scoreValueSchema,
  actionDelivery: scoreValueSchema.nullable(),
  recursiveQuality: scoreValueSchema.nullable(),
}).strict();
const recursiveSemanticSchema = z.object({
  nodeId: z.string().min(1),
  meaning: z.string().min(1),
  delivered: z.string().min(1),
  limitations: z.string().min(1),
  effectOnLayer: z.string().min(1),
  evidence: z.array(screenshotReferenceSchema).min(1),
}).strict();
const allocationChoiceSchema = z.enum(["expand", "reference", "invoke", "stop"]);
const allocationStepSchema = z.object({
  step: z.number().int().nonnegative(),
  ranking: z.array(z.object({ choice: allocationChoiceSchema, rank: scoreValueSchema }).strict()).length(4),
  preferredChoice: allocationChoiceSchema,
  authoredChoice: allocationChoiceSchema,
  authoredActionId: z.string().min(1).nullable(),
  margin: z.enum(["close", "clearly_better", "necessary"]),
  selectionFinding: z.string().min(1),
  evidence: z.array(screenshotReferenceSchema).min(1),
}).strict();
const missingActionOpportunitySchema = z.object({
  allocationStep: z.number().int().nonnegative(),
  preferredChoice: z.enum(["expand", "reference", "invoke"]),
  importance: z.enum(["material", "critical"]),
  unansweredQuestion: z.string().min(1),
  expectedContribution: z.string().min(1),
  artifactEvidence: z.array(z.string().min(1)).min(1),
  evidence: z.array(screenshotReferenceSchema).min(1),
}).strict();
const recursiveActionSchema = z.object({
  actionId: z.string().min(1),
  kind: z.enum(["expand", "reference", "invoke"]),
  allocationStep: z.number().int().nonnegative(),
  labelAndPlacement: z.string().min(1),
  delivery: z.string().min(1).nullable(),
  recursiveContribution: z.string().min(1).nullable(),
  targetLayerId: z.string().min(1).nullable(),
  reusedLayerId: z.string().min(1).nullable(),
  evidence: z.array(screenshotReferenceSchema).min(1),
}).strict();
const recursiveNodeReviewSchema = z.object({
  layerId: z.string().min(1),
  nodeId: z.string().min(1),
  evidence: z.object({
    context: z.array(screenshotReferenceSchema).min(1),
    detail: z.array(screenshotReferenceSchema).min(1),
  }).strict(),
  score: recursiveScoreSchema,
  semantic: recursiveSemanticSchema,
  allocationSteps: z.array(allocationStepSchema).min(1),
  missingActionOpportunities: z.array(missingActionOpportunitySchema).default([]),
  actions: z.array(recursiveActionSchema),
  findings: z.array(findingSchema),
}).strict();
const recursiveLayerResultSchema = z.object({
  layerId: z.string().min(1),
  depth: z.number().int().nonnegative(),
  nodeScores: z.array(recursiveScoreSchema.nullable()).length(8),
  nodeSemantics: z.array(recursiveSemanticSchema.nullable()).length(8),
  layerRatings: layerRatingsSchema,
  layerSummary: z.string().min(1),
  evidence: z.array(screenshotReferenceSchema).min(1),
}).strict();
const recursiveTurnReviewSchema = z.object({
  turnId: z.string().min(1),
  rootLayerResult: recursiveLayerResultSchema,
  evidence: z.object({ representative: z.array(screenshotReferenceSchema).min(1) }).strict(),
  ratings: turnRatingsSchema,
  nullRatingJustifications: optionalJustifications(turnRatingsSchema.shape),
  summary: z.string().min(1),
  findings: z.array(findingSchema),
  scoreCeiling: z.object({
    maximum: scoreValueSchema,
    reason: z.string().min(1),
    evidence: z.array(screenshotReferenceSchema).min(1),
  }).strict(),
}).strict();

export async function startSimulatedUserReviewMcpServer(
  options: SimulatedUserMcpServerOptions,
): Promise<SimulatedUserMcpServerHandle> {
  const bearerToken = options.bearerToken ?? randomBytes(32).toString("base64url");
  if (bearerToken.length < 24) throw new Error("Simulated-user MCP bearer token must contain at least 24 characters");
  const now = options.now ?? (() => new Date());
  const trace: McpToolTraceEntry[] = [];
  const activeConnections = new Set<{ readonly server: McpServer; readonly transport: StreamableHTTPServerTransport }>();
  let expectedHost: string | undefined;

  const httpServer = createServer(async (request, response) => {
    try {
      if (request.url !== "/mcp") return sendStatus(response, 404, "Not found");
      if (!isLoopbackAddress(request.socket.remoteAddress)) return sendStatus(response, 403, "Loopback clients only");
      if (expectedHost === undefined || request.headers.host !== expectedHost) return sendStatus(response, 421, "Invalid host");
      if (!hasBearerToken(request, bearerToken)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        return sendStatus(response, 401, "Unauthorized");
      }
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendStatus(response, 405, "Method not allowed");
      }

      const contract = options.reviewStore instanceof RecursivePresentationReviewStore ? "recursive" : "legacy";
      const mcpServer = createMcpServer(options.controller, options.reviewStore, trace, now, contract);
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      const connection = { server: mcpServer, transport };
      activeConnections.add(connection);
      response.once("close", () => {
        activeConnections.delete(connection);
        void transport.close();
        void mcpServer.close();
      });
      // The SDK's Node transport predates exactOptionalPropertyTypes on the
      // shared Transport declaration; it is the concrete SDK transport here.
      await mcpServer.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) sendStatus(response, 500, errorMessage(error));
    }
  });

  await listenLoopback(httpServer, options.port ?? 0);
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await closeHttpServer(httpServer);
    throw new Error("Simulated-user MCP server did not receive a TCP address");
  }
  expectedHost = `127.0.0.1:${address.port}`;
  let closed = false;
  return {
    endpoint: `http://${expectedHost}/mcp`,
    bearerToken,
    serverName: SIMULATED_USER_MCP_SERVER_NAME,
    trace: () => structuredClone(trace),
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all([...activeConnections].map(async ({ server, transport }) => {
        await transport.close();
        await server.close();
      }));
      await closeHttpServer(httpServer);
    },
  };
}

function createMcpServer(
  controller: ReviewSessionController,
  reviewStore: SimulatedUserReviewStore | RecursivePresentationReviewStore,
  trace: McpToolTraceEntry[],
  now: () => Date,
  contract: "legacy" | "recursive",
): McpServer {
  const server = new McpServer({ name: SIMULATED_USER_MCP_SERVER_NAME, version: "1.0.0" });

  server.registerTool("screenshot", {
    description: "Capture the visible review viewport or a visible element. Full element captures may return ordered image tiles.",
    inputSchema: z.object({
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("viewport") }).strict(),
        z.object({ kind: z.literal("element"), elementRef: z.string().min(1) }).strict(),
      ]),
      mode: z.enum(["visible", "full"]),
      label: z.string().min(1),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => traced(trace, now, "screenshot", input, async () => {
    try {
      const capture = await controller.screenshot(input);
      if (capture.output.ok && capture.images.length !== capture.output.screenshot.tileCount) {
        throw new Error("Screenshot image tile count does not match immutable screenshot metadata");
      }
      const base = mcpResult(capture.output);
      return capture.output.ok
        ? { ...base, content: [...base.content, ...capture.images.map((image) => ({ type: "image" as const, ...image }))] }
        : base;
    } catch (error) {
      return mcpResult(explorationFailure("screenshot", error));
    }
  }));

  server.registerTool("interact", {
    description: "Activate one visible accessible review control by element reference.",
    inputSchema: z.object({ elementRef: z.string().min(1), activate: z.literal(true) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => traced(trace, now, "interact", input, async () => {
    try {
      return mcpResult(await controller.interact(input));
    } catch (error) {
      return mcpResult(explorationFailure("interact", error));
    }
  }));

  server.registerTool("history", {
    description: "Move backward or forward through review-session UI history with a non-zero integer delta.",
    inputSchema: z.object({ delta: z.number().int().refine((delta) => delta !== 0, "History delta must be non-zero") }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => traced(trace, now, "history", input, async () => {
    try {
      return mcpResult(await controller.history(input));
    } catch (error) {
      return mcpResult(explorationFailure("history", error));
    }
  }));

  if (contract === "recursive") {
    registerRecursiveReviewTools(server, reviewStore as RecursivePresentationReviewStore, trace, now);
    return server;
  }

  const legacyStore = reviewStore as SimulatedUserReviewStore;
  server.registerTool("reviewLayer", {
    description: "Create or revise the screenshot-grounded assessment for one reachable layer.",
    inputSchema: z.object({ review: layerReviewSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ review }) => traced(trace, now, "reviewLayer", { review }, async () => {
    const typedReview = review as LayerReview;
    try {
      assertNullRatingsJustified(review.ratings, review.nullRatingJustifications, ["review", "ratings"]);
      const revision = legacyStore.reviewLayer(typedReview);
      return mcpResult<ReviewLayerToolOutput>({
        ok: true,
        disposition: revision.revision === 1 ? "created" : "revised",
        layerId: typedReview.layerId,
      });
    } catch (error) {
      return mcpResult<ReviewLayerToolOutput>(reviewFailure("reviewLayer", error));
    }
  }));

  server.registerTool("reviewNode", {
    description: "Create or revise one node assessment, including every visible action and whether expansion, reference, or invoke affordances are needed even when absent.",
    inputSchema: z.object({ review: nodeReviewSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ review }) => traced(trace, now, "reviewNode", { review }, async () => {
    const typedReview = review as NodeReview;
    try {
      assertNullRatingsJustified(review.ratings, review.nullRatingJustifications, ["review", "ratings"]);
      for (const [index, action] of review.actions.entries()) {
        assertNullRatingsJustified(
          action.ratings,
          action.nullRatingJustifications,
          ["review", "actions", index, "ratings"],
        );
      }
      const revision = legacyStore.reviewNode(typedReview);
      return mcpResult<ReviewNodeToolOutput>({
        ok: true,
        disposition: revision.revision === 1 ? "created" : "revised",
        nodeId: typedReview.nodeId,
      });
    } catch (error) {
      return mcpResult<ReviewNodeToolOutput>(reviewFailure("reviewNode", error));
    }
  }));

  server.registerTool("submitReview", {
    description: "Finalize the overall turn review after all reachable layer, node, and visible action coverage is complete.",
    inputSchema: z.object({ review: turnReviewSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ review }) => traced(trace, now, "submitReview", { review }, async () => {
    const typedReview = review as TurnReview;
    try {
      assertNullRatingsJustified(review.ratings, review.nullRatingJustifications, ["review", "ratings"]);
      legacyStore.submitReview(typedReview);
      return mcpResult<SubmitReviewToolOutput>({ ok: true, finalized: true, turnId: typedReview.turnId });
    } catch (error) {
      return mcpResult<SubmitReviewToolOutput>(reviewFailure("submitReview", error));
    }
  }));

  return server;
}

function registerRecursiveReviewTools(
  server: McpServer,
  store: RecursivePresentationReviewStore,
  trace: McpToolTraceEntry[],
  now: () => Date,
): void {
  server.registerTool("reviewNode", {
    description: "Write or revise one node result after all expansion LayerResults and any reference targets present in the recursive inventory are finalized. A reference-only target absent from inventory is delivery-graded from screenshots with reusedLayerId null. Rank expand, reference, invoke, and stop at every allocation step, and review every authored action.",
    inputSchema: z.object({ review: recursiveNodeReviewSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ review }) => traced(trace, now, "reviewNode", { review }, async () => {
    try {
      const typed = review as RecursiveNodeReview;
      const revision = store.reviewNode(typed);
      return mcpResult({
        ok: true,
        disposition: revision.revision === 1 ? "created" : "revised",
        nodeId: typed.nodeId,
      });
    } catch (error) {
      return mcpResult(reviewFailure("reviewNode", error));
    }
  }));

  server.registerTool("reviewLayer", {
    description: "Finalize or revise one bottom-up LayerResult. Supply exactly eight aligned score and semantic slots; occupied slots must preserve the current node results and unused slots must be null.",
    inputSchema: z.object({ review: recursiveLayerResultSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ review }) => traced(trace, now, "reviewLayer", { review }, async () => {
    try {
      const typed = review as unknown as RecursiveLayerResult;
      const revision = store.reviewLayer(typed);
      return mcpResult({
        ok: true,
        disposition: revision.revision === 1 ? "created" : "revised",
        layerId: typed.layerId,
        layerResult: typed,
      });
    } catch (error) {
      return mcpResult(reviewFailure("reviewLayer", error));
    }
  }));

  server.registerTool("submitReview", {
    description: "Finalize the graph-presentation turn judgment using the original request, bounded artifact evidence, and the current root LayerResult only.",
    inputSchema: z.object({ review: recursiveTurnReviewSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ review }) => traced(trace, now, "submitReview", { review }, async () => {
    try {
      const typed = review as unknown as RecursiveTurnReview;
      assertNullRatingsJustified(typed.ratings, typed.nullRatingJustifications, ["review", "ratings"]);
      store.submitReview(typed);
      return mcpResult({ ok: true, finalized: true, turnId: typed.turnId });
    } catch (error) {
      return mcpResult(reviewFailure("submitReview", error));
    }
  }));
}

async function traced(
  trace: McpToolTraceEntry[],
  now: () => Date,
  tool: SimulatedUserToolName,
  argumentsValue: unknown,
  invoke: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const sequence = trace.length + 1;
  const startedAt = now().toISOString();
  try {
    const result = await invoke();
    trace.push({
      sequence,
      tool,
      startedAt,
      completedAt: now().toISOString(),
      status: result.isError === true ? "failed" : "completed",
      arguments: structuredClone(argumentsValue),
      output: structuredClone(result.structuredContent),
    });
    return result;
  } catch (error) {
    trace.push({
      sequence,
      tool,
      startedAt,
      completedAt: now().toISOString(),
      status: "failed",
      arguments: structuredClone(argumentsValue),
      error: errorMessage(error),
    });
    throw error;
  }
}

function mcpResult<Output extends { readonly ok: boolean }>(output: Output): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: structuredClone(output) as Record<string, unknown>,
    isError: !output.ok,
  };
}

function reviewFailure<ToolName extends ReviewToolName>(
  tool: ToolName,
  error: unknown,
): ReviewToolFailure<ToolName> {
  const issues: ReviewValidationIssue[] = error instanceof ScreenshotEvidenceValidationError
    ? [...error.issues]
    : error instanceof NullRatingJustificationError
      ? [{ code: "unjustified_null_rating", path: error.path, message: error.message }]
      : [{ code: error instanceof MissingReviewSubjectsError ? "incomplete_coverage" : "invalid_input", path: [], message: errorMessage(error) }];
  return {
    ok: false,
    error: {
      schemaVersion: 1,
      kind: "review_validation_error",
      tool,
      message: errorMessage(error),
      issues,
      missingSubjects: error instanceof MissingReviewSubjectsError ? [...error.missingSubjects] : [],
    },
  };
}

function explorationFailure<ToolName extends ExplorationToolName>(
  tool: ToolName,
  error: unknown,
): SimulatedUserToolFailure<ToolName> {
  const message = errorMessage(error);
  const code = tool === "screenshot"
    ? "capture_failed"
    : tool === "history" && /outside|out of range/i.test(message)
      ? "history_out_of_range"
      : tool === "interact" && /unknown|invisible/i.test(message)
        ? "unknown_element"
        : "invalid_input";
  return {
    ok: false,
    error: {
      schemaVersion: 1,
      kind: "tool_error",
      tool,
      code,
      message,
    },
  };
}

function assertNullRatingsJustified(
  ratings: Readonly<Record<string, unknown>>,
  justifications: Readonly<Record<string, string | undefined>> | undefined,
  path: readonly (string | number)[],
): void {
  for (const [criterion, rating] of Object.entries(ratings)) {
    if (rating === null && !justifications?.[criterion]?.trim()) {
      throw new NullRatingJustificationError(criterion, [...path, criterion]);
    }
  }
}

class NullRatingJustificationError extends Error {
  constructor(
    readonly criterion: string,
    readonly path: readonly (string | number)[],
  ) {
    super(`Null rating requires justification: ${criterion}`);
    this.name = "NullRatingJustificationError";
  }
}

function hasBearerToken(request: IncomingMessage, expectedToken: string): boolean {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function sendStatus(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

function listenLoopback(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const SIMULATED_USER_MCP_TOOL_NAMES = SIMULATED_USER_JUDGE_CONTRACT_V1.toolNames;
