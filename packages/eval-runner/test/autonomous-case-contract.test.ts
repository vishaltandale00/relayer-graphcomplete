import { describe, expect, it } from "vitest";

import {
  bindAutonomousCaseSnapshot,
  canonicalJson,
  createAutonomousCaseSnapshot,
  decorateCatalogCaseWithSnapshot,
  digestAutonomousCaseSnapshot,
  sanitizeAutonomousCaseSnapshot,
  type AutonomousCaseSnapshotInputV1,
} from "../src/index.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

function caseInput(): AutonomousCaseSnapshotInputV1 {
  return {
    id: "coding.example-feature",
    name: "Example feature",
    description: "Adds one behavior-verifiable feature to a frozen project.",
    category: "coding",
    taskType: "feature-change",
    artifacts: {
      task: {
        kind: "visible-task",
        text: "Add filtering to the existing results view.",
        contentDigest: digest("1"),
      },
      workspace: {
        kind: "frozen-workspace",
        materializerId: "git-seeded-v1",
        source: "https://example.test/project.git",
        revision: "commit:0123456789abcdef",
        contentDigest: digest("2"),
        environmentDigest: digest("3"),
      },
      reference: {
        kind: "sealed-reference",
        artifactId: "reference-solution",
        format: "git-patch",
        contentDigest: digest("4"),
        sealedPath: "solution/reference.patch",
      },
      verifier: {
        kind: "sealed-verifier",
        artifactId: "behavior-verifier",
        verifierId: "node-project-v1",
        contentDigest: digest("5"),
        sealedPath: "verifier/verify.mjs",
        mandatoryGates: [{
          id: "filter-behavior",
          label: "Filtering works",
          description: "The result view filters the rendered records.",
        }],
      },
      outcomeRubric: {
        kind: "outcome-rubric",
        rubricVersion: "outcome-v1",
        contentDigest: digest("6"),
        criteria: [{
          id: "behavior",
          label: "Behavior",
          description: "The requested filtering behavior works.",
          weight: 1,
        }],
      },
    },
  };
}

describe("autonomous case snapshot contract", () => {
  it("creates a frozen five-artifact snapshot with the default presentation decay", () => {
    const snapshot = createAutonomousCaseSnapshot(caseInput());

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      category: "coding",
      taskType: "feature-change",
      authoringStatus: "candidate",
      presentation: { graphApplicable: true, layerDepthDecay: 0.5 },
      artifacts: {
        task: { kind: "visible-task" },
        workspace: { kind: "frozen-workspace" },
        reference: { kind: "sealed-reference" },
        verifier: { kind: "sealed-verifier" },
        outcomeRubric: { kind: "outcome-rubric" },
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.artifacts.verifier.mandatoryGates)).toBe(true);
  });

  it("requires a mandatory verifier gate and validates presentation decay", () => {
    const original = caseInput();
    const missingGate = {
      ...original,
      artifacts: {
        ...original.artifacts,
        verifier: { ...original.artifacts.verifier, mandatoryGates: [] },
      },
    };
    expect(() => createAutonomousCaseSnapshot(missingGate)).toThrow("at least one mandatory gate");

    expect(() => createAutonomousCaseSnapshot({
      ...caseInput(),
      presentation: { graphApplicable: true, layerDepthDecay: 0 },
    })).toThrow("layer-depth decay");
  });

  it("rejects unsafe sealed paths and duplicate rubric identifiers", () => {
    const original = caseInput();
    const unsafe = {
      ...original,
      artifacts: {
        ...original.artifacts,
        reference: { ...original.artifacts.reference, sealedPath: "../solution.patch" },
      },
    };
    expect(() => createAutonomousCaseSnapshot(unsafe)).toThrow("package-relative confined path");

    const duplicate = {
      ...original,
      artifacts: {
        ...original.artifacts,
        outcomeRubric: {
          ...original.artifacts.outcomeRubric,
          criteria: [
            ...original.artifacts.outcomeRubric.criteria,
            { ...original.artifacts.outcomeRubric.criteria[0]! },
          ],
        },
      },
    };
    expect(() => createAutonomousCaseSnapshot(duplicate)).toThrow("duplicate outcome rubric criterion IDs");
  });
});

describe("autonomous case catalog projection", () => {
  it("produces a stable canonical digest independent of object key insertion order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
    const snapshot = createAutonomousCaseSnapshot(caseInput());
    expect(digestAutonomousCaseSnapshot(snapshot)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(digestAutonomousCaseSnapshot(structuredClone(snapshot))).toBe(digestAutonomousCaseSnapshot(snapshot));
  });

  it("never exposes sealed paths from the sanitized snapshot", () => {
    const snapshot = createAutonomousCaseSnapshot(caseInput());
    const runtimeSnapshot = structuredClone(snapshot) as typeof snapshot & {
      artifacts: typeof snapshot.artifacts & {
        reference: typeof snapshot.artifacts.reference & { contents: string };
        verifier: typeof snapshot.artifacts.verifier & { privatePath: string };
      };
    };
    runtimeSnapshot.artifacts.reference.contents = "sealed reference contents";
    runtimeSnapshot.artifacts.verifier.privatePath = "/private/verifier";
    const sanitized = sanitizeAutonomousCaseSnapshot(runtimeSnapshot);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain("solution/reference.patch");
    expect(serialized).not.toContain("verifier/verify.mjs");
    expect(serialized).not.toContain("sealed reference contents");
    expect(serialized).not.toContain("/private/verifier");
    expect(sanitized.artifacts.reference).not.toHaveProperty("sealedPath");
    expect(sanitized.artifacts.verifier).not.toHaveProperty("sealedPath");
    expect(sanitized.artifacts.reference.contentDigest).toBe(digest("4"));
    expect(sanitized.artifacts.verifier.mandatoryGates).toHaveLength(1);
  });

  it("binds legacy in-memory definitions while decorating catalogs only with safe data", () => {
    const definition = { id: "legacy-case", prompts: ["Do the work."] };
    const snapshot = createAutonomousCaseSnapshot(caseInput());
    const bound = bindAutonomousCaseSnapshot(definition, snapshot);
    const catalog = decorateCatalogCaseWithSnapshot(bound);

    expect(bound.snapshot.artifacts.reference.sealedPath).toBe("solution/reference.patch");
    expect(bound.snapshotDigest).toBe(digestAutonomousCaseSnapshot(snapshot));
    expect(catalog).toMatchObject({
      definition,
      caseSnapshot: { id: "coding.example-feature" },
      caseSnapshotDigest: bound.snapshotDigest,
    });
    expect(JSON.stringify(catalog)).not.toContain("sealedPath");
    expect(Object.isFrozen(catalog)).toBe(true);
  });
});
