import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isProxy } from "node:util/types";
import { DetailCompilationError, NodeDetailAuthoring, beginNodeDetailAuthoringFinalization, cancelNodeDetailAuthoringFinalization, compileAuthenticatedNodeDetail, freezeNodeDetailAuthoring, isNodeDetailAuthoringOwner, snapshotAuthoredNodeDetailProgram, snapshotRetainedCompiledNodeDetail, type AuthenticatedNodeDetailOwnerSnapshot, type AuthenticatedNodeDetailProgramSnapshot, type CompiledNodeDetail } from "./detail.js";
import { isRelayerIconName } from "./icons.js";
import { applyAcceptedNodeResponse } from "./node-response.js";
import { EdgeObject, LayerObject, NodeObject, actionId, edgeId, layerId, nodeId, type ActionObject, type ActionReference, type EdgeReference, type LayerReference, type NodeReference } from "./objects.js";
import { GRAPH_QUERY_CONTRACT_VERSION } from "./query-errors.generated.js";
import { GraphQueryError, isGraphQueryErrorBody, type GraphQueryErrorBody, type GraphSearchOptions, type GraphSearchRequest, type GraphSearchResult } from "./query.js";
import { GraphApiError, type CompletionInputGraph, type CompletionOutput, type CompletionState, type CurrentTransitionReceipt, type GraphAction, type GraphApiErrorBody, type GraphCapability, type GraphEdge, type GraphId, type GraphLayer, type GraphNode, type InteractionInput, type ResolvedLayer, type ResolvedPersonalPresentation, type StopReason } from "./types.js";

export class RelayerGraphClient {
  readonly capability: GraphCapability;
  readonly #submittedDetails = new WeakMap<NodeObject, Promise<CompiledNodeDetail>>();
  readonly #acceptedDetails = new WeakMap<NodeObject, Promise<CompiledNodeDetail>>();
  readonly #submissionEnvelopes = new WeakMap<NodeObject, NodeSubmissionEnvelope>();
  readonly #submittedNodes = new WeakMap<NodeObject, Promise<GraphNode>>();

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

  submitNode(node: NodeObject): Promise<GraphNode> {
    const existing = this.#submittedNodes.get(node);
    if (existing !== undefined) return existing;
    const submission = deferred<GraphNode>();
    this.#submittedNodes.set(node, submission.promise);
    let work: Promise<GraphNode>;
    try {
      const envelope = this.submissionEnvelope(node);
      const acceptedDetail = deferred<CompiledNodeDetail>();
      this.#acceptedDetails.set(node, acceptedDetail.promise);
      void acceptedDetail.promise.catch(() => undefined);
      work = this.submitNodeEnvelope(node, envelope, acceptedDetail);
    } catch (error) {
      if (this.#submittedNodes.get(node) === submission.promise) this.#submittedNodes.delete(node);
      submission.reject(error);
      return submission.promise;
    }
    void work.then(submission.resolve, (error: unknown) => {
      if (this.#submittedNodes.get(node) === submission.promise) this.#submittedNodes.delete(node);
      this.#acceptedDetails.delete(node);
      submission.reject(error);
    });
    return submission.promise;
  }

  private async submitNodeEnvelope(
    node: NodeObject,
    envelope: NodeSubmissionEnvelope,
    acceptedDetail: ReturnType<typeof deferred<CompiledNodeDetail>>,
  ): Promise<GraphNode> {
    let authoredDetail: CompiledNodeDetail | undefined;
    try {
      authoredDetail = await this.finalizeNodeDetail(node, envelope);
      const body = await this.request<unknown>("/api/graph/nodes", {
        method: "POST",
        body: JSON.stringify({
          clientKey: envelope.clientKey,
          kind: envelope.kind,
          icon: envelope.icon,
          title: envelope.title,
          detail: envelope.detail,
          ...(authoredDetail.components.length === 0 ? {} : { authoredDetail }),
        }),
      });
      const accepted = validatedSubmittedNodeResponse(
        body,
        envelope.clientKey,
        authoredDetail.components.length === 0 ? undefined : authoredDetail,
      );
      acceptedDetail.resolve(accepted.authoredDetail ?? authoredDetail);
      applyAcceptedNodeResponse(envelope.owner.object, accepted);
      return accepted;
    } catch (error) {
      if (authoredDetail === undefined) acceptedDetail.reject(error);
      else acceptedDetail.resolve(authoredDetail);
      throw error;
    }
  }

  checkpointNodeDetail(node: NodeObject): Promise<CompiledNodeDetail> {
    const accepted = this.#acceptedDetails.get(node);
    if (accepted !== undefined) return accepted;
    const finalized = this.#submittedDetails.get(node);
    if (finalized !== undefined) return finalized;
    return this.compileNodeDetailCheckpoint(node);
  }

  private async compileNodeDetailCheckpoint(node: NodeObject): Promise<CompiledNodeDetail> {
    const envelope = materializeNodeSubmissionEnvelope(node);
    const program = snapshotAuthoredNodeDetailProgram(envelope.detailAuthoring, envelope.owner);
    const assets = await this.resolveDetailAssets(program);
    return compileAuthenticatedNodeDetail(program, assets);
  }

  private finalizeNodeDetail(node: NodeObject, envelope: NodeSubmissionEnvelope): Promise<CompiledNodeDetail> {
    const finalized = this.#submittedDetails.get(node);
    if (finalized !== undefined) return finalized;
    const finalization = deferred<CompiledNodeDetail>();
    this.#submittedDetails.set(node, finalization.promise);
    let work: Promise<CompiledNodeDetail>;
    try {
      work = this.compileAndFreezeNodeDetail(envelope);
    } catch (error) {
      if (this.#submittedDetails.get(node) === finalization.promise) this.#submittedDetails.delete(node);
      finalization.reject(error);
      return finalization.promise;
    }
    void work.then(finalization.resolve, (error: unknown) => {
      if (this.#submittedDetails.get(node) === finalization.promise) this.#submittedDetails.delete(node);
      finalization.reject(error);
    });
    return finalization.promise;
  }

  private async compileAndFreezeNodeDetail(envelope: NodeSubmissionEnvelope): Promise<CompiledNodeDetail> {
    const program = snapshotAuthoredNodeDetailProgram(envelope.detailAuthoring, envelope.owner);
    const finalization = beginNodeDetailAuthoringFinalization(envelope.detailAuthoring);
    try {
      const assets = await this.resolveDetailAssets(program);
      const compiled = compileAuthenticatedNodeDetail(program, assets);
      freezeNodeDetailAuthoring(envelope.detailAuthoring);
      return compiled;
    } catch (error) {
      cancelNodeDetailAuthoringFinalization(envelope.detailAuthoring, finalization);
      throw error;
    }
  }

  private async resolveDetailAssets(program: AuthenticatedNodeDetailProgramSnapshot): Promise<readonly ResolvedDetailAsset[]> {
    const logicalIds = program.logicalIds;
    if (logicalIds.length === 0) return [];
    const body = await this.request<unknown>("/api/graph/detail-assets/resolve", {
      method: "POST",
      body: JSON.stringify({ logicalIds }),
    });
    return validatedResolvedDetailAssets(body, logicalIds);
  }

  private submissionEnvelope(node: NodeObject): NodeSubmissionEnvelope {
    const existing = this.#submissionEnvelopes.get(node);
    if (existing !== undefined) return existing;
    const envelope = materializeNodeSubmissionEnvelope(node);
    this.#submissionEnvelopes.set(node, envelope);
    return envelope;
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

interface NodeSubmissionEnvelope {
  readonly owner: AuthenticatedNodeDetailOwnerSnapshot;
  readonly detailAuthoring: NodeDetailAuthoring;
  readonly clientKey: string;
  readonly kind: string;
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
}

const NODE_ENVELOPE_FIELDS = Object.freeze([
  "icon", "title", "detail", "kind", "clientKey", "detailAuthoring", "ref",
] as const);

function materializeNodeSubmissionEnvelope(node: NodeObject): NodeSubmissionEnvelope {
  try {
    if (Object.getPrototypeOf(node) !== NodeObject.prototype) return invalidNodeSubmissionEnvelope();
    const descriptors = Object.getOwnPropertyDescriptors(node);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !NODE_ENVELOPE_FIELDS.includes(key as typeof NODE_ENVELOPE_FIELDS[number]))) {
      return invalidNodeSubmissionEnvelope();
    }
    const values = new Map<string, unknown>();
    for (const field of NODE_ENVELOPE_FIELDS) {
      const descriptor = descriptors[field];
      if (descriptor === undefined) return invalidNodeSubmissionEnvelope();
      if (field === "ref") {
        if (descriptor.configurable !== false || descriptor.enumerable !== true
          || typeof descriptor.get !== "function" || descriptor.set !== undefined) {
          return invalidNodeSubmissionEnvelope();
        }
        continue;
      }
      if (!("value" in descriptor) || descriptor.enumerable !== true) return invalidNodeSubmissionEnvelope();
      values.set(field, descriptor.value);
    }
    const clientKey = values.get("clientKey");
    const kind = values.get("kind");
    const icon = values.get("icon");
    const title = values.get("title");
    const detail = values.get("detail");
    const detailAuthoring = values.get("detailAuthoring");
    if (typeof clientKey !== "string" || typeof kind !== "string" || typeof icon !== "string"
      || typeof title !== "string" || typeof detail !== "string" || !(detailAuthoring instanceof NodeDetailAuthoring)
      || !isNodeDetailAuthoringOwner(detailAuthoring, node)) {
      return invalidNodeSubmissionEnvelope();
    }
    const owner = Object.freeze({ object: node, clientKey });
    return Object.freeze({ owner, detailAuthoring, clientKey, kind, icon, title, detail });
  } catch (error) {
    if (error instanceof DetailCompilationError) throw error;
    return invalidNodeSubmissionEnvelope();
  }
}

function invalidNodeSubmissionEnvelope(): never {
  throw new DetailCompilationError(Object.freeze([Object.freeze({
    code: "node_envelope_invalid",
    componentId: "",
    path: "node",
    line: 1,
    column: 1,
    message: "Node submission fields must be ordinary own data properties",
  })]));
}

interface ResolvedDetailAsset {
  readonly logicalId: string;
  readonly authority: "current" | "stale";
  readonly availability: "available" | "unavailable" | "revoked";
  readonly digestSha256: string;
  readonly mediaType: string;
  readonly representation: { readonly kind: "image"; readonly sanitized: boolean };
}

const GRAPH_NODE_KEYS = Object.freeze(["detail", "icon", "id", "kind", "state", "title"]);

function validatedSubmittedNodeResponse(
  value: unknown,
  expectedClientKey: string,
  expectedAuthoredDetail?: CompiledNodeDetail,
): GraphNode {
  try {
    const envelope = snapshotNodeResponseRecord(
      value,
      ["node"],
      [],
      "response",
      "Response must contain exactly one ordinary node data property",
    );
    const candidate = snapshotNodeResponseRecord(
      envelope.values.node,
      GRAPH_NODE_KEYS,
      ["authoredDetail", "clientKey", "leasedActionId"],
      "node",
      "Node must use the exact ordinary GraphNode data shape",
    );
    const fields = candidate.values;
    if (!Number.isSafeInteger(fields.id) || (fields.id as number) < 1) {
      return invalidNodeResponse("node.id", "Node id must be a positive safe integer");
    }
    if (candidate.optionalFields.has("leasedActionId") && fields.leasedActionId !== null
      && (!Number.isSafeInteger(fields.leasedActionId) || (fields.leasedActionId as number) < 1)) {
      return invalidNodeResponse("node.leasedActionId", "Node leased action id must be null or a positive safe integer");
    }
    if (candidate.optionalFields.has("clientKey") && fields.clientKey !== expectedClientKey) {
      return invalidNodeResponse("node.clientKey", "Node client key must equal the stable key submitted by this client");
    }
    const kind = fields.kind;
    const title = fields.title;
    const detail = fields.detail;
    if (typeof kind !== "string" || kind.trim() === "") {
      return invalidNodeResponse("node.kind", "Node kind must be a nonblank string");
    }
    if (typeof title !== "string" || title.trim() === "") {
      return invalidNodeResponse("node.title", "Node title must be a nonblank string");
    }
    if (typeof detail !== "string" || detail.trim() === "") {
      return invalidNodeResponse("node.detail", "Node detail must be a nonblank string");
    }
    if (typeof fields.icon !== "string" || !isRelayerIconName(fields.icon)) {
      return invalidNodeResponse("node.icon", "Node icon must use the curated Relayer icon vocabulary");
    }
    if (fields.state !== "draft" && fields.state !== "accepted" && fields.state !== "stopped") {
      return invalidNodeResponse("node.state", "Node state must be draft, accepted, or stopped");
    }
    const hasAuthoredDetail = candidate.optionalFields.has("authoredDetail");
    const acceptedAuthoredDetail = expectedAuthoredDetail === undefined && hasAuthoredDetail
      ? snapshotRetainedCompiledNodeDetail(fields.authoredDetail)
      : expectedAuthoredDetail;
    if ((expectedAuthoredDetail !== undefined && (!hasAuthoredDetail || !isDeepStrictEqual(fields.authoredDetail, expectedAuthoredDetail)))
      || (expectedAuthoredDetail === undefined && hasAuthoredDetail && acceptedAuthoredDetail === undefined)) {
      return invalidNodeResponse(
        "node.authoredDetail",
        "Node authored detail must equal the canonical package submitted by this client",
      );
    }
    return Object.freeze({
      id: fields.id as number,
      ...(candidate.optionalFields.has("clientKey") ? { clientKey: expectedClientKey } : {}),
      ...(candidate.optionalFields.has("leasedActionId") ? { leasedActionId: fields.leasedActionId as number | null } : {}),
      kind,
      icon: fields.icon,
      title,
      detail,
      ...(acceptedAuthoredDetail === undefined ? {} : { authoredDetail: acceptedAuthoredDetail }),
      state: fields.state,
    });
  } catch (error) {
    if (error instanceof GraphApiError && error.code === "invalid_node_response") throw error;
    return invalidNodeResponse("response", "Response must be an ordinary valid GraphNode envelope");
  }
}

function snapshotNodeResponseRecord(
  value: unknown,
  requiredFields: readonly string[],
  optionalFields: readonly string[],
  path: string,
  message: string,
): { readonly values: Readonly<Record<string, unknown>>; readonly optionalFields: ReadonlySet<string> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return invalidNodeResponse(path, message);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
  const allowed = new Set([...requiredFields, ...optionalFields]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    return invalidNodeResponse(path, message);
  }
  const stringKeys = keys as string[];
  if (requiredFields.some((field) => !Object.hasOwn(descriptors, field))) {
    return invalidNodeResponse(path, message);
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const presentOptionalFields = new Set<string>();
  for (const key of stringKeys) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      return invalidNodeResponse(path, message);
    }
    values[key] = descriptor.value;
    if (optionalFields.includes(key)) presentOptionalFields.add(key);
  }
  return Object.freeze({
    values: Object.freeze(values),
    optionalFields: Object.freeze(presentOptionalFields),
  });
}

const RESOLVED_ASSET_KEYS = Object.freeze([
  "authority", "availability", "digestSha256", "logicalId", "mediaType", "representation",
]);
const RESOLVED_REPRESENTATION_KEYS = Object.freeze(["kind", "sanitized"]);
const RESOLVED_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);

function validatedResolvedDetailAssets(value: unknown, logicalIds: readonly string[]): readonly ResolvedDetailAsset[] {
  if (!isRecord(value)) invalidDetailAssetResponse("response", "Response must be an object");
  if (!("assets" in value)) invalidDetailAssetResponse("assets", "Response must contain assets");
  if (!hasExactKeys(value, ["assets"])) invalidDetailAssetResponse("response", "Response must contain only assets");
  const assets = value.assets;
  if (!Array.isArray(assets)) invalidDetailAssetResponse("assets", "Assets must be an array");
  if (assets.length !== logicalIds.length) invalidDetailAssetResponse("assets", "Assets must match the requested cardinality");
  return Object.freeze(assets.map((candidate, index) => {
    const path = `assets[${index}]`;
    if (!isRecord(candidate) || !hasExactKeys(candidate, RESOLVED_ASSET_KEYS)) {
      invalidDetailAssetResponse(path, "Asset records must use the exact authenticated response shape");
    }
    if (typeof candidate.logicalId !== "string"
      || !isBoundedIdentity(candidate.logicalId)
      || candidate.logicalId !== logicalIds[index]) {
      invalidDetailAssetResponse(`${path}.logicalId`, "Asset identity must exactly match the requested identity at this position");
    }
    if (candidate.authority !== "current" && candidate.authority !== "stale") {
      invalidDetailAssetResponse(`${path}.authority`, "Asset authority must be current or stale");
    }
    if (candidate.availability !== "available"
      && candidate.availability !== "unavailable"
      && candidate.availability !== "revoked") {
      invalidDetailAssetResponse(`${path}.availability`, "Asset availability is invalid");
    }
    if (typeof candidate.digestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.digestSha256)) {
      invalidDetailAssetResponse(`${path}.digestSha256`, "Asset digest must be one lowercase SHA-256 value");
    }
    if (typeof candidate.mediaType !== "string" || !RESOLVED_MEDIA_TYPES.has(candidate.mediaType)) {
      invalidDetailAssetResponse(`${path}.mediaType`, "Asset media type is unsupported");
    }
    if (!isRecord(candidate.representation)
      || !hasExactKeys(candidate.representation, RESOLVED_REPRESENTATION_KEYS)) {
      invalidDetailAssetResponse(`${path}.representation`, "Asset representation must use the exact response shape");
    }
    if (candidate.representation.kind !== "image") {
      invalidDetailAssetResponse(`${path}.representation.kind`, "Asset representation kind must be image");
    }
    if (typeof candidate.representation.sanitized !== "boolean") {
      invalidDetailAssetResponse(`${path}.representation.sanitized`, "Asset sanitization must be a boolean");
    }
    return Object.freeze({
      logicalId: candidate.logicalId,
      authority: candidate.authority,
      availability: candidate.availability,
      digestSha256: candidate.digestSha256,
      mediaType: candidate.mediaType,
      representation: Object.freeze({ kind: candidate.representation.kind, sanitized: candidate.representation.sanitized }),
    });
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isBoundedIdentity(value: string): boolean {
  return value !== "" && value.trim() === value && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 128;
}

function invalidDetailAssetResponse(path: string, message: string): never {
  throw new GraphApiError(200, "invalid_detail_asset_response", path, message);
}

function invalidNodeResponse(path: string, message: string): never {
  throw new GraphApiError(200, "invalid_node_response", path, message);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
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
