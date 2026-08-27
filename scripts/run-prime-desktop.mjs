import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import electron from "electron";

import { resolveDesktopHarnessConfiguration } from "../desktop/main/services/desktop-harness-configuration.mjs";
import { inspectPrimeAgentRuntime, requirePrimeAgentRuntime } from "../desktop/main/services/prime-agent-runtime.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const configurationArgument = readOption("--configuration");
const configurationName = resolveDesktopHarnessConfiguration({
  isPackaged: false,
  environment: {
    ...process.env,
    RELAYER_DESKTOP_HARNESS_CONFIGURATION:
      configurationArgument || process.env.RELAYER_DESKTOP_HARNESS_CONFIGURATION || "prime-agent-basic",
  },
});

if (!configurationName.startsWith("prime-agent-")) {
  throw new Error(`The Prime Agent desktop launcher cannot run configuration ${configurationName}.`);
}

const configurationPath = join(repositoryRoot, "harnesses", `${configurationName}.yaml`);
await access(configurationPath);
const pythonClientPath = join(repositoryRoot, "python", "relayer-graph", "src");
requirePrimeAgentRuntime(await inspectPrimeAgentRuntime({
  appPath: repositoryRoot,
  harnessDirectory: join(repositoryRoot, "harnesses"),
  manifestPath: join(repositoryRoot, "vendor", "prime-agent", "manifest.json"),
  pythonClientRoot: pythonClientPath,
}));
const environment = {
  ...process.env,
  RELAYER_DESKTOP_HARNESS_CONFIGURATION: configurationName,
  RELAYER_PRIME_PYTHON_CLIENT_ROOT: pythonClientPath,
  RELAYER_DESKTOP_USER_DATA_DIR:
    process.env.RELAYER_DESKTOP_USER_DATA_DIR || join(repositoryRoot, ".relayer", `desktop-${configurationName}`),
  RELAYER_CODEX_HOME: process.env.RELAYER_CODEX_HOME || join(homedir(), ".codex"),
};
delete environment.ELECTRON_RUN_AS_NODE;

if (checkOnly) {
  console.log(`Prime Agent desktop is ready (${configurationName}).`);
  process.exit(0);
}

console.log(`Starting Relayer with ${configurationName}.`);
console.log(`Local profile: ${environment.RELAYER_DESKTOP_USER_DATA_DIR}`);
const child = spawn(electron, [join(repositoryRoot, "desktop", "main", "index.mjs")], {
  cwd: repositoryRoot,
  env: environment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(`Relayer could not start: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}
