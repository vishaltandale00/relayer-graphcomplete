import { randomUUID } from "node:crypto";
import { NodeDetailAuthoring } from "./detail.js";
import { bindDetailOwner } from "./detail-host.js";
import type { GraphAction, GraphEdge, GraphId, GraphLayer, GraphNode, InputControl, InputOption, NavigateRelation } from "./types.js";

export class NodeObject {
  readonly clientKey: string;
  readonly detailAuthoring: NodeDetailAuthoring;
  ref?: GraphNode;

  constructor(
    public icon: string,
    public title: string,
    public detail: string,
    public kind = "concept",
    clientKey: string = randomUUID(),
  ) {
    this.clientKey = clientKey;
    this.detailAuthoring = new NodeDetailAuthoring();
    bindDetailOwner(this.detailAuthoring, clientKey);
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

export class LayerLayoutObject {
  readonly version = 1 as const;

  constructor(public placements: readonly NodePlacementObject[]) {}
}

export class LayerObject {
  readonly clientKey: string;
  ref?: GraphLayer;

  constructor(
    public nodes: readonly NodeReference[],
    public edges: readonly EdgeReference[],
    public layout: LayerLayoutObject,
    clientKey: string = randomUUID(),
  ) {
    this.clientKey = clientKey;
  }
}

export type ActionPresentationObject =
  | { readonly variant?: "pill"; readonly icon?: string; readonly description?: never }
  | { readonly variant: "chip" | "wide"; readonly icon?: string; readonly description?: never }
  | { readonly variant: "card"; readonly icon?: string; readonly description: string };

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
