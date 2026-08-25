import type { RelayerIconName } from "./icons.js";

export type GraphId = number;
export type RecordState = "draft" | "accepted" | "stopped";

export interface GraphNode {
  readonly id: GraphId;
  readonly leasedActionId?: GraphId | null;
  readonly kind: string;
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
  readonly state: RecordState;
}

export interface GraphEdge {
  readonly id: GraphId;
  readonly endpoints: readonly [GraphId, GraphId];
  readonly state: RecordState;
}

export interface NodePlacement {
  readonly nodeId: GraphId;
  readonly x: number;
  readonly y: number;
}

export interface LayerLayout {
  readonly version: 1;
  readonly placements: readonly NodePlacement[];
}

export interface GraphLayer {
  readonly id: GraphId;
  readonly nodes: readonly GraphId[];
  readonly edges: readonly GraphId[];
  /** Null or absent only for accepted layers created before authored layouts were introduced. */
  readonly layout?: LayerLayout | null;
  readonly state: RecordState;
}

export type ActionKind = "navigate" | "invoke" | "interaction.context";
export type NavigateRelation = "expand" | "reference";
export type ActionVariant = "chip" | "pill" | "wide" | "card";

export interface GraphAction {
  readonly id: GraphId;
  readonly sourceNodeId: GraphId;
  readonly sourceLayerId?: GraphId | null;
  readonly kind: ActionKind;
  readonly relation?: NavigateRelation | null;
  readonly label: string;
  readonly variant: ActionVariant;
  readonly icon?: RelayerIconName | null;
  readonly description?: string | null;
  readonly targetLayerId?: GraphId | null;
  readonly interactionText?: string | null;
  readonly state: RecordState;
}

export interface ResolvedLayer {
  readonly layer: GraphLayer;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly actions: readonly GraphAction[];
}

export interface CompletionOutput {
  readonly nodeId: GraphId;
  readonly rootAction: GraphAction;
  readonly rootLayer: ResolvedLayer;
}

export interface InteractionContext {
  readonly id: GraphId;
  readonly type: "interaction.context";
  readonly sourceNodeId: GraphId;
  readonly targetNode: GraphNode;
  readonly annotations: readonly string[];
}

export interface InteractionInput {
  readonly interaction: GraphNode;
  readonly contexts: readonly InteractionContext[];
}

export interface GraphCapability {
  readonly url: string;
  readonly token: string;
  readonly nodeId: GraphId;
}

export interface GraphApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly path?: string;
    readonly message?: string;
    readonly issues?: readonly GraphValidationIssue[];
  };
}

export interface GraphValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class GraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly path: string | undefined,
    message: string,
    readonly issues: readonly GraphValidationIssue[] = [],
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}
