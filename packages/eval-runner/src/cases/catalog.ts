import { createHash } from "node:crypto";

import type {
  AutonomousCaseSnapshot,
  CaseContentDigest,
  PublicAutonomousCaseSnapshot,
} from "./contracts.js";
import { validateAutonomousCaseSnapshot } from "./contracts.js";

export interface BoundAutonomousCase<Definition> {
  readonly definition: Definition;
  /** Evaluator-only snapshot. Do not return this object from a catalog API. */
  readonly snapshot: AutonomousCaseSnapshot;
  readonly snapshotDigest: CaseContentDigest;
  readonly catalogSnapshot: PublicAutonomousCaseSnapshot;
}

export interface SnapshotDecoratedCatalogCase<Definition> {
  readonly definition: Definition;
  readonly caseSnapshot: PublicAutonomousCaseSnapshot;
  readonly caseSnapshotDigest: CaseContentDigest;
}

export function digestAutonomousCaseSnapshot(snapshot: AutonomousCaseSnapshot): CaseContentDigest {
  validateAutonomousCaseSnapshot(snapshot);
  return `sha256:${createHash("sha256").update(canonicalJson(snapshot)).digest("hex")}`;
}

export function sanitizeAutonomousCaseSnapshot(snapshot: AutonomousCaseSnapshot): PublicAutonomousCaseSnapshot {
  validateAutonomousCaseSnapshot(snapshot);
  const reference = {
    kind: snapshot.artifacts.reference.kind,
    artifactId: snapshot.artifacts.reference.artifactId,
    format: snapshot.artifacts.reference.format,
    contentDigest: snapshot.artifacts.reference.contentDigest,
  } as const;
  const verifier = {
    kind: snapshot.artifacts.verifier.kind,
    artifactId: snapshot.artifacts.verifier.artifactId,
    verifierId: snapshot.artifacts.verifier.verifierId,
    contentDigest: snapshot.artifacts.verifier.contentDigest,
    mandatoryGates: structuredClone(snapshot.artifacts.verifier.mandatoryGates),
  } as const;
  return deepFreeze({
    ...structuredClone(snapshot),
    artifacts: {
      task: structuredClone(snapshot.artifacts.task),
      workspace: structuredClone(snapshot.artifacts.workspace),
      reference: structuredClone(reference),
      verifier: structuredClone(verifier),
      outcomeRubric: structuredClone(snapshot.artifacts.outcomeRubric),
    },
  });
}

/**
 * Keeps the evaluator-only snapshot separate from a legacy in-memory definition,
 * while providing the safe projection and digest needed by a future catalog.
 */
export function bindAutonomousCaseSnapshot<Definition>(
  definition: Definition,
  snapshot: AutonomousCaseSnapshot,
): BoundAutonomousCase<Definition> {
  const storedSnapshot = structuredClone(snapshot);
  validateAutonomousCaseSnapshot(storedSnapshot);
  return deepFreeze({
    definition: structuredClone(definition),
    snapshot: storedSnapshot,
    snapshotDigest: digestAutonomousCaseSnapshot(storedSnapshot),
    catalogSnapshot: sanitizeAutonomousCaseSnapshot(storedSnapshot),
  });
}

/** A safe adapter shape that existing in-memory catalog entries can consume later. */
export function decorateCatalogCaseWithSnapshot<Definition>(
  bound: BoundAutonomousCase<Definition>,
): SnapshotDecoratedCatalogCase<Definition> {
  return deepFreeze({
    definition: structuredClone(bound.definition),
    caseSnapshot: structuredClone(bound.catalogSnapshot),
    caseSnapshotDigest: bound.snapshotDigest,
  });
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Canonical JSON cannot encode this value.");
  return serialized;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
