export const AUTONOMOUS_CASE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_LAYER_DEPTH_DECAY: number = 0.5;

export type AutonomousCaseCategory = "coding" | "work";
export type CaseContentDigest = `sha256:${string}`;

export interface VisibleTaskArtifactDescriptor {
  readonly kind: "visible-task";
  readonly text: string;
  readonly contentDigest: CaseContentDigest;
}

export interface FrozenWorkspaceArtifactDescriptor {
  readonly kind: "frozen-workspace";
  /** Code-owned materializer capability, not an executable command from case data. */
  readonly materializerId: string;
  /** Stable upstream identity such as a repository URL or artifact collection ID. */
  readonly source: string;
  /** Immutable source revision such as a commit, tree, or versioned bundle ID. */
  readonly revision: string;
  readonly contentDigest: CaseContentDigest;
  /** Stable environment identity, for example an OCI digest or lockfile digest. */
  readonly environmentDigest: CaseContentDigest;
}

export interface SealedReferenceArtifactDescriptor {
  readonly kind: "sealed-reference";
  readonly artifactId: string;
  readonly format: string;
  readonly contentDigest: CaseContentDigest;
  /** Package-relative evaluator-only location. Never include this in catalog output. */
  readonly sealedPath: string;
}

export interface MandatoryVerifierGate {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface SealedVerifierArtifactDescriptor {
  readonly kind: "sealed-verifier";
  readonly artifactId: string;
  /** Code-owned verifier capability, not an executable command from case data. */
  readonly verifierId: string;
  readonly contentDigest: CaseContentDigest;
  /** Package-relative evaluator-only location. Never include this in catalog output. */
  readonly sealedPath: string;
  readonly mandatoryGates: readonly MandatoryVerifierGate[];
}

export interface OutcomeRubricCriterion {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly weight: number;
}

export interface OutcomeRubricArtifactDescriptor {
  readonly kind: "outcome-rubric";
  readonly rubricVersion: string;
  readonly criteria: readonly OutcomeRubricCriterion[];
  readonly contentDigest: CaseContentDigest;
}

export interface GraphPresentationPolicy {
  readonly graphApplicable: boolean;
  readonly layerDepthDecay: number;
}

/**
 * Immutable evaluator-owned identity for one autonomous benchmark case.
 *
 * The five logical artifacts intentionally remain distinct so visible task data
 * cannot accidentally become authority for the sealed reference or verifier.
 */
export interface AutonomousCaseSnapshotV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: AutonomousCaseCategory;
  readonly taskType: string;
  /** Candidate cases are runnable for calibration but are not benchmark-promoted. */
  readonly authoringStatus: "candidate" | "human_reviewed";
  readonly artifacts: {
    readonly task: VisibleTaskArtifactDescriptor;
    readonly workspace: FrozenWorkspaceArtifactDescriptor;
    readonly reference: SealedReferenceArtifactDescriptor;
    readonly verifier: SealedVerifierArtifactDescriptor;
    readonly outcomeRubric: OutcomeRubricArtifactDescriptor;
  };
  readonly presentation: GraphPresentationPolicy;
}

export interface AutonomousCaseSnapshotInputV1 extends Omit<AutonomousCaseSnapshotV1, "schemaVersion" | "presentation" | "authoringStatus"> {
  readonly schemaVersion?: 1;
  readonly authoringStatus?: "candidate" | "human_reviewed";
  readonly presentation?: {
    readonly graphApplicable: boolean;
    readonly layerDepthDecay?: number;
  };
}

export type AutonomousCaseSnapshot = AutonomousCaseSnapshotV1;

export type PublicReferenceArtifactDescriptor = Omit<SealedReferenceArtifactDescriptor, "sealedPath">;
export type PublicVerifierArtifactDescriptor = Omit<SealedVerifierArtifactDescriptor, "sealedPath">;

/** Safe to expose through the Eval catalog. It contains no sealed content or path. */
export interface PublicAutonomousCaseSnapshotV1 extends Omit<AutonomousCaseSnapshotV1, "artifacts"> {
  readonly artifacts: {
    readonly task: VisibleTaskArtifactDescriptor;
    readonly workspace: FrozenWorkspaceArtifactDescriptor;
    readonly reference: PublicReferenceArtifactDescriptor;
    readonly verifier: PublicVerifierArtifactDescriptor;
    readonly outcomeRubric: OutcomeRubricArtifactDescriptor;
  };
}

export type PublicAutonomousCaseSnapshot = PublicAutonomousCaseSnapshotV1;

export function createAutonomousCaseSnapshot(input: AutonomousCaseSnapshotInputV1): AutonomousCaseSnapshotV1 {
  const snapshot: AutonomousCaseSnapshotV1 = {
    schemaVersion: AUTONOMOUS_CASE_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    description: input.description,
    category: input.category,
    taskType: input.taskType,
    authoringStatus: input.authoringStatus ?? "candidate",
    artifacts: structuredClone(input.artifacts),
    presentation: {
      graphApplicable: input.presentation?.graphApplicable ?? true,
      layerDepthDecay: input.presentation?.layerDepthDecay ?? DEFAULT_LAYER_DEPTH_DECAY,
    },
  };
  validateAutonomousCaseSnapshot(snapshot);
  return deepFreeze(snapshot);
}

export function validateAutonomousCaseSnapshot(snapshot: AutonomousCaseSnapshot): void {
  if (snapshot.schemaVersion !== AUTONOMOUS_CASE_SCHEMA_VERSION) {
    throw new Error(`Unsupported autonomous case schema version: ${String(snapshot.schemaVersion)}`);
  }
  requireIdentifier(snapshot.id, "case ID");
  requireNonEmpty(snapshot.name, "case name");
  requireNonEmpty(snapshot.description, "case description");
  if (snapshot.category !== "coding" && snapshot.category !== "work") {
    throw new Error(`Invalid autonomous case category: ${String(snapshot.category)}`);
  }
  requireIdentifier(snapshot.taskType, "task type");
  if (snapshot.authoringStatus !== "candidate" && snapshot.authoringStatus !== "human_reviewed") {
    throw new Error(`Invalid autonomous case authoring status: ${String(snapshot.authoringStatus)}`);
  }

  const { task, workspace, reference, verifier, outcomeRubric } = snapshot.artifacts;
  if (task.kind !== "visible-task") throw new Error("Autonomous case task artifact has the wrong kind.");
  requireNonEmpty(task.text, "visible task text");
  requireDigest(task.contentDigest, "visible task digest");

  if (workspace.kind !== "frozen-workspace") throw new Error("Autonomous case workspace artifact has the wrong kind.");
  requireIdentifier(workspace.materializerId, "workspace materializer ID");
  requireNonEmpty(workspace.source, "workspace source");
  requireNonEmpty(workspace.revision, "workspace revision");
  requireDigest(workspace.contentDigest, "workspace digest");
  requireDigest(workspace.environmentDigest, "workspace environment digest");

  if (reference.kind !== "sealed-reference") throw new Error("Autonomous case reference artifact has the wrong kind.");
  requireIdentifier(reference.artifactId, "reference artifact ID");
  requireNonEmpty(reference.format, "reference format");
  requireDigest(reference.contentDigest, "reference digest");
  requireSafeRelativePath(reference.sealedPath, "reference sealed path");

  if (verifier.kind !== "sealed-verifier") throw new Error("Autonomous case verifier artifact has the wrong kind.");
  requireIdentifier(verifier.artifactId, "verifier artifact ID");
  requireIdentifier(verifier.verifierId, "verifier capability ID");
  requireDigest(verifier.contentDigest, "verifier digest");
  requireSafeRelativePath(verifier.sealedPath, "verifier sealed path");
  if (verifier.mandatoryGates.length === 0) {
    throw new Error("Autonomous case verifier must declare at least one mandatory gate.");
  }
  requireUniqueIds(verifier.mandatoryGates, "mandatory verifier gate");
  for (const gate of verifier.mandatoryGates) {
    requireIdentifier(gate.id, "mandatory verifier gate ID");
    requireNonEmpty(gate.label, "mandatory verifier gate label");
    requireNonEmpty(gate.description, "mandatory verifier gate description");
  }

  if (outcomeRubric.kind !== "outcome-rubric") throw new Error("Autonomous case outcome rubric artifact has the wrong kind.");
  requireIdentifier(outcomeRubric.rubricVersion, "outcome rubric version");
  requireDigest(outcomeRubric.contentDigest, "outcome rubric digest");
  if (outcomeRubric.criteria.length === 0) throw new Error("Autonomous case outcome rubric must declare at least one criterion.");
  requireUniqueIds(outcomeRubric.criteria, "outcome rubric criterion");
  let totalWeight = 0;
  for (const criterion of outcomeRubric.criteria) {
    requireIdentifier(criterion.id, "outcome rubric criterion ID");
    requireNonEmpty(criterion.label, "outcome rubric criterion label");
    requireNonEmpty(criterion.description, "outcome rubric criterion description");
    if (!Number.isFinite(criterion.weight) || criterion.weight <= 0) {
      throw new Error(`Outcome rubric criterion ${criterion.id} must have a positive finite weight.`);
    }
    totalWeight += criterion.weight;
  }
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) throw new Error("Autonomous case outcome rubric has no positive weight.");

  if (typeof snapshot.presentation.graphApplicable !== "boolean") {
    throw new Error("Autonomous case graph applicability must be boolean.");
  }
  if (!Number.isFinite(snapshot.presentation.layerDepthDecay)
    || snapshot.presentation.layerDepthDecay <= 0
    || snapshot.presentation.layerDepthDecay > 1) {
    throw new Error("Autonomous case layer-depth decay must be greater than 0 and at most 1.");
  }
}

function requireIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Autonomous case ${label} must not be empty.`);
}

function requireDigest(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label}: ${String(value)}`);
}

function requireSafeRelativePath(value: string, label: string): void {
  requireNonEmpty(value, label);
  if (value.startsWith("/")
    || value.startsWith("\\")
    || /^[a-z]:[\\/]/i.test(value)
    || value.split(/[\\/]/).includes("..")) {
    throw new Error(`Autonomous case ${label} must be a package-relative confined path.`);
  }
}

function requireUniqueIds(values: readonly { readonly id: string }[], label: string): void {
  const ids = values.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error(`Autonomous case contains duplicate ${label} IDs.`);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
