import { z } from "zod";
import { assetRef, DetailCompilationError, GraphApiError, css, detailCapability, html, LayerLayoutObject, LayerObject, NodeObject, NodePlacementObject, RelayerGraphClient, type ActionObject, type ArtifactDetails, type EdgeRouteObject, type EdgeShape, type GraphCapability, type NodeSide } from "@relayer/graph-client";

const identity = z.string().min(1).max(128).refine((value) => value === value.trim() && !value.includes("\0") && Buffer.byteLength(value) <= 128, "Identity must be trimmed, NUL-free, and at most 128 UTF-8 bytes");
const layer = z.object({ clientKey: identity, nodes: z.array(identity).max(8) }).strict();
const presentation = { variant: z.enum(["chip", "pill", "wide", "card"]).optional(), icon: z.string().optional(), description: z.string().optional() };
const common = { clientKey: identity, label: z.string(), sourceLayer: layer, ...presentation };
const action = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("navigate"), sourceLayer: layer.optional(), relation: z.enum(["expand", "reference"]), target: z.union([z.number().int().positive(), layer]) }).strict(),
  z.object({ ...common, kind: z.literal("invoke"), interactionText: z.string(), reusable: z.boolean().optional(), inputActions: z.array(z.union([z.number().int().positive(), z.object({ inputActionClientKey: identity }).strict()])).max(128).optional() }).strict(),
  z.object({ ...common, kind: z.literal("input"), control: z.enum(["text", "single_select", "multi_select"]), prompt: z.string(), options: z.array(z.object({ key: z.string(), label: z.string() }).strict()).max(50).optional(), minimumSelections: z.number().int().optional() }).strict(),
]);
const binding = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asset"), logicalId: identity }).strict(),
  z.object({ kind: z.literal("link"), key: identity, href: z.string() }).strict(),
  z.object({ kind: z.literal("action"), key: identity, action }).strict(),
]);
const template = z.object({ strings: z.array(z.string()).min(1).max(129), values: z.array(binding).max(128) }).strict()
  .refine((value) => value.strings.length === value.values.length + 1, "Template must have one more string than bindings");
const request = z.object({
  version: z.literal(1), objectId: identity, token: z.string(), nodeId: z.number().int().positive(),
  operation: z.enum(["checkpoint", "submit", "replace"]),
  replacement: z.object({ nodeId: z.number().int().positive(), expectedRevision: z.number().int().nonnegative() }).strict().optional(),
  // Artifact details are shape-checked by graph-core; this boundary only bounds and forwards them.
  node: z.object({ clientKey: identity, icon: z.string(), title: z.string(), detail: z.string(), kind: z.string(), artifact: z.record(z.string(), z.unknown()).optional() }).strict(),
  detail: z.object({ clear: z.boolean(), components: z.array(z.object({ id: identity, markup: template, styles: z.string() }).strict()).max(64) }).strict(),
}).strict();

interface Submission {
  readonly signature: string;
  readonly node: NodeObject;
  readonly client: RelayerGraphClient;
  locked: boolean;
  transport: { active: () => void; signal: AbortSignal };
  inFlight?: Promise<Record<string, unknown>>;
}
export class PrimeVisualAuthoring {
  private readonly submissions = new Map<string, Submission>();
  private bytes = 0;
  /** Only declarative authoring crosses this boundary. Graph core remains authoritative. */
  async execute(payload: unknown, capability: GraphCapability, active: () => void, signal: AbortSignal): Promise<Record<string, unknown>> {
    active();
    let input: z.infer<typeof request>;
    try {
      if (Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8") > 1024 * 1024) throw new Error("Visual authoring request exceeds 1 MiB");
      input = request.parse(payload);
    } catch (error) {
      return authoringFailure(error, false);
    }
    if (input.token !== capability.token || input.nodeId !== capability.nodeId) throw new Error("The graph session belongs to another run");
    if ((input.operation === "replace") !== (input.replacement !== undefined)) return authoringFailure(new Error("Replacement target is required only for replacement operations"), false);
    const signature = JSON.stringify({ node: input.node, detail: input.detail });
    const existing = this.submissions.get(input.objectId);
    if (existing !== undefined && input.operation !== "replace") {
      if (existing.signature !== signature) throw new Error("detail_finalized: create a fresh NodeObject to replace a draft");
      if (input.operation === "checkpoint") {
        const value = await existing.client.checkpointNodeDetail(existing.node);
        active();
        return { ok: true, value, frozen: existing.locked };
      }
      return this.submit(existing, active, signal);
    }
    const node = new NodeObject(input.node.icon, input.node.title, input.node.detail, input.node.kind, input.node.clientKey);
    if (input.node.artifact !== undefined) node.artifact = input.node.artifact as unknown as ArtifactDetails;
    const makeLayer = (value: z.infer<typeof layer>): LayerObject => new LayerObject(
      value.nodes.map((key) => key === node.clientKey ? node : new NodeObject("", "", "", "concept", key)),
      [], new LayerLayoutObject([], "default"), value.clientKey,
    );
    const declarations = new Map<string, ActionObject>();
    const signatures = new Map<string, string>();
    try {
      const actions = input.detail.components.flatMap((component) => component.markup.values).filter((value) => value.kind === "action");
      for (const value of actions) {
        const declaration = value.action;
        const signature = JSON.stringify(declaration);
        if (signatures.has(declaration.clientKey) && signatures.get(declaration.clientKey) !== signature) throw new Error("Conflicting action declarations share a clientKey");
        signatures.set(declaration.clientKey, signature);
        if (!declarations.has(declaration.clientKey)) declarations.set(declaration.clientKey, { ...declaration,
          ...(declaration.sourceLayer === undefined ? {} : { sourceLayer: makeLayer(declaration.sourceLayer) }),
          ...(declaration.kind === "navigate" ? { target: typeof declaration.target === "number" ? declaration.target : makeLayer(declaration.target) } : {}),
        } as ActionObject);
      }
      for (const value of actions) {
        if (value.action.kind !== "invoke") continue;
        const inputs = (value.action.inputActions ?? []).map((reference) => {
          if (typeof reference === "number") return reference;
          const input = declarations.get(reference.inputActionClientKey);
          if (!input || input.kind !== "input") throw new Error("Invoke must reference a mounted Input declaration");
          return input;
        });
        const native = declarations.get(value.action.clientKey)!;
        if (native.kind === "invoke") declarations.set(value.action.clientKey, { ...native, inputActions: inputs });
      }
    } catch (error) { return authoringFailure(error, false); }
    const makeBinding = (value: z.infer<typeof binding>): unknown => {
      if (value.kind === "asset") return assetRef(value.logicalId);
      if (value.kind === "link") return detailCapability.externalLink(value.key, value.href);
      const native = declarations.get(value.action.clientKey)!;
      if (native.kind === "invoke") return detailCapability.invoke(value.key, native);
      if (native.kind === "input") return detailCapability.input(value.key, native);
      return native.relation === "expand" ? detailCapability.expand(value.key, { ...native, relation: "expand" }) : detailCapability.reference(value.key, { ...native, relation: "reference" });
    };
    if (input.detail.clear) node.detailAuthoring.clear();
    for (const component of input.detail.components) {
      const strings = Object.assign([...component.markup.strings], { raw: [...component.markup.strings] });
      const styles = Object.assign([component.styles], { raw: [component.styles] });
      node.detailAuthoring.setComponent(component.id, html(strings, ...component.markup.values.map(makeBinding)), css(styles));
    }
    if (input.operation === "replace") {
      try {
        await new RelayerGraphClient(capability, { beforeRequest: active, signal }).replaceNodePresentation(input.replacement!.nodeId, input.replacement!.expectedRevision, node);
        active();
        return { ok: true, value: null, frozen: false };
      } catch (error) {
        return authoringFailure(error, false);
      }
    }
    if (input.operation === "checkpoint") {
      try {
        const value = await new RelayerGraphClient(capability, { beforeRequest: active, signal }).checkpointNodeDetail(node);
        active();
        return { ok: true, value, frozen: false };
      } catch (error) {
        return authoringFailure(error, false);
      }
    }
    const bytes = Buffer.byteLength(signature);
    if (this.submissions.size >= 256 || this.bytes + bytes > 16 * 1024 * 1024) throw new Error("Visual authoring run exceeds its bounded submission cache");
    const entry: Submission = {
      node, signature, locked: false, transport: { active, signal },
      client: new RelayerGraphClient(capability, { beforeRequest: (path) => {
        entry.transport.active();
        if (path === "/api/graph/nodes") entry.locked = true;
      }, get signal() { return entry.transport.signal; } }),
    };
    this.submissions.set(input.objectId, entry);
    this.bytes += bytes;
    const result = await this.submit(entry, active, signal);
    if (!entry.locked) {
      this.submissions.delete(input.objectId);
      this.bytes -= bytes;
    }
    return result;
  }

  private async submit(entry: Submission, active: () => void, signal: AbortSignal): Promise<Record<string, unknown>> {
    active();
    if (entry.inFlight !== undefined) return entry.inFlight;
    entry.transport = { active, signal };
    const work = this.submitOnce(entry, active);
    entry.inFlight = work;
    try { return await work; }
    finally { delete entry.inFlight; }
  }

  private async submitOnce(entry: Submission, active: () => void): Promise<Record<string, unknown>> {
    try {
      active();
      const value = await entry.client.submitNode(entry.node);
      active();
      return { ok: true, value, frozen: true };
    } catch (error) {
      return authoringFailure(error, entry.locked);
    }
  }
}

function authoringFailure(error: unknown, frozen: boolean): Record<string, unknown> {
  return { ok: false, frozen,
    message: error instanceof Error ? error.message : "Visual authoring failed",
    ...(error instanceof DetailCompilationError ? { issues: error.issues } : {}),
    ...(error instanceof GraphApiError ? { httpStatus: error.status, error: {
      code: error.code, message: error.message,
      ...(error.path === undefined ? {} : {path:error.path}), issues: error.issues,
    } } : {}),
  };
}

const layerId = z.number().int().positive();
const layerPoint = { x: z.number(), y: z.number() };
const layerRoute = z.object({
  edgeId: layerId,
  shape: z.string().optional(),
  ends: z.array(z.object({ nodeId: layerId, side: z.string().optional() }).strict()).max(2).optional(),
  waypoints: z.array(z.object(layerPoint).strict()).max(64).optional(),
}).strict();
const layerRequest = z.object({
  version: z.literal(1), token: z.string(), nodeId: layerId,
  layer: z.object({
    clientKey: z.string().min(1).max(512),
    nodes: z.array(layerId).max(64),
    defaultNodeId: layerId.nullable().optional(),
    edges: z.array(layerId).max(512),
    layout: z.object({
      version: z.literal(1),
      placements: z.array(z.object({ nodeId: layerId, ...layerPoint }).strict()).max(64),
      edgeShape: z.string(),
      edgeRoutes: z.array(layerRoute).max(512).optional(),
    }).strict(),
    sizeJustification: z.string().nullable().optional(),
    renderer: z.literal("artifact").optional(),
  }).strict(),
}).strict();

/**
 * Submits a Prime layer through the host's graph client, which writes its
 * draft preview into the turn's preview folder (PRD §11.10). A bounded Prime
 * kernel can read that folder but not write it. The graph server stays
 * authoritative; its rejections return to Python as data for repair. Prime's
 * kernel owns a reply's `status` key, so the HTTP status travels as `httpStatus`.
 */
export async function submitPrimeLayer(
  payload: unknown,
  capability: GraphCapability,
  active: () => void,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  active();
  let input: z.infer<typeof layerRequest>;
  try {
    if (Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8") > 1024 * 1024) throw new Error("Layer request exceeds 1 MiB");
    input = layerRequest.parse(payload);
  } catch (error) {
    const message = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : "Invalid layer request";
    return { ok: false, httpStatus: 400, error: { code: "invalid_request", message } };
  }
  if (input.token !== capability.token || input.nodeId !== capability.nodeId) throw new Error("The graph session belongs to another run");
  const { layer } = input;
  const routes = (layer.layout.edgeRoutes ?? []).map((value): EdgeRouteObject => ({
    edge: value.edgeId,
    ...(value.shape === undefined ? {} : { shape: value.shape as EdgeShape }),
    ...(value.ends === undefined ? {} : {
      ends: value.ends.map((end) => ({ node: end.nodeId, ...(end.side === undefined ? {} : { side: end.side as NodeSide }) })) as unknown as NonNullable<EdgeRouteObject["ends"]>,
    }),
    ...(value.waypoints === undefined ? {} : { waypoints: value.waypoints }),
  }));
  const native = new LayerObject(
    layer.nodes,
    layer.edges,
    new LayerLayoutObject(
      layer.layout.placements.map((placement) => new NodePlacementObject(placement.nodeId, placement.x, placement.y)),
      layer.layout.edgeShape as EdgeShape,
      routes,
    ),
    layer.clientKey,
    layer.defaultNodeId ?? undefined,
    layer.renderer,
  );
  try {
    const value = await new RelayerGraphClient(capability, { beforeRequest: active, signal })
      .submitLayer(native, layer.sizeJustification == null ? {} : { sizeJustification: layer.sizeJustification });
    active();
    return { ok: true, value };
  } catch (error) {
    if (!(error instanceof GraphApiError)) throw error;
    return {
      ok: false,
      httpStatus: error.status,
      error: { code: error.code, ...(error.path === undefined ? {} : { path: error.path }), message: error.message, issues: error.issues },
    };
  }
}
