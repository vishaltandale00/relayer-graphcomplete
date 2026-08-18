import { randomUUID } from "node:crypto";
import type { GraphAction, GraphEdge, GraphId, GraphLayer, GraphNode } from "./types.js";

export class NodeObject {
  readonly clientKey: string;
  ref?: GraphNode;

  constructor(
    public icon: string,
    public title: string,
    public detail: string,
    public kind = "concept",
    clientKey: string = randomUUID(),
  ) {
    this.clientKey = clientKey;
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

export class LayerObject {
  readonly clientKey: string;
  ref?: GraphLayer;

  constructor(
    public nodes: readonly NodeReference[],
    public edges: readonly EdgeReference[],
    clientKey: string = randomUUID(),
  ) {
    this.clientKey = clientKey;
  }
}

export interface NavigateActionObject {
  readonly kind: "navigate";
  readonly label: string;
  readonly target: LayerReference;
  readonly response?: boolean;
  clientKey?: string;
  ref?: GraphAction;
}

export interface InvokeActionObject {
  readonly kind: "invoke";
  readonly label: string;
  readonly interactionText: string;
  clientKey?: string;
  ref?: GraphAction;
}

export type ActionObject = NavigateActionObject | InvokeActionObject;
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
