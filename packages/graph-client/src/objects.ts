import type { GraphIcon } from "./image-icons.js";
import { randomUUID } from "node:crypto";
import { createOwnedNodeDetailAuthoring, NodeDetailAuthoring } from "./detail.js";
import type { EdgeShape, NodeSide } from "./edge-shapes.js";
import { acceptedNodeResponse } from "./node-response.js";
import type { ArtifactDetails, GraphAction, GraphEdge, GraphId, GraphLayer, GraphNode, InputControl, InputOption, LayerRenderer, NavigateRelation } from "./types.js";

export class NodeObject {
  readonly clientKey: string;
  readonly detailAuthoring: NodeDetailAuthoring;
  /**
   * Artifact details: set these to make this node something the user opens in
   * the artifact viewer. Such a node must be the only node of a layer created
   * with `LayerObject.forArtifact(node)`.
   */
  artifact: ArtifactDetails | undefined = undefined;
  declare readonly ref: GraphNode | undefined;

  constructor(
    public icon: GraphIcon,
    public title: string,
    public detail: string,
    public kind = "concept",
    clientKey: string = randomUUID(),
  ) {
    this.clientKey = clientKey;
    this.detailAuthoring = createOwnedNodeDetailAuthoring(this);
    Object.defineProperty(this, "ref", {
      configurable: false,
      enumerable: true,
      get: () => acceptedNodeResponse(this),
    });
  }
}

export class EdgeObject {
  readonly clientKey: string;
  ref?: GraphEdge;

  constructor(
    public endpoints: readonly [NodeReference, NodeReference],
    clientKey: string = randomUUID(),
  ) {
    this.clientKey = clientKey;
  }
}

export class NodePlacementObject {
  constructor(
    public node: NodeReference,
    public x: number,
    public y: number,
  ) {}
}

export interface EdgeEndObject {
  readonly node: NodeReference;
  /** Omit to let the renderer choose where the edge meets the node. */
  readonly side?: NodeSide;
}

/**
 * One edge's own shape, attachment sides and waypoints. Waypoints are 0..1 layout
 * coordinates listed from ends[0] to ends[1]; that order is not a direction.
 */
export interface EdgeRouteObject {
  readonly edge: EdgeReference;
  readonly shape?: EdgeShape;
  readonly ends?: readonly [EdgeEndObject, EdgeEndObject];
  readonly waypoints?: readonly { readonly x: number; readonly y: number }[];
}

export class LayerLayoutObject {
  readonly version = 1 as const;

  /** Placement order is the layer's reading order. Edges without a route draw in the layer's edge shape. */
  constructor(
    public placements: readonly NodePlacementObject[],
    public edgeShape: EdgeShape,
    public edgeRoutes: readonly EdgeRouteObject[] = [],
  ) {}
}

export class LayerObject {
  readonly clientKey: string;
  ref?: GraphLayer;

  constructor(
    public nodes: readonly NodeReference[],
    public edges: readonly EdgeReference[],
    public layout: LayerLayoutObject,
    clientKey: string = randomUUID(),
    public defaultNode?: NodeReference,
    /** Absent: a graph. "artifact": the artifact viewer reads this layer's single node. */
    public renderer?: LayerRenderer,
  ) {
    this.clientKey = clientKey;
  }

  /** A layer the artifact viewer reads: exactly one node that carries `artifact` details. */
  static forArtifact(node: NodeReference, clientKey: string = randomUUID()): LayerObject {
    return new LayerObject(
      [node],
      [],
      new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)], "default"),
      clientKey,
      node,
      "artifact",
    );
  }
}

export type ActionPresentationObject =
  | { readonly variant?: "pill"; readonly icon?: GraphIcon; readonly description?: never }
  | { readonly variant: "chip" | "wide"; readonly icon?: GraphIcon; readonly description?: never }
  | { readonly variant: "card"; readonly icon?: GraphIcon; readonly description: string };

export interface NavigateActionFields {
  readonly kind: "navigate";
  readonly relation: NavigateRelation;
  readonly label: string;
  readonly target: LayerReference;
  readonly sourceLayer?: LayerReference;
  clientKey?: string;
  ref?: GraphAction;
}

export interface InvokeActionFields {
  readonly kind: "invoke";
  readonly label: string;
  readonly interactionText: string;
  readonly sourceLayer: LayerReference;
  clientKey?: string;
  ref?: GraphAction;
}

export interface InputActionFields {
  readonly kind: "input";
  readonly label: string;
  readonly control: InputControl;
  readonly prompt: string;
  readonly options?: readonly InputOption[];
  readonly minimumSelections?: number;
  readonly sourceLayer: LayerReference;
  clientKey?: string;
  ref?: GraphAction;
}

export type NavigateActionObject = NavigateActionFields & ActionPresentationObject;
export type InvokeActionObject = InvokeActionFields & ActionPresentationObject;
export type InputActionObject = InputActionFields & ActionPresentationObject;
export type ActionObject = NavigateActionObject | InvokeActionObject | InputActionObject;
export type ActionReference = ActionObject | GraphAction | GraphId;
export type NodeReference = NodeObject | GraphNode | GraphId;
export type EdgeReference = EdgeObject | GraphEdge | GraphId;
export type LayerReference = LayerObject | GraphLayer | GraphId;

export function nodeId(value: NodeReference): GraphId {
  if (typeof value === "number") return value;
  if (value instanceof NodeObject) {
    if (value.ref === undefined) throw new Error(`NodeObject ${value.clientKey} must be submitted before it can be referenced`);
    return value.ref.id;
  }
  return value.id;
}

export function edgeId(value: EdgeReference): GraphId {
  if (typeof value === "number") return value;
  if (value instanceof EdgeObject) {
    if (value.ref === undefined) throw new Error(`EdgeObject ${value.clientKey} must be created before it can be referenced`);
    return value.ref.id;
  }
  return value.id;
}

export function layerId(value: LayerReference): GraphId {
  if (typeof value === "number") return value;
  if (value instanceof LayerObject) {
    if (value.ref === undefined) throw new Error(`LayerObject ${value.clientKey} must be submitted before it can be referenced`);
    return value.ref.id;
  }
  return value.id;
}

export function actionId(value: ActionReference): GraphId {
  if (typeof value === "number") return value;
  if (!("id" in value)) {
    if (value.ref === undefined) throw new Error(`Action ${value.clientKey ?? "unknown"} must be submitted before it can be referenced`);
    return value.ref.id;
  }
  return value.id;
}
