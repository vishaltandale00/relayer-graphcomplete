import type { ApprovalMode, ModelReasoningEffort, SandboxMode, WebSearchMode } from "@openai/codex-sdk";
import { RELAYER_ICON_NAMES, type GraphCapability } from "@relayer/graph-client";
import { createHash } from "node:crypto";
import { INTERACTION_INPUT_GUIDANCE, renderInteractionInput } from "../interaction-input.js";
import { redactTraceData } from "../trace.js";
import {
  runCodexAppServerTurn,
  type CodexAppServerSpawn,
  type CodexAppServerTurnOptions,
} from "./codex-app-server.js";
import type {
  Harness,
  HarnessFactory,
  HarnessFactoryContext,
  HarnessRunContext,
  HarnessSessionState,
  HarnessTraceSpan,
  HarnessTraceSupport,
  HarnessTraceTerminalStatus,
  JsonObject,
  JsonValue,
} from "../types.js";

export const CODEX_BASIC_KEY = "codex.basic";

export interface CodexBasicDependencies {
  readonly runAppServerTurn?: (options: CodexAppServerTurnOptions) => ReturnType<typeof runCodexAppServerTurn>;
  readonly spawnProcess?: CodexAppServerSpawn;
  readonly clientModuleUrl?: string;
  readonly graphAuthoringLauncherPath?: string;
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
  readonly promptProfile?: "layered-navigation-v1" | "layered-navigation-multi-agent-v1";
}

interface ResolvedCodexPermission {
  readonly sandboxMode: SandboxMode;
  readonly approvalPolicy: ApprovalMode;
  readonly approvalsReviewer?: "user" | "auto_review";
  readonly networkAccessEnabled?: boolean;
}

interface CodexTraceState {
  readonly collaborationSpans: Map<string, HarnessTraceSpan>;
}

interface NormalizedCollaborationItem {
  readonly providerItemId?: string;
  readonly operation: "spawn_agent" | "send_input" | "resume_agent" | "wait" | "close_agent" | "unknown";
  readonly providerOperation?: string;
  readonly senderThreadId?: string;
  readonly receiverThreadIds?: readonly string[];
  readonly delegationPrompt?: string;
  readonly model?: string;
  readonly reasoningEffort?: JsonValue;
  readonly agentStates?: JsonObject;
  readonly status?: "in_progress" | "completed" | "failed";
}

export class CodexBasicHarness implements Harness {
  private readonly clientModuleUrl: string;
  private readonly resolved: ResolvedCodexConfiguration;
  private codexThreadId: string | undefined;
  private readonly activeForceShutdowns = new Set<AbortController>();

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
    const prompt = this.prompt(context);
    context.trace.emit({ type: "prompt", data: { text: prompt, interactionNodeId: context.inputGraph.id } });
    const traceState: CodexTraceState = { collaborationSpans: new Map() };
    const forceShutdown = new AbortController();
    this.activeForceShutdowns.add(forceShutdown);
    try {
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
        forceSignal: forceShutdown.signal,
        ...(this.dependencies.spawnProcess === undefined ? {} : { spawnProcess: this.dependencies.spawnProcess }),
        onThreadId: (threadId) => { this.codexThreadId = threadId; },
        onNotification: (method, params) => traceCodexAppServerNotification(context, method, params, traceState),
      });
    } finally {
      this.activeForceShutdowns.delete(forceShutdown);
      closeIncompleteCollaborationSpans(traceState);
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

  forceDispose(): void {
    for (const shutdown of this.activeForceShutdowns) shutdown.abort(new Error("Codex harness force-disposed"));
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

  private prompt(context: HarnessRunContext): string {
    const interactionNode = context.inputGraph;
    if (this.resolved.promptProfile === "layered-navigation-v1") {
      return this.layeredNavigationPrompt(context);
    }
    if (this.resolved.promptProfile === "layered-navigation-multi-agent-v1") {
      return `${this.layeredNavigationPrompt(context)}

Codex native subagents are available when useful. Subagents may directly author, revise, and submit graph objects using the available graph capability. Use the configured model family as appropriate; coordination remains native to Codex.`;
    }
    const launcher = this.graphAuthoringCommand();
    const launcherClause = this.dependencies.graphAuthoringLauncherPath ? " do not resolve the launcher or Node.js from PATH," : "";
    const launcherArgumentsClause = this.dependencies.graphAuthoringLauncherPath ? " with no arguments" : "";
    return `You are the basic Relayer graph harness. Answer the current user interaction by authoring and accepting a useful graph layer.

Current interaction node: ${interactionNode.id}
Normalized interaction input:
${renderInteractionInput(context.interactionInput)}

${INTERACTION_INPUT_GUIDANCE} In JavaScript, call graph.getInteractionInput() to re-read it.

Use executable JavaScript and the Relayer graph client. Do not return a JSON graph in chat. Run exactly ${launcher}${launcherArgumentsClause} and pass the program through standard input using a shell-native single-quoted here-document;${launcherClause} never place authored graph code in a --eval argument, and do not create a script in either the project checkout or a temporary directory. The quoted here-document must prevent the provider shell from expanding environment variables in the program. Import from:
${this.clientModuleUrl}

The module exports RelayerGraphClient, NodeObject, EdgeObject, NodePlacementObject, LayerLayoutObject, and LayerObject. Use RelayerGraphClient.fromEnv(). Give every persisted node, edge, layer, and action an explicit descriptive clientKey that is unique within this interaction and stable across edits and reruns. For example, use new NodeObject("info", "Summary", "...", "concept", "summary-node"), new EdgeObject([summaryNode, detailNode], "summary-detail-edge"), and new LayerObject(nodes, edges, layout, "response-layer"). Never rely on the constructors' generated client keys in an authored program.

The required order is:
1. create stable-keyed NodeObject values with icon, title, and useful markdown detail;
2. await graph.submitNode(node) for each node;
3. create a stable-keyed EdgeObject and await graph.createEdge(edge) for each visible undirected connection;
4. create a version-1 LayerLayoutObject with exactly one NodePlacementObject(node, x, y) per layer node, then await graph.submitLayer(new LayerObject(nodes, edges, layout, "response-layer"));
5. await graph.addAction(${interactionNode.id}, { kind: "navigate", relation: "expand", label: "Response", target: layer, clientKey: "root-response" });
6. await graph.submit(${interactionNode.id}).

The visible layer must contain 1 to 8 nodes and must be connected. Layer edges are exactly what the user sees.

Every new layer, including every child layer, requires an intentional authored layout. Coordinates are normalized numbers from 0 through 1 and describe semantic relative position independently of the viewport. Place a one-node layer at (0.5, 0.5). Keep flow or time moving consistently, use a parent or summary node to anchor hierarchy, group related nodes spatially, align comparisons deliberately, and avoid accidental overlap or edge crossings where a clearer arrangement is available. The renderer changes the camera for the viewport; do not derive coordinates from pixels, window size, or inspector state.

Every node icon, and every optional action icon, must use exactly one supported Relayer icon name. Unsupported names are rejected so that you can repair the object. Choose the closest semantic name from:
${RELAYER_ICON_NAMES.join(", ")}

Relayer graph affordances:
- A node can be a complete explanation in the current layer.
- A node can open a more detailed child layer. Submit the stable-keyed child LayerObject, then attach it with await graph.addAction(node, { kind: "navigate", relation: "expand", sourceLayer: layer, label: "Useful label", target: childLayer, variant: "pill", clientKey: "node-detail" }).
- A node can offer a useful follow-up interaction with await graph.addAction(node, { kind: "invoke", sourceLayer: layer, label: "Useful label", interactionText: "A useful follow-up", variant: "chip", clientKey: "node-follow-up" }).

Every action uses Relayer's renderer-independent presentation grammar. You author its order, kind and payload, label, optional supported icon, and one of these variants:
- "chip": the most compact inline action;
- "pill": the standard rounded action and the default when variant is omitted;
- "wide": a full-width action for a prominent next step;
- "card": a full-width action with both label and a required supporting description, for example { variant: "card", label: "Compare approaches", description: "Lay out the tradeoffs before choosing.", icon: "git-compare" }.

Choose variants with the available inspector space in mind: chips and pills suit several concise choices, while wide actions and cards consume more vertical space. This footprint guidance is advisory, not a limit. You may freely mix variants, author multiple cards, and let a useful action list scroll. Do not author HTML, CSS, colors, dimensions, or style fields. Description is supported only by card actions.

Navigate and invoke actions are first-class options, not requirements for every node. Use them where they materially improve the answer, and submit every referenced node, edge, and layer before adding its action.

If a graph call rejects an object or graph.submit reports a repairable issue, edit the same program and rerun it with the same clientKey values. Stable keys make the whole-program rerun update the same drafts instead of creating duplicates when each object's identity-owning context stays unchanged. An action's clientKey is scoped to its source node: keep every draft action on the same source node during repair, because moving it creates a different action and leaves the original draft behind. Do not add fake navigate or reference actions merely to make abandoned draft layers reachable. Only when graph.submit identifies a genuinely abandoned orphan draft, recover with graph.discardLayer(layer); this preserves that layer as stopped history without discarding its nodes, edges, actions, or child layers. The graph is complete only after graph.submit succeeds.`;
  }

  private layeredNavigationPrompt(context: HarnessRunContext): string {
    const interactionNode = context.inputGraph;
    const launcher = this.graphAuthoringCommand();
    const launcherClause = this.dependencies.graphAuthoringLauncherPath ? " do not resolve the launcher or Node.js from PATH," : "";
    const launcherArgumentsClause = this.dependencies.graphAuthoringLauncherPath ? " with no arguments" : "";
    return `You are the Relayer layered-navigation harness. Your task is to answer the current user interaction with a useful graph. A flat answer is valid. Add navigation only when opening it would materially improve understanding or support; apply that same test again inside every layer you author.

Current interaction node: ${interactionNode.id}
Normalized interaction input:
${renderInteractionInput(context.interactionInput)}

${INTERACTION_INPUT_GUIDANCE} In JavaScript, call graph.getInteractionInput() to re-read it.

Use executable JavaScript and the Relayer graph client. Do not return a JSON graph in chat. Run exactly ${launcher}${launcherArgumentsClause} and pass the program through standard input using a shell-native single-quoted here-document;${launcherClause} never place authored graph code in a --eval argument, and do not create a script in either the project checkout or a temporary directory. The quoted here-document must prevent the provider shell from expanding environment variables in the program. Import from:
${this.clientModuleUrl}

The module exports RelayerGraphClient, NodeObject, EdgeObject, NodePlacementObject, LayerLayoutObject, and LayerObject. Use RelayerGraphClient.fromEnv(). Give every persisted node, edge, layer, and action an explicit descriptive clientKey that is unique within this interaction and stable across edits and reruns. For example, use new NodeObject("info", "Summary", "...", "concept", "summary-node"), new EdgeObject([summaryNode, detailNode], "summary-detail-edge"), and new LayerObject(nodes, edges, layout, "response-layer"). Never rely on the constructors' generated client keys in an authored program. Author in whatever order fits the task, while submitting each referenced object before using it. The final graph call must be await graph.submit(${interactionNode.id}); call it only after the full response has been authored.

The current interaction may carry an invoke lease created by the product. Before authoring, use graph.getNode(${interactionNode.id}) and graph.getNeighbors(${interactionNode.id}) to inspect the current node and any relevant source context exposed by the graph. Treat that context as input to your answer; do not copy, forge, or manage lease metadata. Author the response normally. A successful ordinary graph.submit(${interactionNode.id}) automatically fulfills any lease held by this interaction. There is no separate resolveAction call.

Navigation has two meanings:
- "expand" continues the explanation with a more detailed layer. Expansion must not point back to an expansion ancestor.
- "reference" opens supporting evidence or context. References may reuse an accepted layer, may point to other reference layers, and may revisit a layer.

The interaction node must have one root navigate action with relation: "expand" and no sourceLayer. Every action on a response node must include sourceLayer: the LayerObject in which you are authoring that action. Expansion layers may author expand, reference, or invoke actions. A layer reached as a reference may author only reference actions. Do not create both expand and reference actions to the same new target layer.

Examples:
await graph.addAction(${interactionNode.id}, { kind: "navigate", relation: "expand", label: "Response", target: rootLayer, clientKey: "root-response" });
await graph.addAction(node, { kind: "navigate", relation: "expand", sourceLayer: rootLayer, label: "Explain further", target: detailLayer, clientKey: "node-detail" });
await graph.addAction(node, { kind: "navigate", relation: "reference", sourceLayer: rootLayer, label: "View evidence", target: evidenceLayer, clientKey: "node-evidence" });
await graph.addAction(node, { kind: "invoke", sourceLayer: rootLayer, label: "Follow up", interactionText: "Ask a useful follow-up", clientKey: "node-follow-up" });

Layers normally contain 1 to 5 nodes. A layer may contain 6 to 8 nodes only when keeping them together is important; pass that private reason as await graph.submitLayer(layer, { sizeJustification: "..." }). Never mention or expose the size justification in user-facing node text. More than 8 nodes must be split into useful layers.

Every new root, expansion, and reference layer requires a version-1 LayerLayoutObject with exactly one NodePlacementObject(node, x, y) per member node. Coordinates are normalized numbers from 0 through 1 and express semantic relative position independently of the viewport. Place a one-node layer at (0.5, 0.5). Keep flow or time moving consistently, use a parent or summary node to anchor hierarchy, group related nodes spatially, align comparisons deliberately, and avoid accidental overlap or edge crossings where a clearer arrangement is available. Do not use pixels, window size, or inspector state. Example: const layout = new LayerLayoutObject([new NodePlacementObject(first, 0.25, 0.5), new NodePlacementObject(second, 0.75, 0.5)]); const layer = new LayerObject([first, second], [edge], layout);

Layer edges are exactly what the user sees and are undirected. Every node needs a supported icon, a short title, and useful markdown detail. Optional action icons must also use a supported Relayer icon name:
${RELAYER_ICON_NAMES.join(", ")}

Action variants are "chip", "pill", "wide", or "card". A card requires description; other variants do not accept one. Do not author HTML, CSS, colors, dimensions, or style fields.

The graph service enforces exact provenance, target visibility, layer size, expansion cycles, and accepted closure. If a call fails, read every natural-language issue, edit the same program, and rerun it with the same clientKey values; stable keys make the whole-program rerun update the same drafts instead of creating duplicates when each object's identity-owning context stays unchanged. An action's clientKey is scoped to its source node: keep every draft action on the same source node during repair, because moving it creates a different action and leaves the original draft behind. Do not add fake navigate or reference actions merely to make abandoned draft layers reachable. Only when graph.submit identifies a genuinely abandoned orphan draft, recover with graph.discardLayer(layer); this preserves that layer as stopped history without discarding its nodes, edges, actions, or child layers. A model turn ending is not completion. The task is complete only when the final graph.submit call succeeds.`;
  }

  private graphAuthoringCommand(): string {
    const launcher = this.dependencies.graphAuthoringLauncherPath;
    if (launcher === undefined) return "node --input-type=module";
    if (!/^\/[A-Za-z0-9._/@+-]+$/.test(launcher)) {
      throw new Error("The graph-authoring launcher must be a shell-safe absolute path.");
    }
    return JSON.stringify(launcher);
  }
}

function traceCodexAppServerNotification(context: HarnessRunContext, method: string, params: unknown, state: CodexTraceState): void {
  const redactedParams = attachCommandExecutableAuthority(redactTraceData(params), params);
  const data = isRecord(redactedParams) ? redactedParams : {};
  const item = isRecord(data.item) ? data.item : undefined;
  const providerEventId = optionalNonemptyString(item?.id);
  context.trace.emit({
    type: "provider.event",
    ...(providerEventId === undefined ? {} : { providerEventId }),
    data: { provider: "codex", method, params: redactedParams },
  });
  try {
    const phase = collaborationNotificationPhase(method);
    if (phase !== undefined && item !== undefined && traceCodexCollaborationItem(context, phase, item, state.collaborationSpans)) return;
  } catch {
    // The raw provider event remains authoritative when a future or malformed shape cannot be normalized.
  }
  if (method === "turn/started") {
    context.trace.emit({ type: "model.call.started", data: { provider: "codex" } });
    return;
  }
  if (method === "turn/completed") {
    closeIncompleteCollaborationSpans(state);
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

function attachCommandExecutableAuthority(redactedParams: JsonValue, rawParams: unknown): JsonValue {
  if (!isRecord(redactedParams) || !isRecord(rawParams)) return redactedParams;
  const redactedItem = isRecord(redactedParams.item) ? redactedParams.item : undefined;
  const rawItem = isRecord(rawParams.item) ? rawParams.item : undefined;
  if (redactedItem?.type !== "commandExecution" || rawItem?.type !== "commandExecution") return redactedParams;
  const redactedActions = Array.isArray(redactedItem.commandActions) ? redactedItem.commandActions : undefined;
  const rawActions = Array.isArray(rawItem.commandActions) ? rawItem.commandActions : undefined;
  if (redactedActions === undefined || rawActions === undefined || redactedActions.length !== rawActions.length) return redactedParams;
  const commandActions = redactedActions.map((redactedAction, index) => {
    if (!isRecord(redactedAction) || !isRecord(rawActions[index])) return redactedAction;
    const {
      relayerExecutableAuthoritySha256: _untrustedExecutable,
      relayerCommandWordAuthoritySha256: _untrustedWords,
      relayerGraphAuthoringLauncherSha256: _untrustedGraphLauncher,
      ...safeAction
    } = redactedAction;
    const graphAuthoringLauncher = pinnedGraphAuthoringLauncher(rawActions[index].command);
    const words = shellCommandWords(rawActions[index].command);
    if (words === undefined) {
      return graphAuthoringLauncher === undefined ? safeAction : {
        ...safeAction,
        relayerGraphAuthoringLauncherSha256: createHash("sha256").update(graphAuthoringLauncher).digest("hex"),
      };
    }
    return {
      ...safeAction,
      ...(words[0]?.startsWith("/") ? {
        relayerExecutableAuthoritySha256: createHash("sha256").update(words[0]).digest("hex"),
      } : {}),
      relayerCommandWordAuthoritySha256: words.map((word) => (
        word.startsWith("/") ? createHash("sha256").update(word).digest("hex") : null
      )),
    };
  });
  return { ...redactedParams, item: { ...redactedItem, commandActions } };
}

function pinnedGraphAuthoringLauncher(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const match = /^("[^"\r\n]+") <<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*\r?\n/.exec(command.trim());
  if (!match) return undefined;
  try {
    const launcher = JSON.parse(match[1] ?? "null");
    return typeof launcher === "string" && /^\/[A-Za-z0-9._/@+-]+$/.test(launcher) ? launcher : undefined;
  } catch {
    return undefined;
  }
}

function shellCommandWords(command: unknown): string[] | undefined {
  if (typeof command !== "string" || /[\r\n\0]/.test(command)) return undefined;
  const input = command.trim();
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) return undefined;
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"') {
        index += 1;
        if (index >= input.length) return undefined;
        word += input[index];
      } else {
        word += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else if (character === "\\") {
      index += 1;
      if (index >= input.length) return undefined;
      word += input[index];
      started = true;
    } else if (/[;|&<>(){}!$`*?\[\]#]/.test(character)) {
      return undefined;
    } else {
      word += character;
      started = true;
    }
  }
  if (quote !== undefined) return undefined;
  if (started) words.push(word);
  return words.length > 0 ? words : undefined;
}

function traceCodexCollaborationItem(
  context: HarnessRunContext,
  phase: "started" | "completed",
  itemValue: JsonObject,
  spans: Map<string, HarnessTraceSpan>,
): boolean {
  const item = normalizeCollaborationItem(itemValue);
  if (item === undefined) return false;
  const data = collaborationItemData(item);
  const providerItemId = item.providerItemId;
  if (providerItemId === undefined) {
    context.trace.emit({
      type: phase === "started" ? "tool.call.started" : "tool.call.completed",
      data: { ...data, missingProviderItemId: true },
    });
    return true;
  }
  if (phase === "started") {
    if (spans.has(providerItemId)) return true;
    const span = context.trace.openSpan({
      name: collaborationItemLabel(item.operation),
      kind: "tool",
      providerSpanId: providerItemId,
    });
    spans.set(providerItemId, span);
    span.emit({ type: "tool.call.started", providerEventId: providerItemId, data });
    return true;
  }
  const missingStart = !spans.has(providerItemId);
  const span = spans.get(providerItemId) ?? context.trace.openSpan({
    name: collaborationItemLabel(item.operation),
    kind: "tool",
    providerSpanId: providerItemId,
  });
  if (missingStart) {
    span.emit({
      type: "tool.call.started",
      providerEventId: providerItemId,
      data: { ...data, missingStart: true },
    });
  }
  const terminalStatus: HarnessTraceTerminalStatus = item.status === "failed" ? "failed" : "completed";
  span.emit({
    type: "tool.call.completed",
    providerEventId: providerItemId,
    data: { ...data, ...(missingStart ? { missingStart: true } : {}) },
  });
  span.end(terminalStatus, missingStart ? { missingStart: true } : undefined);
  spans.delete(providerItemId);
  return true;
}

function closeIncompleteCollaborationSpans(state: CodexTraceState): void {
  for (const [providerItemId, span] of state.collaborationSpans) {
    try {
      span.end("partial", { providerItemId, reason: "Codex collaboration operation did not report completion" });
    } catch {
      // Trace finalization is best effort and must not change completion behavior.
    }
  }
  state.collaborationSpans.clear();
}

function normalizeCollaborationItem(value: JsonObject): NormalizedCollaborationItem | undefined {
  const itemType = normalizeName(value.type);
  if (itemType !== "collabtoolcall" && itemType !== "collabagenttoolcall") return undefined;
  const rawOperation = optionalNonemptyString(firstDefined(value, "tool", "operation"));
  if (rawOperation === undefined) return undefined;
  const operation = normalizeCollaborationOperation(rawOperation);
  const providerItemId = optionalNonemptyString(value.id);
  const senderThreadId = optionalNonemptyString(firstDefined(value, "sender_thread_id", "senderThreadId"));
  const receiverThreadIds = optionalStringList(firstDefined(value, "receiver_thread_ids", "receiverThreadIds"));
  const delegationPrompt = optionalPlainString(firstDefined(value, "prompt", "delegation_prompt", "delegationPrompt"));
  const model = optionalNonemptyString(value.model);
  const reasoningEffort = optionalJsonValue(firstDefined(value, "reasoning_effort", "reasoningEffort"));
  const agentStates = optionalAgentStates(firstDefined(value, "agents_states", "agentsStates"));
  const status = normalizeCollaborationStatus(value.status);
  return {
    ...(providerItemId === undefined ? {} : { providerItemId }),
    operation,
    ...(operation === "unknown" ? { providerOperation: rawOperation } : {}),
    ...(senderThreadId === undefined ? {} : { senderThreadId }),
    ...(receiverThreadIds === undefined ? {} : { receiverThreadIds }),
    ...(delegationPrompt === undefined ? {} : { delegationPrompt }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(agentStates === undefined ? {} : { agentStates }),
    ...(status === undefined ? {} : { status }),
  };
}

function collaborationItemData(item: NormalizedCollaborationItem): JsonObject {
  return redactTraceData({
    provider: "codex",
    coordinationOperation: true,
    itemType: "collaboration_operation",
    providerItemId: item.providerItemId,
    operation: item.operation,
    providerOperation: item.providerOperation,
    senderThreadId: item.senderThreadId,
    receiverThreadIds: item.receiverThreadIds,
    delegationPrompt: item.delegationPrompt,
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    agentStates: item.agentStates,
    status: item.status,
  }) as JsonObject;
}

function collaborationNotificationPhase(method: string): "started" | "completed" | undefined {
  const normalized = normalizeName(method);
  if (normalized === "itemstarted") return "started";
  if (normalized === "itemcompleted") return "completed";
  return undefined;
}

function collaborationItemLabel(operation: NormalizedCollaborationItem["operation"]): string {
  return operation === "unknown" ? "Codex collaboration operation" : `Codex ${operation}`;
}

function normalizeCollaborationOperation(value: string): NormalizedCollaborationItem["operation"] {
  const normalized = normalizeName(value);
  if (normalized === "spawnagent") return "spawn_agent";
  if (normalized === "sendinput") return "send_input";
  if (normalized === "resumeagent") return "resume_agent";
  if (normalized === "wait") return "wait";
  if (normalized === "closeagent") return "close_agent";
  return "unknown";
}

function normalizeCollaborationStatus(value: JsonValue | undefined): NormalizedCollaborationItem["status"] | undefined {
  const normalized = normalizeName(value);
  if (normalized === "inprogress") return "in_progress";
  if (normalized === "completed") return "completed";
  if (normalized === "failed") return "failed";
  return undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDefined(value: JsonObject, ...keys: readonly string[]): JsonValue | undefined {
  for (const key of keys) if (value[key] !== undefined) return value[key];
  return undefined;
}

function normalizeName(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() : "";
}

function optionalNonemptyString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalPlainString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalStringList(value: JsonValue | undefined): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function optionalAgentStates(value: JsonValue | undefined): JsonObject | undefined {
  if (!isRecord(value)) return undefined;
  const states: Record<string, JsonValue> = {};
  for (const [agentId, agentState] of Object.entries(value)) {
    if (typeof agentState === "string") {
      states[agentId] = agentState;
      continue;
    }
    if (!isRecord(agentState)) continue;
    const status = optionalNonemptyString(firstDefined(agentState, "status", "state"));
    if (status !== undefined) states[agentId] = { status };
  }
  return states;
}

function optionalJsonValue(value: JsonValue | undefined): JsonValue | undefined {
  return value;
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
  const promptProfile = optionalEnum(configuration.promptProfile, ["layered-navigation-v1", "layered-navigation-multi-agent-v1"] as const, "promptProfile");
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
