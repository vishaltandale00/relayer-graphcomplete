import type { ApprovalMode, ModelReasoningEffort, SandboxMode, WebSearchMode } from "@openai/codex-sdk";
import { RELAYER_ICON_NAMES, type GraphCapability, type GraphNode } from "@relayer/graph-client";
import { redactTraceData } from "../trace.js";
import {
  runCodexAppServerTurn,
  type CodexAppServerSpawn,
  type CodexAppServerTurnOptions,
} from "./codex-app-server.js";
import type { Harness, HarnessFactory, HarnessFactoryContext, HarnessRunContext, HarnessSessionState, HarnessTraceSupport, JsonObject } from "../types.js";

export const CODEX_BASIC_KEY = "codex.basic";

export interface CodexBasicDependencies {
  readonly runAppServerTurn?: (options: CodexAppServerTurnOptions) => ReturnType<typeof runCodexAppServerTurn>;
  readonly spawnProcess?: CodexAppServerSpawn;
  readonly clientModuleUrl?: string;
  readonly codexPathOverride?: string;
}

interface CodexBasicConfiguration {
  readonly model?: string;
  readonly modelReasoningEffort?: ModelReasoningEffort;
  readonly sandboxMode?: SandboxMode;
  readonly approvalPolicy?: ApprovalMode;
  readonly networkAccessEnabled?: boolean;
  readonly webSearchMode?: WebSearchMode;
  readonly skipGitRepoCheck?: boolean;
  readonly additionalDirectories?: readonly string[];
}

interface ResolvedCodexConfiguration {
  readonly settings: CodexBasicConfiguration;
  readonly permission: ResolvedCodexPermission;
  readonly promptProfile?: "layered-navigation-v1";
}

interface ResolvedCodexPermission {
  readonly sandboxMode: SandboxMode;
  readonly approvalPolicy: ApprovalMode;
  readonly approvalsReviewer?: "user" | "auto_review";
  readonly networkAccessEnabled?: boolean;
}

export class CodexBasicHarness implements Harness {
  private readonly clientModuleUrl: string;
  private readonly resolved: ResolvedCodexConfiguration;
  private codexThreadId: string | undefined;

  constructor(private readonly context: HarnessFactoryContext, private readonly dependencies: CodexBasicDependencies = {}) {
    const resolved = parseCodexBasicConfiguration(context);
    this.resolved = resolved;
    this.clientModuleUrl = dependencies.clientModuleUrl ?? import.meta.resolve("@relayer/graph-client");
    const codexThreadId = context.savedState?.codexThreadId;
    this.codexThreadId = typeof codexThreadId === "string" ? codexThreadId : undefined;
  }

  async complete(context: HarnessRunContext, signal?: AbortSignal): Promise<void> {
    const model = this.selectedModel(context);
    const capability = context.graph.acquireCapability();
    const environment = this.graphEnvironment(capability);
    const sandboxPolicy = this.sandboxPolicy();
    const run = this.dependencies.runAppServerTurn ?? runCodexAppServerTurn;
    const prompt = this.prompt(context.inputGraph);
    context.trace.emit({ type: "prompt", data: { text: prompt, interactionNodeId: context.inputGraph.id } });
    await run({
      environment,
      ...(this.dependencies.codexPathOverride === undefined ? {} : { codexPathOverride: this.dependencies.codexPathOverride }),
      ...(this.codexThreadId === undefined ? {} : { savedThreadId: this.codexThreadId }),
      threadParams: this.threadParams(model),
      turnParams: this.turnParams(sandboxPolicy, model),
      prompt,
      approvals: context.approvals,
      workingDirectory: this.context.workingDirectory,
      sandboxPolicy,
      ...(signal === undefined ? {} : { signal }),
      ...(this.dependencies.spawnProcess === undefined ? {} : { spawnProcess: this.dependencies.spawnProcess }),
      onThreadId: (threadId) => { this.codexThreadId = threadId; },
      onNotification: (method, params) => traceCodexAppServerNotification(context, method, params),
    });
  }

  traceSupport(): HarnessTraceSupport {
    return {
      prompt: "full",
      messages: "full",
      reasoningSummaries: "full",
      modelCalls: "full",
      toolCalls: "full",
      usage: "full",
      childStreams: "none",
      nativeArtifacts: "none",
    };
  }

  state(): HarnessSessionState {
    return this.codexThreadId === undefined ? {} : { codexThreadId: this.codexThreadId };
  }

  private graphEnvironment(graph: GraphCapability): Record<string, string> {
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    environment.RELAYER_GRAPH_URL = graph.url;
    environment.RELAYER_GRAPH_TOKEN = graph.token;
    environment.RELAYER_NODE_ID = String(graph.nodeId);
    return environment;
  }

  private selectedModel(context: HarnessRunContext): string | undefined {
    if (context.model === undefined) return this.resolved.settings.model;
    if (context.model.providerId !== "codex") {
      throw new Error(`codex.basic cannot run provider ${context.model.providerId}`);
    }
    return context.model.modelId;
  }

  private threadParams(model: string | undefined): JsonObject {
    const { settings, permission } = this.resolved;
    const config: Record<string, JsonObject[keyof JsonObject]> = {};
    if (settings.skipGitRepoCheck !== undefined) config.skip_git_repo_check = settings.skipGitRepoCheck;
    if (settings.webSearchMode !== undefined) config.web_search = settings.webSearchMode;
    return {
      cwd: this.context.workingDirectory,
      approvalPolicy: permission.approvalPolicy,
      sandbox: permission.sandboxMode,
      ...(permission.approvalsReviewer === undefined ? {} : { approvalsReviewer: permission.approvalsReviewer }),
      ...(model === undefined ? {} : { model }),
      ...(Object.keys(config).length === 0 ? {} : { config }),
      serviceName: "relayer_graphcomplete",
    };
  }

  private turnParams(sandboxPolicy: JsonObject, model: string | undefined): JsonObject {
    const { settings, permission } = this.resolved;
    return {
      cwd: this.context.workingDirectory,
      approvalPolicy: permission.approvalPolicy,
      ...(permission.approvalsReviewer === undefined ? {} : { approvalsReviewer: permission.approvalsReviewer }),
      sandboxPolicy,
      ...(model === undefined ? {} : { model }),
      ...(settings.modelReasoningEffort === undefined ? {} : { effort: settings.modelReasoningEffort }),
    };
  }

  private sandboxPolicy(): JsonObject {
    const { settings, permission } = this.resolved;
    if (permission.sandboxMode === "danger-full-access") return { type: "dangerFullAccess" };
    if (permission.sandboxMode === "read-only") {
      return { type: "readOnly", networkAccess: permission.networkAccessEnabled ?? false };
    }
    return {
      type: "workspaceWrite",
      writableRoots: [this.context.workingDirectory, ...(settings.additionalDirectories ?? [])],
      networkAccess: permission.networkAccessEnabled ?? false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  private prompt(interactionNode: GraphNode): string {
    if (this.resolved.promptProfile === "layered-navigation-v1") {
      return this.layeredNavigationPrompt(interactionNode);
    }
    return `You are the basic Relayer graph harness. Answer the current user interaction by authoring and accepting a useful graph layer.

Current interaction node: ${interactionNode.id}
User text: ${interactionNode.detail}

Use executable JavaScript and the Relayer graph client. Do not return a JSON graph in chat. Write a small .mjs file in the system temporary directory, not in the project checkout, and run it with Node.js. Import from:
${this.clientModuleUrl}

The module exports RelayerGraphClient, NodeObject, EdgeObject, and LayerObject. Use RelayerGraphClient.fromEnv(). The required order is:
1. create NodeObject values with icon, title, and useful markdown detail;
2. await graph.submitNode(node) for each node;
3. await graph.createEdge(leftNode, rightNode) for each visible undirected connection;
4. create and await graph.submitLayer(new LayerObject(nodes, edges));
5. await graph.addAction(${interactionNode.id}, { kind: "navigate", label: "Response", target: layer, response: true });
6. await graph.submit(${interactionNode.id}).

The visible layer must contain 1 to 8 nodes and must be connected. Layer edges are exactly what the user sees.

Every node icon, and every optional action icon, must use exactly one supported Relayer icon name. Unsupported names are rejected so that you can repair the object. Choose the closest semantic name from:
${RELAYER_ICON_NAMES.join(", ")}

Relayer graph affordances:
- A node can be a complete explanation in the current layer.
- A node can open a more detailed child layer. Submit the child LayerObject, then attach it with await graph.addAction(node, { kind: "navigate", label: "Useful label", target: childLayer, variant: "pill" }).
- A node can offer a useful follow-up interaction with await graph.addAction(node, { kind: "invoke", label: "Useful label", interactionText: "A useful follow-up", variant: "chip" }).

Every action uses Relayer's renderer-independent presentation grammar. You author its order, kind and payload, label, optional supported icon, and one of these variants:
- "chip": the most compact inline action;
- "pill": the standard rounded action and the default when variant is omitted;
- "wide": a full-width action for a prominent next step;
- "card": a full-width action with both label and a required supporting description, for example { variant: "card", label: "Compare approaches", description: "Lay out the tradeoffs before choosing.", icon: "git-compare" }.

Choose variants with the available inspector space in mind: chips and pills suit several concise choices, while wide actions and cards consume more vertical space. This footprint guidance is advisory, not a limit. You may freely mix variants, author multiple cards, and let a useful action list scroll. Do not author HTML, CSS, colors, dimensions, or style fields. Description is supported only by card actions.

Navigate and invoke actions are first-class options, not requirements for every node. Use them where they materially improve the answer, and submit every referenced node, edge, and layer before adding its action.

If a graph call rejects an object, read its error message, repair only that object, and retry. The graph is complete only after graph.submit succeeds.`;
  }

  private layeredNavigationPrompt(interactionNode: GraphNode): string {
    return `You are the Relayer layered-navigation harness. Your task is to answer the current user interaction with a useful graph. A flat answer is valid. Add navigation only when opening it would materially improve understanding or support; apply that same test again inside every layer you author.

Current interaction node: ${interactionNode.id}
User text: ${interactionNode.detail}

Use executable JavaScript and the Relayer graph client. Do not return a JSON graph in chat. Write a small .mjs file in the system temporary directory, not in the project checkout, and run it with Node.js. Import from:
${this.clientModuleUrl}

The module exports RelayerGraphClient, NodeObject, EdgeObject, and LayerObject. Use RelayerGraphClient.fromEnv(). Author in whatever order fits the task, while submitting each referenced object before using it. The final graph call must be await graph.submit(${interactionNode.id}); call it only after the full response has been authored.

The current interaction may carry an invoke lease created by the product. Before authoring, use graph.getNode(${interactionNode.id}) and graph.getNeighbors(${interactionNode.id}) to inspect the current node and any relevant source context exposed by the graph. Treat that context as input to your answer; do not copy, forge, or manage lease metadata. Author the response normally. A successful ordinary graph.submit(${interactionNode.id}) automatically fulfills any lease held by this interaction. There is no separate resolveAction call.

Navigation has two meanings:
- "expand" continues the explanation with a more detailed layer. Expansion must not point back to an expansion ancestor.
- "reference" opens supporting evidence or context. References may reuse an accepted layer, may point to other reference layers, and may revisit a layer.

The interaction node must have one root navigate action with relation: "expand" and no sourceLayer. Every action on a response node must include sourceLayer: the LayerObject in which you are authoring that action. Expansion layers may author expand, reference, or invoke actions. A layer reached as a reference may author only reference actions. Do not create both expand and reference actions to the same new target layer.

Examples:
await graph.addAction(${interactionNode.id}, { kind: "navigate", relation: "expand", label: "Response", target: rootLayer });
await graph.addAction(node, { kind: "navigate", relation: "expand", sourceLayer: rootLayer, label: "Explain further", target: detailLayer });
await graph.addAction(node, { kind: "navigate", relation: "reference", sourceLayer: rootLayer, label: "View evidence", target: evidenceLayer });
await graph.addAction(node, { kind: "invoke", sourceLayer: rootLayer, label: "Follow up", interactionText: "Ask a useful follow-up" });

Layers normally contain 1 to 5 nodes. A layer may contain 6 to 8 nodes only when keeping them together is important; pass that private reason as await graph.submitLayer(layer, { sizeJustification: "..." }). Never mention or expose the size justification in user-facing node text. More than 8 nodes must be split into useful layers.

Layer edges are exactly what the user sees and are undirected. Every node needs a supported icon, a short title, and useful markdown detail. Optional action icons must also use a supported Relayer icon name:
${RELAYER_ICON_NAMES.join(", ")}

Action variants are "chip", "pill", "wide", or "card". A card requires description; other variants do not accept one. Do not author HTML, CSS, colors, dimensions, or style fields.

The graph service enforces exact provenance, target visibility, layer size, expansion cycles, and accepted closure. If a call fails, read every natural-language issue, repair the rejected object or missing closure, and retry. A model turn ending is not completion. The task is complete only when the final graph.submit call succeeds.`;
  }
}

function traceCodexAppServerNotification(context: HarnessRunContext, method: string, params: unknown): void {
  const data = redactTraceData(params) as JsonObject;
  const item = isRecord(data.item) ? data.item : undefined;
  const providerEventId = typeof item?.id === "string" ? item.id : undefined;
  context.trace.emit({
    type: "provider.event",
    ...(providerEventId === undefined ? {} : { providerEventId }),
    data: { provider: "codex", method, params: data },
  });
  if (method === "turn/started") {
    context.trace.emit({ type: "model.call.started", data: { provider: "codex" } });
    return;
  }
  if (method === "turn/completed") {
    const turn = isRecord(data.turn) ? data.turn : {};
    const status = turn.status === "completed" ? "completed" : "failed";
    const usage = isRecord(turn.usage) ? turn.usage : isRecord(data.usage) ? data.usage : undefined;
    if (usage !== undefined) context.trace.emit({ type: "usage", data: { provider: "codex", ...usage } });
    context.trace.emit({ type: "model.call.completed", data: { provider: "codex", status } });
    return;
  }
  if (method === "error") {
    const error = isRecord(data.error) ? data.error : {};
    context.trace.emit({ type: "error", data: { provider: "codex", message: String(error.message ?? "Codex turn failed") } });
    return;
  }
  if (method !== "item/completed" || item === undefined) return;
  if (item.type === "agentMessage" && typeof item.text === "string") {
    context.trace.emit({ type: "message", data: { role: "assistant", text: item.text } });
  } else if (item.type === "reasoning" && typeof item.text === "string") {
    context.trace.emit({ type: "reasoning.summary", data: { text: item.text } });
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCodexBasicConfiguration(context: HarnessFactoryContext): ResolvedCodexConfiguration {
  const selected = context.configuration;
  if (selected.implementation !== CODEX_BASIC_KEY) {
    throw new Error(`codex.basic cannot run implementation ${selected.implementation}`);
  }
  if (selected.implementationVersion !== 1) {
    throw new Error(`Unsupported codex.basic implementation version: ${selected.implementationVersion}`);
  }
  const configuration = selected.settings;
  const allowed = new Set(["model", "modelReasoningEffort", "webSearchMode", "skipGitRepoCheck", "additionalDirectories", "promptProfile"]);
  const unknown = Object.keys(configuration).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown codex.basic configuration field: ${unknown.join(", ")}`);

  const model = optionalString(configuration.model, "model");
  const modelReasoningEffort = optionalEnum(configuration.modelReasoningEffort, ["minimal", "low", "medium", "high", "xhigh"] as const, "modelReasoningEffort");
  const webSearchMode = optionalEnum(configuration.webSearchMode, ["disabled", "cached", "live"] as const, "webSearchMode");
  const skipGitRepoCheck = optionalBoolean(configuration.skipGitRepoCheck, "skipGitRepoCheck");
  const additionalDirectories = optionalStringArray(configuration.additionalDirectories, "additionalDirectories");
  const promptProfile = optionalEnum(configuration.promptProfile, ["layered-navigation-v1"] as const, "promptProfile");
  const permission = parseCodexPermissionBinding(context.permissionProfileId, context.permissionBinding);

  return {
    settings: {
      ...(model === undefined ? {} : { model }),
      ...(modelReasoningEffort === undefined ? {} : { modelReasoningEffort }),
      ...(webSearchMode === undefined ? {} : { webSearchMode }),
      ...(skipGitRepoCheck === undefined ? {} : { skipGitRepoCheck }),
      ...(additionalDirectories === undefined ? {} : { additionalDirectories }),
    },
    permission,
    ...(promptProfile === undefined ? {} : { promptProfile }),
  };
}

function parseCodexPermissionBinding(profileId: string, binding: JsonObject): ResolvedCodexPermission {
  const allowed = new Set(["sandboxMode", "approvalPolicy", "approvalsReviewer", "networkAccessEnabled"]);
  const unknown = Object.keys(binding).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown codex.basic permission binding field: ${unknown.join(", ")}`);
  const sandboxMode = optionalEnum(binding.sandboxMode, ["read-only", "workspace-write", "danger-full-access"] as const, "permission sandboxMode");
  const approvalPolicy = optionalEnum(binding.approvalPolicy, ["never", "on-request", "on-failure", "untrusted"] as const, "permission approvalPolicy");
  const approvalsReviewer = optionalEnum(binding.approvalsReviewer, ["user", "auto_review"] as const, "permission approvalsReviewer");
  const networkAccessEnabled = optionalBoolean(binding.networkAccessEnabled, "permission networkAccessEnabled");
  const expected = profileId === "ask"
    ? { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user" } as const
    : profileId === "auto"
      ? { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review" } as const
      : profileId === "full"
        ? { sandboxMode: "danger-full-access", approvalPolicy: "never" } as const
        : undefined;
  if (expected === undefined) throw new Error(`codex.basic does not support permission profile ${profileId}`);
  if (sandboxMode !== expected.sandboxMode || approvalPolicy !== expected.approvalPolicy) {
    throw new Error(`codex.basic permission binding ${profileId} does not match the product profile contract`);
  }
  if (profileId === "full") {
    if (approvalsReviewer !== undefined) throw new Error("codex.basic full permission binding must not configure an approvals reviewer");
    if (networkAccessEnabled !== undefined) throw new Error("codex.basic full permission binding must not claim sandbox network control");
    return { sandboxMode, approvalPolicy };
  }
  const expectedReviewer = profileId === "ask" ? "user" : "auto_review";
  if (approvalsReviewer !== expectedReviewer || networkAccessEnabled === undefined) {
    throw new Error(`codex.basic permission binding ${profileId} does not match the product profile contract`);
  }
  return { sandboxMode, approvalPolicy, approvalsReviewer, networkAccessEnabled };
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`codex.basic ${field} must be a non-empty string`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`codex.basic ${field} must be a boolean`);
  return value;
}

function optionalEnum<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`codex.basic ${field} must be one of: ${allowed.join(", ")}`);
  return value as T[number];
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`codex.basic ${field} must be an array of non-empty strings`);
  }
  return value;
}

export function createCodexBasicFactory(dependencies: CodexBasicDependencies = {}): HarnessFactory {
  return (context) => new CodexBasicHarness(context, dependencies);
}
