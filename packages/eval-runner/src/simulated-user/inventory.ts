import type { ActionId, LayerId, NodeId, TurnId } from "./contracts.js";

export type ReviewSubjectId = string | number;

export interface ReviewTopologyInputOption {
  readonly key: string;
  readonly label: string;
}

export interface ReviewTopologyInputOccurrence {
  readonly presentingInteractionNodeId: number;
  readonly presentingLayerId: number;
  readonly actionId: number;
}

export type ReviewTopologyInputSnapshot =
  | {
      readonly control: "text";
      readonly prompt: string;
      readonly options: readonly [];
      readonly occurrence?: ReviewTopologyInputOccurrence;
      readonly minimumSelections?: never;
    }
  | {
      readonly control: "single_select";
      readonly prompt: string;
      readonly options: readonly ReviewTopologyInputOption[];
      readonly occurrence?: ReviewTopologyInputOccurrence;
      readonly minimumSelections?: never;
    }
  | {
      readonly control: "multi_select";
      readonly prompt: string;
      readonly options: readonly ReviewTopologyInputOption[];
      readonly minimumSelections?: number;
      readonly occurrence?: ReviewTopologyInputOccurrence;
    };

interface ReviewTopologyActionBase {
  readonly id: ActionId;
  readonly sourceNodeId: NodeId;
}

export type ReviewTopologyAction = ReviewTopologyActionBase & (
  | {
      readonly kind: "navigate";
      readonly relation: "expand" | "reference";
      readonly targetLayerId: LayerId;
    }
  | {
      readonly kind: "invoke";
      readonly relation?: null;
      readonly targetLayerId?: null;
    }
  | ({
      readonly kind: "input";
      readonly relation?: null;
      readonly targetLayerId?: null;
    } & ReviewTopologyInputSnapshot)
);

export interface ReviewTopologyLayer {
  readonly id: LayerId;
  readonly nodeIds: readonly NodeId[];
  readonly actions: readonly ReviewTopologyAction[];
}

export interface ReviewTopology {
  readonly turnId: TurnId;
  readonly rootLayerId: LayerId;
  readonly layers: readonly ReviewTopologyLayer[];
}

export interface LayerReviewSubject {
  readonly kind: "layer";
  readonly layerId: LayerId;
  readonly depth: number;
  readonly incomingActionIds: readonly ActionId[];
}

export interface NodeReviewSubject {
  readonly kind: "node";
  readonly layerId: LayerId;
  readonly nodeId: NodeId;
  readonly actionIds: readonly ActionId[];
}

export interface ActionReviewSubject {
  readonly kind: "action";
  readonly layerId: LayerId;
  readonly nodeId: NodeId;
  readonly actionId: ActionId;
  readonly actionKind: "navigate" | "invoke" | "input";
  readonly relation?: "expand" | "reference";
  readonly targetLayerId?: LayerId;
  readonly control?: "text" | "single_select" | "multi_select";
  readonly prompt?: string;
  readonly options?: readonly ReviewTopologyInputOption[];
  readonly minimumSelections?: number;
  readonly occurrence?: ReviewTopologyInputOccurrence;
}

export interface TurnReviewSubject {
  readonly kind: "turn";
  readonly turnId: TurnId;
}

export interface ReviewSubjectInventory {
  readonly turn: TurnReviewSubject;
  readonly layers: readonly LayerReviewSubject[];
  readonly nodes: readonly NodeReviewSubject[];
  readonly actions: readonly ActionReviewSubject[];
}

/**
 * Inventories the UI subjects reachable from one accepted turn's root layer.
 *
 * Layer depth is the shortest expansion distance from the root. Expansion
 * destinations are reviewed recursively. Reference destinations are reached
 * and graded as part of the source action, but their layers and nodes are not
 * regraded. Unreachable layers are intentionally not part of review coverage.
 */
export function inventoryReviewSubjects(topology: ReviewTopology): ReviewSubjectInventory {
  const layersById = new Map<LayerId, ReviewTopologyLayer>();
  for (const layer of topology.layers) {
    if (layersById.has(layer.id)) throw new Error(`Duplicate review topology layer: ${formatId(layer.id)}`);
    requireUnique(layer.nodeIds, `node in layer ${formatId(layer.id)}`);
    requireUnique(layer.actions.map((action) => action.id), `action in layer ${formatId(layer.id)}`);
    layersById.set(layer.id, layer);
  }

  if (!layersById.has(topology.rootLayerId)) {
    throw new Error(`Unknown root review layer: ${formatId(topology.rootLayerId)}`);
  }

  const expansionAdjacency = new Map<LayerId, readonly LayerId[]>();
  for (const layer of topology.layers) {
    const nodeIds = new Set(layer.nodeIds);
    const destinations: LayerId[] = [];
    for (const action of layer.actions) {
      if (!nodeIds.has(action.sourceNodeId)) {
        throw new Error(
          `Review action ${formatId(action.id)} has source node ${formatId(action.sourceNodeId)} outside layer ${formatId(layer.id)}`,
        );
      }
      if (action.kind === "navigate") {
        const targetLayerId = action.targetLayerId as LayerId | null | undefined;
        const relation = action.relation as "expand" | "reference" | null | undefined;
        if (targetLayerId === undefined || targetLayerId === null) {
          throw new Error(`Navigate action ${formatId(action.id)} has no target layer`);
        }
        if (!layersById.has(targetLayerId)) {
          throw new Error(
            `Navigate action ${formatId(action.id)} targets unknown layer ${formatId(targetLayerId)}`,
          );
        }
        if (relation !== "expand" && relation !== "reference") {
          throw new Error(`Navigate action ${formatId(action.id)} has no valid relation`);
        }
        if (relation === "expand") destinations.push(targetLayerId);
      } else if (
        action.targetLayerId !== undefined
        && action.targetLayerId !== null
        || action.relation !== undefined && action.relation !== null
      ) {
        throw new Error(`${action.kind === "input" ? "Input" : "Invoke"} action ${formatId(action.id)} cannot target a layer`);
      }
    }
    expansionAdjacency.set(layer.id, destinations);
  }

  assertReachableExpansionsAreAcyclic(topology.rootLayerId, expansionAdjacency);

  const depths = new Map<LayerId, number>([[topology.rootLayerId, 0]]);
  const orderedLayerIds: LayerId[] = [];
  const queue: LayerId[] = [topology.rootLayerId];
  for (let index = 0; index < queue.length; index += 1) {
    const layerId = queue[index]!;
    orderedLayerIds.push(layerId);
    const depth = depths.get(layerId)!;
    for (const destination of expansionAdjacency.get(layerId) ?? []) {
      if (!depths.has(destination)) {
        depths.set(destination, depth + 1);
        queue.push(destination);
      }
    }
  }

  const layerSubjects: LayerReviewSubject[] = [];
  const nodeSubjects: NodeReviewSubject[] = [];
  const actionSubjects: ActionReviewSubject[] = [];
  const incoming = new Map<LayerId, ActionId[]>();
  for (const sourceLayerId of orderedLayerIds) {
    for (const action of layersById.get(sourceLayerId)!.actions) {
      if (action.kind !== "navigate" || action.relation !== "expand") continue;
      const targetIncoming = incoming.get(action.targetLayerId!) ?? [];
      targetIncoming.push(action.id);
      incoming.set(action.targetLayerId!, targetIncoming);
    }
  }
  for (const layerId of orderedLayerIds) {
    const layer = layersById.get(layerId)!;
    layerSubjects.push({
      kind: "layer",
      layerId,
      depth: depths.get(layerId)!,
      incomingActionIds: [...(incoming.get(layerId) ?? [])],
    });
    for (const nodeId of layer.nodeIds) {
      const actions = layer.actions.filter((action) => action.sourceNodeId === nodeId);
      nodeSubjects.push({
        kind: "node",
        layerId,
        nodeId,
        actionIds: actions.map((action) => action.id),
      });
      for (const action of actions) {
        actionSubjects.push(action.kind === "navigate"
          ? {
              kind: "action",
              layerId,
              nodeId,
              actionId: action.id,
              actionKind: "navigate",
              relation: action.relation!,
              targetLayerId: action.targetLayerId!,
            }
          : action.kind === "invoke" ? {
              kind: "action",
              layerId,
              nodeId,
              actionId: action.id,
              actionKind: "invoke",
            } : {
              kind: "action",
              layerId,
              nodeId,
              actionId: action.id,
              actionKind: "input",
              control: action.control,
              prompt: action.prompt,
              options: action.options,
              ...(action.occurrence === undefined ? {} : { occurrence: action.occurrence }),
              ...(action.control === "multi_select" && action.minimumSelections !== undefined
                ? { minimumSelections: action.minimumSelections }
                : {}),
            });
      }
    }
  }

  return {
    turn: { kind: "turn", turnId: topology.turnId },
    layers: layerSubjects,
    nodes: nodeSubjects,
    actions: actionSubjects,
  };
}

function assertReachableExpansionsAreAcyclic(
  rootLayerId: LayerId,
  adjacency: ReadonlyMap<LayerId, readonly LayerId[]>,
): void {
  const visiting = new Set<LayerId>();
  const visited = new Set<LayerId>();
  const path: LayerId[] = [];

  const visit = (layerId: LayerId): void => {
    if (visiting.has(layerId)) {
      const cycleStart = path.findIndex((pathLayerId) => pathLayerId === layerId);
      const cycle = [...path.slice(cycleStart), layerId].map(formatId).join(" -> ");
      throw new Error(`Review expansion topology must be acyclic; found ${cycle}`);
    }
    if (visited.has(layerId)) return;
    visiting.add(layerId);
    path.push(layerId);
    for (const destination of adjacency.get(layerId) ?? []) visit(destination);
    path.pop();
    visiting.delete(layerId);
    visited.add(layerId);
  };

  visit(rootLayerId);
}

function requireUnique(values: readonly ReviewSubjectId[], label: string): void {
  const seen = new Set<ReviewSubjectId>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${formatId(value)}`);
    seen.add(value);
  }
}

function formatId(value: ReviewSubjectId): string {
  return JSON.stringify(value);
}
