import { Codex, type ApprovalMode, type ModelReasoningEffort, type SandboxMode, type ThreadOptions, type WebSearchMode } from "@openai/codex-sdk";
import { RelayerGraphClient, type CompletionOutput, type GraphCapability, type GraphNode } from "@relayer/graph-client";
import type { Harness, HarnessFactory, HarnessFactoryContext, HarnessSessionState } from "../types.js";

export const CODEX_BASIC_KEY = "codex.basic";

type CodexThread = ReturnType<Codex["startThread"]>;

export interface CodexBasicDependencies {
  readonly createCodex?: (environment: Record<string, string>, codexPathOverride?: string) => Codex;
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

export class CodexBasicHarness implements Harness {
  private graphClient: RelayerGraphClient;
  private codex: Codex;
  private graph: GraphCapability;
  private readonly clientModuleUrl: string;
  private readonly threadOptions: CodexBasicConfiguration;
  private thread: CodexThread | undefined;
  private codexThreadId: string | undefined;

  constructor(private readonly context: HarnessFactoryContext, private readonly dependencies: CodexBasicDependencies = {}) {
    this.graph = context.graph;
    this.graphClient = new RelayerGraphClient(context.graph);
    this.codex = this.createCodex(context.graph);
    this.clientModuleUrl = dependencies.clientModuleUrl ?? import.meta.resolve("@relayer/graph-client");
    this.threadOptions = parseCodexBasicConfiguration(context);
    const codexThreadId = context.savedState?.codexThreadId;
    this.codexThreadId = typeof codexThreadId === "string" ? codexThreadId : undefined;
  }

  setGraphCapability(graph: GraphCapability): void {
    if (sameCapability(this.graph, graph)) return;
    this.graph = graph;
    this.graphClient = new RelayerGraphClient(graph);
    this.codex = this.createCodex(graph);
    this.thread = undefined;
  }

  async complete(interactionNode: GraphNode, signal?: AbortSignal): Promise<CompletionOutput> {
    const thread = this.thread ?? this.openThread();
    this.thread = thread;
    try {
      const turn = await thread.run(this.prompt(interactionNode), signal === undefined ? {} : { signal });
      try {
        return await this.graphClient.getCompletionOutput(interactionNode.id);
      } catch (error) {
        const suffix = turn.finalResponse.trim() ? ` Codex said: ${turn.finalResponse.trim()}` : "";
        throw new Error(`Codex ended its turn without accepting a graph completion.${suffix}`, { cause: error });
      }
    } finally {
      this.codexThreadId = thread.id ?? this.codexThreadId;
    }
  }

  state(): HarnessSessionState {
    return this.codexThreadId === undefined ? {} : { codexThreadId: this.codexThreadId };
  }

  private createCodex(graph: GraphCapability): Codex {
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    environment.RELAYER_GRAPH_URL = graph.url;
    environment.RELAYER_GRAPH_TOKEN = graph.token;
    environment.RELAYER_NODE_ID = String(graph.nodeId);
    return this.dependencies.createCodex?.(environment, this.dependencies.codexPathOverride) ?? new Codex({
      env: environment,
      ...(this.dependencies.codexPathOverride === undefined ? {} : {
        codexPathOverride: this.dependencies.codexPathOverride,
      }),
    });
  }

  private openThread(): CodexThread {
    const { additionalDirectories, ...configuredOptions } = this.threadOptions;
    const options: ThreadOptions = {
      workingDirectory: this.context.workingDirectory,
      ...configuredOptions,
      ...(additionalDirectories === undefined ? {} : { additionalDirectories: [...additionalDirectories] }),
    };
    return this.codexThreadId === undefined ? this.codex.startThread(options) : this.codex.resumeThread(this.codexThreadId, options);
  }

  private prompt(interactionNode: GraphNode): string {
    return `You are the basic Relayer graph harness. Answer the current user interaction by authoring and accepting a useful graph layer.

Current interaction node: ${interactionNode.id}
User text: ${interactionNode.detail}

Use executable JavaScript and the Relayer graph client. Do not return a JSON graph in chat. Write a small .mjs file in the working directory and run it with Node.js. Import from:
${this.clientModuleUrl}

The module exports RelayerGraphClient, NodeObject, EdgeObject, and LayerObject. Use RelayerGraphClient.fromEnv(). The required order is:
1. create NodeObject values with icon, title, and useful markdown detail;
2. await graph.submitNode(node) for each node;
3. await graph.createEdge(leftNode, rightNode) for each visible undirected connection;
4. create and await graph.submitLayer(new LayerObject(nodes, edges));
5. await graph.addAction(${interactionNode.id}, { kind: "navigate", label: "Response", target: layer, response: true });
6. await graph.submit(${interactionNode.id}).

The visible layer must contain 1 to 8 nodes and must be connected. Layer edges are exactly what the user sees.

A response may contain additional layers. When a concept benefits from deeper explanation, you may submit another LayerObject and attach it to an output node with await graph.addAction(node, { kind: "navigate", label: "Useful label", target: childLayer }). This is optional: use it only when the additional layer materially improves the answer. You may similarly add an invoke action with { kind: "invoke", label: "Useful label", interactionText: "A useful follow-up" } when a suggested follow-up is valuable. Submit every referenced node, edge, and layer before adding its action.

If a graph call rejects an object, read its error message, repair only that object, and retry. The graph is complete only after graph.submit succeeds.`;
  }
}

function parseCodexBasicConfiguration(context: HarnessFactoryContext): CodexBasicConfiguration {
  const selected = context.configuration;
  if (selected.implementation !== CODEX_BASIC_KEY) {
    throw new Error(`codex.basic cannot run implementation ${selected.implementation}`);
  }
  if (selected.implementationVersion !== 1) {
    throw new Error(`Unsupported codex.basic implementation version: ${selected.implementationVersion}`);
  }
  const configuration = selected.settings;
  const allowed = new Set(["model", "modelReasoningEffort", "sandboxMode", "approvalPolicy", "networkAccessEnabled", "webSearchMode", "skipGitRepoCheck", "additionalDirectories"]);
  const unknown = Object.keys(configuration).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown codex.basic configuration field: ${unknown.join(", ")}`);

  const model = optionalString(configuration.model, "model");
  const modelReasoningEffort = optionalEnum(configuration.modelReasoningEffort, ["minimal", "low", "medium", "high", "xhigh"] as const, "modelReasoningEffort");
  const sandboxMode = optionalEnum(configuration.sandboxMode, ["read-only", "workspace-write", "danger-full-access"] as const, "sandboxMode");
  const approvalPolicy = optionalEnum(configuration.approvalPolicy, ["never", "on-request", "on-failure", "untrusted"] as const, "approvalPolicy");
  const webSearchMode = optionalEnum(configuration.webSearchMode, ["disabled", "cached", "live"] as const, "webSearchMode");
  const networkAccessEnabled = optionalBoolean(configuration.networkAccessEnabled, "networkAccessEnabled");
  const skipGitRepoCheck = optionalBoolean(configuration.skipGitRepoCheck, "skipGitRepoCheck");
  const additionalDirectories = optionalStringArray(configuration.additionalDirectories, "additionalDirectories");

  return {
    ...(model === undefined ? {} : { model }),
    ...(modelReasoningEffort === undefined ? {} : { modelReasoningEffort }),
    ...(sandboxMode === undefined ? {} : { sandboxMode }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(networkAccessEnabled === undefined ? {} : { networkAccessEnabled }),
    ...(webSearchMode === undefined ? {} : { webSearchMode }),
    ...(skipGitRepoCheck === undefined ? {} : { skipGitRepoCheck }),
    ...(additionalDirectories === undefined ? {} : { additionalDirectories }),
  };
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

function sameCapability(left: GraphCapability, right: GraphCapability): boolean {
  return left.url === right.url && left.token === right.token && left.nodeId === right.nodeId;
}
