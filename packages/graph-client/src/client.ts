import { randomUUID } from "node:crypto";
import { EdgeObject, LayerObject, NodeObject, edgeId, layerId, nodeId, type ActionObject, type EdgeReference, type LayerReference, type NodeReference } from "./objects.js";
import { GraphApiError, type CompletionOutput, type GraphAction, type GraphApiErrorBody, type GraphCapability, type GraphEdge, type GraphId, type GraphNode, type ResolvedLayer } from "./types.js";

export class RelayerGraphClient {
  readonly capability: GraphCapability;

  constructor(capability: GraphCapability) {
    this.capability = { ...capability, url: capability.url.replace(/\/$/, "") };
  }

  static fromEnv(environment: NodeJS.ProcessEnv = process.env): RelayerGraphClient {
    const url = environment.RELAYER_GRAPH_URL;
    const token = environment.RELAYER_GRAPH_TOKEN;
    const node = Number(environment.RELAYER_NODE_ID);
    if (!url || !token || !Number.isSafeInteger(node) || node < 1) {
      throw new Error("RELAYER_GRAPH_URL, RELAYER_GRAPH_TOKEN, and RELAYER_NODE_ID are required");
    }
    return new RelayerGraphClient({ url, token, nodeId: node });
  }

  async getNode(reference: NodeReference): Promise<GraphNode> {
    const body = await this.request<{ node: GraphNode }>(`/api/graph/nodes/${nodeId(reference)}`);
    return body.node;
  }

  async getNeighbors(reference: NodeReference): Promise<readonly GraphNode[]> {
    const body = await this.request<{ nodes: GraphNode[] }>(`/api/graph/nodes/${nodeId(reference)}/neighbors`);
    return body.nodes;
  }

  async submitNode(node: NodeObject): Promise<GraphNode> {
    const body = await this.request<{ node: GraphNode }>("/api/graph/nodes", {
      method: "POST",
      body: JSON.stringify({ clientKey: node.clientKey, kind: node.kind, icon: node.icon, title: node.title, detail: node.detail }),
    });
    node.ref = body.node;
    return body.node;
  }

  async createEdge(left: NodeReference, right: NodeReference, clientKey?: string): Promise<GraphEdge>;
  async createEdge(edge: EdgeObject): Promise<GraphEdge>;
  async createEdge(leftOrEdge: NodeReference | EdgeObject, right?: NodeReference, clientKey = randomUUID()): Promise<GraphEdge> {
    const edge = leftOrEdge instanceof EdgeObject ? leftOrEdge : new EdgeObject([leftOrEdge, requireReference(right)], clientKey);
    const body = await this.request<{ edge: GraphEdge }>("/api/graph/edges", {
      method: "POST",
      body: JSON.stringify({ clientKey: edge.clientKey, endpoints: edge.endpoints.map(nodeId) }),
    });
    edge.ref = body.edge;
    return body.edge;
  }

  async createEdges(pairs: readonly (readonly [NodeReference, NodeReference])[]): Promise<readonly GraphEdge[]> {
    const edges: GraphEdge[] = [];
    for (const pair of pairs) edges.push(await this.createEdge(pair[0], pair[1]));
    return edges;
  }

  async submitLayer(layer: LayerObject): Promise<ResolvedLayer["layer"]> {
    const body = await this.request<{ layer: ResolvedLayer["layer"] }>("/api/graph/layers", {
      method: "POST",
      body: JSON.stringify({ clientKey: layer.clientKey, nodes: layer.nodes.map(nodeId), edges: layer.edges.map(edgeId) }),
    });
    layer.ref = body.layer;
    return body.layer;
  }

  async addAction(source: NodeReference, action: ActionObject): Promise<GraphAction> {
    const clientKey = action.clientKey ??= randomUUID();
    const body = await this.request<{ action: GraphAction }>("/api/graph/actions", {
      method: "POST",
      body: JSON.stringify(action.kind === "navigate" ? {
        clientKey,
        sourceNodeId: nodeId(source),
        kind: action.kind,
        label: action.label,
        targetLayerId: layerId(action.target),
        response: action.response ?? false,
      } : {
        clientKey,
        sourceNodeId: nodeId(source),
        kind: action.kind,
        label: action.label,
        interactionText: action.interactionText,
      }),
    });
    action.ref = body.action;
    return body.action;
  }

  async getLayer(reference: LayerReference): Promise<ResolvedLayer> {
    return this.request<ResolvedLayer>(`/api/graph/layers/${layerId(reference)}`);
  }

  async submit(interactionNode: NodeReference = this.capability.nodeId): Promise<CompletionOutput> {
    return this.request<CompletionOutput>("/api/graph/submit", {
      method: "POST",
      body: JSON.stringify({ nodeId: nodeId(interactionNode) }),
    });
  }

  async getCompletionOutput(interactionNode: NodeReference = this.capability.nodeId): Promise<CompletionOutput> {
    return this.request<CompletionOutput>(`/api/graph/nodes/${nodeId(interactionNode)}/output`);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.capability.url}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.capability.token}`, ...init.headers },
    });
    const body = await response.json().catch(() => ({})) as T & GraphApiErrorBody;
    if (!response.ok) {
      throw new GraphApiError(response.status, body.error?.code ?? "request_failed", body.error?.path, body.error?.message ?? `Graph request failed with ${response.status}`);
    }
    return body;
  }
}

function requireReference(value: NodeReference | undefined): NodeReference {
  if (value === undefined) throw new Error("createEdge requires two node references");
  return value;
}

export { EdgeObject, LayerObject, NodeObject };
export type { ActionObject, EdgeReference, LayerReference, NodeReference };
