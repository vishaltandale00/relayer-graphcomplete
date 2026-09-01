import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  collectFilesystemDependencyClosureEntries,
  digestFilesystemTree,
  digestFileEntries,
} from "../../shared/prime-runtime-integrity.mjs";

const execFileAsync = promisify(execFile);
const PRIME_PACKAGE = "@earendil-works/pi-coding-agent";
const SKILLS = Object.freeze([
  ["agent-message", "agent_message"],
  ["agent-observe", "agent_observe"],
  ["attach-image", "attach_image"],
  ["browser", "browser"],
  ["compact", "compact"],
  ["edit", "edit"],
  ["goal", "goal"],
  ["linear", "linear"],
  ["notion", "notion"],
  ["refine", "refine"],
  ["rlm-heartbeat", "rlm_heartbeat"],
  ["websearch", "websearch"],
]);

export const PRIME_MANAGED_KERNEL_IMPORTS = Object.freeze([
  "rlm",
  "relayer_graph",
  ...SKILLS.map(([, importName]) => importName),
]);

async function defaultRun(command, args, options) {
  await execFileAsync(command, args, options);
}

async function copyTree(source, destination) {
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}

async function makeVenvInterpreterRelocatable({ installationRoot, python, sourcePython }) {
  const details = await lstat(python);
  if (!details.isSymbolicLink() || await readlink(python) !== sourcePython) {
    throw new Error("uv created an unexpected managed venv interpreter link.");
  }
  await rm(python);
  await symlink("../../python/bin/python3", python);
  const relativeTarget = join(dirname(python), await readlink(python));
  if (relativeTarget !== sourcePython) throw new Error("Managed venv interpreter is not relocatable.");
}

export function createPrimeReviewedTreeCopier({ appRoot, pythonClientRoot, expectedClosureSha256, expectedPythonClientSha256 }) {
  return async ({ installationRoot, sitePackages }) => {
    const roots = [
      "node_modules/@earendil-works/pi-agent-core",
      "node_modules/@earendil-works/pi-ai",
      "node_modules/@earendil-works/pi-coding-agent",
      "node_modules/@earendil-works/pi-tui",
    ];
    const entries = await collectFilesystemDependencyClosureEntries(appRoot, roots);
    if (digestFileEntries(entries) !== expectedClosureSha256) {
      throw new Error("Packaged Prime dependency closure does not match its reviewed identity.");
    }
    const jsRoot = join(installationRoot, "js");
    for (const entry of entries) {
      const destination = join(jsRoot, ...entry.path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, entry.bytes, { flag: "wx", mode: 0o600 });
    }
    if (digestFileEntries(await collectFilesystemDependencyClosureEntries(jsRoot, roots)) !== expectedClosureSha256) {
      throw new Error("Managed Prime dependency closure changed while copying.");
    }

    const codingAgent = join(jsRoot, "node_modules", ...PRIME_PACKAGE.split("/"));
    await copyTree(join(codingAgent, "dist", "prime-agent-runtime", "src", "rlm"), join(sitePackages, "rlm"));
    for (const [skill, importName] of SKILLS) {
      await copyTree(join(codingAgent, "skills", skill, "src", importName), join(sitePackages, importName));
    }
    const pythonClient = join(pythonClientRoot, "relayer_graph");
    if (await digestFilesystemTree(pythonClient, (path) => path.endsWith(".py")) !== expectedPythonClientSha256) {
      throw new Error("relayer_graph does not match its reviewed tree identity.");
    }
    const managedPythonClient = join(sitePackages, "relayer_graph");
    await copyTree(pythonClient, managedPythonClient);
    if (await digestFilesystemTree(managedPythonClient, (path) => path.endsWith(".py")) !== expectedPythonClientSha256) {
      throw new Error("Managed relayer_graph changed while copying.");
    }
  };
}

export async function assemblePrimeManagedRuntime(context, {
  run = defaultRun,
  copyReviewedTrees,
  copyWheel = copyTree,
  makeWheelDirectory = mkdir,
  relocateVenvPython = makeVenvInterpreterRelocatable,
  writeIsolatedLauncher,
  wheelDirectory = join(context.installationRoot, "wheels"),
} = {}) {
  if (typeof copyReviewedTrees !== "function") throw new Error("Prime assembly requires reviewed first-party trees.");
  const { recipe, installationRoot, artifactRoots, tools, signal } = context;
  const venv = join(installationRoot, "venv");
  const python = join(venv, "bin", "python");
  const environment = {
    ...context.environment,
    PYTHONNOUSERSITE: "1",
    PYTHONSAFEPATH: "1",
    UV_OFFLINE: "1",
  };
  delete environment.HOME;
  delete environment.CODEX_HOME;
  await makeWheelDirectory(wheelDirectory, { recursive: true });
  for (const artifactId of recipe.runtimeContract.python.wheelArtifactIds) {
    const artifact = recipe.artifacts.find((candidate) => candidate.artifactId === artifactId);
    await copyWheel(join(artifactRoots[artifactId], artifact.filename), join(wheelDirectory, artifact.filename));
  }
  await run(tools.uv, ["venv", venv, "--python", tools.python, "--relocatable", "--no-config", "--offline"], { env: environment, signal });
  await relocateVenvPython({ installationRoot, python, sourcePython: tools.python });
  await run(tools.uv, [
    "pip", "install", "--python", python, "--no-config",
    "--no-index", "--no-deps", "--only-binary", ":all:", "--find-links", wheelDirectory, "--offline",
    ...recipe.runtimeContract.python.requirements,
  ], { env: environment, signal });
  const sitePackages = join(venv, "lib", "python3.11", "site-packages");
  await copyReviewedTrees({ installationRoot, sitePackages, signal });
  const installLauncher = writeIsolatedLauncher ?? (async () => {
    const isolatedPython = join(installationRoot, "bin", "python");
    await mkdir(dirname(isolatedPython), { recursive: true });
    await writeFile(isolatedPython, [
      "#!/bin/sh",
      "script_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
      "exec \"$script_dir/../venv/bin/python\" -I \"$@\"",
      "",
    ].join("\n"), { mode: 0o700, flag: "wx" });
    await chmod(isolatedPython, 0o700);
  });
  await installLauncher();
}

export async function checkPrimeManagedRuntime({ runtime, importPrimeAgent } = {}) {
  const moduleUrl = typeof runtime?.moduleUrl === "string"
    ? runtime.moduleUrl
    : typeof runtime?.modulePath === "string" ? pathToFileURL(runtime.modulePath).href : null;
  if (runtime?.runtimeId !== "prime" || typeof runtime.executable !== "string" || moduleUrl === null) {
    return { available: false };
  }
  const load = importPrimeAgent ?? (() => import(moduleUrl));
  const prime = await load();
  if (prime.MANAGED_KERNEL_VERSION !== 1 || typeof prime.probeManagedKernel !== "function") {
    throw new Error("Managed Prime bridge is incompatible.");
  }
  await prime.probeManagedKernel({
    pythonExecutable: runtime.executable,
    imports: PRIME_MANAGED_KERNEL_IMPORTS,
  });
  return { available: true };
}
