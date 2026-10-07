import type { GraphIcon } from "./image-icons.js";
import type { EdgeShape, NodeSide } from "./edge-shapes.js";
import type { CompiledNodeDetail } from "./detail.js";

export type GraphId = number;

export interface CompletionInputGraph {
  readonly interactionNode: GraphId;
}
export type RecordState = "draft" | "accepted" | "stopped";

/** What an artifact node shows in the artifact viewer (PRD 6.6, 11.11). */
export type ArtifactKind = "website" | "pdf" | "video" | "image" | "markdown" | "url" | "app";
export type ArtifactViewport = "desktop" | "tablet" | "phone";

export type ArtifactSource =
  /** A website: the entry file and the site root folder it loads from, both relative to the thread folder. */
  | { readonly file: string; readonly root: string }
  /** A PDF, video, image or Markdown file relative to the thread folder. */
  | { readonly file: string }
  /** A deployed https URL (or http on localhost), or a web app's loopback address. */
  | { readonly url: string };

/** A web app's server invoke: the command that starts it in the thread folder (PRD 6.6.6). */
export interface ArtifactServer {
  readonly command: string;
  /** The loopback URL that answers once the app is ready; defaults to the source URL. */
  readonly readyUrl?: string;
  /** Minutes without a viewer before a server Relayer started stops; default 60. */
  readonly idleTimeoutMinutes?: number;
}

/** Starting state applied on every open: test values only (PRD 6.6.7). */
export interface ArtifactSeed {
  readonly localStorage?: Readonly<Record<string, string>>;
  /** Web apps only. */
  readonly cookies?: readonly { readonly name: string; readonly value: string; readonly path?: string }[];
}

export interface ArtifactPart {
  /** website/url: a route such as "/pricing", "#/cart" or "?plan=regular". */
  readonly route?: string;
  /** pdf: the page to open at, from 1. */
  readonly page?: number;
  /** video: a segment in seconds; playback stops at end until the user plays the whole video. */
  readonly start?: number;
  readonly end?: number;
  /** markdown: the heading text to open at. */
  readonly heading?: string;
}

export interface ArtifactDetails {
  readonly kind: ArtifactKind;
  readonly source: ArtifactSource;
  readonly part?: ArtifactPart;
  /** website/url/app only. */
  readonly viewport?: ArtifactViewport;
  /** app only, and required there. */
  readonly server?: ArtifactServer;
  /** website/app only. */
  readonly seed?: ArtifactSeed;
  /** Set by Relayer when a file artifact is submitted; never author it. */
  readonly fingerprint?: string;
}

/** Which renderer reads a layer. Absent means the graph. */
export type LayerRenderer = "artifact";

export interface GraphNode {
  readonly id: GraphId;
  /** Stable author-assigned identity; absent only in projections written before client keys were exposed. */
  readonly clientKey?: string;
  readonly leasedActionId?: GraphId | null;
  readonly kind: string;
  readonly icon: GraphIcon;
  readonly title: string;
  readonly detail: string;
  readonly authoredDetail?: CompiledNodeDetail;
  /** Present only on the single node of an artifact layer. */
  readonly artifact?: ArtifactDetails;
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
  /** List order is the layer's reading order. */
  readonly placements: readonly NodePlacement[];
  /** Absent only on layers accepted before edge shapes existed; read it as "default". */
  readonly edgeShape?: EdgeShape;
  readonly edgeRoutes?: readonly EdgeRoute[];
}

export interface EdgeRoute {
  readonly edgeId: GraphId;
  readonly shape?: EdgeShape;
  readonly ends?: readonly { readonly nodeId: GraphId; readonly side?: NodeSide }[];
  readonly waypoints?: readonly { readonly x: number; readonly y: number }[];
}

export interface GraphLayer {
  /** Agent-chosen member to open when no user selection is remembered. */
  readonly defaultNodeId?: GraphId;
  readonly id: GraphId;
  /** Stable author-assigned identity; absent only in projections written before client keys were exposed. */
  readonly clientKey?: string;
  readonly nodes: readonly GraphId[];
  readonly edges: readonly GraphId[];
  /** Null or absent only for accepted layers created before authored layouts were introduced. */
  readonly layout?: LayerLayout | null;
  /** "artifact": the viewer reads this layer's single node. Absent: a graph. */
  readonly renderer?: LayerRenderer;
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
  /** Inert imported conversion provenance; never grants invocation or edit authority. */
  readonly convertedFromInvoke?: boolean;
  readonly resolvedInvokeInteractionId?: GraphId;
  readonly id: GraphId;
  /** Stable author-assigned identity; absent only in projections written before client keys were exposed. */
  readonly clientKey?: string;
  readonly sourceNodeId: GraphId;
  readonly sourceLayerId?: GraphId | null;
  /** Stable identity of sourceLayerId; absent for legacy projections and actions without a source layer. */
  readonly sourceLayerClientKey?: string;
  readonly kind: ActionKind;
  readonly relation?: NavigateRelation | null;
  readonly label: string;
  readonly variant: ActionVariant;
  readonly icon?: GraphIcon | null;
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
  readonly threadIconProposal?: string;
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

/** Read-only frozen policy; only trusted graph preparation creates authority. */
export interface InteractionPermissions {
  readonly version: "1" | "2";
  readonly enabled: boolean;
  readonly permissions: readonly (
    | { readonly kind: "navigate.add"; readonly nodeId: GraphId }
    | { readonly kind: "invoke.resolve"; readonly actionId: GraphId }
  )[];
}

export interface InteractionInput {
  readonly interactionPermissions?: InteractionPermissions;
  readonly interaction: InteractionInputNode;
  readonly contexts: readonly InteractionContext[];
  readonly submittedInputs?: readonly SubmittedInput[];
}

export type SubmittedInputAction =
  | { readonly control: "text"; readonly prompt: string }
  | { readonly control: "single_select"; readonly prompt: string; readonly options: readonly InputOption[] }
  | { readonly control: "multi_select"; readonly prompt: string; readonly options: readonly InputOption[]; readonly minimumSelections?: number };

export type SubmittedInputValue =
  | { readonly text: string }
  | { readonly selected: readonly InputOption[] };

/** Authority-free semantic snapshot of one immutable direct interaction input child. */
export interface SubmittedInput {
  readonly action: SubmittedInputAction;
  readonly value: SubmittedInputValue;
}

/** Model-visible node contents without invocation or occurrence authority. */
export interface InteractionInputNode {
  readonly id: GraphId;
  readonly kind: string;
  readonly icon: GraphIcon;
  readonly title: string;
  readonly detail: string;
  readonly state: RecordState;
}

export interface GraphCapability {
  /** Optional diagnostic capture; never graph authority. */
  readonly authoringErrors?: boolean;
  readonly url: string;
  readonly token: string;
  readonly nodeId: GraphId;
  /** Where this completion's draft-preview PNGs are written (PRD §11.10). */
  readonly previewDirectory?: string;
  /** Where this completion's saved graph programs are kept, so a retry can name one and send edits. */
  readonly programDirectory?: string;
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
