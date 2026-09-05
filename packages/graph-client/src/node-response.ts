import type { GraphNode } from "./types.js";

const acceptedNodeResponses = new WeakMap<object, GraphNode>();

export function acceptedNodeResponse(node: object): GraphNode | undefined {
  return acceptedNodeResponses.get(node);
}

export function applyAcceptedNodeResponse(node: object, response: GraphNode): void {
  acceptedNodeResponses.set(node, response);
}
