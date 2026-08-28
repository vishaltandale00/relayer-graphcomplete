import type { RelayerIconName } from "./icons.js";

export type GraphId = number;

export interface CompletionInputGraph {
  readonly interactionNode: GraphId;
}
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

export type ActionKind = "navigate" | "invoke" | "input" | "interaction.context";
export type NavigateRelation = "expand" | "reference";
export type ActionVariant = "chip" | "pill" | "wide" | "card";
export type InputControl = "text" | "single_select" | "multi_select";

export interface InputOption {
  readonly key: string;
  readonly label: string;
}

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
  readonly control?: InputControl;
  readonly prompt?: string;
  readonly options?: readonly InputOption[];
  readonly minimumSelections?: number;
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

export type CompletionLifecycle = "active" | "succeeded" | "stopped" | "failed";
export type StopReason = "cancelled_by_user";

export interface TemporalFeatureConfig {
  readonly configVersion: number;
  readonly schemaRead: boolean;
  readonly rootCurrentWrite: boolean;
  readonly projectionUi: boolean;
  readonly invokeResolution: boolean;
  readonly providerRecursion: boolean;
}

export interface CompletionState {
  readonly completionId: GraphId;
  readonly lifecycle: CompletionLifecycle;
  readonly headRevision: number;
  readonly currentLayerId?: GraphId | null;
  readonly finalLayerId?: GraphId | null;
  readonly safeReason?: string | null;
  readonly temporalFeatures: TemporalFeatureConfig;
}

export interface CurrentTransitionReceipt {
  readonly completionId: GraphId;
  readonly revision: number;
  readonly lifecycle: CompletionLifecycle;
  readonly currentLayerId?: GraphId | null;
  readonly finalLayerId?: GraphId | null;
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly snapshotDigest: string;
  readonly projectionSequence: number;
}

export interface AcceptedGraphClosure {
  readonly nodeId: GraphId;
  readonly rootAction: GraphAction;
  readonly rootLayerId: GraphId;
  readonly layers: readonly ResolvedLayer[];
}

export interface PersonalPresentationAttachment {
  readonly interactionNodeId: GraphId;
  readonly versionInteractionNodeId: GraphId;
  readonly rootLayerId: GraphId;
}

export interface ResolvedPersonalPresentation {
  readonly attachment: PersonalPresentationAttachment;
  readonly graph: AcceptedGraphClosure;
}

export interface InteractionContext {
  readonly type: "interaction.context";
  readonly targetNode: InteractionInputNode;
  readonly annotations: readonly string[];
}

export interface InteractionInput {
  readonly interaction: InteractionInputNode;
  readonly contexts: readonly InteractionContext[];
}

/** Model-visible node contents without invocation or occurrence authority. */
export interface InteractionInputNode {
  readonly id: GraphId;
  readonly kind: string;
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
  readonly state: RecordState;
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
