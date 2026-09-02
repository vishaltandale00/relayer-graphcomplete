import { describe, expect, it } from "vitest";
import type { HarnessConfiguration } from "@relayer/harness-host";
import { expandTestRun } from "../src/run-plan.js";

const medium: HarnessConfiguration = {
  schemaVersion: 1,
  name: "codex-basic",
  implementation: "codex.basic",
  implementationVersion: 1,
  permissionBindings: { ask: {}, auto: {}, full: {} },
  settings: { modelReasoningEffort: "medium" },
};
const high: HarnessConfiguration = {
  ...medium,
  name: "codex-basic-high",
  settings: { modelReasoningEffort: "high" },
};

describe("test run expansion", () => {
  it("expands harness-agnostic cases across independently selected configurations and rejects unresolved names", () => {
    const executions = expandTestRun({
      testRunId: "run-123",
      testCaseIds: ["case-a", "case-b"],
      harnessConfigurationNames: [medium.name, high.name],
      judgeConfiguration: { name: "judge-v1", threshold: 0.8 },
    }, new Map([[medium.name, medium], [high.name, high]]));

    expect(
      executions.map(({ testRunId, testCaseId, harnessConfigurationName }) => [testRunId, testCaseId, harnessConfigurationName]),
      "every case expands across every selected configuration",
    ).toEqual([
      ["run-123", "case-a", "codex-basic"],
      ["run-123", "case-a", "codex-basic-high"],
      ["run-123", "case-b", "codex-basic"],
      ["run-123", "case-b", "codex-basic-high"],
    ]);
    expect(executions[0]!.harnessConfiguration, "each execution binds the resolved configuration").toEqual(medium);
    expect(executions[0]!.harnessConfiguration, "the bound configuration is a copy, not the selected object").not.toBe(medium);
    expect(executions[0]!.harnessConfigurationDigest, "each bound configuration is digested").toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      executions[0]!.harnessConfigurationDigest,
      "independently selected configurations digest differently",
    ).not.toBe(executions[1]!.harnessConfigurationDigest);

    expect(() => expandTestRun({
      testRunId: "run-123",
      testCaseIds: ["case-a"],
      harnessConfigurationNames: ["missing"],
      judgeConfiguration: { name: "none" },
    }, new Map()), "a selected name that was never resolved fails at the runner boundary").toThrow(
      "Unknown harness configuration: missing",
    );
  });
});
