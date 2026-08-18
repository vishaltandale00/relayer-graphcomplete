import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarnessConfigurations } from "@relayer/harness-host";
import { runBasicRuntimeEval } from "./runtime-basic.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const configurationNames = ["codex-basic", "codex-basic-high"] as const;

async function main(): Promise<void> {
  const outputDirectory = resolve(argument("--output-dir") ?? ".relayer/evals/runtime");
  const paths = configurationNames.map((name) => join(repositoryRoot, "harnesses", `${name}.yaml`));
  const catalog = await loadHarnessConfigurations(paths);
  const implementations = new Set([...catalog.values()].map(({ implementation }) => implementation));
  if (implementations.size !== 1 || !implementations.has("codex.basic")) {
    throw new Error("Codex configuration matrix must contain two configurations for the codex.basic implementation");
  }

  const runs = [];
  for (const configurationPath of paths) {
    const artifact = await runBasicRuntimeEval({ outputDirectory, live: true, configurationPath, judge: true });
    runs.push({ configuration: artifact.harness, runId: artifact.runId, passed: artifact.passed });
  }
  const passed = runs.every((run) => run.passed);
  console.log(JSON.stringify({ implementation: "codex.basic", configurations: [...catalog.keys()], runs, passed }));
  if (!passed) process.exitCode = 1;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

void main();
