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
  it("publishes three coding features and one work artifact across pinned repositories", () => {
    expect([...frontierAutonomousCaseIds]).toEqual([
      OFETCH_RETRY_METHODS_CASE_ID,
      TRUE_MYTH_INSPECT_BOTH_CASE_ID,
      SQL_FORMATTER_ANSI_ALIAS_CASE_ID,
      HTTPX_PROXY_AUTH_REPORT_CASE_ID,
    ]);
    expect(frontierAutonomousCases.map(({ snapshot }) => snapshot.category)).toEqual([
      "coding",
      "coding",
      "coding",
      "work",
    ]);
    expect(frontierAutonomousCases.slice(0, 3).every(({ snapshot }) => snapshot.taskType === "feature-change")).toBe(true);
    expect(new Set(frontierAutonomousCases.map(({ snapshot }) => snapshot.artifacts.workspace.source)).size).toBe(4);
  });

  it("keeps evaluator-only paths out of every public catalog snapshot", () => {
    for (const entry of frontierAutonomousCases) {
      expect(entry.snapshot.authoringStatus).toBe("candidate");
      expect(entry.snapshot.artifacts.verifier.mandatoryGates).toHaveLength(2);
      expect(entry.catalogSnapshot.artifacts.reference).not.toHaveProperty("sealedPath");
      expect(entry.catalogSnapshot.artifacts.verifier).not.toHaveProperty("sealedPath");
      expect(entry.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  it("accepts reasonable documentation alongside the required ofetch delivery files", async () => {
    const checks = await gradeFrontierProjectWorkspace({
      caseId: OFETCH_RETRY_METHODS_CASE_ID,
      workspaceDirectory: "/disposable/ofetch",
      runCommand: async (command, args) => {
        if (command !== "git") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "diff") {
          return {
            exitCode: 0,
            stdout: "M\tREADME.md\nM\tsrc/fetch.ts\nM\tsrc/types.ts\nM\ttest/index.test.ts\n",
            stderr: "",
          };
        }
        if (args[0] === "rev-list") return { exitCode: 0, stdout: "reference-commit\n", stderr: "" };
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
    });

    expect(checks.find(({ name }) => name === "workspace:required-delivery-files")).toMatchObject({
      passed: true,
    });
    expect(checks.every(({ passed }) => passed)).toBe(true);
  });

  it("rejects deleted required files and changes outside the declared scope", async () => {
    const checks = await gradeFrontierProjectWorkspace({
      caseId: OFETCH_RETRY_METHODS_CASE_ID,
      workspaceDirectory: "/disposable/ofetch",
      runCommand: async (command, args) => {
        if (command !== "git") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "diff") return { exitCode: 0, stdout: "M\tsrc/fetch.ts\nM\tsrc/types.ts\nD\ttest/index.test.ts\nA\tpackage.json\n", stderr: "" };
        if (args[0] === "rev-list") return { exitCode: 0, stdout: "commit\n", stderr: "" };
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
    });
    expect(checks.find(({ name }) => name === "workspace:required-delivery-files")?.passed).toBe(false);
  });
});
