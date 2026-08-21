import { Codex, type ApprovalMode, type CodexOptions, type ModelReasoningEffort, type SandboxMode, type ThreadEvent, type ThreadItem, type ThreadOptions, type WebSearchMode } from "@openai/codex-sdk";
import { RELAYER_ICON_NAMES, type GraphCapability, type GraphNode } from "@relayer/graph-client";
import { redactTraceData } from "../trace.js";
import type { Harness, HarnessFactory, HarnessFactoryContext, HarnessRunContext, HarnessSessionState, HarnessTraceSpan, HarnessTraceSupport, JsonObject } from "../types.js";

export const CODEX_BASIC_KEY = "codex.basic";

type CodexThread = ReturnType<Codex["startThread"]>;

export interface CodexBasicDependencies {
  readonly createCodex?: (environment: Record<string, string>, codexPathOverride: string | undefined, config: CodexConfiguration) => Codex;
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

type CodexConfiguration = NonNullable<CodexOptions["config"]>;

interface ResolvedCodexConfiguration {
  readonly threadOptions: CodexBasicConfiguration;
  readonly codexConfig: CodexConfiguration;
  readonly promptProfile?: "layered-navigation-v1";
}

export class CodexBasicHarness implements Harness {
  private readonly clientModuleUrl: string;
  private readonly threadOptions: CodexBasicConfiguration;
  private readonly codexConfig: CodexConfiguration;
  private readonly promptProfile: ResolvedCodexConfiguration["promptProfile"];
  private codexThreadId: string | undefined;

  constructor(private readonly context: HarnessFactoryContext, private readonly dependencies: CodexBasicDependencies = {}) {
    const resolved = parseCodexBasicConfiguration(context);
    this.threadOptions = resolved.threadOptions;
    this.codexConfig = resolved.codexConfig;
    this.promptProfile = resolved.promptProfile;
    this.clientModuleUrl = dependencies.clientModuleUrl ?? import.meta.resolve("@relayer/graph-client");
    const codexThreadId = context.savedState?.codexThreadId;
    this.codexThreadId = typeof codexThreadId === "string" ? codexThreadId : undefined;
  }

  async complete(context: HarnessRunContext, signal?: AbortSignal): Promise<void> {
    const model = this.selectedModel(context);
    const capability = context.graph.acquireCapability();
    const thread = this.openThread(this.createCodex(capability), model);
    try {
      const prompt = this.prompt(context.inputGraph);
      context.trace.emit({ type: "prompt", data: { text: prompt, interactionNodeId: context.inputGraph.id } });
      if (typeof thread.runStreamed !== "function") {
        await thread.run(prompt, signal === undefined ? {} : { signal });
        return;
      }
      const streamed = await thread.runStreamed(prompt, signal === undefined ? {} : { signal });
      const spans = new Map<string, HarnessTraceSpan>();
      for await (const event of streamed.events) traceCodexEvent(context, event, spans);
    } finally {
      this.codexThreadId = thread.id ?? this.codexThreadId;
    }
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

  private createCodex(graph: GraphCapability): Codex {
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    environment.RELAYER_GRAPH_URL = graph.url;
    environment.RELAYER_GRAPH_TOKEN = graph.token;
    environment.RELAYER_NODE_ID = String(graph.nodeId);
    return this.dependencies.createCodex?.(environment, this.dependencies.codexPathOverride, this.codexConfig) ?? new Codex({
      env: environment,
      config: this.codexConfig,
      ...(this.dependencies.codexPathOverride === undefined ? {} : {
        codexPathOverride: this.dependencies.codexPathOverride,
      }),
    });
  }

  private selectedModel(context: HarnessRunContext): string | undefined {
    if (context.model === undefined) return this.threadOptions.model;
    if (context.model.providerId !== "codex") {
      throw new Error(`codex.basic cannot run provider ${context.model.providerId}`);
    }
    return context.model.modelId;
  }

  private openThread(codex: Codex, model: string | undefined): CodexThread {
    const { additionalDirectories, ...configuredOptions } = this.threadOptions;
    const options: ThreadOptions = {
      workingDirectory: this.context.workingDirectory,
      ...configuredOptions,
      ...(model === undefined ? {} : { model }),
      ...(additionalDirectories === undefined ? {} : { additionalDirectories: [...additionalDirectories] }),
    };
    return this.codexThreadId === undefined ? codex.startThread(options) : codex.resumeThread(this.codexThreadId, options);
  }

  private prompt(interactionNode: GraphNode): string {
    if (this.promptProfile === "layered-navigation-v1") {
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

function traceCodexEvent(context: HarnessRunContext, event: ThreadEvent, spans: Map<string, HarnessTraceSpan>): void {
  const providerEventId = providerItemId(event);
  context.trace.emit({
    type: "provider.event",
    ...(providerEventId === undefined ? {} : { providerEventId }),
    data: { provider: "codex", event: redactTraceData(event) },
  });
  if (event.type === "turn.started") {
    spans.set("turn", context.trace.openSpan({ name: "Codex model turn", kind: "model" }));
    context.trace.emit({ type: "model.call.started", data: { provider: "codex" } });
    return;
  }
  if (event.type === "turn.completed") {
    context.trace.emit({ type: "usage", data: { provider: "codex", ...event.usage } });
    context.trace.emit({ type: "model.call.completed", data: { provider: "codex", status: "completed" } });
    spans.get("turn")?.end("completed");
    spans.delete("turn");
    return;
  }
  if (event.type === "turn.failed") {
    context.trace.emit({ type: "model.call.completed", data: { provider: "codex", status: "failed", error: event.error.message } });
    spans.get("turn")?.end("failed", { error: event.error.message });
    spans.delete("turn");
    return;
  }
  if (event.type === "error") {
    context.trace.emit({ type: "error", data: { provider: "codex", message: event.message } });
    return;
  }
  if (event.type === "item.started") traceCodexItemStarted(context, event.item, spans);
  if (event.type === "item.completed") traceCodexItemCompleted(context, event.item, spans);
}

function traceCodexItemStarted(context: HarnessRunContext, item: ThreadItem, spans: Map<string, HarnessTraceSpan>): void {
  if (!isCodexToolItem(item)) return;
  const span = context.trace.openSpan({ name: codexItemLabel(item), kind: "tool", providerSpanId: item.id });
  spans.set(item.id, span);
  span.emit({ type: "tool.call.started", data: codexItemData(item) });
}

function traceCodexItemCompleted(context: HarnessRunContext, item: ThreadItem, spans: Map<string, HarnessTraceSpan>): void {
  if (item.type === "agent_message") {
    context.trace.emit({ type: "message", data: { role: "assistant", text: item.text } });
    return;
  }
  if (item.type === "reasoning") {
    context.trace.emit({ type: "reasoning.summary", data: { text: item.text } });
    return;
  }
  if (item.type === "error") {
    context.trace.emit({ type: "error", data: { message: item.message } });
    return;
  }
  if (!isCodexToolItem(item)) return;
  const span = spans.get(item.id) ?? context.trace.openSpan({ name: codexItemLabel(item), kind: "tool", providerSpanId: item.id });
  const failed = ("status" in item && item.status === "failed") || (item.type === "mcp_tool_call" && item.error !== undefined);
  span.emit({ type: "tool.call.completed", data: { ...codexItemData(item), status: failed ? "failed" : "completed" } });
  span.end(failed ? "failed" : "completed");
  spans.delete(item.id);
}

function isCodexToolItem(item: ThreadItem): boolean {
  return item.type === "command_execution" || item.type === "file_change" || item.type === "mcp_tool_call" || item.type === "web_search";
}

function codexItemLabel(item: ThreadItem): string {
  if (item.type === "command_execution") return "Command execution";
  if (item.type === "file_change") return "File change";
  if (item.type === "mcp_tool_call") return `${item.server}.${item.tool}`;
  if (item.type === "web_search") return "Web search";
  return item.type;
}

function codexItemData(item: ThreadItem): JsonObject {
  if (item.type === "command_execution") return redactTraceData({ itemType: item.type, command: item.command, output: item.aggregated_output, exitCode: item.exit_code ?? null }) as JsonObject;
  if (item.type === "file_change") return redactTraceData({ itemType: item.type, changes: item.changes }) as JsonObject;
  if (item.type === "mcp_tool_call") return redactTraceData({ itemType: item.type, server: item.server, tool: item.tool, arguments: item.arguments, result: item.result, error: item.error }) as JsonObject;
  if (item.type === "web_search") return { itemType: item.type, query: item.query };
  return { itemType: item.type };
}

function providerItemId(event: ThreadEvent): string | undefined {
  return "item" in event ? event.item.id : event.type === "thread.started" ? event.thread_id : undefined;
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
    threadOptions: {
      ...(model === undefined ? {} : { model }),
      ...(modelReasoningEffort === undefined ? {} : { modelReasoningEffort }),
      sandboxMode: permission.sandboxMode,
      approvalPolicy: permission.approvalPolicy,
      ...(permission.networkAccessEnabled === undefined ? {} : { networkAccessEnabled: permission.networkAccessEnabled }),
      ...(webSearchMode === undefined ? {} : { webSearchMode }),
      ...(skipGitRepoCheck === undefined ? {} : { skipGitRepoCheck }),
      ...(additionalDirectories === undefined ? {} : { additionalDirectories }),
    },
    codexConfig: permission.approvalsReviewer === undefined ? {} : { approvals_reviewer: permission.approvalsReviewer },
    ...(promptProfile === undefined ? {} : { promptProfile }),
  };
}

function parseCodexPermissionBinding(profileId: string, binding: JsonObject): {
  readonly sandboxMode: SandboxMode;
  readonly approvalPolicy: ApprovalMode;
  readonly approvalsReviewer?: "user" | "auto_review";
  readonly networkAccessEnabled?: boolean;
} {
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
