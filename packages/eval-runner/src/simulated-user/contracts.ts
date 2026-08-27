import type {
  InvokeActionRatings,
  LayerRatings,
  NavigateActionRatings,
  NodeRatings,
  TurnRatings,
} from "./rubric.js";

export const SIMULATED_USER_CONTRACT_VERSION = 1 as const;
export const SIMULATED_USER_CONTRACT_ID = "simulated-user-tools-v1" as const;

export type ExecutionId = string;
export type ThreadId = string;
export type TurnId = string;
export type LayerId = string;
export type NodeId = string;
export type ActionId = string;
export type ElementRef = string;
export type ScreenshotId = string;
export type ContentDigest = `sha256:${string}`;
export type ScreenshotEvidenceRef = ScreenshotId;

export interface ViewportMetadata {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
}

export type ScreenshotCaptureTarget =
  | { readonly kind: "viewport" }
  | { readonly kind: "element"; readonly elementRef: ElementRef };

export interface ScreenshotTileMetadata {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly contentDigest: ContentDigest;
}

export interface NavigationPathEntry {
  readonly layerId: LayerId;
  readonly viaActionId: ActionId | null;
}

export interface ScreenshotState {
  readonly executionId: ExecutionId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly layerId: LayerId;
  readonly selectedNodeId: NodeId | null;
  readonly activatedActionId: ActionId | null;
  readonly navigationPath: readonly NavigationPathEntry[];
}

export interface ScreenshotMetadata extends ScreenshotState {
  readonly schemaVersion: 1;
  readonly screenshotId: ScreenshotId;
  readonly label: string;
  readonly mode: "visible" | "full";
  readonly viewport: ViewportMetadata;
  readonly captureTarget: ScreenshotCaptureTarget;
  readonly tileCount: number;
  readonly tiles: readonly ScreenshotTileMetadata[];
  readonly contentDigest: ContentDigest;
}

export interface LayerEvidence {
  readonly viewport: readonly ScreenshotEvidenceRef[];
}

export interface NodeEvidence {
  readonly context: readonly ScreenshotEvidenceRef[];
  readonly detail: readonly ScreenshotEvidenceRef[];
}

export interface NavigateActionEvidence {
  readonly source: readonly ScreenshotEvidenceRef[];
  readonly destination: readonly ScreenshotEvidenceRef[];
}

export interface InvokeActionEvidence {
  readonly source: readonly ScreenshotEvidenceRef[];
}

export interface TurnEvidence {
  readonly representative: readonly ScreenshotEvidenceRef[];
}

export type Finding = StrengthFinding | IssueFinding;

export interface StrengthFinding {
  readonly type: "strength";
  readonly text: string;
  readonly evidence: readonly ScreenshotEvidenceRef[];
}

export interface IssueFinding {
  readonly type: "issue";
  readonly severity: "minor" | "material" | "critical";
  readonly text: string;
  readonly evidence: readonly ScreenshotEvidenceRef[];
}

export interface LayerReview {
  readonly layerId: LayerId;
  readonly evidence: LayerEvidence;
  readonly ratings: LayerRatings;
  readonly nullRatingJustifications?: Readonly<Partial<Record<keyof LayerRatings, string>>>;
  readonly summary: string;
  readonly findings: readonly Finding[];
}

export interface NavigateActionReview {
  readonly actionId: ActionId;
  readonly kind: "navigate";
  readonly evidence: NavigateActionEvidence;
  readonly ratings: NavigateActionRatings;
  readonly nullRatingJustifications?: Readonly<Partial<Record<keyof NavigateActionRatings, string>>>;
  readonly summary: string;
  readonly findings: readonly Finding[];
}

export interface InvokeActionReview {
  readonly actionId: ActionId;
  readonly kind: "invoke";
  readonly evidence: InvokeActionEvidence;
  readonly ratings: InvokeActionRatings;
  readonly nullRatingJustifications?: Readonly<Partial<Record<keyof InvokeActionRatings, string>>>;
  readonly summary: string;
  readonly findings: readonly Finding[];
}

export type ActionReview = NavigateActionReview | InvokeActionReview;

export interface NodeReview {
  readonly nodeId: NodeId;
  readonly layerId: LayerId;
  readonly evidence: NodeEvidence;
  readonly ratings: NodeRatings;
  readonly nullRatingJustifications?: Readonly<Partial<Record<keyof NodeRatings, string>>>;
  readonly actions: readonly ActionReview[];
  /** Required recursive-disclosure judgment, including absent-but-needed affordances. */
  readonly structure: NodeStructureReview;
  readonly summary: string;
  readonly findings: readonly Finding[];
}

export interface NodeStructureReview {
  readonly rating: 1 | 2 | 3 | 4;
  readonly expansion: StructureDimensionReview;
  readonly references: StructureDimensionReview;
  readonly invoke: StructureDimensionReview;
  readonly reason: string;
  readonly evidence: readonly ScreenshotEvidenceRef[];
}

export interface TurnReview {
  readonly turnId: TurnId;
  readonly evidence: TurnEvidence;
  readonly ratings: TurnRatings;
  readonly nullRatingJustifications?: Readonly<Partial<Record<keyof TurnRatings, string>>>;
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly structure: StructureReview;
  /** Explicit ceiling applied after weighted presentation aggregation. */
  readonly scoreCeiling: PresentationScoreCeiling;
}

export interface PresentationScoreCeiling {
  readonly maximum: 1 | 2 | 3 | 4;
  readonly reason: string;
  readonly evidence: readonly ScreenshotEvidenceRef[];
}

export type StructureNeed = "none" | "helpful" | "required";
export type StructureResult = "absent" | "works" | "mixed" | "fails";

export interface StructureDimensionReview {
  readonly need: StructureNeed;
  readonly result: StructureResult;
}

export interface StructureReview {
  readonly overall: "helps" | "neutral" | "mixed" | "hurts";
  readonly expansion: StructureDimensionReview;
  readonly references: StructureDimensionReview;
  readonly reason: string;
  readonly evidence: readonly ScreenshotEvidenceRef[];
}

export interface ScreenshotToolInput {
  readonly target: ScreenshotCaptureTarget;
  readonly mode: "visible" | "full";
  readonly label: string;
}

export interface VisibleElementReference {
  readonly elementRef: ElementRef;
  readonly role: string;
  readonly name: string;
  readonly disabled: boolean;
}

export interface ScreenshotToolSuccess {
  readonly ok: true;
  readonly screenshot: ScreenshotMetadata;
  readonly elements: readonly VisibleElementReference[];
}

export interface InteractToolInput {
  readonly elementRef: ElementRef;
  readonly activate: true;
}

export interface ReviewUiState {
  readonly turnId: TurnId;
  readonly layerId: LayerId;
  readonly selectedNodeId: NodeId | null;
  readonly activatedActionId: ActionId | null;
  readonly navigationPath: readonly NavigationPathEntry[];
}

export interface InteractToolSuccess {
  readonly ok: true;
  readonly state: ReviewUiState;
}

export interface HistoryToolInput {
  /** A non-zero integer. Negative moves backward and positive moves forward. */
  readonly delta: number;
}

export interface HistoryToolSuccess {
  readonly ok: true;
  readonly state: ReviewUiState;
}

export interface ReviewLayerToolInput {
  readonly review: LayerReview;
}

export interface ReviewLayerToolSuccess {
  readonly ok: true;
  readonly disposition: "created" | "revised";
  readonly layerId: LayerId;
}

export interface ReviewNodeToolInput {
  readonly review: NodeReview;
}

export interface ReviewNodeToolSuccess {
  readonly ok: true;
  readonly disposition: "created" | "revised";
  readonly nodeId: NodeId;
}

export interface SubmitReviewToolInput {
  readonly review: TurnReview;
}

export interface SubmitReviewToolSuccess {
  readonly ok: true;
  readonly finalized: true;
  readonly turnId: TurnId;
}

export type ReviewValidationIssueCode =
  | "invalid_contract"
  | "invalid_input"
  | "unknown_rubric_key"
  | "missing_rubric_key"
  | "invalid_rating"
  | "unjustified_null_rating"
  | "unknown_evidence"
  | "unrelated_evidence"
  | "evidence_subject_mismatch"
  | "screenshot_state_mismatch"
  | "navigation_path_mismatch"
  | "incomplete_coverage"
  | "already_finalized";

export interface ReviewValidationIssue {
  readonly code: ReviewValidationIssueCode;
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly screenshotId?: ScreenshotId;
}

export interface MissingReviewSubject {
  readonly kind: "layer" | "node" | "navigate_action" | "invoke_action" | "turn";
  readonly subjectId: string;
  readonly layerId?: LayerId;
  readonly nodeId?: NodeId;
}

export type ReviewToolName = "reviewLayer" | "reviewNode" | "submitReview";

export interface ReviewValidationError<ToolName extends ReviewToolName = ReviewToolName> {
  readonly schemaVersion: 1;
  readonly kind: "review_validation_error";
  readonly tool: ToolName;
  readonly message: string;
  readonly issues: readonly ReviewValidationIssue[];
  readonly missingSubjects: readonly MissingReviewSubject[];
}

export interface ReviewToolFailure<ToolName extends ReviewToolName = ReviewToolName> {
  readonly ok: false;
  readonly error: ReviewValidationError<ToolName>;
}

export type ExplorationToolName = "screenshot" | "interact" | "history";

export interface SimulatedUserToolError<ToolName extends ExplorationToolName = ExplorationToolName> {
  readonly schemaVersion: 1;
  readonly kind: "tool_error";
  readonly tool: ToolName;
  readonly code: "invalid_input" | "unknown_element" | "history_out_of_range" | "capture_failed";
  readonly message: string;
}

export interface SimulatedUserToolFailure<ToolName extends ExplorationToolName = ExplorationToolName> {
  readonly ok: false;
  readonly error: SimulatedUserToolError<ToolName>;
}

export type ScreenshotToolOutput = ScreenshotToolSuccess | SimulatedUserToolFailure<"screenshot">;
export type InteractToolOutput = InteractToolSuccess | SimulatedUserToolFailure<"interact">;
export type HistoryToolOutput = HistoryToolSuccess | SimulatedUserToolFailure<"history">;
export type ReviewLayerToolOutput = ReviewLayerToolSuccess | ReviewToolFailure<"reviewLayer">;
export type ReviewNodeToolOutput = ReviewNodeToolSuccess | ReviewToolFailure<"reviewNode">;
export type SubmitReviewToolOutput = SubmitReviewToolSuccess | ReviewToolFailure<"submitReview">;

export interface SimulatedUserToolContractMap {
  readonly screenshot: { readonly input: ScreenshotToolInput; readonly output: ScreenshotToolOutput };
  readonly interact: { readonly input: InteractToolInput; readonly output: InteractToolOutput };
  readonly history: { readonly input: HistoryToolInput; readonly output: HistoryToolOutput };
  readonly reviewLayer: { readonly input: ReviewLayerToolInput; readonly output: ReviewLayerToolOutput };
  readonly reviewNode: { readonly input: ReviewNodeToolInput; readonly output: ReviewNodeToolOutput };
  readonly submitReview: { readonly input: SubmitReviewToolInput; readonly output: SubmitReviewToolOutput };
}

export type SimulatedUserToolName = keyof SimulatedUserToolContractMap;

export interface SimulatedUserJudgeContractManifest {
  readonly schemaVersion: 1;
  readonly contractId: "simulated-user-tools-v1";
  readonly toolNames: readonly SimulatedUserToolName[];
  readonly elementReferencesAreEvidence: false;
  readonly submitAcceptsLayerOrNodeReviews: false;
}

export const SIMULATED_USER_JUDGE_CONTRACT_V1 = {
  schemaVersion: SIMULATED_USER_CONTRACT_VERSION,
  contractId: SIMULATED_USER_CONTRACT_ID,
  toolNames: ["screenshot", "interact", "history", "reviewLayer", "reviewNode", "submitReview"],
  elementReferencesAreEvidence: false,
  submitAcceptsLayerOrNodeReviews: false,
} as const satisfies SimulatedUserJudgeContractManifest;
