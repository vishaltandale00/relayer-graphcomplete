import { describe, expect, it } from "vitest";

import {
  frontierAutonomousCases,
  frontierAutonomousCaseIds,
  HTTPX_PROXY_AUTH_REPORT_CASE_ID,
  OFETCH_RETRY_METHODS_CASE_ID,
  SQL_FORMATTER_ANSI_ALIAS_CASE_ID,
  TRUE_MYTH_INSPECT_BOTH_CASE_ID,
  gradeFrontierProjectWorkspace,
} from "../src/project-cases/frontier-autonomous-cases.js";

describe("frontier autonomous candidate cases", () => {
  it("publishes frontier candidate cases across pinned repositories without evaluator-only paths", () => {
    expect([...frontierAutonomousCaseIds], "the published case order").toEqual([
      OFETCH_RETRY_METHODS_CASE_ID,
      TRUE_MYTH_INSPECT_BOTH_CASE_ID,
      SQL_FORMATTER_ANSI_ALIAS_CASE_ID,
      HTTPX_PROXY_AUTH_REPORT_CASE_ID,
    ]);
    expect(frontierAutonomousCases.map(({ snapshot }) => snapshot.category), "three coding features and one work artifact").toEqual([
      "coding",
      "coding",
      "coding",
      "work",
    ]);
    expect(
      frontierAutonomousCases.slice(0, 3).every(({ snapshot }) => snapshot.taskType === "feature-change"),
      "the coding cases are feature changes",
    ).toBe(true);
    expect(
      new Set(frontierAutonomousCases.map(({ snapshot }) => snapshot.artifacts.workspace.source)).size,
      "each case pins a distinct repository",
    ).toBe(4);

    for (const entry of frontierAutonomousCases) {
      expect.soft(entry.snapshot.authoringStatus, `${entry.snapshot.id}: the case remains a candidate`).toBe("candidate");
      expect.soft(entry.snapshot.artifacts.verifier.mandatoryGates, `${entry.snapshot.id}: the verifier keeps two mandatory gates`).toHaveLength(2);
      expect.soft(entry.catalogSnapshot.artifacts.reference, `${entry.snapshot.id}: the catalog reference hides sealed paths`).not.toHaveProperty("sealedPath");
      expect.soft(entry.catalogSnapshot.artifacts.verifier, `${entry.snapshot.id}: the catalog verifier hides sealed paths`).not.toHaveProperty("sealedPath");
      expect.soft(entry.snapshotDigest, `${entry.snapshot.id}: the snapshot digest is a sha256 value`).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  it("grades frontier delivery files and change scope from the git record", async () => {
    const gitRunner = (diffOutput: string) => async (command: string, args: readonly string[]) => {
      if (command !== "git") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "diff") return { exitCode: 0, stdout: diffOutput, stderr: "" };
      if (args[0] === "rev-list") return { exitCode: 0, stdout: "reference-commit\n", stderr: "" };
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    };

    const accepted = await gradeFrontierProjectWorkspace({
      caseId: OFETCH_RETRY_METHODS_CASE_ID,
      workspaceDirectory: "/disposable/ofetch",
      runCommand: gitRunner("M\tREADME.md\nM\tsrc/fetch.ts\nM\tsrc/types.ts\nM\ttest/index.test.ts\n"),
    });
    expect(
      accepted.find(({ name }) => name === "workspace:required-delivery-files"),
      "reasonable documentation alongside the required delivery files is accepted",
    ).toMatchObject({ passed: true });
    expect(accepted.every(({ passed }) => passed), "a complete in-scope delivery passes every check").toBe(true);

    const rejected = await gradeFrontierProjectWorkspace({
      caseId: OFETCH_RETRY_METHODS_CASE_ID,
      workspaceDirectory: "/disposable/ofetch",
      runCommand: gitRunner("M\tsrc/fetch.ts\nM\tsrc/types.ts\nD\ttest/index.test.ts\nA\tpackage.json\n"),
    });
    expect(
      rejected.find(({ name }) => name === "workspace:required-delivery-files")?.passed,
      "deleted required files and out-of-scope changes fail the delivery check",
    ).toBe(false);
  });
});
