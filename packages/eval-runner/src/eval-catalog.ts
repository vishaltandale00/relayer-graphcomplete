import type { BoundAutonomousCase } from "./cases/catalog.js";
import { bindAutonomousCaseSnapshot, canonicalJson, digestAutonomousCaseSnapshot, sanitizeAutonomousCaseSnapshot } from "./cases/catalog.js";
import type { AutonomousCaseSnapshot, CaseContentDigest, PublicAutonomousCaseSnapshot } from "./cases/contracts.js";
import type { EvalCheck } from "./cases/graph-checks.js";
import { projectCapabilitySuiteCatalog, resolveCapabilitySuite, validateCapabilitySuiteManifestV1, type CapabilitySuiteManifestV1 } from "./suites/contracts.js";

export interface EvalMaterializeContextV1 {
  readonly caseId: string;
  readonly workspaceDirectory: string;
  readonly cacheDirectory: string;
  readonly platform: NodeJS.Platform;
}
export interface EvalGradeContextV1 {
  readonly caseId: string;
  readonly workspaceDirectory: string;
  readonly fixture: unknown;
  readonly threadDefinition: unknown;
}
export interface EvalMandatoryGateResultV1 {
  readonly complete: boolean;
  readonly passed: boolean;
  readonly matched: readonly EvalCheck[];
}
export interface EvalCaseDefinitionV1 {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly caseSnapshot: PublicAutonomousCaseSnapshot;
  readonly caseSnapshotDigest: CaseContentDigest;
  readonly threads: readonly EvalProjectThreadDefinitionV1[];
  readonly [key: string]: unknown;
}
export interface EvalProjectThreadDefinitionV1 {
  readonly id: string;
  readonly name: string;
  readonly permissionProfileId: "ask" | "auto" | "full";
  readonly mutationPolicy: "read-only" | "writable";
  readonly prompts: readonly string[];
  readonly workspaceGrade: "question" | "diagnosis" | "implementation" | "autonomous-implementation";
}
export interface EvalCaseRegistrationV1 {
  readonly definition: EvalCaseDefinitionV1;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly boundCase: BoundAutonomousCase<unknown>;
  readonly materialize: (context: EvalMaterializeContextV1) => Promise<unknown> | unknown;
  readonly grade: (context: EvalGradeContextV1) => Promise<readonly EvalCheck[]> | readonly EvalCheck[];
  readonly evaluateMandatoryGate: (gate: { readonly id: string; readonly label: string; readonly [key: string]: unknown }, checks: readonly EvalCheck[]) => EvalMandatoryGateResultV1;
}
export interface EvalCatalogV1 {
  readonly schemaVersion: 1;
  readonly cases: readonly EvalCaseRegistrationV1[];
  readonly suites: readonly CapabilitySuiteManifestV1[];
}

/** Projects an external grader result into immutable, validated SDK checks. */
export function validateEvalChecksV1(value: unknown): readonly EvalCheck[] {
  if (!Array.isArray(value)) throw new Error("External evaluation grader must return an array of checks.");
  return Object.freeze(Array.from(value, (entry, index) => {
    if (!isPlainDataRecord(entry)) throw new Error(`External evaluation check ${index} must be a plain data object.`);
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) {
      throw new Error(`External evaluation check ${index} cannot contain accessors.`);
    }
    if (typeof entry.name !== "string" || entry.name.trim() === ""
      || typeof entry.passed !== "boolean" || typeof entry.detail !== "string") {
      throw new Error(`External evaluation check ${index} must contain a non-empty name, boolean passed, and string detail.`);
    }
    return Object.freeze({ name: entry.name, passed: entry.passed, detail: entry.detail });
  }));
}

/** Validates the trusted catalog module at the generic SDK boundary. */
export function validateEvalCatalogV1(value: unknown): EvalCatalogV1 {
  const catalogProperties = dataProperties(value, "External evaluation catalog");
  const schemaVersion = catalogProperties.schemaVersion?.value;
  const suppliedCases = dataArray(catalogProperties.cases?.value, "External evaluation catalog cases") as EvalCaseRegistrationV1[];
  const suppliedSuites = dataArray(catalogProperties.suites?.value, "External evaluation catalog suites") as CapabilitySuiteManifestV1[];
  if (schemaVersion !== 1) {
    throw new Error("External evaluation catalog must use schemaVersion 1 and include cases and suites arrays.");
  }
  const caseIds = new Set<string>();
  const cases = suppliedCases.map((registration) => {
    const registrationProperties = dataProperties(registration, "Evaluation case registration");
    const definition = registrationProperties.definition?.value as EvalCaseDefinitionV1;
    const boundCase = registrationProperties.boundCase?.value as BoundAutonomousCase<unknown>;
    const available = registrationProperties.available?.value;
    const unavailableReason = registrationProperties.unavailableReason?.value;
    const materialize = registrationProperties.materialize?.value;
    const grade = registrationProperties.grade?.value;
    const evaluateMandatoryGate = registrationProperties.evaluateMandatoryGate?.value;
    if (!isRecord(definition) || !isRecord(boundCase)) throw new Error("Invalid evaluation case registration.");
    assertSerializable(definition);
    if (["interactive", "humanBrief", "humanRubric", "participantBrief", "reviewerRubric", "disclosureGuidance"].some((key) => Object.hasOwn(definition, key))) throw new Error("Private interactive metadata belongs in the canonical snapshot, not the public definition.");
    assertSerializable(boundCase);
    for (const key of ["id", "name", "description"] as const) if (typeof definition[key] !== "string" || definition[key].trim() === "") throw new Error(`Evaluation case definition ${key} must be non-empty.`);
    if (caseIds.has(definition.id)) throw new Error(`Duplicate evaluation case ID: ${definition.id}`);
    caseIds.add(definition.id);
    validateThreads(definition);
    if (typeof available !== "boolean" || (available ? unavailableReason !== null : typeof unavailableReason !== "string" || unavailableReason.trim() === "")) throw new Error(`Invalid availability state for case ${definition.id}.`);
    if (typeof materialize !== "function" || typeof grade !== "function" || typeof evaluateMandatoryGate !== "function") throw new Error(`Evaluation case ${definition.id} must implement its SDK callbacks.`);
    const snapshot = boundCase.snapshot as AutonomousCaseSnapshot;
    if (!snapshot || snapshot.id !== definition.id) throw new Error(`Bound case identity does not match definition ${definition.id}.`);
    for (const key of ["name", "description"] as const) {
      if (definition[key] !== snapshot[key]) throw new Error(`Case ${key} drifted from its authoritative snapshot: ${definition.id}.`);
    }
    const actualDigest = digestAutonomousCaseSnapshot(snapshot);
    const projection = sanitizeAutonomousCaseSnapshot(snapshot);
    if (boundCase.snapshotDigest !== actualDigest || definition.caseSnapshotDigest !== actualDigest || canonicalJson(definition.caseSnapshot) !== canonicalJson(projection) || canonicalJson(boundCase.catalogSnapshot) !== canonicalJson(projection)) throw new Error(`Case snapshot projection or digest drifted: ${definition.id}.`);
    if (canonicalJson(boundCase.definition) !== canonicalJson(Object.fromEntries(Object.entries(definition).filter(([key]) => key !== "caseSnapshot" && key !== "caseSnapshotDigest")))) throw new Error(`Bound case definition drifted: ${definition.id}.`);
    if (definition.threads[0]!.prompts[0] !== snapshot.artifacts.task.text) throw new Error(`Case snapshot task does not match executable initial prompt: ${definition.id}.`);
    const storedBoundCase = bindAutonomousCaseSnapshot(structuredClone(boundCase.definition), structuredClone(snapshot));
    return deepFreeze({
      definition: structuredClone(definition),
      available,
      unavailableReason,
      boundCase: storedBoundCase,
      materialize,
      grade,
      evaluateMandatoryGate,
    });
  });
  const suiteIds = new Set<string>();
  const suites = suppliedSuites.map((suite) => {
    assertSerializable(suite);
    if (!isRecord(suite) || typeof suite.id !== "string") throw new Error("Invalid capability suite manifest.");
    validateCapabilitySuiteManifestV1(suite);
    if (suiteIds.has(suite.id)) throw new Error(`Duplicate capability suite ID: ${suite.id}`);
    suiteIds.add(suite.id);
    return deepFreeze(structuredClone(suite));
  });
  return deepFreeze({ schemaVersion: 1, cases, suites });
}

export { projectCapabilitySuiteCatalog, resolveCapabilitySuite };

function validateThreads(definition: Record<string, any>): void {
  if (!Array.isArray(definition.threads) || definition.threads.length === 0) throw new Error(`Evaluation case ${definition.id} must declare at least one project thread.`);
  const ids = new Set<string>();
  for (const thread of definition.threads) {
    if (!isRecord(thread) || !["id", "name"].every((key) => typeof thread[key] === "string" && thread[key].trim() !== "")) throw new Error(`Evaluation case ${definition.id} has an invalid project thread identity.`);
    if (ids.has(thread.id)) throw new Error(`Evaluation case ${definition.id} has duplicate project thread ID: ${thread.id}`);
    ids.add(thread.id);
    if (!(thread.permissionProfileId === "ask" || thread.permissionProfileId === "auto" || thread.permissionProfileId === "full") || !(thread.mutationPolicy === "read-only" || thread.mutationPolicy === "writable") || !["question", "diagnosis", "implementation", "autonomous-implementation"].includes(thread.workspaceGrade) || !Array.isArray(thread.prompts) || thread.prompts.length === 0 || thread.prompts.some((prompt: unknown) => typeof prompt !== "string" || prompt.trim() === "")) throw new Error(`Evaluation case ${definition.id} has invalid project thread fields: ${thread.id}.`);
  }
}
function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function dataProperties(value: unknown, label: string): Record<string, PropertyDescriptor> {
  if (!isPlainDataRecord(value)) throw new Error(`${label} must be a plain data object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")
    || Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) {
    throw new Error(`${label} cannot contain accessors or symbol properties.`);
  }
  return descriptors;
}
function dataArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${label} must be an array.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")
    || Object.entries(descriptors).some(([key, descriptor]) => key !== "length" && (descriptor.get !== undefined || descriptor.set !== undefined))) {
    throw new Error(`${label} cannot contain accessors or symbol properties.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(descriptors, String(index))) throw new Error(`${label} cannot be sparse.`);
  }
  return value;
}
function assertSerializable(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value)) throw new Error("Evaluation case definition must be acyclic JSON data.");
  seen.add(value);
  if (Array.isArray(value)) {
    const entries = dataArray(value, "Evaluation case definition array");
    for (let index = 0; index < entries.length; index += 1) assertSerializable(Object.getOwnPropertyDescriptor(entries, String(index))!.value, seen);
  }
  else {
    const descriptors = dataProperties(value, "Evaluation case definition");
    for (const [key, descriptor] of Object.entries(descriptors)) { if (typeof descriptor.value === "undefined") throw new Error(`Undefined definition field: ${key}`); assertSerializable(descriptor.value, seen); }
  }
  seen.delete(value);
}
function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
