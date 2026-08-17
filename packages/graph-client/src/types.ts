export type GraphId = number;
export type RecordState = "draft" | "accepted" | "stopped";

export interface GraphNode {
  readonly id: GraphId;
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

export interface GraphLayer {
  readonly id: GraphId;
  readonly nodes: readonly GraphId[];
  readonly edges: readonly GraphId[];
  readonly state: RecordState;
}

export type ActionKind = "navigate" | "invoke";

export interface GraphAction {
  readonly id: GraphId;
  readonly sourceNodeId: GraphId;
  readonly kind: ActionKind;
  readonly label: string;
  readonly targetLayerId?: GraphId | null;
  readonly interactionText?: string | null;
  readonly response: boolean;
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
  };
}

export class GraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly path: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}
