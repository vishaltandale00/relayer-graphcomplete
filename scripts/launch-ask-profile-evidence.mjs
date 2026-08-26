import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, accessSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const launcherPath = fileURLToPath(import.meta.url);
const executedFromStdin = process.argv[1] === "-";
const directlyExecuted = executedFromStdin || Boolean(process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(launcherPath));
const requestedBootstrapRoot = executedFromStdin ? process.argv[2] : resolve(dirname(launcherPath), "..");
const bootstrapRoot = typeof requestedBootstrapRoot === "string" && isAbsolute(requestedBootstrapRoot)
  ? realpathSync(requestedBootstrapRoot)
  : resolve(dirname(launcherPath), "..");
const requestedRepositoryRoot = process.argv[executedFromStdin ? 3 : 2];
const requestedSourceCommit = process.argv[executedFromStdin ? 4 : 3];
const repositoryRoot = directlyExecuted
  && typeof requestedRepositoryRoot === "string"
  && isAbsolute(requestedRepositoryRoot)
  ? realpathSync(requestedRepositoryRoot)
  : resolve(bootstrapRoot);

function authenticatedPrivateBootstrapRoot() {
  const root = realpathSync(bootstrapRoot);
  const temporaryRoot = realpathSync("/tmp");
  const details = lstatSync(bootstrapRoot);
  if (root === temporaryRoot
    || !root.startsWith(`${temporaryRoot}${sep}`)
    || !basename(root).startsWith("relayer-ask-bootstrap.")
    || !details.isDirectory()
    || details.isSymbolicLink()
    || (details.mode & 0o777) !== 0o700
    || details.uid !== process.getuid?.()) {
    throw new Error("Ask-profile evidence must execute from its private bootstrap snapshot.");
  }
  return root;
}
const bootstrapControlFiles = [
  "package.json",
  "package-lock.json",
  "scripts/launch-ask-profile-evidence.sh",
  "scripts/capture-ask-profile-evidence.mjs",
  "scripts/ask-profile-evidence-model.mjs",
  "scripts/evidence-capture-integrity.mjs",
];
const fixedGitEnvironment = { HOME: "/var/empty", PATH: "/usr/bin:/bin", GIT_NO_REPLACE_OBJECTS: "1" };

export function authenticateBootstrapControls({
  sourceRepositoryRoot = repositoryRoot,
  executedBootstrapRoot = bootstrapRoot,
  sourceCommit = requestedSourceCommit ?? "HEAD",
} = {}) {
  for (const path of bootstrapControlFiles) {
    const committed = execFileSync("/usr/bin/git", [
      "--no-optional-locks", "-C", sourceRepositoryRoot,
      "-c", "core.attributesFile=/dev/null", "-c", "core.fsmonitor=false",
      "show", `${sourceCommit}:${path}`,
    ], { env: fixedGitEnvironment, encoding: null });
    const observed = readFileSync(join(executedBootstrapRoot, path));
    if (!observed.equals(committed)) {
      throw new Error(`Ask-profile evidence refuses modified bootstrap control: ${path}`);
    }
  }
}

export function resolveInstalledElectronExecutable(requireFrom = join(repositoryRoot, "package.json")) {
  const require = createRequire(requireFrom);
  const packageRoot = dirname(require.resolve("electron/package.json"));
  const distributionRoot = realpathSync(join(packageRoot, "dist"));
  const relativeExecutable = readFileSync(join(packageRoot, "path.txt"), "utf8").trim();
  if (relativeExecutable === "" || isAbsolute(relativeExecutable)) {
    throw new Error("The installed Electron package returned an invalid executable path.");
  }
  const executable = realpathSync(join(distributionRoot, relativeExecutable));
  const relativeToDistribution = relative(distributionRoot, executable);
  if (relativeToDistribution === ""
    || relativeToDistribution === ".."
    || relativeToDistribution.startsWith(`..${sep}`)
    || !statSync(executable).isFile()) {
    throw new Error("The installed Electron executable escapes its package distribution.");
  }
  accessSync(executable, fsConstants.X_OK);
  return executable;
}

export function trustedElectronLaunchEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => {
    const normalizedKey = key.toUpperCase();
    return value !== undefined
      && !normalizedKey.startsWith("DYLD_")
      && !normalizedKey.startsWith("LD_")
      && !normalizedKey.startsWith("NODE_")
      && !normalizedKey.startsWith("ELECTRON_")
      && !normalizedKey.startsWith("OPENSSL_");
  }));
}

export function authenticateInstalledElectron(executable) {
  const appSuffix = ".app/Contents/MacOS/Electron";
  const appIndex = executable.indexOf(appSuffix);
  if (appIndex < 1 || appIndex + appSuffix.length !== executable.length) {
    throw new Error("The installed Electron executable is not inside the expected app bundle.");
  }
  const appBundle = executable.slice(0, appIndex + 4);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appBundle], { stdio: "pipe" });
  const details = statSync(executable, { bigint: true });
  return {
    dev: details.dev,
    ino: details.ino,
    sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  };
}

function requireStableElectron(executable, authority) {
  const details = statSync(executable, { bigint: true });
  const sha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
  if (details.dev !== authority.dev || details.ino !== authority.ino || sha256 !== authority.sha256) {
    throw new Error("The installed Electron executable changed after authentication.");
  }
}

export function launchAskProfileEvidence({
  environment = process.env,
  electronExecutable = resolveInstalledElectronExecutable(),
  captureScript = join(bootstrapRoot, "scripts", "capture-ask-profile-evidence.mjs"),
  spawnProcess = spawn,
  signalTarget = process,
  electronAuthenticator = authenticateInstalledElectron,
  electronStabilityCheck = requireStableElectron,
  controlAuthenticator = authenticateBootstrapControls,
} = {}) {
  controlAuthenticator();
  const electronAuthority = electronAuthenticator(electronExecutable);
  electronStabilityCheck(electronExecutable, electronAuthority);
  const child = spawnProcess(electronExecutable, [
    captureScript,
    "--source-repository-root", repositoryRoot,
    "--source-commit", requestedSourceCommit ?? "HEAD",
  ], {
    cwd: repositoryRoot,
    env: trustedElectronLaunchEnvironment(environment),
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    signalTarget.once(signal, () => {
      try { child.kill(signal); } catch {}
    });
  }
  return child;
}

if (directlyExecuted) {
  if (typeof requestedRepositoryRoot !== "string" || !isAbsolute(requestedRepositoryRoot)) {
    throw new Error("Ask-profile evidence requires the authenticated source repository root.");
  }
  if (typeof requestedSourceCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(requestedSourceCommit)) {
    throw new Error("Ask-profile evidence requires the pinned source commit.");
  }
  const privateBootstrapRoot = authenticatedPrivateBootstrapRoot();
  let child;
  try {
    child = launchAskProfileEvidence();
  } catch (error) {
    rmSync(privateBootstrapRoot, { recursive: true, force: true });
    throw error;
  }
  child.once("error", (error) => {
    rmSync(privateBootstrapRoot, { recursive: true, force: true });
    console.error(`Ask-profile evidence capture could not start: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    rmSync(privateBootstrapRoot, { recursive: true, force: true });
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
