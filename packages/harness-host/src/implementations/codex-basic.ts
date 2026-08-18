import { Codex } from "@openai/codex-sdk";
import { RelayerGraphClient, type CompletionOutput, type GraphCapability, type GraphNode } from "@relayer/graph-client";
import type { Harness, HarnessFactory, HarnessFactoryContext, HarnessSessionState } from "../types.js";

export const CODEX_BASIC_KEY = "codex.basic";

type CodexThread = ReturnType<Codex["startThread"]>;

export interface CodexBasicDependencies {
  readonly createCodex?: (environment: Record<string, string>) => Codex;
  readonly clientModuleUrl?: string;
}

export class CodexBasicHarness implements Harness {
  private graphClient: RelayerGraphClient;
  private codex: Codex;
  private graph: GraphCapability;
  private readonly clientModuleUrl: string;
  private thread: CodexThread | undefined;
  private codexThreadId: string | undefined;

  constructor(private readonly context: HarnessFactoryContext, private readonly dependencies: CodexBasicDependencies = {}) {
    this.graph = context.graph;
    this.graphClient = new RelayerGraphClient(context.graph);
    this.codex = this.createCodex(context.graph);
    this.clientModuleUrl = dependencies.clientModuleUrl ?? import.meta.resolve("@relayer/graph-client");
    if (context.savedState !== undefined && context.savedState.schemaVersion !== 1) {
      throw new Error(`Unsupported codex.basic session state version: ${context.savedState.schemaVersion}`);
    }
    const codexThreadId = context.savedState?.values.codexThreadId;
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
    return {
      schemaVersion: 1,
      values: this.codexThreadId === undefined ? {} : { codexThreadId: this.codexThreadId },
    };
  }

  private createCodex(graph: GraphCapability): Codex {
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    environment.RELAYER_GRAPH_URL = graph.url;
    environment.RELAYER_GRAPH_TOKEN = graph.token;
    environment.RELAYER_NODE_ID = String(graph.nodeId);
    return this.dependencies.createCodex?.(environment) ?? new Codex({ env: environment });
  }

  private openThread(): CodexThread {
    const options = {
      workingDirectory: this.context.workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write" as const,
      approvalPolicy: "never" as const,
      networkAccessEnabled: true,
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

The visible layer must contain 1 to 8 nodes and must be connected. Layer edges are exactly what the user sees. If a graph call rejects an object, read its error message, repair only that object, and retry. The graph is complete only after graph.submit succeeds.`;
  }
}

export function createCodexBasicFactory(dependencies: CodexBasicDependencies = {}): HarnessFactory {
  return (context) => new CodexBasicHarness(context, dependencies);
}

function sameCapability(left: GraphCapability, right: GraphCapability): boolean {
  return left.url === right.url && left.token === right.token && left.nodeId === right.nodeId;
}
