import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexBasicFactory, loadHarnessConfigurations, productHarnessImplementations, type HarnessConfiguration } from "@relayer/harness-host";
import { graphMemoryFixtureConfiguration, graphMemoryFixtureFactory } from "./fixtures/graph-memory.js";
import { taskSystemFixtureConfiguration, taskSystemFixtureFactory } from "./fixtures/task-system.js";
import { expandTestRun, type TestRunSelection } from "./run-plan.js";
import { basicEvalCaseId, basicEvalPythonPath, executionDirectory, graphMemoryEvalCaseId, runBasicRuntimeEval, type BasicJudgeConfiguration } from "./runtime-basic.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
process.env.PYTHONPATH = basicEvalPythonPath(process.env.PYTHONPATH);

async function main(): Promise<void> {
  const outputDirectory = resolve(singleArgument("--output-dir") ?? ".relayer/evals/runtime");
  const testRunId = singleArgument("--test-run-id") ?? randomUUID();
  const testCaseIds = repeatedArgument("--case");
  const requestedConfigurations = repeatedArgument("--configuration");
  const requireConfiguration = process.argv.includes("--require-configuration");
  if (requireConfiguration && requestedConfigurations.length === 0) {
    throw new Error("Select at least one harness configuration with --configuration");
  }

  const defaultCaseIds = testCaseIds.length === 0 ? [basicEvalCaseId] : testCaseIds;
  const defaultFixture = selectDefaultFixture(defaultCaseIds);
  const harnessConfigurations = requestedConfigurations.length === 0
    ? new Map([[defaultFixture.configuration.name, defaultFixture.configuration]])
    : await resolveHarnessConfigurations(requestedConfigurations);
  const judgeConfiguration = resolveJudgeConfiguration(singleArgument("--judge-configuration") ?? "none");
  const selection: TestRunSelection<BasicJudgeConfiguration> = {
    testRunId,
    testCaseIds: defaultCaseIds,
    harnessConfigurationNames: requestedConfigurations.length === 0
      ? [defaultFixture.configuration.name]
      : requestedConfigurations,
    judgeConfiguration,
  };
  const executions = expandTestRun(selection, harnessConfigurations);
  const candidateUsesCodex = [...harnessConfigurations.values()].some(({ implementation }) => implementation === "codex.basic");
  const judgeUsesCodex = judgeConfiguration.name === "codex-structured";
  const codexBinary = process.env.RELAYER_CODEX_BINARY?.trim();
  if ((candidateUsesCodex || judgeUsesCodex) && !codexBinary) {
    throw new Error("Live Codex candidate or judge requires an explicit managed executable in RELAYER_CODEX_BINARY.");
  }
  const managedCodexExecutable = codexBinary ? resolve(codexBinary) : undefined;
  const implementations = productHarnessImplementations({
    "fixture.task-system": taskSystemFixtureFactory,
    "fixture.graph-memory": graphMemoryFixtureFactory,
    ...(candidateUsesCodex ? { "codex.basic": createCodexBasicFactory({ codexPathOverride: managedCodexExecutable! }) } : {}),
  });
  const results = [];

  for (const execution of executions) {
    const artifact = await runBasicRuntimeEval({
      outputDirectory,
      execution,
      implementations,
      ...(judgeUsesCodex ? { judgeCodexPathOverride: managedCodexExecutable! } : {}),
    });
    results.push({
      testRunId: execution.testRunId,
      testCaseId: execution.testCaseId,
      harnessConfigurationName: execution.harnessConfigurationName,
      harnessConfigurationDigest: execution.harnessConfigurationDigest,
      passed: artifact.passed,
      viewer: join(executionDirectory(outputDirectory, execution), "index.html"),
    });
  }

  const passed = results.every((result) => result.passed);
  console.log(JSON.stringify({ testRunId, executions: results, passed }));
  if (!passed) process.exitCode = 1;
}

function selectDefaultFixture(testCaseIds: readonly string[]): {
  readonly configuration: HarnessConfiguration;
} {
  const needsGraphMemory = testCaseIds.includes(graphMemoryEvalCaseId);
  const needsOther = testCaseIds.some((caseId) => caseId !== graphMemoryEvalCaseId);
  if (needsGraphMemory && needsOther) {
    throw new Error("Default inference-free runtime Eval cannot mix graph-memory and other cases; select an explicit compatible harness configuration.");
  }
  return {
    configuration: needsGraphMemory ? graphMemoryFixtureConfiguration : taskSystemFixtureConfiguration,
  };
}

async function resolveHarnessConfigurations(names: readonly string[]): Promise<ReadonlyMap<string, HarnessConfiguration>> {
  const paths = names.map((name) => {
    requireIdentifier(name, "harness configuration name");
    return join(repositoryRoot, "harnesses", `${name}.yaml`);
  });
  return loadHarnessConfigurations(paths);
}

function resolveJudgeConfiguration(name: string): BasicJudgeConfiguration {
  if (name === "none" || name === "codex-structured") return { name };
  throw new Error(`Unknown judge configuration: ${name}`);
}

function repeatedArgument(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) {
      const value = process.argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function singleArgument(name: string): string | undefined {
  const values = repeatedArgument(name);
  if (values.length > 1) throw new Error(`${name} may only be provided once`);
  return values[0];
}

function requireIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}

void main();
