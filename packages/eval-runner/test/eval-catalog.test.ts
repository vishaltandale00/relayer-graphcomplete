import { describe, expect, it } from "vitest";
import { createSyntheticExternalCatalog } from "./fixtures/external-catalog.js";
import { projectCapabilitySuiteCatalog, validateEvalCatalogV1, validateEvalChecksV1 } from "../src/eval-catalog.js";
import { computeCapabilitySuiteDigest } from "../src/suites/contracts.js";

describe("external evaluation catalog boundary", () => {
  it("validates generic bound cases and their public projections before use", () => {
    const catalog = validateEvalCatalogV1(createSyntheticExternalCatalog());
    expect(catalog.cases.map(({ definition }) => definition.id)).toEqual([
      "fixture.external-a", "fixture.external-b",
    ]);
    expect(catalog.suites).toHaveLength(1);
    expect(JSON.stringify(catalog.cases.map(({ definition }) => definition))).not.toContain("sealedPath");
  });
  it("rejects private interactive metadata on public definitions", () => {
    const catalog = createSyntheticExternalCatalog();
    const first = catalog.cases[0]!;
    for (const key of ["humanBrief", "humanRubric", "interactive", "participantBrief"]) {
      expect(() => validateEvalCatalogV1({ ...catalog, cases: [{ ...first, definition: { ...first.definition, [key]: "private" } }] })).toThrow("Private interactive metadata");
    }
  });
  it("rejects missing callbacks and project threads with invalid authority", () => {
    const catalog = createSyntheticExternalCatalog();
    const first = catalog.cases[0]!;
    const { grade: _grade, ...missingCallback } = first;
    expect(() => validateEvalCatalogV1({ ...catalog, cases: [missingCallback, catalog.cases[1]] })).toThrow("must implement its SDK callbacks");
    const invalidThread = { ...first, definition: { ...first.definition, threads: [{ ...first.definition.threads[0], permissionProfileId: "root" }] } };
    expect(() => validateEvalCatalogV1({ ...catalog, cases: [invalidThread, catalog.cases[1]] })).toThrow("invalid project thread fields");
  });
  it("rejects duplicate IDs and tampered public snapshot claims", () => {
    const catalog = createSyntheticExternalCatalog();
    expect(() => validateEvalCatalogV1({ ...catalog, cases: [...catalog.cases, catalog.cases[0]] })).toThrow("Duplicate evaluation case ID");
    const first = catalog.cases[0]!;
    expect(() => validateEvalCatalogV1({ ...catalog, cases: [{ ...first, definition: { ...first.definition, caseSnapshotDigest: `sha256:${"0".repeat(64)}` } }, catalog.cases[1]] })).toThrow("projection or digest drifted");
  });
  it.each(["name", "description"] as const)("rejects %s drift from the authoritative snapshot", (key) => {
    const catalog = createSyntheticExternalCatalog();
    const first = catalog.cases[0]!;
    const changedDefinition = { ...first.definition, [key]: `Drifted ${key}` };
    const changedBoundDefinition = { ...(first.boundCase.definition as typeof first.definition), [key]: `Drifted ${key}` };
    expect(() => validateEvalCatalogV1({
      ...catalog,
      cases: [{ ...first, definition: changedDefinition, boundCase: { ...first.boundCase, definition: changedBoundDefinition } }, catalog.cases[1]!],
    })).toThrow(`Case ${key} drifted from its authoritative snapshot`);
  });
  it("retains valid individual cases when a well-formed suite cannot resolve", () => {
    const supplied = createSyntheticExternalCatalog();
    const suite = supplied.suites[0]!;
    const missingMember = { ...suite.members[0]!, caseId: "fixture.missing" };
    const body = { ...suite, members: [missingMember, ...suite.members.slice(1)] };
    const unresolvedSuite = {
      ...body,
      suiteDigest: computeCapabilitySuiteDigest(body),
    };

    const catalog = validateEvalCatalogV1({ ...supplied, suites: [unresolvedSuite] });
    expect(catalog.cases.map(({ definition }) => definition.id)).toEqual(["fixture.external-a", "fixture.external-b"]);
    expect(projectCapabilitySuiteCatalog(catalog.suites[0]!, catalog.cases.map(({ boundCase }) => boundCase))).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining("references missing case: fixture.missing"),
    });
  });
  it("still rejects a malformed suite manifest before catalog admission", () => {
    const supplied = createSyntheticExternalCatalog();
    expect(() => validateEvalCatalogV1({
      ...supplied,
      suites: [{ ...supplied.suites[0]!, status: "draft" }],
    })).toThrow("Invalid capability suite status");
  });
  it("owns immutable catalog data while retaining the validated callback references", () => {
    const supplied = createSyntheticExternalCatalog();
    const mutableCases = supplied.cases.map((registration) => ({
      ...registration,
      definition: structuredClone(registration.definition),
      boundCase: structuredClone(registration.boundCase),
    }));
    const mutableSuites = structuredClone(supplied.suites);
    const callbacks = mutableCases.map(({ materialize, grade, evaluateMandatoryGate }) => ({ materialize, grade, evaluateMandatoryGate }));
    const catalog = validateEvalCatalogV1({ schemaVersion: 1, cases: mutableCases, suites: mutableSuites });

    (mutableCases[0]!.definition as { name: string }).name = "Mutated after validation";
    (mutableCases[0]!.boundCase.snapshot.artifacts.task as { text: string }).text = "Mutated task";
    (mutableSuites[0]!.members[0] as { caseId: string }).caseId = "fixture.replaced";

    expect(catalog.cases[0]!.definition.name).toBe("External fixture A");
    expect(catalog.cases[0]!.boundCase.snapshot.artifacts.task.text).toBe("Implement the synthetic fixture change and verify it.");
    expect(catalog.suites[0]!.members[0]!.caseId).toBe("fixture.external-a");
    expect(catalog.cases[0]!.materialize).toBe(callbacks[0]!.materialize);
    expect(catalog.cases[0]!.grade).toBe(callbacks[0]!.grade);
    expect(catalog.cases[0]!.evaluateMandatoryGate).toBe(callbacks[0]!.evaluateMandatoryGate);
    expect(Object.isFrozen(catalog.cases[0]!.definition)).toBe(true);
    expect(Object.isFrozen(catalog.cases[0]!.boundCase.snapshot.artifacts)).toBe(true);
    expect(Object.isFrozen(catalog.suites[0]!.members)).toBe(true);
  });
  it("rejects a snapshot task that differs from the executable initial prompt", () => {
    const supplied = createSyntheticExternalCatalog();
    const first = supplied.cases[0]!;
    const changedDefinition = structuredClone(first.definition);
    (changedDefinition.threads[0]!.prompts as string[])[0] = "A different executable prompt.";
    const changedBoundDefinition = structuredClone(first.boundCase.definition) as typeof changedDefinition;
    (changedBoundDefinition.threads[0]!.prompts as string[])[0] = "A different executable prompt.";
    expect(() => validateEvalCatalogV1({
      ...supplied,
      cases: [{ ...first, definition: changedDefinition, boundCase: { ...first.boundCase, definition: changedBoundDefinition } }, supplied.cases[1]!],
    })).toThrow("snapshot task does not match executable initial prompt");
  });
  it("rejects catalog accessors without invoking them", () => {
    const supplied = createSyntheticExternalCatalog();
    let reads = 0;
    const definition = structuredClone(supplied.cases[0]!.definition);
    Object.defineProperty(definition, "name", {
      enumerable: true,
      get() { reads += 1; return "Race-dependent name"; },
    });
    expect(() => validateEvalCatalogV1({
      ...supplied,
      cases: [{ ...supplied.cases[0]!, definition }, supplied.cases[1]!],
    })).toThrow("cannot contain accessors");
    expect(reads).toBe(0);

    const boundCase = structuredClone(supplied.cases[0]!.boundCase);
    Object.defineProperty(boundCase.snapshot.artifacts.task, "text", {
      enumerable: true,
      get() { reads += 1; return "Race-dependent snapshot task"; },
    });
    expect(() => validateEvalCatalogV1({
      ...supplied,
      cases: [{ ...supplied.cases[0]!, boundCase }, supplied.cases[1]!],
    })).toThrow("cannot contain accessors");
    expect(reads).toBe(0);

    const rootReads = { count: 0 };
    expect(() => validateEvalCatalogV1({
      get schemaVersion() { rootReads.count += 1; return 1; },
      cases: supplied.cases,
      suites: supplied.suites,
    })).toThrow("cannot contain accessors");
    expect(rootReads.count).toBe(0);
  });
  it("projects grader checks to immutable plain SDK data and rejects malformed truthy results", () => {
    const projected = validateEvalChecksV1([{ name: "workspace:contract", passed: true, detail: "Passed.", ignored: "private" }]);
    expect(projected).toEqual([{ name: "workspace:contract", passed: true, detail: "Passed." }]);
    expect(() => validateEvalChecksV1(new Array(1))).toThrow("plain data object");
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected[0])).toBe(true);
    expect(() => validateEvalChecksV1([{ name: "workspace:contract", passed: "false", detail: "Malformed." }])).toThrow("boolean passed");
    expect(() => validateEvalChecksV1([{ name: "workspace:contract", passed: true, get detail() { return "Accessor."; } }])).toThrow("cannot contain accessors");
  });
});
