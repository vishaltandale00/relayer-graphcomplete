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
  it("creates a confined, frozen five-artifact snapshot", () => {
    const snapshot = createAutonomousCaseSnapshot(caseInput());

    expect(snapshot, "the snapshot carries the five artifacts with the default presentation decay").toMatchObject({
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
    expect(Object.isFrozen(snapshot), "the snapshot is immutable").toBe(true);
    expect(Object.isFrozen(snapshot.artifacts.verifier.mandatoryGates), "the verifier gates are immutable").toBe(true);

    const original = caseInput();
    const cases: readonly [label: string, input: typeof original, message: string][] = [
      ["a verifier without mandatory gates", {
        ...original,
        artifacts: {
          ...original.artifacts,
          verifier: { ...original.artifacts.verifier, mandatoryGates: [] },
        },
      }, "at least one mandatory gate"],
      ["an out-of-range layer-depth decay", {
        ...original,
        presentation: { graphApplicable: true, layerDepthDecay: 0 },
      }, "layer-depth decay"],
      ["an unsafe sealed path", {
        ...original,
        artifacts: {
          ...original.artifacts,
          reference: { ...original.artifacts.reference, sealedPath: "../solution.patch" },
        },
      }, "package-relative confined path"],
      ["duplicate rubric identifiers", {
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
      }, "duplicate outcome rubric criterion IDs"],
    ];
    expect(cases, "every confined-snapshot violation is a named row").toHaveLength(4);
    for (const [label, input, message] of cases) {
      expect(() => createAutonomousCaseSnapshot(input), `${label} is rejected`).toThrow(message);
    }
  });

  it("projects sealed snapshots into safe catalog bindings", () => {
    expect(
      canonicalJson({ z: 1, a: { y: 2, x: 3 } }),
      "canonical JSON is independent of object key insertion order",
    ).toBe(canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
    const snapshot = createAutonomousCaseSnapshot(caseInput());
    expect(digestAutonomousCaseSnapshot(snapshot), "the snapshot digest is a sha256 value").toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      digestAutonomousCaseSnapshot(structuredClone(snapshot)),
      "the digest is stable across clones",
    ).toBe(digestAutonomousCaseSnapshot(snapshot));

    const runtimeSnapshot = structuredClone(snapshot) as typeof snapshot & {
      artifacts: typeof snapshot.artifacts & {
        reference: typeof snapshot.artifacts.reference & { contents: string };
        verifier: typeof snapshot.artifacts.verifier & { privatePath: string };
      },
    };
    runtimeSnapshot.artifacts.reference.contents = "sealed reference contents";
    runtimeSnapshot.artifacts.verifier.privatePath = "/private/verifier";
    const sanitized = sanitizeAutonomousCaseSnapshot(runtimeSnapshot);
    const serialized = JSON.stringify(sanitized);

    expect(serialized, "sealed reference paths never leave the sanitizer").not.toContain("solution/reference.patch");
    expect(serialized, "sealed verifier paths never leave the sanitizer").not.toContain("verifier/verify.mjs");
    expect(serialized, "sealed reference contents never leave the sanitizer").not.toContain("sealed reference contents");
    expect(serialized, "runtime-private paths never leave the sanitizer").not.toContain("/private/verifier");
    expect(sanitized.artifacts.reference, "the sanitized reference drops sealedPath").not.toHaveProperty("sealedPath");
    expect(sanitized.artifacts.verifier, "the sanitized verifier drops sealedPath").not.toHaveProperty("sealedPath");
    expect(sanitized.artifacts.reference.contentDigest, "the reference digest survives sanitization").toBe(digest("4"));
    expect(sanitized.artifacts.verifier.mandatoryGates, "the mandatory gates survive sanitization").toHaveLength(1);

    const definition = { id: "legacy-case", prompts: ["Do the work."] };
    const bound = bindAutonomousCaseSnapshot(definition, snapshot);
    const catalog = decorateCatalogCaseWithSnapshot(bound);

    expect(bound.snapshot.artifacts.reference.sealedPath, "the in-memory binding keeps the sealed path for evaluators").toBe("solution/reference.patch");
    expect(bound.snapshotDigest, "the binding records the snapshot digest").toBe(digestAutonomousCaseSnapshot(snapshot));
    expect(catalog, "the catalog carries only safe decorated data").toMatchObject({
      definition,
      caseSnapshot: { id: "coding.example-feature" },
      caseSnapshotDigest: bound.snapshotDigest,
    });
    expect(JSON.stringify(catalog), "the catalog never exposes sealedPath").not.toContain("sealedPath");
    expect(Object.isFrozen(catalog), "the catalog projection is immutable").toBe(true);
  });
});
