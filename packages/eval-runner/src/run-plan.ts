import { digestHarnessConfiguration, type HarnessConfiguration } from "@relayer/harness-host";

export interface TestRunSelection<JudgeConfiguration> {
  readonly testRunId: string;
  readonly testCaseIds: readonly string[];
  readonly harnessConfigurationNames: readonly string[];
  readonly judgeConfiguration: JudgeConfiguration;
}

export interface TestExecutionPlan<JudgeConfiguration> {
  readonly testRunId: string;
  readonly testCaseId: string;
  readonly harnessConfigurationName: string;
  readonly harnessConfiguration: HarnessConfiguration;
  readonly harnessConfigurationDigest: string;
  readonly judgeConfiguration: JudgeConfiguration;
}

export function expandTestRun<JudgeConfiguration>(
  selection: TestRunSelection<JudgeConfiguration>,
  harnessConfigurations: ReadonlyMap<string, HarnessConfiguration>,
): readonly TestExecutionPlan<JudgeConfiguration>[] {
  requireIdentifier(selection.testRunId, "test run ID");
  requireUniqueNonEmpty(selection.testCaseIds, "test case IDs");
  requireUniqueNonEmpty(selection.harnessConfigurationNames, "harness configuration names");

  return selection.testCaseIds.flatMap((testCaseId) => {
    requireIdentifier(testCaseId, "test case ID");
    return selection.harnessConfigurationNames.map((harnessConfigurationName) => {
      requireIdentifier(harnessConfigurationName, "harness configuration name");
      const resolved = harnessConfigurations.get(harnessConfigurationName);
      if (resolved === undefined) throw new Error(`Unknown harness configuration: ${harnessConfigurationName}`);
      if (resolved.name !== harnessConfigurationName) {
        throw new Error(`Harness configuration catalog key ${harnessConfigurationName} does not match snapshot name ${resolved.name}`);
      }
      const harnessConfiguration = structuredClone(resolved);
      return {
        testRunId: selection.testRunId,
        testCaseId,
        harnessConfigurationName,
        harnessConfiguration,
        harnessConfigurationDigest: digestHarnessConfiguration(harnessConfiguration),
        judgeConfiguration: structuredClone(selection.judgeConfiguration),
      };
    });
  });
}

function requireUniqueNonEmpty(values: readonly string[], label: string): void {
  if (values.length === 0) throw new Error(`Test run must select at least one ${label.slice(0, -1)}`);
  if (new Set(values).size !== values.length) throw new Error(`Test run contains duplicate ${label}`);
}

function requireIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}
