import { randomUUID } from "node:crypto";
import { checkpointWithHostAssets, detailAssetIds, finalizedDetail, finalizeWithHostAssets, type HostResolvedDetailAsset } from "./detail-host.js";
import type { CompiledNodeDetail } from "./detail.js";
import { EdgeObject, LayerObject, NodeObject, actionId, edgeId, layerId, nodeId, type ActionObject, type ActionReference, type EdgeReference, type LayerReference, type NodeReference } from "./objects.js";
import { GRAPH_QUERY_CONTRACT_VERSION } from "./query-errors.generated.js";
import { GraphQueryError, isGraphQueryErrorBody, type GraphQueryErrorBody, type GraphSearchOptions, type GraphSearchRequest, type GraphSearchResult } from "./query.js";
import { GraphApiError, type CompletionInputGraph, type CompletionOutput, type CompletionState, type CurrentTransitionReceipt, type GraphAction, type GraphApiErrorBody, type GraphCapability, type GraphEdge, type GraphId, type GraphLayer, type GraphNode, type InteractionInput, type ResolvedLayer, type ResolvedPersonalPresentation, type StopReason } from "./types.js";

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

  async getInteractionInput(): Promise<InteractionInput> {
    return this.request<InteractionInput>("/api/graph/input");
  }

  async getPersonalPresentation(): Promise<ResolvedPersonalPresentation> {
    return this.request<ResolvedPersonalPresentation>("/api/graph/personal-presentation");
  }

  async submitNode(node: NodeObject): Promise<GraphNode> {
    const authoredDetail = await this.finalizeNodeDetail(node);
    const body = await this.request<{ node: GraphNode }>("/api/graph/nodes", {
      method: "POST",
      body: JSON.stringify({
        clientKey: node.clientKey,
        kind: node.kind,
        icon: node.icon,
        title: node.title,
        detail: node.detail,
        ...(authoredDetail.components.length === 0 ? {} : { authoredDetail }),
      }),
    });
    node.ref = body.node;
    return body.node;
  }

  async checkpointNodeDetail(node: NodeObject): Promise<CompiledNodeDetail> {
    const finalized = finalizedDetail(node.detailAuthoring);
    if (finalized !== undefined) return finalized;
    const assets = await this.resolveDetailAssets(node);
    return checkpointWithHostAssets(node.detailAuthoring, assets);
  }

  private async finalizeNodeDetail(node: NodeObject): Promise<CompiledNodeDetail> {
    const finalized = finalizedDetail(node.detailAuthoring);
    if (finalized !== undefined) return finalized;
    const assets = await this.resolveDetailAssets(node);
    return finalizeWithHostAssets(node.detailAuthoring, assets);
  }

  private async resolveDetailAssets(node: NodeObject): Promise<readonly (HostResolvedDetailAsset | null)[]> {
    const logicalIds = detailAssetIds(node.detailAuthoring);
    if (logicalIds.length === 0) return [];
    const body = await this.request<{ readonly assets: readonly (HostResolvedDetailAsset | null)[] }>("/api/graph/detail-assets/resolve", {
      method: "POST",
      body: JSON.stringify({ logicalIds }),
    });
    return body.assets;
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

  async submitLayer(layer: LayerObject, options: { readonly sizeJustification?: string } = {}): Promise<ResolvedLayer["layer"]> {
    const body = await this.request<{ layer: ResolvedLayer["layer"] }>("/api/graph/layers", {
      method: "POST",
      body: JSON.stringify({
        clientKey: layer.clientKey,
        nodes: layer.nodes.map(nodeId),
        edges: layer.edges.map(edgeId),
        layout: {
          version: layer.layout.version,
          placements: layer.layout.placements.map((placement) => ({
            nodeId: nodeId(placement.node),
            x: placement.x,
            y: placement.y,
          })),
        },
        sizeJustification: options.sizeJustification,
      }),
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
        sourceLayerId: action.sourceLayer === undefined ? null : layerId(action.sourceLayer),
        kind: action.kind,
        relation: action.relation,
        label: action.label,
        variant: action.variant ?? "pill",
        icon: action.icon ?? null,
        description: action.description ?? null,
        targetLayerId: layerId(action.target),
      } : action.kind === "invoke" ? {
        clientKey,
        sourceNodeId: nodeId(source),
        sourceLayerId: layerId(action.sourceLayer),
        kind: action.kind,
        label: action.label,
        variant: action.variant ?? "pill",
        icon: action.icon ?? null,
        description: action.description ?? null,
        interactionText: action.interactionText,
      } : {
        clientKey,
        sourceNodeId: nodeId(source),
        sourceLayerId: layerId(action.sourceLayer),
        kind: action.kind,
        label: action.label,
        variant: action.variant ?? "pill",
        icon: action.icon ?? null,
        description: action.description ?? null,
        control: action.control,
        prompt: action.prompt,
        ...(action.control === "text" ? {} : { options: action.options }),
        ...(action.minimumSelections === undefined ? {} : { minimumSelections: action.minimumSelections }),
      }),
    });
    action.ref = body.action;
    return body.action;
  }

  async getLayer(reference: LayerReference): Promise<ResolvedLayer> {
    return this.request<ResolvedLayer>(`/api/graph/layers/${layerId(reference)}`);
  }

  async discardLayer(reference: LayerReference): Promise<GraphLayer> {
    const layer = await this.request<{ layer: GraphLayer }>(
      `/api/graph/layers/${layerId(reference)}/discard`,
      { method: "POST" },
    );
    if (reference instanceof LayerObject) reference.ref = layer.layer;
    return layer.layer;
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

  async getCurrent(): Promise<CompletionState> {
    return this.request<CompletionState>("/api/graph/current");
  }

  async prepareComplete(action: ActionReference): Promise<CompletionInputGraph> {
    return this.request<CompletionInputGraph>("/api/graph/completions/prepare", {
      method: "POST",
      body: JSON.stringify({ actionId: actionId(action) }),
    });
  }

  async advanceCurrent(layer: LayerReference, expectedRevision: number, operationKey: string): Promise<CurrentTransitionReceipt> {
    return this.transitionCurrent(expectedRevision, operationKey, { kind: "advance", layerId: layerId(layer) });
  }

  async returnCurrent(layer: LayerReference, expectedRevision: number, operationKey: string): Promise<CurrentTransitionReceipt> {
    return this.transitionCurrent(expectedRevision, operationKey, { kind: "return", layerId: layerId(layer) });
  }

  async stopCurrent(expectedRevision: number, operationKey: string, reason: StopReason): Promise<CurrentTransitionReceipt> {
    return this.transitionCurrent(expectedRevision, operationKey, { kind: "stop", reason });
  }

  private async transitionCurrent(
    expectedRevision: number,
    operationKey: string,
    transition: { readonly kind: "advance" | "return"; readonly layerId: GraphId }
      | { readonly kind: "stop"; readonly reason: string },
  ): Promise<CurrentTransitionReceipt> {
    return this.request<CurrentTransitionReceipt>("/api/graph/current/transitions", {
      method: "POST",
      body: JSON.stringify({ expectedRevision, operationKey, transition }),
    });
  }

  async search(request: GraphSearchRequest, options: GraphSearchOptions = {}): Promise<GraphSearchResult> {
    const result = await this.request<unknown>("/api/graph/search", {
      method: "POST",
      body: JSON.stringify({
        queryContractVersion: request.queryContractVersion,
        ...(request.target === undefined ? {} : {
          target: { scope: request.target.scope, id: request.target.id },
        }),
        query: request.query,
        parameters: request.parameters ?? {},
        budget: request.budget ?? {},
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, "query");
    if (!isVersionedGraphSearchResult(result)) {
      throw new GraphApiError(
        200,
        "invalid_search_response",
        "queryContractVersion",
        `Graph search response must use query contract version ${GRAPH_QUERY_CONTRACT_VERSION}`,
      );
    }
    return result;
  }

  private async request<T>(path: string, init: RequestInit = {}, errorKind: "api" | "query" = "api"): Promise<T> {
    const response = await fetch(`${this.capability.url}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.capability.token}`, ...init.headers },
    });
    const body = await response.json().catch(() => ({})) as T & GraphApiErrorBody & GraphQueryErrorBody;
    if (!response.ok) {
      if (errorKind === "query" && isGraphQueryErrorBody(body)) {
        throw new GraphQueryError(
          response.status,
          body.error.code,
          body.error.phase,
          body.error.path,
          body.error.message ?? `Graph search failed with ${response.status}`,
        );
      }
      throw new GraphApiError(
        response.status,
        body.error?.code ?? "request_failed",
        body.error?.path,
        body.error?.message ?? `Graph request failed with ${response.status}`,
        body.error?.issues ?? [],
      );
    }
    return body;
  }
}

function requireReference(value: NodeReference | undefined): NodeReference {
  if (value === undefined) throw new Error("createEdge requires two node references");
  return value;
}

function isVersionedGraphSearchResult(value: unknown): value is GraphSearchResult {
  return typeof value === "object"
    && value !== null
    && "queryContractVersion" in value
    && value.queryContractVersion === GRAPH_QUERY_CONTRACT_VERSION;
}

export { EdgeObject, LayerObject, NodeObject };
export type { ActionObject, EdgeReference, LayerReference, NodeReference };
