import { app, BrowserWindow, ipcMain } from "electron";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// Electron patches Node's fs APIs to present ASAR files as virtual directories.
// Integrity inventory must hash the signed archive bytes and stable file metadata.
process.noAsar = true;

import {
  isFreshRecordedPromptFrame,
  validateApprovalPromptHoldEvidence,
} from "./ask-profile-evidence-model.mjs";
import {
  createPinnedProviderWrapperScript,
  createPinnedGraphAuthoringLauncherScript,
  createPinnedGraphAuthoringExecPolicy,
  createPinnedGraphAuthoringNetworkProfile,
  createPinnedFreshBuildSandboxProfile,
  captureExactRegularFileIdentity,
  discoverNonSystemMachODependencies,
  fixedGitArguments,
  fixedGitEnvironment,
  inventoryRegularArtifactTree,
  pipeByteChunks,
  pinUniqueBytes,
  pinnedBuffersInFileOrder,
  pinnedSequenceSha256,
  settleMediaCompletion,
  settleBeforeDeadline,
  readCommittedGitBytes,
  readCommittedGitInventory,
  readGitCommitTree,
  rejectAncestorCargoConfiguration,
  resolvePinnedXcodeTool,
  restoreDirectoryWritesSync,
  sanitizeElectronBootstrapEnvironment,
  sealMachORuntimeCopies,
  validatePinnedGraphAuthoringCommands,
  verifyRepositoryGitAuthority,
  verifyPinnedByteInventory,
} from "./evidence-capture-integrity.mjs";

function resolveExecutable(executable) {
  const candidates = executable.includes("/")
    ? [resolve(executable)]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((entry) => join(entry, executable));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue through the fixed PATH snapshot.
    }
  }
  throw new Error(`Executable is unavailable: ${executable}`);
}

function resolveCodexProviderExecutable(executable) {
  const resolved = resolveExecutable(executable);
  if (basename(resolved) !== "codex.js") return resolved;
  const targetTriple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  const platformPackage = process.arch === "arm64" ? "@openai/codex-darwin-arm64" : "@openai/codex-darwin-x64";
  const wrapperRequire = createRequire(resolved);
  const packageJson = wrapperRequire.resolve(`${platformPackage}/package.json`);
  return resolveExecutable(join(dirname(packageJson), "vendor", targetTriple, "bin", "codex"));
}

const SYSTEM_GIT_PATH = "/usr/bin/git";
const SYSTEM_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
const SYSTEM_CODESIGN_PATH = "/usr/bin/codesign";
const BOOTSTRAP_CONTROL_FILES = [
  "launch-ask-profile-evidence.sh",
  "launch-ask-profile-evidence.mjs",
  "capture-ask-profile-evidence.mjs",
  "ask-profile-evidence-model.mjs",
  "evidence-capture-integrity.mjs",
];

function fixedSystemGit() {
  accessSync(SYSTEM_GIT_PATH, fsConstants.X_OK);
  if (realpathSync(SYSTEM_GIT_PATH) !== SYSTEM_GIT_PATH) {
    throw new Error(`Ask-profile evidence requires the fixed system Git executable: ${SYSTEM_GIT_PATH}`);
  }
  return SYSTEM_GIT_PATH;
}

function fixedSystemSandboxExec() {
  accessSync(SYSTEM_SANDBOX_EXEC_PATH, fsConstants.X_OK);
  if (realpathSync(SYSTEM_SANDBOX_EXEC_PATH) !== SYSTEM_SANDBOX_EXEC_PATH) {
    throw new Error(`Ask-profile evidence requires the fixed macOS sandbox executable: ${SYSTEM_SANDBOX_EXEC_PATH}`);
  }
  return SYSTEM_SANDBOX_EXEC_PATH;
}

function bootstrapEnvironment() {
  return sanitizeElectronBootstrapEnvironment(process.env);
}

function rejectMutableRepositoryAuthority(gitPath, root) {
  verifyRepositoryGitAuthority({
    gitPath,
    repositoryRoot: root,
    revisionPaths: ["."],
    timeoutMs: Math.max(1, Math.min(LOCAL_OPERATION_TIMEOUT_MS, bootstrapReplayDeadline - Date.now())),
  });
}

function gitObjectBytes(gitPath, root, commit, path) {
  return readCommittedGitBytes({
    gitPath,
    repositoryRoot: root,
    commit,
    path,
    timeoutMs: Math.max(1, Math.min(LOCAL_OPERATION_TIMEOUT_MS, bootstrapReplayDeadline - Date.now())),
  });
}

function gitCommitTree(gitPath, root, commit) {
  return readGitCommitTree({
    gitPath,
    repositoryRoot: root,
    commit,
    timeoutMs: Math.max(1, Math.min(LOCAL_OPERATION_TIMEOUT_MS, bootstrapReplayDeadline - Date.now())),
  });
}

function cleanSourceRevision(gitPath, root, excludedPaths = []) {
  rejectMutableRepositoryAuthority(gitPath, root);
  const gitEnvironment = fixedGitEnvironment();
  const commit = execFileSync(gitPath, fixedGitArguments(root, ["rev-parse", "HEAD"]), {
    cwd: root,
    env: gitEnvironment,
    encoding: "utf8",
    timeout: Math.max(1, Math.min(LOCAL_OPERATION_TIMEOUT_MS, bootstrapReplayDeadline - Date.now())),
  }).trim();
  const status = execFileSync(gitPath, fixedGitArguments(root, [
    "status", "--porcelain", "--untracked-files=all", "--", ".",
    ...excludedPaths.map((path) => `:(exclude,literal)${relative(root, path)}`),
  ]), {
    cwd: root,
    env: gitEnvironment,
    encoding: "utf8",
    timeout: Math.max(1, Math.min(LOCAL_OPERATION_TIMEOUT_MS, bootstrapReplayDeadline - Date.now())),
  }).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit) || status !== "") {
    throw new Error(`Ask-profile evidence requires a clean source revision before any runtime copy: ${JSON.stringify({ commit, status })}`);
  }
  return commit;
}

const OPT_IN = "RELAYER_CAPTURE_ASK_PROFILE_EVIDENCE";
const MODEL_ID = "gpt-5.6-luna";
const VIDEO_FILE = "ask-profile-live-luna.mp4";
const RECORDING_FPS = 8;
const FRAME_INTERVAL_MS = 1_000 / RECORDING_FPS;
const CAPTURE_DEADLINE_MS = 2_000;
const LOCAL_OPERATION_TIMEOUT_MS = 30_000;
const REPLAY_TIMEOUT_MS = 30 * 60_000;
const MAJOR_OPERATION_TIMEOUT_MS = 120_000;
const MODEL_COMPLETION_TIMEOUT_MS = 6 * 60_000;
const FRESH_BUILD_TIMEOUT_MS = 10 * 60_000;
const APPROVAL_PROMPT_HOLD_MS = 3_000;
const APPROVAL_PROMPT_MIN_FRAMES = Math.ceil(APPROVAL_PROMPT_HOLD_MS / FRAME_INTERVAL_MS);
const APPROVAL_PROMPT_HOLD_TIMEOUT_MS = 6_000;
const MEDIA_COMPLETION_TIMEOUT_MS = 120_000;
const MEDIA_ABORT_GRACE_MS = 2_000;
const IMMUTABLE_ELECTRON_ROOT = "RELAYER_ASK_PROFILE_IMMUTABLE_ELECTRON_ROOT";
const IMMUTABLE_ELECTRON_CAPABILITY_FD = "RELAYER_ASK_PROFILE_IMMUTABLE_ELECTRON_CAPABILITY_FD";
const bootstrapReplayDeadline = Date.now() + REPLAY_TIMEOUT_MS;
function requestedSourceRepositoryRoot() {
  const optionIndex = process.argv.indexOf("--source-repository-root");
  if (optionIndex < 0) return null;
  const requested = process.argv[optionIndex + 1];
  if (typeof requested !== "string" || !isAbsolute(requested)) {
    throw new Error("Ask-profile evidence requires an absolute source repository root.");
  }
  return realpathSync(requested);
}
function requestedSourceCommit() {
  const optionIndex = process.argv.indexOf("--source-commit");
  if (optionIndex < 0) return null;
  const requested = process.argv[optionIndex + 1];
  if (typeof requested !== "string" || !/^[a-f0-9]{40,64}$/.test(requested)) {
    throw new Error("Ask-profile evidence requires a valid pinned source commit.");
  }
  return requested;
}
if (process.env[OPT_IN] !== "1") {
  throw new Error(`Paid Ask-profile evidence capture is opt-in. Set ${OPT_IN}=1 to run it.`);
}
if (process.platform !== "darwin") throw new Error("Ask-profile desktop evidence capture currently supports macOS only.");
function authenticatedElectronBootstrap() {
  const bootstrapRoot = process.env[IMMUTABLE_ELECTRON_ROOT];
  const capabilityFd = Number(process.env[IMMUTABLE_ELECTRON_CAPABILITY_FD]);
  if (!bootstrapRoot || !Number.isSafeInteger(capabilityFd) || capabilityFd < 3) return null;
  try {
    const authenticatedRoot = realpathSync(bootstrapRoot);
    const tempRoot = realpathSync(tmpdir());
    const rootDetails = lstatSync(bootstrapRoot);
    const markerPath = join(authenticatedRoot, "bootstrap.json");
    const markerDetails = lstatSync(markerPath);
    if (authenticatedRoot === tempRoot
      || !authenticatedRoot.startsWith(`${tempRoot}${sep}`)
      || !basename(authenticatedRoot).startsWith("relayer-ask-electron-")
      || !rootDetails.isDirectory()
      || rootDetails.isSymbolicLink()
      || (rootDetails.mode & 0o777) !== 0o700
      || rootDetails.uid !== process.getuid?.()
      || !markerDetails.isFile()
      || markerDetails.isSymbolicLink()
      || (markerDetails.mode & 0o777) !== 0o600
      || markerDetails.uid !== process.getuid?.()) return null;
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    const capability = readFileSync(capabilityFd, "utf8");
    const { authenticationSha256, ...authenticatedPayload } = marker;
    const executable = realpathSync(process.execPath);
    const script = realpathSync(process.argv[1]);
    const relativeExecutable = relative(authenticatedRoot, executable);
    const relativeScript = relative(authenticatedRoot, script);
    return authenticationSha256 === createHmac("sha256", capability).update(JSON.stringify(authenticatedPayload)).digest("hex")
      && marker.parentPid === process.ppid
      && marker.executable === executable
      && marker.script === script
      && /^[a-f0-9]{40,64}$/.test(marker.sourceCommit)
      && /^[a-f0-9]{40,64}$/.test(marker.sourceTree)
      && marker.bootstrapControlSha256 !== null
      && typeof marker.bootstrapControlSha256 === "object"
      && !Array.isArray(marker.bootstrapControlSha256)
      && Number.isSafeInteger(marker.replayDeadline)
      && marker.replayDeadline <= bootstrapReplayDeadline
      && relativeExecutable !== ""
      && !relativeExecutable.startsWith(`..${sep}`)
      && relativeExecutable !== ".."
      && relativeScript !== ""
      && !relativeScript.startsWith(`..${sep}`)
      && relativeScript !== ".."
      ? marker
      : null;
  } catch {
    return null;
  }
}

const authenticatedBootstrap = authenticatedElectronBootstrap();
if (!authenticatedBootstrap) {
  const bootstrapDirectory = mkdtempSync(join(tmpdir(), "relayer-ask-electron-"));
  let child;
  try {
    const sourceScript = realpathSync(process.argv[1]);
    const sourceScripts = dirname(sourceScript);
    const sourceRepositoryRoot = requestedSourceRepositoryRoot() ?? resolve(sourceScripts, "..");
    const sourceGit = fixedSystemGit();
    const sourceCommit = cleanSourceRevision(sourceGit, sourceRepositoryRoot);
    const pinnedSourceCommit = requestedSourceCommit();
    if (pinnedSourceCommit !== null && sourceCommit !== pinnedSourceCommit) {
      throw new Error("Ask-profile evidence source commit changed after bootstrap authentication.");
    }
    const sourceTree = gitCommitTree(sourceGit, sourceRepositoryRoot, sourceCommit);
    const bootstrapControls = new Map(BOOTSTRAP_CONTROL_FILES.map((name) => {
      const bytes = gitObjectBytes(sourceGit, sourceRepositoryRoot, sourceCommit, `scripts/${name}`);
      return [name, bytes];
    }));
    const sourceContents = resolve(dirname(process.execPath), "..");
    const copiedContents = join(bootstrapDirectory, "Contents");
    execFileSync("/usr/bin/ditto", [sourceContents, copiedContents], {
      timeout: Math.max(1, Math.min(MAJOR_OPERATION_TIMEOUT_MS, bootstrapReplayDeadline - Date.now())),
    });
    const copiedElectron = join(copiedContents, "MacOS", basename(process.execPath));
    const copiedScripts = join(bootstrapDirectory, "scripts");
    mkdirSync(copiedScripts, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of bootstrapControls) writeFileSync(join(copiedScripts, name), bytes, { mode: 0o600 });
    const copiedScript = join(copiedScripts, basename(sourceScript));
    const bootstrapCapability = randomBytes(32).toString("hex");
    const bootstrapPayload = {
      parentPid: process.pid,
      executable: realpathSync(copiedElectron),
      script: realpathSync(copiedScript),
      repositoryRoot: sourceRepositoryRoot,
      sourceCommit,
      sourceTree,
      bootstrapControlSha256: Object.fromEntries([...bootstrapControls].map(([name, bytes]) => [
        name,
        createHash("sha256").update(bytes).digest("hex"),
      ])),
      originalElectronContents: realpathSync(sourceContents),
      replayDeadline: bootstrapReplayDeadline,
    };
    writeFileSync(join(bootstrapDirectory, "bootstrap.json"), JSON.stringify({
      ...bootstrapPayload,
      authenticationSha256: createHmac("sha256", bootstrapCapability).update(JSON.stringify(bootstrapPayload)).digest("hex"),
    }), { encoding: "utf8", mode: 0o600 });
    child = spawn(copiedElectron, [copiedScript], {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      env: {
        ...bootstrapEnvironment(),
        [IMMUTABLE_ELECTRON_ROOT]: bootstrapDirectory,
        [IMMUTABLE_ELECTRON_CAPABILITY_FD]: "3",
      },
    });
    child.stdio[3].on("error", () => {});
    child.stdio[3].end(bootstrapCapability);
    let forwardedSignal;
    let forwardedSignalCount = 0;
    const forward = (signal) => {
      forwardedSignal ??= signal;
      forwardedSignalCount += 1;
      try { child.kill(forwardedSignalCount === 1 ? signal : "SIGKILL"); } catch {}
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    const result = await new Promise((resolveChild, rejectChild) => {
      const timeout = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        rejectChild(new Error("Immutable Electron child exceeded the absolute replay deadline."));
      }, Math.max(1, bootstrapReplayDeadline - Date.now()));
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectChild(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolveChild({ code, signal });
      });
    });
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    const exitCode = forwardedSignal === "SIGINT" || result.signal === "SIGINT"
      ? 130
      : forwardedSignal === "SIGTERM" || result.signal === "SIGTERM"
        ? 143
        : result.code ?? 1;
    rmSync(bootstrapDirectory, { recursive: true, force: true });
    process.exit(exitCode);
  } catch (error) {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    rmSync(bootstrapDirectory, { recursive: true, force: true });
    throw error;
  }
}
const absoluteReplayDeadline = authenticatedBootstrap?.replayDeadline ?? bootstrapReplayDeadline;
function remainingReplayTimeout(capMs = LOCAL_OPERATION_TIMEOUT_MS) {
  const remainingMs = absoluteReplayDeadline - Date.now();
  if (remainingMs <= 0) throw new Error("Ask-profile evidence replay exceeded its absolute deadline.");
  return Math.max(1, Math.min(capMs, remainingMs));
}
const configuredFfmpeg = process.env.RELAYER_FFMPEG_PATH || "ffmpeg";
const SOURCE_FFMPEG_PATH = resolveExecutable(configuredFfmpeg);
const configuredFfprobe = process.env.RELAYER_FFPROBE_PATH
  || (configuredFfmpeg.includes("/") ? join(dirname(SOURCE_FFMPEG_PATH), "ffprobe") : "ffprobe");
const SOURCE_FFPROBE_PATH = resolveExecutable(configuredFfprobe);
const SOURCE_CODEX_EXECUTABLE = resolveCodexProviderExecutable(process.env.RELAYER_CODEX_PATH || process.env.RELAYER_CODEX_BINARY || "codex");
const SOURCE_CODEX_CODE_MODE_HOST = resolveExecutable(process.env.RELAYER_CODEX_CODE_MODE_HOST_PATH || "codex-code-mode-host");
const SOURCE_NODE_PATH = resolveExecutable(process.env.RELAYER_NODE_PATH || "node");
const SOURCE_GIT_PATH = fixedSystemGit();
const SOURCE_SANDBOX_EXEC_PATH = fixedSystemSandboxExec();
const SOURCE_SED_PATH = resolveExecutable(process.env.RELAYER_SED_PATH || "sed");
const SOURCE_RG_PATH = resolveExecutable(process.env.RELAYER_RG_PATH || "rg");
const protectedRoot = process.env.RELAYER_EVIDENCE_PROTECTED_ROOT || "/Users/Shared";
const repositoryRoot = authenticatedBootstrap?.repositoryRoot ?? resolve(import.meta.dirname, "..");
const SOURCE_TAR_PATH = resolveExecutable("/usr/bin/tar");
const SOURCE_XCRUN_PATH = resolveExecutable("/usr/bin/xcrun");
const SOURCE_OTOOL_PATH = resolvePinnedXcodeTool("otool", { timeoutMs: () => remainingReplayTimeout() });
const SOURCE_INSTALL_NAME_TOOL_PATH = resolvePinnedXcodeTool("install_name_tool", { timeoutMs: () => remainingReplayTimeout() });
const SOURCE_RUSTUP_PATH = resolveExecutable(process.env.RELAYER_RUSTUP_PATH || "rustup");
const SOURCE_TYPESCRIPT_PATH = join(repositoryRoot, "node_modules", "typescript");
const SOURCE_NODE_TYPES_PATH = join(repositoryRoot, "node_modules", "@types", "node");
const SOURCE_UNDICI_TYPES_PATH = join(repositoryRoot, "node_modules", "undici-types");
let sourceCommit = authenticatedBootstrap?.sourceCommit;
function verifyExecutedBootstrapControls() {
  const observedTree = gitCommitTree(SOURCE_GIT_PATH, repositoryRoot, sourceCommit);
  if (observedTree !== authenticatedBootstrap.sourceTree) {
    throw new Error(`Authenticated source tree changed: ${JSON.stringify({ expected: authenticatedBootstrap.sourceTree, observed: observedTree })}`);
  }
  for (const controlFile of BOOTSTRAP_CONTROL_FILES) {
    const committedBytes = gitObjectBytes(SOURCE_GIT_PATH, repositoryRoot, sourceCommit, `scripts/${controlFile}`);
    const executedBytes = readFileSync(join(import.meta.dirname, controlFile));
    const sourceBytes = readFileSync(join(repositoryRoot, "scripts", controlFile));
    const expectedSha256 = authenticatedBootstrap.bootstrapControlSha256[controlFile];
    const committedSha256 = createHash("sha256").update(committedBytes).digest("hex");
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)
      || committedSha256 !== expectedSha256
      || !executedBytes.equals(committedBytes)
      || !sourceBytes.equals(committedBytes)) {
      throw new Error(`Bootstrap control does not match its authenticated clean-commit bytes: ${controlFile}`);
    }
  }
}
verifyExecutedBootstrapControls();
const publishedDirectory = join(repositoryRoot, "docs", "prd", "assets", "evidence", "ask-profile-approval");
const publishedReadmePath = "docs/prd/assets/evidence/ask-profile-approval/README.md";
const publishedReadme = gitObjectBytes(SOURCE_GIT_PATH, repositoryRoot, sourceCommit, publishedReadmePath).toString("utf8");
function committedJsonVersion(path, label) {
  const value = JSON.parse(gitObjectBytes(SOURCE_GIT_PATH, repositoryRoot, sourceCommit, path).toString("utf8"))?.version;
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`Authenticated ${label} metadata does not contain a semantic version.`);
  }
  return value;
}
function committedRustWorkspaceVersion() {
  const cargo = gitObjectBytes(SOURCE_GIT_PATH, repositoryRoot, sourceCommit, "Cargo.toml").toString("utf8");
  const section = /\[workspace\.package\]([\s\S]*?)(?=\n\[|$)/.exec(cargo)?.[1];
  const value = /^version\s*=\s*"([^"]+)"\s*$/m.exec(section ?? "")?.[1];
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("Authenticated Rust workspace metadata does not contain a semantic version.");
  }
  return value;
}
const rustWorkspaceVersion = committedRustWorkspaceVersion();
const sourceVersions = Object.freeze({
  desktop: committedJsonVersion("desktop/package.json", "desktop"),
  appServer: rustWorkspaceVersion,
  graphServer: rustWorkspaceVersion,
  harnessHost: committedJsonVersion("packages/harness-host/package.json", "harness host"),
});
const electronContentsDirectory = resolve(dirname(process.execPath), "..");
const originalElectronContentsDirectory = authenticatedBootstrap?.originalElectronContents;
if (typeof originalElectronContentsDirectory !== "string"
  || realpathSync(originalElectronContentsDirectory) !== originalElectronContentsDirectory) {
  throw new Error("Authenticated bootstrap did not identify the original Electron Contents directory.");
}
function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function nonSystemMachODependencies(executables, dependencyRoot = undefined, executableDigests = new Map()) {
  return discoverNonSystemMachODependencies({
    executables,
    dependencyRoot,
    executableDigests,
    timeoutMs: () => remainingReplayTimeout(),
    otoolPath: SOURCE_OTOOL_PATH,
  });
}

let sourceMachOExecutableDigests = new Map();
let dynamicRuntimeDependencies = [];
let externalNodeClosureSources = new Set();
const sourceRuntimeArtifactSpecs = [];
let freshBuildRelation;
let freshBuildInputSpecs = [];
let freshBuildExpectedInputs = [];
let freshBuildOutputSpecs = [];
let freshBuildSourceSpec;
let freshBuildExpectedSource = [];
let freshBuildReadOnlyDirectoryAuthorities = [];
let runtimeSnapshotReadOnlyDirectoryAuthorities = [];

function sealedSystemHardlinkPolicy(path) {
  const resolvedPath = realpathSync(path);
  return ["/bin", "/sbin", "/usr/bin", "/usr/lib", "/usr/sbin", "/System", "/Applications/Xcode.app/Contents/Developer"]
    .some((root) => resolvedPath === root || resolvedPath.startsWith(`${root}${sep}`));
}

function configureFreshRuntimeArtifactSpecs(freshRoot, freshTarget, freshJavaScriptOutput) {
  const freshAppServer = join(freshTarget, "debug", "relayer-app-server");
  const freshGraphServer = join(freshTarget, "debug", "relayer-graph-server");
  const nativeRoots = [
    SOURCE_FFMPEG_PATH, SOURCE_FFPROBE_PATH, SOURCE_NODE_PATH, SOURCE_GIT_PATH,
    SOURCE_SANDBOX_EXEC_PATH, SOURCE_SED_PATH, SOURCE_RG_PATH, SOURCE_CODEX_EXECUTABLE,
    SOURCE_CODEX_CODE_MODE_HOST, freshAppServer, freshGraphServer,
  ];
  sourceMachOExecutableDigests = new Map();
  dynamicRuntimeDependencies = nonSystemMachODependencies(nativeRoots, undefined, sourceMachOExecutableDigests);
  const discoveredMachOSha256 = (path) => sourceMachOExecutableDigests.get(realpathSync(path));
  sourceRuntimeArtifactSpecs.unshift(
    { key: "codex", source: SOURCE_CODEX_EXECUTABLE, label: "<codex-executable>", copy: true, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_CODEX_EXECUTABLE) },
    { key: "codex-code-mode-host", source: SOURCE_CODEX_CODE_MODE_HOST, label: "<codex-code-mode-host-executable>", copy: true, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_CODEX_CODE_MODE_HOST) },
    { key: "ffmpeg", source: SOURCE_FFMPEG_PATH, label: "<ffmpeg-executable>", copy: true, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_FFMPEG_PATH) },
    { key: "ffprobe", source: SOURCE_FFPROBE_PATH, label: "<ffprobe-executable>", copy: true, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_FFPROBE_PATH) },
    { key: "node", source: SOURCE_NODE_PATH, label: "<node-executable>", copy: true, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_NODE_PATH), allowExternalCopySourceHardlinks: true },
    { key: "git", source: SOURCE_GIT_PATH, label: "<git-executable>", copy: true, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_GIT_PATH), allowHardlinks: sealedSystemHardlinkPolicy(SOURCE_GIT_PATH) },
    { key: "sandbox-exec", source: SOURCE_SANDBOX_EXEC_PATH, label: "<sandbox-executable>", copy: false, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_SANDBOX_EXEC_PATH), allowHardlinks: sealedSystemHardlinkPolicy(SOURCE_SANDBOX_EXEC_PATH) },
    { key: "sed", source: SOURCE_SED_PATH, label: "<sed-executable>", copy: true, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_SED_PATH), allowHardlinks: sealedSystemHardlinkPolicy(SOURCE_SED_PATH) },
    { key: "rg", source: SOURCE_RG_PATH, label: "<ripgrep-executable>", copy: true, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_RG_PATH) },
    ...dynamicRuntimeDependencies.map(([name, dependency]) => ({
      key: name, source: dependency.source, label: `<dynamic-library>/${name}`, copy: true, provenance: "external", discoveredSha256: dependency.sha256,
      ...(externalNodeClosureSources.has(realpathSync(dependency.source)) ? { allowExternalCopySourceHardlinks: true } : {}),
    })),
    { key: "app-server", source: freshAppServer, label: "target/debug/relayer-app-server", copy: true, provenance: "fresh-build", discoveredSha256: discoveredMachOSha256(freshAppServer) },
    { key: "graph-server", source: freshGraphServer, label: "target/debug/relayer-graph-server", copy: true, provenance: "fresh-build", discoveredSha256: discoveredMachOSha256(freshGraphServer) },
    { key: "desktop", source: join(freshRoot, "desktop"), label: "desktop", copy: true, provenance: "commit", revisionPath: "desktop" },
    { key: "permissions", source: join(freshRoot, "permissions"), label: "permissions", copy: true, provenance: "commit", revisionPath: "permissions" },
    { key: "harnesses", source: join(freshRoot, "harnesses"), label: "harnesses", copy: true, provenance: "commit", revisionPath: "harnesses" },
    { key: "graph-client-dist", source: join(freshJavaScriptOutput, "graph-client"), label: "packages/graph-client/dist", copy: true, target: "node_modules/@relayer/graph-client/dist", provenance: "fresh-build" },
    { key: "graph-client-package", source: join(freshRoot, "packages", "graph-client", "package.json"), label: "packages/graph-client/package.json", copy: true, target: "node_modules/@relayer/graph-client/package.json", provenance: "commit", revisionPath: "packages/graph-client/package.json" },
    { key: "harness-host-dist", source: join(freshJavaScriptOutput, "harness-host"), label: "packages/harness-host/dist", copy: true, target: "node_modules/@relayer/harness-host/dist", provenance: "fresh-build" },
    { key: "harness-host-package", source: join(freshRoot, "packages", "harness-host", "package.json"), label: "packages/harness-host/package.json", copy: true, target: "node_modules/@relayer/harness-host/package.json", provenance: "commit", revisionPath: "packages/harness-host/package.json" },
    { key: "codex-sdk", source: join(repositoryRoot, "node_modules", "@openai", "codex-sdk"), label: "node_modules/@openai/codex-sdk", copy: true, target: "node_modules/@openai/codex-sdk", provenance: "external" },
    { key: "yaml", source: join(repositoryRoot, "node_modules", "yaml"), label: "node_modules/yaml", copy: true, target: "node_modules/yaml", provenance: "external" },
    ...BOOTSTRAP_CONTROL_FILES.map((name) => ({
      key: `control-source-${name}`, source: join(freshRoot, "scripts", name), label: `scripts/${name}`,
      copy: true, target: `control-source/${name}`, provenance: "commit", revisionPath: `scripts/${name}`,
    })),
    { key: "bootstrap-control", source: import.meta.dirname, label: "<bootstrap-control>", copy: false, provenance: "authenticated-bootstrap" },
    { key: "electron", source: originalElectronContentsDirectory, executedSource: electronContentsDirectory, label: "<electron-runtime>", copy: false, provenance: "external" },
  );
}
let activeRuntimeArtifactSpecs = [];
let CODEX_EXECUTABLE = SOURCE_CODEX_EXECUTABLE;
let FFMPEG_PATH = SOURCE_FFMPEG_PATH;
let FFPROBE_PATH = SOURCE_FFPROBE_PATH;
let NODE_PATH = SOURCE_NODE_PATH;
let GIT_PATH = SOURCE_GIT_PATH;
let SANDBOX_EXEC_PATH = SOURCE_SANDBOX_EXEC_PATH;
let SED_PATH = SOURCE_SED_PATH;
let RG_PATH = SOURCE_RG_PATH;
let appServerBinary = join(repositoryRoot, "target", "debug", "relayer-app-server");
let graphServerBinary = join(repositoryRoot, "target", "debug", "relayer-graph-server");
let desktopDirectory = join(repositoryRoot, "desktop");
let permissionCatalogPath = join(repositoryRoot, "permissions", "desktop.json");
let harnessConfigurationPath = join(repositoryRoot, "harnesses", "codex-basic.yaml");
let graphClientModuleUrl = pathToFileURL(join(repositoryRoot, "packages", "graph-client", "dist", "index.js")).href;
let harnessHostModuleUrl;
let CodexCredentialAdapter;
let CodexModelCatalogAdapter;
let startModelCatalogRefreshServer;
let ModelCatalogService;
let GraphCompleteRuntimeService;
let RelayerAppServerService;
let createWindowFactory;
let redactRuntimeTraceData;
const sourceCodexHome = process.env.RELAYER_CODEX_HOME || process.env.CODEX_HOME || join(homedir(), ".codex");
let outputDirectory;
let frameDirectory;
let traceDirectory;
let dataDirectory;
let projectDirectory;
let isolatedCodexHome;
let markerDirectory;
let providerPidFile;
let providerWrapperSource;
let providerWrapper;
let graphAuthoringLauncherSource;
let graphAuthoringLauncher;
let graphAuthoringNetworkProfileSource;
let graphAuthoringNetworkProfile;
function cleanupInitializedDirectoriesSync() {
  const cleanupAuthorities = [
    ...freshBuildReadOnlyDirectoryAuthorities,
    ...runtimeSnapshotReadOnlyDirectoryAuthorities,
  ];
  const sourceRestored = cleanupAuthorities.length === 0
    || restoreDirectoryWritesSync(cleanupAuthorities);
  for (const directory of [outputDirectory, markerDirectory, projectDirectory]) {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
  if (dataDirectory && sourceRestored) rmSync(dataDirectory, { recursive: true, force: true });
}
process.once("exit", () => {
  cleanupInitializedDirectoriesSync();
});
try {
  outputDirectory = mkdtempSync(join(resolve(publishedDirectory, ".."), ".ask-profile-approval-stage-"));
  frameDirectory = join(outputDirectory, ".frames");
  traceDirectory = join(outputDirectory, "traces");
  dataDirectory = mkdtempSync(join(tmpdir(), "relayer-ask-profile-evidence-"));
  projectDirectory = mkdtempSync(join(protectedRoot, "relayer-ask-profile-project-"));
  isolatedCodexHome = join(dataDirectory, "codex-home");
  markerDirectory = mkdtempSync(join(protectedRoot, "relayer-ask-profile-evidence-"));
  providerPidFile = join(dataDirectory, "codex-provider.pid");
  providerWrapperSource = join(dataDirectory, "codex-provider-wrapper-source");
  providerWrapper = join(dataDirectory, "runtime-snapshot", "codex-provider-wrapper");
  graphAuthoringLauncherSource = join(dataDirectory, "graph-authoring-launcher-source");
  graphAuthoringLauncher = join(dataDirectory, "runtime-snapshot", "graph-authoring-launcher");
  graphAuthoringNetworkProfileSource = join(dataDirectory, "graph-authoring-network-profile-source");
  graphAuthoringNetworkProfile = join(dataDirectory, "runtime-snapshot", "graph-authoring-network.sb");
  sourceRuntimeArtifactSpecs.push({
    key: "codex-provider-wrapper",
    source: providerWrapperSource,
    label: "<codex-provider-wrapper>",
    copy: true,
    provenance: "generated",
  });
  sourceRuntimeArtifactSpecs.push({
    key: "graph-authoring-network-profile",
    source: graphAuthoringNetworkProfileSource,
    label: "<graph-authoring-network-profile>",
    copy: true,
    target: "graph-authoring-network.sb",
    provenance: "generated",
  });
  sourceRuntimeArtifactSpecs.push({
    key: "graph-authoring-launcher",
    source: graphAuthoringLauncherSource,
    label: "<graph-authoring-launcher>",
    copy: true,
    provenance: "generated",
  });

  app.setName("Relayer Ask Profile Evidence");
  mkdirSync(join(dataDirectory, "electron-profile"), { recursive: true });
  app.setPath("userData", join(dataDirectory, "electron-profile"));
  app.commandLine.appendSwitch("disable-gpu");
} catch (error) {
  cleanupInitializedDirectoriesSync();
  throw error;
}
const services = [];
const ipcChannels = [];
const observations = [];
const approvalPromptHolds = [];
const screenshots = {};
const validatedArtifacts = new Map();
const pinnedVideoFrames = new Map();
const pinnedVideoFrameBytes = new Map();
let runtime;
let runtimeSession;
let mainWindow;
let recording = false;
let recorder;
let frameCount = 0;
let recordingStartedAt;
let recordingFinishedAt;
let recordingFailure;
let lastRecordedCurrentFrame;
let ffmpegAbortController;
let exitCode = 1;
let shutdownPromise;
let terminationClosePromise;
let terminationSignal;
let terminationSignalCount = 0;
let publicationCommitted = false;
let cleanupComplete = false;
let resolveTerminationRequest;
let replayDeadline = absoluteReplayDeadline;
let replayDeadlineEscalation;
const terminationRequested = new Promise((resolveRequest) => {
  resolveTerminationRequest = resolveRequest;
});
const replayDeadlineWatchdog = setTimeout(() => {
  terminateOnSignal("SIGTERM");
  replayDeadlineEscalation = setTimeout(() => {
    if (!cleanupComplete) terminateOnSignal("SIGTERM");
  }, MEDIA_ABORT_GRACE_MS);
}, remainingReplayTimeout(REPLAY_TIMEOUT_MS));

function registerIpc(channel, handler) {
  ipcMain.handle(channel, handler);
  ipcChannels.push(channel);
}

function ensureActive() {
  if (terminationSignal) throw new Error(`Evidence capture interrupted by ${terminationSignal}.`);
  if (recordingFailure) throw recordingFailure;
  if (replayDeadline !== undefined && Date.now() >= replayDeadline) {
    const error = new Error(`Ask-profile evidence replay exceeded its ${REPLAY_TIMEOUT_MS}ms global deadline.`);
    error.code = "RELAYER_REPLAY_DEADLINE";
    throw error;
  }
}

async function waitWhileActive(durationMs) {
  ensureActive();
  const remainingReplayMs = replayDeadline === undefined ? durationMs : replayDeadline - Date.now();
  const boundedDurationMs = Math.min(durationMs, Math.max(0, remainingReplayMs));
  let timeout;
  try {
    await Promise.race([
      new Promise((resolveWait) => { timeout = setTimeout(resolveWait, boundedDurationMs); }),
      terminationRequested.then(() => { throw new Error(`Evidence capture interrupted by ${terminationSignal}.`); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  ensureActive();
}

function boundedEvidenceCheck(label, check, deadline, timeoutMs) {
  const effectiveDeadline = replayDeadline === undefined ? deadline : Math.min(deadline, replayDeadline);
  return settleBeforeDeadline(check, {
    label,
    deadline: effectiveDeadline,
    timeoutMs,
    interruption: terminationRequested,
  });
}

async function abortableEvidenceOperation(label, operation, timeoutMs = LOCAL_OPERATION_TIMEOUT_MS, onAbort = () => {}) {
  ensureActive();
  const controller = new AbortController();
  const localDeadline = Date.now() + timeoutMs;
  const deadline = replayDeadline === undefined ? localDeadline : Math.min(localDeadline, replayDeadline);
  try {
    return await settleBeforeDeadline(() => operation(controller.signal), {
      label,
      deadline,
      timeoutMs,
      interruption: terminationRequested,
    });
  } catch (error) {
    controller.abort(error);
    let abortTimer;
    await Promise.race([
      Promise.resolve().then(onAbort).catch(() => undefined),
      new Promise((resolveAbort) => { abortTimer = setTimeout(resolveAbort, MEDIA_ABORT_GRACE_MS); }),
    ]).finally(() => clearTimeout(abortTimer));
    throw error;
  }
}

async function holdApprovalPrompt(name, waitingReceipt) {
  const requestId = waitingReceipt.request.requestId;
  const promptValidatedAt = Date.now();
  const deadline = promptValidatedAt + APPROVAL_PROMPT_HOLD_TIMEOUT_MS;
  let stableStateSamples = 0;
  let anchor;
  while (true) {
    ensureActive();
    const state = await boundedEvidenceCheck(
      `${name} approval hold state`,
      approvalDockState,
      deadline,
      APPROVAL_PROMPT_HOLD_TIMEOUT_MS,
    );
    if (state?.requestId !== requestId
      || !completeWaitingDock(state, waitingReceipt)
      || !visibleGraphDock(state)) {
      throw new Error(`Ask waiting state changed during the ${name} video hold: ${JSON.stringify(state)}`);
    }
    stableStateSamples += 1;
    if (!anchor && isFreshRecordedPromptFrame(lastRecordedCurrentFrame, promptValidatedAt)) {
      anchor = lastRecordedCurrentFrame;
    }
    const observedMs = anchor ? Date.now() - anchor.captureCompletedAt : 0;
    const frameCountAtStart = anchor?.frameIndex;
    const frameDelta = frameCount - frameCountAtStart;
    if (anchor && observedMs >= APPROVAL_PROMPT_HOLD_MS && frameDelta >= APPROVAL_PROMPT_MIN_FRAMES) {
      return {
        label: name,
        requestId,
        requiredMs: APPROVAL_PROMPT_HOLD_MS,
        observedMs,
        stableStateSamples,
        videoStartOffsetMs: frameCountAtStart * FRAME_INTERVAL_MS,
        videoEndOffsetMs: frameCount * FRAME_INTERVAL_MS,
        frameCountAtStart,
        frameCountAtEnd: frameCount,
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(`${name} did not record ${APPROVAL_PROMPT_MIN_FRAMES} stable prompt frames within ${APPROVAL_PROMPT_HOLD_TIMEOUT_MS}ms.`);
    }
    await waitWhileActive(Math.min(125, deadline - Date.now()));
  }
}

async function capturePageWithinDeadline(label) {
  let timeout;
  const deadline = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`${label} exceeded the ${CAPTURE_DEADLINE_MS}ms capture deadline.`);
      error.code = "RELAYER_CAPTURE_DEADLINE";
      reject(error);
    }, CAPTURE_DEADLINE_MS);
  });
  try {
    return await Promise.race([mainWindow.webContents.capturePage(), deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

function appendDiagnosticTail(current, chunk) {
  return `${current}${chunk}`.slice(-65_536);
}

function mediaChildAbort(child, controller) {
  return () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    controller.abort();
  };
}

function forceMediaChildClosed(child) {
  return () => {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
}

function mediaChildCompletion(child, label, stdout, stderr) {
  let processError;
  child.once("error", (error) => { processError = error; });
  const closed = new Promise((resolveChild) => {
    child.once("close", (code, signal) => resolveChild({ code, signal }));
  });
  const completion = closed.then(({ code, signal }) => {
    if (processError) {
      throw new Error(`${label} failed to start or was aborted.${stderr() ? ` ${stderr().trim()}` : ""}`, { cause: processError });
    }
    if (code !== 0) throw new Error(`${label} exited with ${signal || code}.${stderr() ? ` ${stderr().trim()}` : ""}`);
    return { stdout: stdout(), stderr: stderr() };
  });
  return { closed, completion };
}

async function runMediaTool(executable, args) {
  ensureActive();
  const label = basename(executable);
  const controller = new AbortController();
  ffmpegAbortController = controller;
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], signal: controller.signal });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr = appendDiagnosticTail(stderr, chunk); });
  const process = mediaChildCompletion(child, label, () => stdout, () => stderr);
  try {
    return await settleMediaCompletion(process.completion, {
      label,
      timeoutMs: remainingReplayTimeout(MEDIA_COMPLETION_TIMEOUT_MS),
      abort: mediaChildAbort(child, controller),
      force: forceMediaChildClosed(child),
      closed: process.closed,
      diagnostics: () => stderr,
      abortCloseTimeoutMs: MEDIA_ABORT_GRACE_MS,
      forceCloseTimeoutMs: MEDIA_ABORT_GRACE_MS,
    });
  } finally {
    if (ffmpegAbortController === controller) ffmpegAbortController = undefined;
  }
}

async function runFrameEncoder(frameBuffers) {
  ensureActive();
  const controller = new AbortController();
  ffmpegAbortController = controller;
  const child = spawn(FFMPEG_PATH, [
    "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(RECORDING_FPS),
    "-vcodec", "mjpeg", "-i", "pipe:0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
    join(outputDirectory, VIDEO_FILE),
  ], { stdio: ["pipe", "ignore", "pipe"], signal: controller.signal });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = appendDiagnosticTail(stderr, chunk);
  });
  const process = mediaChildCompletion(child, "ffmpeg frame encoder", () => "", () => stderr);
  const encoded = Promise.all([
    pipeByteChunks(child.stdin, frameBuffers, controller.signal),
    process.completion,
  ]);
  try {
    await settleMediaCompletion(encoded, {
      label: "ffmpeg frame encoder",
      timeoutMs: remainingReplayTimeout(MEDIA_COMPLETION_TIMEOUT_MS),
      abort: mediaChildAbort(child, controller),
      force: forceMediaChildClosed(child),
      closed: process.closed,
      diagnostics: () => stderr,
      abortCloseTimeoutMs: MEDIA_ABORT_GRACE_MS,
      forceCloseTimeoutMs: MEDIA_ABORT_GRACE_MS,
    });
  } finally {
    if (ffmpegAbortController === controller) ffmpegAbortController = undefined;
  }
}

function registerEvidenceIpc() {
  registerIpc("relayer:account-read", () => ({
    status: "connected",
    account: { email: "local-codex-account", planType: "Paid inference evidence" },
  }));
  registerIpc("relayer:appearance-read", () => ({ appearance: "dark" }));
  registerIpc("relayer:folder-choose", () => null);
  registerIpc("relayer:tutorial-read", () => ({
    status: "dismissed",
    automaticEligible: false,
  }));
  registerIpc("relayer:update-status", () => ({
    phase: "development",
    channel: "stable",
    version: sourceVersions.desktop,
    availableVersion: null,
    percent: null,
    error: null,
  }));
}

async function waitFor(label, check, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (true) {
    ensureActive();
    if (Date.now() >= deadline) break;
    try {
      const value = await boundedEvidenceCheck(label, check, deadline, timeoutMs);
      if (value) return value;
    } catch (error) {
      if (error?.code === "RELAYER_WAIT_DEADLINE") break;
      if (error?.code === "RELAYER_WAIT_INTERRUPTED") throw error;
      lastError = error;
    }
    ensureActive();
    await waitWhileActive(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ${label}.${lastError ? ` Last error: ${lastError.message}` : ""}`);
}

async function productRequest(session, path, init = {}) {
  const method = init.method ?? "GET";
  return abortableEvidenceOperation(`${method} ${path}`, async (signal) => {
    const response = await fetch(new URL(path, session.origin), {
      ...init,
      signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
      headers: {
        Accept: "application/json",
        Cookie: `${session.cookie.name}=${session.cookie.value}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
    const value = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(value?.error?.message || JSON.stringify(value));
    return value;
  });
}

async function threadDetail(session, threadId) {
  return productRequest(session, `/api/threads/${threadId}`);
}

async function waitForThread(session, threadId, check, label, timeoutMs = MODEL_COMPLETION_TIMEOUT_MS) {
  return waitFor(label, async () => {
    const detail = await threadDetail(session, threadId);
    return check(detail) ? detail : false;
  }, timeoutMs);
}

async function createInteraction(session, threadId, text) {
  return productRequest(session, `/api/threads/${threadId}/interactions`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

async function openThread(session, threadId) {
  await abortableEvidenceOperation(
    `thread ${threadId} navigation`,
    () => mainWindow.loadURL(`${session.origin}/?threadId=${encodeURIComponent(threadId)}`),
    LOCAL_OPERATION_TIMEOUT_MS,
    () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.stop();
    },
  );
  await waitFor("ordinary ProductWorkspace", () => mainWindow.webContents.executeJavaScript(`(() => (
    !document.querySelector('#threadView')?.classList.contains('hidden')
    && Boolean(document.querySelector('#threadComposer'))
    && Boolean(document.querySelector('#graphStage'))
  ))()`), 20_000);
}

async function approvalDockState() {
  return mainWindow.webContents.executeJavaScript(`(() => {
    const dock = document.querySelector('#approvalDock');
    if (!dock || dock.classList.contains('hidden') || dock.classList.contains('history-only')) return false;
    const graphStage = document.querySelector('#graphStage');
    const graphEmpty = document.querySelector('#graphEmpty');
    return {
      requestId: dock.dataset.requestId,
      eyebrow: document.querySelector('#approvalEyebrow')?.textContent?.trim(),
      title: document.querySelector('#approvalTitle')?.textContent?.trim(),
      action: document.querySelector('#approvalActionValue')?.textContent?.trim(),
      workingDirectory: document.querySelector('#approvalWorkingDirectory')?.textContent?.trim(),
      affectedFiles: document.querySelector('#approvalAffectedFiles')?.textContent?.trim(),
      scope: document.querySelector('#approvalScopeDescription')?.textContent?.trim(),
      queue: document.querySelector('#approvalQueuePosition')?.textContent?.trim(),
      waiting: document.querySelector('#approvalEyebrow')?.textContent?.trim() === 'Needs approval',
      graphNodeCount: document.querySelectorAll('.graph-node').length,
      graphStageVisible: Boolean(graphStage && !graphStage.classList.contains('hidden')),
      graphEmptyHidden: Boolean(graphEmpty?.classList.contains('hidden')),
      composerHidden: document.querySelector('#threadComposerShell')?.classList.contains('hidden'),
      decisions: ['denyApproval', 'approveOnce', 'approveAlways'].map((id) => ({
        id,
        label: document.getElementById(id)?.textContent?.replace(/\\s+/g, ' ').trim(),
        disabled: document.getElementById(id)?.disabled,
      })),
    };
  })()`);
}

function expectedApprovalPresentation(receipt) {
  const action = receipt?.request?.action;
  const value = action?.kind === "command"
    ? action.command
    : action?.kind === "network"
      ? [action.action, action.networkDestination].filter((entry) => typeof entry === "string" && entry.trim() !== "").join(" · ")
      : action?.action;
  return {
    title: receipt?.request?.title,
    action: value,
    workingDirectory: action?.workingDirectory || "",
    affectedFiles: Array.isArray(action?.affectedFiles) ? action.affectedFiles.join(", ") : "",
    scope: receipt?.request?.scopeDescription,
  };
}

function completeWaitingDock(dock, receipt) {
  const decisionLabels = Object.fromEntries(dock?.decisions?.map((decision) => [decision.id, decision.label]) ?? []);
  const expected = expectedApprovalPresentation(receipt);
  return Boolean(
    dock?.waiting
    && dock.composerHidden
    && [dock.title, dock.action, dock.workingDirectory, dock.affectedFiles, dock.scope]
      .every((value) => typeof value === "string" && value.trim() !== "")
    && decisionLabels.denyApproval === "Deny"
    && decisionLabels.approveOnce === "Approve once"
    && decisionLabels.approveAlways?.startsWith("Approve always")
    && dock.decisions?.every((decision) => decision.disabled === false)
    && dock.title === expected.title
    && dock.action === expected.action
    && dock.workingDirectory === expected.workingDirectory
    && dock.affectedFiles === expected.affectedFiles
    && dock.scope === expected.scope
  );
}

function visibleGraphDock(dock) {
  return Boolean(dock?.graphNodeCount > 0 && dock.graphStageVisible && dock.graphEmptyHidden);
}

async function waitForOpenApproval(session, threadId, interactionId, label) {
  const detail = await waitForThread(
    session,
    threadId,
    (candidate) => {
      const pending = candidate.approvals.some((receipt) => (
        String(receipt.request.correlation.interactionId) === String(interactionId)
        && receipt.resolution == null
      ));
      const status = candidate.interactions.find((interaction) => String(interaction.id) === String(interactionId))?.completionStatus;
      return pending || ["accepted", "stopped", "failed"].includes(status);
    },
    label,
  );
  const terminalStatus = detail.interactions.find((interaction) => String(interaction.id) === String(interactionId))?.completionStatus;
  if (!detail.approvals.some((receipt) => (
    String(receipt.request.correlation.interactionId) === String(interactionId) && receipt.resolution == null
  ))) {
    throw new Error(`${label} reached terminal status ${terminalStatus} without requesting approval.`);
  }
  await openThread(session, threadId);
  const dock = await waitFor(`${label} dock`, approvalDockState, 20_000);
  const receipt = detail.approvals.find((candidate) => candidate.request.requestId === dock.requestId);
  if (!receipt || String(receipt.request.correlation.interactionId) !== String(interactionId)) {
    throw new Error(`Dock/request correlation mismatch for ${label}: ${JSON.stringify({ dock, approvals: detail.approvals })}`);
  }
  if (!completeWaitingDock(dock, receipt)) {
    throw new Error(`Incomplete Ask waiting presentation for ${label}: ${JSON.stringify(dock)}`);
  }
  await click("#previousTurn");
  const graphDock = await waitFor(`${label} prior accepted graph with live dock`, async () => {
    const state = await approvalDockState();
    if (state?.requestId !== dock.requestId) return false;
    if (visibleGraphDock(state) && completeWaitingDock(state, receipt)) return state;
    const canStepBack = await mainWindow.webContents.executeJavaScript(`document.querySelector('#previousTurn')?.disabled === false`);
    if (canStepBack) await click("#previousTurn");
    return false;
  }, 20_000);
  return { detail, dock: graphDock, receipt };
}

async function click(selector) {
  await boundedEvidenceCheck(
    `click ${selector}`,
    () => mainWindow.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.click()`),
    Date.now() + CAPTURE_DEADLINE_MS,
    CAPTURE_DEADLINE_MS,
  );
}

async function requireWaitingCaptureState(receipt, label) {
  const requestId = receipt.request.requestId;
  return waitFor(`${label} screenshot state`, async () => {
    const state = await approvalDockState();
    if (state?.requestId !== requestId || !completeWaitingDock(state, receipt)) return false;
    if (visibleGraphDock(state)) return state;
    const canStepBack = await mainWindow.webContents.executeJavaScript(`document.querySelector('#previousTurn')?.disabled === false`);
    if (canStepBack) await click("#previousTurn");
    return false;
  }, 20_000);
}

async function capture(name, requirements, waitingReceipt = null, stateCheck = null) {
  await waitWhileActive(300);
  if (waitingReceipt) await requireWaitingCaptureState(waitingReceipt, name);
  if (stateCheck) await waitFor(`${name} exact rendered state`, stateCheck, 20_000);
  const file = `${name}.png`;
  const image = await capturePageWithinDeadline(`${name} screenshot`);
  if (waitingReceipt) {
    const after = await boundedEvidenceCheck(
      `${name} post-screenshot approval state`,
      approvalDockState,
      Date.now() + CAPTURE_DEADLINE_MS,
      CAPTURE_DEADLINE_MS,
    );
    if (after?.requestId !== waitingReceipt.request.requestId
      || !completeWaitingDock(after, waitingReceipt)
      || !visibleGraphDock(after)) {
      throw new Error(`Ask waiting state changed while capturing ${name}: ${JSON.stringify(after)}`);
    }
  }
  const postCaptureState = stateCheck ? await boundedEvidenceCheck(
    `${name} post-screenshot rendered state`,
    stateCheck,
    Date.now() + CAPTURE_DEADLINE_MS,
    CAPTURE_DEADLINE_MS,
  ) : undefined;
  if (stateCheck && !postCaptureState) throw new Error(`Rendered state changed while capturing ${name}.`);
  const outputPath = join(outputDirectory, file);
  const png = image.toPNG();
  await writeFile(outputPath, png);
  await pinValidatedBytes(outputPath, png);
  screenshots[name] = {
    file,
    requirements,
    ...(waitingReceipt ? { approvalRequestId: waitingReceipt.request.requestId } : {}),
  };
  process.stdout.write(`Captured ${file}\n`);
  if (waitingReceipt) {
    approvalPromptHolds.push(await holdApprovalPrompt(name, waitingReceipt));
  }
  return postCaptureState;
}

async function recordFrames() {
  const initialImage = await capturePageWithinDeadline("initial video frame");
  const initialJpeg = Buffer.from(initialImage.toJPEG(68));
  const initialFilename = `frame-${String(frameCount).padStart(6, "0")}.jpg`;
  pinUniqueBytes(pinnedVideoFrames, initialFilename, initialJpeg);
  pinnedVideoFrameBytes.set(initialFilename, initialJpeg);
  await writeFile(join(frameDirectory, initialFilename), initialJpeg);
  frameCount += 1;
  recording = true;
  recordingStartedAt = Date.now();
  recorder = (async () => {
    let captureFailureStartedAt;
    let lastJpeg = initialJpeg;
    let nextCaptureAt = recordingStartedAt + FRAME_INTERVAL_MS;
    while (recording && mainWindow && !mainWindow.isDestroyed()) {
      let image;
      const captureStartedAt = Date.now();
      try {
        image = await capturePageWithinDeadline("continuous video frame");
        captureFailureStartedAt = undefined;
      } catch (error) {
        if (error?.code === "RELAYER_CAPTURE_DEADLINE") {
          recordingFailure = error;
          recording = false;
          return;
        }
        // Navigations can invalidate one capture; sustained loss is not continuous evidence.
        captureFailureStartedAt ??= Date.now();
        if (Date.now() - captureFailureStartedAt >= 2_000) {
          recordingFailure = new Error("Continuous desktop recording lost capture access for two seconds.", { cause: error });
          recording = false;
          return;
        }
      }
      if (image) {
        const captureCompletedAt = Date.now();
        const jpeg = image.toJPEG(68);
        const wallClockFrameCount = Math.max(frameCount + 1, Math.ceil((Date.now() - recordingStartedAt) / FRAME_INTERVAL_MS));
        const currentFrameIndex = wallClockFrameCount - 1;
        try {
          while (frameCount < wallClockFrameCount) {
            const filename = `frame-${String(frameCount).padStart(6, "0")}.jpg`;
            const isRecoveredCurrentSlot = frameCount === wallClockFrameCount - 1;
            const frameBytes = Buffer.from(isRecoveredCurrentSlot ? jpeg : lastJpeg);
            pinUniqueBytes(pinnedVideoFrames, filename, frameBytes);
            pinnedVideoFrameBytes.set(filename, frameBytes);
            await writeFile(join(frameDirectory, filename), frameBytes);
            frameCount += 1;
          }
          lastJpeg = jpeg;
          lastRecordedCurrentFrame = {
            frameIndex: currentFrameIndex,
            captureStartedAt,
            captureCompletedAt,
          };
        } catch (error) {
          recordingFailure = new Error(`Continuous desktop recording could not write frame ${frameCount}.`, { cause: error });
          recording = false;
          return;
        }
      }
      nextCaptureAt = image
        ? recordingStartedAt + (frameCount * FRAME_INTERVAL_MS)
        : Math.max(nextCaptureAt + FRAME_INTERVAL_MS, Date.now() + FRAME_INTERVAL_MS);
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.max(0, nextCaptureAt - Date.now())));
    }
  })();
}

async function finishRecording() {
  recording = false;
  await recorder;
  recordingFinishedAt = Date.now();
  if (recordingFailure) throw recordingFailure;
  if (frameCount < 2) throw new Error("The continuous desktop recording did not capture enough frames.");
  if (pinnedVideoFrames.size !== frameCount || pinnedVideoFrameBytes.size !== frameCount) {
    throw new Error(`Captured frame pin count does not match the recording: ${JSON.stringify({
      frameCount,
      pinnedFrames: pinnedVideoFrames.size,
      retainedFrames: pinnedVideoFrameBytes.size,
    })}`);
  }
  const frameInventory = await artifactInventory(frameDirectory, "", false);
  verifyPinnedByteInventory(pinnedVideoFrames, frameInventory);
  const frameBuffers = pinnedBuffersInFileOrder(pinnedVideoFrames, pinnedVideoFrameBytes);
  const frameSequenceSha256 = pinnedSequenceSha256(pinnedVideoFrames);
  ensureActive();
  await runFrameEncoder(frameBuffers);
  const probe = await runMediaTool(FFPROBE_PATH, [
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames,duration", "-of", "json",
    join(outputDirectory, VIDEO_FILE),
  ]);
  ensureActive();
  const stream = JSON.parse(probe.stdout).streams?.[0];
  const encodedFrameCount = Number(stream?.nb_read_frames);
  const encodedDurationMs = Math.round(Number(stream?.duration) * 1_000);
  const expectedDurationMs = Math.round((frameCount / RECORDING_FPS) * 1_000);
  if (!Number.isSafeInteger(encodedFrameCount)
    || encodedFrameCount !== frameCount
    || !Number.isFinite(encodedDurationMs)
    || Math.abs(encodedDurationMs - expectedDurationMs) > FRAME_INTERVAL_MS) {
    throw new Error(`Encoded video does not match the captured frame sequence: ${JSON.stringify({ frameCount, encodedFrameCount, expectedDurationMs, encodedDurationMs })}`);
  }
  await pinArtifact(join(outputDirectory, VIDEO_FILE));
  return { encodedFrameCount, encodedDurationMs, frameSequenceSha256 };
}

async function inventoryBuildArtifacts(specs) {
  const artifacts = [];
  for (const spec of specs) artifacts.push(...await inventoryRegularArtifactTree({
    root: spec.source,
    label: spec.label,
    ...(spec.recordSymlinks ? { recordSymlinks: true } : {}),
    ...(spec.allowHardlinks ? { allowHardlinks: true } : {}),
    ...(spec.allowExternalCopySourceHardlinks ? { allowExternalCopySourceHardlinks: true } : {}),
  }));
  return artifacts.sort((left, right) => left.file.localeCompare(right.file));
}

async function preparePinnedBuildNodeRuntime() {
  const destination = join(dataDirectory, "pinned-build-node");
  const staging = mkdtempSync(join(dataDirectory, ".pinned-build-node-"));
  const executableDigests = new Map();
  const dependencies = nonSystemMachODependencies([SOURCE_NODE_PATH], undefined, executableDigests);
  externalNodeClosureSources = new Set([
    realpathSync(SOURCE_NODE_PATH),
    ...dependencies.map(([, dependency]) => realpathSync(dependency.source)),
  ]);
  const sourceSpecs = [
    { source: SOURCE_NODE_PATH, target: "node", label: "<pinned-build-node>/node", discoveredSha256: executableDigests.get(realpathSync(SOURCE_NODE_PATH)) },
    ...dependencies.map(([name, dependency]) => ({ source: dependency.source, target: name, label: `<pinned-build-node>/${name}`, discoveredSha256: dependency.sha256 })),
  ];
  const sourceIdentity = async (spec) => {
    const details = await lstat(spec.source);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`External Node closure source is not one exact regular file: ${spec.label}`);
    }
    return {
      path: realpathSync(spec.source),
      dev: details.dev,
      ino: details.ino,
      size: details.size,
      mtimeMs: details.mtimeMs,
      ctimeMs: details.ctimeMs,
      uid: details.uid,
      gid: details.gid,
      mode: details.mode,
      nlink: details.nlink,
    };
  };
  const inventorySource = async () => {
    const artifacts = [];
    for (const spec of sourceSpecs) {
      const observed = await inventoryRegularArtifactTree({
        root: spec.source,
        label: spec.label,
        allowExternalCopySourceHardlinks: true,
      });
      if (observed.length !== 1 || observed[0].sha256 !== spec.discoveredSha256) {
        throw new Error(`External Node closure changed after authenticated dependency discovery: ${spec.label}`);
      }
      artifacts.push(...observed);
    }
    return artifacts.sort((left, right) => left.file.localeCompare(right.file));
  };
  try {
    const beforeIdentities = await Promise.all(sourceSpecs.map(sourceIdentity));
    const before = await inventorySource();
    for (const [index, spec] of sourceSpecs.entries()) {
      const target = join(staging, spec.target);
      await copyFile(spec.source, target);
      await chmod(target, 0o700);
    }
    const after = await inventorySource();
    const afterIdentities = await Promise.all(sourceSpecs.map(sourceIdentity));
    if (JSON.stringify(afterIdentities) !== JSON.stringify(beforeIdentities)
      || JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error("External Node closure changed while its private copy was prepared.");
    }
    const stagedSpecs = sourceSpecs.map((spec) => ({ source: join(staging, spec.target), label: spec.label }));
    const staged = await inventoryBuildArtifacts(stagedSpecs);
    if (JSON.stringify(staged) !== JSON.stringify(before)) {
      throw new Error("Private Node closure copy does not match its authenticated external source bytes.");
    }
    const otoolSpec = { source: SOURCE_OTOOL_PATH, label: "<build-tool>/otool", allowHardlinks: sealedSystemHardlinkPolicy(SOURCE_OTOOL_PATH) };
    const authenticatedOtool = await inventoryBuildArtifacts([otoolSpec]);
    const sealingToolDependencies = nonSystemMachODependencies([
      SOURCE_OTOOL_PATH, SOURCE_INSTALL_NAME_TOOL_PATH,
    ]).map(([name, dependency]) => ({
      source: dependency.source,
      label: `<build-tool-dynamic-library>/${name}`,
      allowHardlinks: sealedSystemHardlinkPolicy(dependency.source),
    }));
    await assertBuildInventory([otoolSpec], authenticatedOtool, "The resolved Xcode otool changed during sealing-tool closure discovery.");
    const sealingToolSpecs = [
      otoolSpec,
      { source: SOURCE_INSTALL_NAME_TOOL_PATH, label: "<build-tool>/install-name-tool", allowHardlinks: sealedSystemHardlinkPolicy(SOURCE_INSTALL_NAME_TOOL_PATH) },
      { source: SYSTEM_CODESIGN_PATH, label: "<build-tool>/codesign", allowHardlinks: true },
      ...sealingToolDependencies,
    ];
    const sealingTools = await inventoryBuildArtifacts(sealingToolSpecs);
    sealMachORuntimeCopies({
      sourceSpecs: sourceSpecs.map((spec) => ({
        source: spec.source,
        target: join(staging, spec.target),
        sourceSha256: spec.discoveredSha256,
        targetAuthority: captureExactRegularFileIdentity(join(staging, spec.target)),
      })),
      runtimeRoot: staging,
      rootExecutable: join(staging, "node"),
      timeoutMs: () => remainingReplayTimeout(),
      otoolPath: SOURCE_OTOOL_PATH,
      installNameToolPath: SOURCE_INSTALL_NAME_TOOL_PATH,
    });
    await assertBuildInventory(sealingToolSpecs, sealingTools, "A fixed Mach-O sealing tool changed during private Node preparation.");
    const finalSourceIdentities = await Promise.all(sourceSpecs.map(sourceIdentity));
    const finalSource = await inventorySource();
    if (JSON.stringify(finalSourceIdentities) !== JSON.stringify(beforeIdentities)
      || JSON.stringify(finalSource) !== JSON.stringify(before)) {
      throw new Error("External Node closure changed while its private load commands were sealed.");
    }
    const sealed = await inventoryBuildArtifacts(stagedSpecs);
    await rename(staging, destination);
    const specs = sourceSpecs.map((spec) => ({ source: join(destination, spec.target), label: spec.label }));
    await assertBuildInventory(specs, sealed, "Private Node closure changed after atomic publication.");
    return { nodePath: join(destination, "node"), root: destination, specs, expected: sealed, sealingToolSpecs };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function freshBuildEnvironment(overrides = {}) {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: join(dataDirectory, "fresh-build-tmp"),
    ...overrides,
  };
}

async function assertBuildInventory(specs, expected, message) {
  const observed = await inventoryBuildArtifacts(specs);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(message);
}

async function verifyFreshBuildSource() {
  if (!freshBuildSourceSpec) throw new Error("Fresh build source inventory was not established.");
  await assertBuildInventory(
    [freshBuildSourceSpec],
    freshBuildExpectedSource,
    "Authenticated commit-materialized source changed during the fresh build.",
  );
}

async function makeTreeReadOnly(path) {
  const details = await lstat(path);
  if (details.isSymbolicLink()) throw new Error(`Fresh build source contains a symbolic link: ${path}`);
  if (details.isDirectory()) {
    for (const name of await readdir(path)) await makeTreeReadOnly(join(path, name));
    await chmod(path, 0o500);
    const sealed = await lstat(path, { bigint: true });
    const canonicalPath = join(realpathSync(dirname(path)), basename(path));
    if (!sealed.isDirectory() || sealed.isSymbolicLink() || realpathSync(path) !== canonicalPath) {
      throw new Error(`Fresh build source directory changed while it was sealed read-only: ${path}`);
    }
    freshBuildReadOnlyDirectoryAuthorities.push({ path, dev: sealed.dev, ino: sealed.ino });
    return;
  }
  if (!details.isFile()) throw new Error(`Fresh build source is not a regular tree: ${path}`);
  await chmod(path, details.mode & 0o111 ? 0o500 : 0o400);
}

function canonicalSandboxPath(path) {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return join(canonicalSandboxPath(parent), basename(path));
}

async function prepareFreshBuiltRuntime() {
  const freshWorkspace = join(dataDirectory, "fresh-build-workspace");
  const freshRoot = join(freshWorkspace, "source");
  const freshOutput = join(freshWorkspace, "output");
  const freshJavaScriptOutput = join(freshOutput, "javascript");
  const freshRustOutput = join(freshWorkspace, "rust-output");
  const freshTarget = join(freshRustOutput, "target");
  const freshCargoHome = join(freshWorkspace, "cargo-home");
  const freshVendor = join(freshWorkspace, "vendor");
  const freshTemporary = join(freshWorkspace, "tmp");
  const buildNodeModules = join(freshWorkspace, "node_modules");
  const graphBuildSandboxProfile = join(freshWorkspace, "graph-build.sb");
  const harnessBuildSandboxProfile = join(freshWorkspace, "harness-build.sb");
  const rustBuildSandboxProfile = join(freshWorkspace, "rust-build.sb");
  await mkdir(freshRoot, { recursive: true, mode: 0o700 });
  await mkdir(freshOutput, { recursive: true, mode: 0o700 });
  await mkdir(freshRustOutput, { recursive: true, mode: 0o700 });
  await mkdir(freshTemporary, { recursive: true, mode: 0o700 });
  await mkdir(join(freshJavaScriptOutput, "graph-client"), { recursive: true, mode: 0o700 });
  await mkdir(join(freshJavaScriptOutput, "harness-host"), { recursive: true, mode: 0o700 });

  const pinnedBuildNode = await preparePinnedBuildNodeRuntime();

  const bootstrapBuildToolSpecs = [
    { source: SOURCE_GIT_PATH, label: "<build-tool>/git", allowHardlinks: true },
    { source: SOURCE_TAR_PATH, label: "<build-tool>/tar", allowHardlinks: true },
    { source: SOURCE_XCRUN_PATH, label: "<build-tool>/xcrun", allowHardlinks: true },
    { source: SOURCE_SANDBOX_EXEC_PATH, label: "<build-tool>/sandbox-exec", allowHardlinks: true },
    ...pinnedBuildNode.sealingToolSpecs,
    ...pinnedBuildNode.specs,
    { source: SOURCE_RUSTUP_PATH, label: "<build-tool>/rustup" },
  ];
  const bootstrapBuildTools = await inventoryBuildArtifacts(bootstrapBuildToolSpecs);
  await assertBuildInventory(bootstrapBuildToolSpecs, bootstrapBuildTools, "A fresh-build bootstrap tool changed before first use.");

  const archive = execFileSync(SOURCE_GIT_PATH, fixedGitArguments(repositoryRoot, [
    "archive", "--format=tar", sourceCommit,
  ]), {
    cwd: repositoryRoot,
    env: fixedGitEnvironment(),
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
    timeout: remainingReplayTimeout(MAJOR_OPERATION_TIMEOUT_MS),
  });
  execFileSync(SOURCE_TAR_PATH, ["-xf", "-", "-C", freshRoot], {
    input: archive,
    env: freshBuildEnvironment({ TMPDIR: freshTemporary }),
    timeout: remainingReplayTimeout(MAJOR_OPERATION_TIMEOUT_MS),
  });
  const committedSource = readCommittedGitInventory({
    gitPath: SOURCE_GIT_PATH,
    repositoryRoot,
    commit: sourceCommit,
    path: ".",
    label: "<fresh-build-source>",
    timeoutMs: remainingReplayTimeout(MAJOR_OPERATION_TIMEOUT_MS),
  });
  const materializedSource = await inventoryRegularArtifactTree({ root: freshRoot, label: "<fresh-build-source>" });
  if (JSON.stringify(materializedSource) !== JSON.stringify(committedSource)) {
    throw new Error("Fresh build source tree does not exactly match authenticated commit-object bytes.");
  }
  freshBuildSourceSpec = { source: freshRoot, label: "<fresh-build-source>" };
  freshBuildExpectedSource = materializedSource;
  rejectAncestorCargoConfiguration(repositoryRoot);
  rejectAncestorCargoConfiguration(freshRoot);

  const resolveXcodeTool = (name) => realpathSync(execFileSync(SOURCE_XCRUN_PATH, ["--find", name], {
    env: freshBuildEnvironment({ TMPDIR: freshTemporary }), encoding: "utf8", timeout: remainingReplayTimeout(),
  }).trim());
  const sourceClangPath = resolveXcodeTool("clang");
  const sourceArPath = resolveXcodeTool("ar");
  const sourceLdPath = resolveXcodeTool("ld");
  const sourceRanlibPath = resolveXcodeTool("ranlib");
  const sourceSdkPath = realpathSync(execFileSync(SOURCE_XCRUN_PATH, ["--sdk", "macosx", "--show-sdk-path"], {
    env: freshBuildEnvironment({ TMPDIR: freshTemporary }), encoding: "utf8", timeout: remainingReplayTimeout(),
  }).trim());
  const resolveRustTool = (name, override) => override
    ? resolveExecutable(override)
    : realpathSync(execFileSync(SOURCE_RUSTUP_PATH, ["which", name], {
      env: freshBuildEnvironment({ TMPDIR: freshTemporary }), encoding: "utf8", timeout: remainingReplayTimeout(),
    }).trim());
  const sourceCargoPath = resolveRustTool("cargo", process.env.RELAYER_CARGO_PATH);
  const sourceRustcPath = resolveRustTool("rustc", process.env.RELAYER_RUSTC_PATH);
  const resolvedCompilerSpecs = [
    { source: sourceCargoPath, label: "<build-tool>/cargo" },
    { source: sourceRustcPath, label: "<build-tool>/rustc" },
    { source: sourceClangPath, label: "<build-tool>/clang", allowHardlinks: true },
    { source: sourceArPath, label: "<build-tool>/ar", allowHardlinks: true },
    { source: sourceLdPath, label: "<build-tool>/ld", allowHardlinks: true },
    { source: sourceRanlibPath, label: "<build-tool>/ranlib", allowHardlinks: true },
  ];
  const resolvedCompilers = await inventoryBuildArtifacts(resolvedCompilerSpecs);
  await assertBuildInventory(resolvedCompilerSpecs, resolvedCompilers, "A resolved compiler changed before first use.");
  const sourceRustSysroot = realpathSync(execFileSync(sourceRustcPath, ["--print", "sysroot"], {
    env: freshBuildEnvironment({ TMPDIR: freshTemporary }), encoding: "utf8", timeout: remainingReplayTimeout(),
  }).trim());
  const sourceClangResourceDirectory = realpathSync(execFileSync(sourceClangPath, ["-print-resource-dir"], {
    env: freshBuildEnvironment({ TMPDIR: freshTemporary }), encoding: "utf8", timeout: remainingReplayTimeout(),
  }).trim());

  const buildNativeDependencies = nonSystemMachODependencies([
    sourceCargoPath, sourceRustcPath, sourceClangPath, sourceArPath, sourceLdPath, sourceRanlibPath,
  ]).map(([name, dependency]) => ({
    source: dependency.source,
    label: `<build-tool-dynamic-library>/${name}`,
    allowHardlinks: sealedSystemHardlinkPolicy(dependency.source),
  }));
  const buildToolSpecs = [
    ...bootstrapBuildToolSpecs,
    ...resolvedCompilerSpecs,
    { source: join(sourceRustSysroot, "lib"), label: "<build-tool>/rust-sysroot-lib", recordSymlinks: true },
    { source: sourceClangResourceDirectory, label: "<build-tool>/clang-resource", recordSymlinks: true, allowHardlinks: true },
    { source: sourceSdkPath, label: "<build-tool>/macos-sdk", recordSymlinks: true, allowHardlinks: true },
    { source: "/private/etc/ssl/openssl.cnf", label: "<build-tool>/system-openssl-config" },
    ...buildNativeDependencies,
  ];
  const buildToolInputs = await inventoryBuildArtifacts(buildToolSpecs);
  const sourceJavaScriptDependencySpecs = [
    { source: SOURCE_TYPESCRIPT_PATH, label: "<build-dependency>/typescript" },
    { source: SOURCE_NODE_TYPES_PATH, label: "<build-dependency>/node-types" },
    { source: SOURCE_UNDICI_TYPES_PATH, label: "<build-dependency>/undici-types" },
    { source: join(repositoryRoot, "node_modules", "yaml"), label: "<build-dependency>/yaml" },
    { source: join(repositoryRoot, "node_modules", "@openai", "codex-sdk"), label: "<build-dependency>/codex-sdk" },
  ];
  const sourceJavaScriptInputs = await inventoryBuildArtifacts(sourceJavaScriptDependencySpecs);
  for (const [source, target] of [
    [SOURCE_TYPESCRIPT_PATH, join(buildNodeModules, "typescript")],
    [SOURCE_NODE_TYPES_PATH, join(buildNodeModules, "@types", "node")],
    [SOURCE_UNDICI_TYPES_PATH, join(buildNodeModules, "undici-types")],
    [join(repositoryRoot, "node_modules", "yaml"), join(buildNodeModules, "yaml")],
    [join(repositoryRoot, "node_modules", "@openai", "codex-sdk"), join(buildNodeModules, "@openai", "codex-sdk")],
  ]) {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(source, target, { recursive: true, preserveTimestamps: true });
  }
  const copiedJavaScriptDependencySpecs = [
    { source: join(buildNodeModules, "typescript"), label: "<build-dependency>/typescript" },
    { source: join(buildNodeModules, "@types", "node"), label: "<build-dependency>/node-types" },
    { source: join(buildNodeModules, "undici-types"), label: "<build-dependency>/undici-types" },
    { source: join(buildNodeModules, "yaml"), label: "<build-dependency>/yaml" },
    { source: join(buildNodeModules, "@openai", "codex-sdk"), label: "<build-dependency>/codex-sdk" },
  ];
  const copiedJavaScriptInputs = await inventoryBuildArtifacts(copiedJavaScriptDependencySpecs);
  if (JSON.stringify(copiedJavaScriptInputs) !== JSON.stringify(sourceJavaScriptInputs)) {
    throw new Error("Copied JavaScript build dependencies do not match their inventoried source bytes.");
  }
  await makeTreeReadOnly(freshRoot);
  await verifyFreshBuildSource();

  const tscPath = join(buildNodeModules, "typescript", "lib", "tsc.js");
  const commonSandboxReadPaths = [freshRoot, buildNodeModules, freshVendor, join(freshCargoHome, "config.toml"), freshTemporary,
    sourceRustSysroot, sourceClangResourceDirectory, sourceSdkPath,
    ...buildToolSpecs.map((spec) => spec.source), "/System/Library", "/System/Volumes/Preboot/Cryptexes/OS",
    "/usr/lib", "/dev/null", "/dev/urandom", "/private/var/db/timezone"];
  const sandboxExecutablePaths = [pinnedBuildNode.nodePath, sourceCargoPath, sourceRustcPath, sourceClangPath, sourceArPath, sourceLdPath, sourceRanlibPath,
    "/bin/sh", "/bin/bash", "/usr/bin/env"];
  const writeBuildProfile = async (path, readPaths, writePaths, executableDirectories = []) => writeFile(
    path,
    createPinnedFreshBuildSandboxProfile({
      readPaths: readPaths.map(canonicalSandboxPath),
      writePaths: writePaths.map(canonicalSandboxPath),
      executablePaths: sandboxExecutablePaths.map(canonicalSandboxPath),
      executableDirectories: executableDirectories.map(canonicalSandboxPath),
    }),
    { mode: 0o400 },
  );
  await writeBuildProfile(graphBuildSandboxProfile, commonSandboxReadPaths, [join(freshJavaScriptOutput, "graph-client"), freshTemporary]);
  await writeBuildProfile(harnessBuildSandboxProfile, [...commonSandboxReadPaths, join(freshJavaScriptOutput, "graph-client")], [join(freshJavaScriptOutput, "harness-host"), freshTemporary]);
  await writeBuildProfile(rustBuildSandboxProfile, [...commonSandboxReadPaths, freshRustOutput], [freshRustOutput, freshTemporary, freshCargoHome, "/dev/null"], [freshTarget]);
  const runSandboxed = (profile, executable, args, timeout, environment = {}) => execFileSync(SOURCE_SANDBOX_EXEC_PATH, [
    "-f", profile, executable, ...args,
  ], {
    cwd: freshRoot,
    env: freshBuildEnvironment({
      TMPDIR: freshTemporary,
      DYLD_LIBRARY_PATH: pinnedBuildNode.root,
      OPENSSL_CONF: "/dev/null",
      ...environment,
    }),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: remainingReplayTimeout(timeout),
  });
  const runTsc = async (profile, configuration, outDir, additionalInputSpecs = [], expectedAdditionalInputs = []) => {
    await verifyFreshBuildSource();
    await assertBuildInventory(buildToolSpecs, buildToolInputs, "A fresh-build tool changed before JavaScript compilation.");
    await assertBuildInventory(additionalInputSpecs, expectedAdditionalInputs, "A generated JavaScript build input changed before compilation.");
    await assertBuildInventory(pinnedBuildNode.specs, pinnedBuildNode.expected, "Private Node closure changed before JavaScript compilation.");
    runSandboxed(profile, pinnedBuildNode.nodePath, [
      tscPath, "-p", configuration, "--outDir", outDir,
      "--types", "node", "--typeRoots", join(buildNodeModules, "@types"),
    ], MAJOR_OPERATION_TIMEOUT_MS);
    await verifyFreshBuildSource();
    await assertBuildInventory(buildToolSpecs, buildToolInputs, "A fresh-build tool changed during JavaScript compilation.");
    await assertBuildInventory(pinnedBuildNode.specs, pinnedBuildNode.expected, "Private Node closure changed during JavaScript compilation.");
    await assertBuildInventory(additionalInputSpecs, expectedAdditionalInputs, "A generated JavaScript build input changed during compilation.");
  };
  await runTsc(graphBuildSandboxProfile, "packages/graph-client/tsconfig.build.json", join(freshJavaScriptOutput, "graph-client"));
  const graphClientWorkspace = join(buildNodeModules, "@relayer", "graph-client");
  await mkdir(graphClientWorkspace, { recursive: true, mode: 0o700 });
  await cp(join(freshJavaScriptOutput, "graph-client"), join(graphClientWorkspace, "dist"), { recursive: true });
  await copyFile(join(freshRoot, "packages", "graph-client", "package.json"), join(graphClientWorkspace, "package.json"));
  const generatedGraphClientInputSpecs = [
    { source: join(freshJavaScriptOutput, "graph-client"), label: "<build-phase-output>/graph-client-dist" },
    { source: join(graphClientWorkspace, "dist"), label: "<build-generated-dependency>/graph-client-dist" },
    { source: join(graphClientWorkspace, "package.json"), label: "<build-generated-dependency>/graph-client-package.json" },
  ];
  const generatedGraphClientInputs = await inventoryBuildArtifacts(generatedGraphClientInputSpecs);
  const expectedGeneratedGraphClientInputs = await inventoryBuildArtifacts([
    { source: join(freshJavaScriptOutput, "graph-client"), label: "<build-phase-output>/graph-client-dist" },
    { source: join(freshJavaScriptOutput, "graph-client"), label: "<build-generated-dependency>/graph-client-dist" },
    { source: join(freshRoot, "packages", "graph-client", "package.json"), label: "<build-generated-dependency>/graph-client-package.json" },
  ]);
  if (JSON.stringify(generatedGraphClientInputs) !== JSON.stringify(expectedGeneratedGraphClientInputs)) {
    throw new Error("Copied generated graph-client build inputs do not match authenticated source and output bytes.");
  }
  await runTsc(
    harnessBuildSandboxProfile,
    "packages/harness-host/tsconfig.build.json",
    join(freshJavaScriptOutput, "harness-host"),
    generatedGraphClientInputSpecs,
    generatedGraphClientInputs,
  );

  await mkdir(freshCargoHome, { recursive: true, mode: 0o700 });
  const cargoEnvironment = freshBuildEnvironment({ TMPDIR: freshTemporary, CARGO_HOME: freshCargoHome, RUSTC: sourceRustcPath });
  await assertBuildInventory(buildToolSpecs, buildToolInputs, "A fresh-build tool changed before Cargo dependency resolution.");
  execFileSync(sourceCargoPath, ["fetch", "--locked", "--manifest-path", join(freshRoot, "Cargo.toml")], {
    cwd: freshRoot,
    env: cargoEnvironment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: remainingReplayTimeout(FRESH_BUILD_TIMEOUT_MS),
  });
  const vendorConfiguration = execFileSync(sourceCargoPath, [
    "vendor", "--locked", "--versioned-dirs", "--offline", freshVendor,
  ], {
    cwd: freshRoot,
    env: cargoEnvironment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: remainingReplayTimeout(FRESH_BUILD_TIMEOUT_MS),
  });
  await writeFile(join(freshCargoHome, "config.toml"), vendorConfiguration, { mode: 0o400 });
  const generatedCargoInputSpecs = [
    { source: freshVendor, label: "<build-dependency>/cargo-vendor" },
    { source: join(freshCargoHome, "config.toml"), label: "<build-dependency>/cargo-config.toml" },
    { source: graphBuildSandboxProfile, label: "<build-control>/graph-sandbox-profile" },
    { source: harnessBuildSandboxProfile, label: "<build-control>/harness-sandbox-profile" },
    { source: rustBuildSandboxProfile, label: "<build-control>/rust-sandbox-profile" },
  ];
  const generatedCargoInputs = await inventoryBuildArtifacts(generatedCargoInputSpecs);
  freshBuildInputSpecs = [
    ...buildToolSpecs,
    ...copiedJavaScriptDependencySpecs,
    ...generatedGraphClientInputSpecs,
    ...generatedCargoInputSpecs,
  ];
  freshBuildExpectedInputs = [...buildToolInputs, ...copiedJavaScriptInputs, ...generatedGraphClientInputs, ...generatedCargoInputs]
    .sort((left, right) => left.file.localeCompare(right.file));
  if (existsSync(freshTarget)) throw new Error("Fresh Rust target directory existed before the authenticated build.");
  const completedJavaScriptOutputSpecs = [
    { source: join(freshJavaScriptOutput, "graph-client"), label: "<build-phase-output>/graph-client-dist" },
    { source: join(freshJavaScriptOutput, "harness-host"), label: "<build-phase-output>/harness-host-dist" },
  ];
  const completedJavaScriptOutputs = await inventoryBuildArtifacts(completedJavaScriptOutputSpecs);
  await verifyFreshBuildSource();
  await assertBuildInventory(freshBuildInputSpecs, freshBuildExpectedInputs, "A fresh-build input changed before Rust compilation.");
  const targetEnvironmentKey = `CARGO_TARGET_${process.arch === "arm64" ? "AARCH64" : "X86_64"}_APPLE_DARWIN_LINKER`;
  await assertBuildInventory(completedJavaScriptOutputSpecs, completedJavaScriptOutputs, "JavaScript build outputs changed before Rust compilation.");
  runSandboxed(rustBuildSandboxProfile, sourceCargoPath, [
    "build", "--frozen", "--offline", "-p", "relayer-app-server", "-p", "relayer-graph-server",
    "--target-dir", freshTarget,
  ], FRESH_BUILD_TIMEOUT_MS, {
    ...cargoEnvironment,
    CC: sourceClangPath,
    AR: sourceArPath,
    RANLIB: sourceRanlibPath,
    SDKROOT: sourceSdkPath,
    OPENSSL_CONF: "/dev/null",
    [targetEnvironmentKey]: sourceClangPath,
    RUSTFLAGS: `-C linker=${sourceClangPath} -C link-arg=-fuse-ld=${sourceLdPath} -C link-arg=-isysroot -C link-arg=${sourceSdkPath}`,
  });
  await verifyFreshBuildSource();
  await assertBuildInventory(freshBuildInputSpecs, freshBuildExpectedInputs, "A fresh-build input changed during Rust compilation.");
  await assertBuildInventory(completedJavaScriptOutputSpecs, completedJavaScriptOutputs, "Rust compilation changed a completed JavaScript output.");

  const outputSpecs = [
    { source: join(freshJavaScriptOutput, "graph-client"), label: "packages/graph-client/dist" },
    { source: join(freshJavaScriptOutput, "harness-host"), label: "packages/harness-host/dist" },
    { source: join(freshTarget, "debug", "relayer-app-server"), label: "target/debug/relayer-app-server" },
    { source: join(freshTarget, "debug", "relayer-graph-server"), label: "target/debug/relayer-graph-server" },
  ];
  freshBuildOutputSpecs = outputSpecs;
  const outputs = await inventoryBuildArtifacts(outputSpecs);
  freshBuildRelation = {
    sourceCommit,
    sourceTree: authenticatedBootstrap.sourceTree,
    sourceInventorySha256: createHash("sha256").update(JSON.stringify(committedSource)).digest("hex"),
    copiedExternalInputsMatchInventoriedSources: true,
    externalInputs: freshBuildExpectedInputs,
    outputs,
  };
  configureFreshRuntimeArtifactSpecs(freshRoot, freshTarget, freshJavaScriptOutput);
  return { freshRoot, freshTarget };
}

async function verifyFreshBuildRelation() {
  await verifyFreshBuildSource();
  const [inputs, outputs] = await Promise.all([
    inventoryBuildArtifacts(freshBuildInputSpecs),
    inventoryBuildArtifacts(freshBuildOutputSpecs),
  ]);
  if (JSON.stringify(inputs) !== JSON.stringify(freshBuildExpectedInputs)
    || JSON.stringify(outputs) !== JSON.stringify(freshBuildRelation?.outputs)) {
    throw new Error("Fresh build inputs or outputs changed after the authenticated build relation was recorded.");
  }
}

async function prepareProviderWrapperSource(snapshotRoot) {
  const nodePath = join(snapshotRoot, "node");
  const codexPath = join(snapshotRoot, "codex");
  await writeFile(providerWrapperSource, createPinnedProviderWrapperScript({
    nodePath,
    codexPath,
    pidFile: providerPidFile,
  }));
  await chmod(providerWrapperSource, 0o700);
}

async function prepareGraphAuthoringLauncherSource(snapshotRoot) {
  const canonicalSnapshotRoot = join(realpathSync(dirname(snapshotRoot)), basename(snapshotRoot));
  await writeFile(graphAuthoringNetworkProfileSource, createPinnedGraphAuthoringNetworkProfile(), { mode: 0o600 });
  await writeFile(graphAuthoringLauncherSource, createPinnedGraphAuthoringLauncherScript({
    nodePath: join(canonicalSnapshotRoot, "node"),
    graphClientRoot: join(canonicalSnapshotRoot, "node_modules", "@relayer", "graph-client"),
    sandboxExecPath: SOURCE_SANDBOX_EXEC_PATH,
    networkProfilePath: join(canonicalSnapshotRoot, "graph-authoring-network.sb"),
  }));
  await chmod(graphAuthoringLauncherSource, 0o700);
}

async function prepareIsolatedCodexHome() {
  const sourceAuth = join(sourceCodexHome, "auth.json");
  if (!existsSync(sourceAuth)) throw new Error(`Connected Codex authentication was not found at ${sourceAuth}.`);
  await mkdir(isolatedCodexHome, { recursive: true, mode: 0o700 });
  const targetAuth = join(isolatedCodexHome, "auth.json");
  await copyFile(sourceAuth, targetAuth);
  await chmod(targetAuth, 0o600);
  const rulesDirectory = join(isolatedCodexHome, "rules");
  await mkdir(rulesDirectory, { recursive: true, mode: 0o700 });
  const graphAuthoringRules = join(rulesDirectory, "graph-authoring.rules");
  await writeFile(graphAuthoringRules, createPinnedGraphAuthoringExecPolicy(graphAuthoringLauncher), { mode: 0o600 });
  process.env.CODEX_HOME = isolatedCodexHome;
  process.env.RELAYER_CODEX_HOME = isolatedCodexHome;
}

function sanitizeEvidence(value) {
  if (typeof value === "string") {
    return value
      .replaceAll(repositoryRoot, "<repository>")
      .replaceAll(dataDirectory, "<disposable-runtime>")
      .replaceAll(projectDirectory, "<disposable-project>")
      .replaceAll(markerDirectory, "<protected-marker-root>");
  }
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeEvidence(entry)]));
  }
  return value;
}

async function artifactInventory(directory, relative = "", excludePublicationMetadata = true) {
  const label = "<artifact-root>";
  const artifacts = await inventoryRegularArtifactTree({ root: join(directory, relative), label });
  return artifacts.map((artifact) => ({
    ...artifact,
    file: join(relative, artifact.file.slice(`${label}/`.length)),
  })).filter((artifact) => (
    !excludePublicationMetadata || !["README.md", "manifest.json", "manifest.sha256"].includes(artifact.file)
  )).sort((left, right) => left.file.localeCompare(right.file));
}

async function pinArtifact(path) {
  return pinValidatedBytes(path, await readFile(path));
}

async function pinValidatedBytes(path, content) {
  const relativePath = relative(outputDirectory, path);
  if (relativePath.startsWith("..") || relativePath === "") throw new Error(`Cannot pin artifact outside the evidence stage: ${path}`);
  const artifact = {
    file: relativePath,
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  const existing = validatedArtifacts.get(relativePath);
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(artifact)) {
    throw new Error(`Validated artifact changed after its semantic check: ${relativePath}`);
  }
  validatedArtifacts.set(relativePath, artifact);
}

async function pinArtifactTree(directory) {
  for (const artifact of await artifactInventory(directory, "", false)) {
    await pinArtifact(join(directory, artifact.file));
  }
}

async function runtimeArtifactInventory(specs = activeRuntimeArtifactSpecs) {
  const artifacts = [];
  for (const spec of specs) {
    const discovered = await inventoryRegularArtifactTree({
      root: spec.source,
      label: spec.label,
      // macOS framework bundles intentionally use internal version symlinks. They
      // are never exposed to graph-authored code and must remain inside Contents;
      // their resolved regular files still require a single filesystem link.
      allowContainedSymlinks: spec.key === "electron",
      allowHardlinks: spec.allowHardlinks === true,
      allowExternalCopySourceHardlinks: spec.allowExternalCopySourceHardlinks === true,
    });
    if (spec.discoveredSha256 !== undefined
      && (discovered.length !== 1 || discovered[0].sha256 !== spec.discoveredSha256)) {
      throw new Error(`Discovered native dependency changed before inventory: ${spec.label}`);
    }
    artifacts.push(...discovered);
  }
  return artifacts.sort((left, right) => left.file.localeCompare(right.file));
}

function verifyRuntimeProvenancePolicy(specs = sourceRuntimeArtifactSpecs) {
  const supported = new Set(["commit", "fresh-build", "generated", "external", "authenticated-bootstrap"]);
  for (const spec of specs) {
    if (!supported.has(spec.provenance)
      || (spec.provenance === "commit") !== (typeof spec.revisionPath === "string")) {
      throw new Error(`Runtime artifact lacks an explicit provenance policy: ${spec.label}`);
    }
  }
}

function rejectMutableTrackedIndexFlags(specs = sourceRuntimeArtifactSpecs) {
  const revisionPaths = specs.filter((spec) => spec.provenance === "commit").map((spec) => spec.revisionPath);
  verifyRepositoryGitAuthority({
    gitPath: SOURCE_GIT_PATH,
    repositoryRoot,
    revisionPaths,
    timeoutMs: remainingReplayTimeout(),
  });
}

async function verifyTrackedRuntimeArtifactsMatchRevision(specs = sourceRuntimeArtifactSpecs) {
  verifyRuntimeProvenancePolicy(specs);
  rejectMutableRepositoryAuthority(SOURCE_GIT_PATH, repositoryRoot);
  rejectMutableTrackedIndexFlags(specs);
  for (const spec of specs.filter((candidate) => candidate.provenance === "commit")) {
    const committed = readCommittedGitInventory({
      gitPath: SOURCE_GIT_PATH,
      repositoryRoot,
      commit: sourceCommit,
      path: spec.revisionPath,
      label: spec.label,
      timeoutMs: remainingReplayTimeout(),
    });
    const actual = await runtimeArtifactInventory([spec]);
    if (JSON.stringify(actual) !== JSON.stringify(committed)) {
      throw new Error(`Tracked runtime artifact does not exactly match authenticated commit bytes: ${spec.label}`);
    }
  }
}

function verifySnapshottedMachOClosure(specs, snapshotRoot) {
  const rootKeys = new Set([
    "ffmpeg", "ffprobe", "node", "git", "sandbox-exec", "sed", "rg", "codex",
    "codex-code-mode-host", "app-server", "graph-server",
  ]);
  const roots = specs.filter((spec) => rootKeys.has(spec.key)).map((spec) => spec.source);
  const observed = nonSystemMachODependencies(roots, snapshotRoot).map(([name, dependency]) => ({ name, sha256: dependency.sha256 }));
  const expected = dynamicRuntimeDependencies.map(([name, dependency]) => ({ name, sha256: dependency.sha256 }));
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(`Snapshotted Mach-O dependency closure differs from authenticated discovery: ${JSON.stringify({ expected, observed })}`);
  }
}

async function prepareImmutableRuntime(sourceInventory) {
  const snapshotRoot = join(dataDirectory, "runtime-snapshot");
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  const specs = [];
  for (const sourceSpec of sourceRuntimeArtifactSpecs) {
    if (!sourceSpec.copy) {
      specs.push({ ...sourceSpec, source: sourceSpec.executedSource ?? sourceSpec.source });
      continue;
    }
    const target = join(snapshotRoot, sourceSpec.target ?? sourceSpec.key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const details = await lstat(sourceSpec.source);
    if (details.isSymbolicLink()) {
      throw new Error(`Runtime source root cannot be a symbolic link: ${sourceSpec.source}`);
    }
    if (details.isDirectory()) {
      await cp(sourceSpec.source, target, { recursive: true, preserveTimestamps: true });
      await captureReadOnlyDirectoryAuthorities(target, runtimeSnapshotReadOnlyDirectoryAuthorities);
    } else if (details.isFile()) {
      await copyFile(sourceSpec.source, target);
      await chmod(target, details.mode & 0o777);
    } else {
      throw new Error(`Runtime source is not a regular file or directory: ${sourceSpec.source}`);
    }
    specs.push({ ...sourceSpec, source: target, allowHardlinks: false, allowExternalCopySourceHardlinks: false });
  }
  const snapshotInventory = await runtimeArtifactInventory(specs);
  if (JSON.stringify(sourceInventory) !== JSON.stringify(snapshotInventory)) {
    throw new Error("Immutable runtime copies do not match their inventoried source bytes.");
  }
  verifySnapshottedMachOClosure(specs, snapshotRoot);
  activeRuntimeArtifactSpecs = specs;
  CODEX_EXECUTABLE = specs.find((spec) => spec.key === "codex").source;
  FFMPEG_PATH = specs.find((spec) => spec.key === "ffmpeg").source;
  FFPROBE_PATH = specs.find((spec) => spec.key === "ffprobe").source;
  NODE_PATH = specs.find((spec) => spec.key === "node").source;
  GIT_PATH = specs.find((spec) => spec.key === "git").source;
  SANDBOX_EXEC_PATH = specs.find((spec) => spec.key === "sandbox-exec").source;
  SED_PATH = specs.find((spec) => spec.key === "sed").source;
  providerWrapper = specs.find((spec) => spec.key === "codex-provider-wrapper").source;
  graphAuthoringLauncher = specs.find((spec) => spec.key === "graph-authoring-launcher").source;
  graphAuthoringNetworkProfile = specs.find((spec) => spec.key === "graph-authoring-network-profile").source;
  RG_PATH = specs.find((spec) => spec.key === "rg").source;
  process.env.RELAYER_CODEX_BINARY = CODEX_EXECUTABLE;
  process.env.CODEX_CODE_MODE_HOST_PATH = specs.find((spec) => spec.key === "codex-code-mode-host").source;
  process.env.DYLD_LIBRARY_PATH = snapshotRoot;
  process.env.PATH = [snapshotRoot, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
  delete process.env.RIPGREP_CONFIG_PATH;
  appServerBinary = specs.find((spec) => spec.key === "app-server").source;
  graphServerBinary = specs.find((spec) => spec.key === "graph-server").source;
  desktopDirectory = specs.find((spec) => spec.key === "desktop").source;
  permissionCatalogPath = join(specs.find((spec) => spec.key === "permissions").source, "desktop.json");
  harnessConfigurationPath = join(specs.find((spec) => spec.key === "harnesses").source, "codex-basic.yaml");
  graphClientModuleUrl = pathToFileURL(join(realpathSync(specs.find((spec) => spec.key === "graph-client-dist").source), "index.js")).href;
  harnessHostModuleUrl = pathToFileURL(join(specs.find((spec) => spec.key === "harness-host-dist").source, "index.js")).href;
  return { sourceRuntimeArtifacts: sourceInventory, runtimeArtifacts: snapshotInventory };
}

async function captureReadOnlyDirectoryAuthorities(path, authorities) {
  const details = await lstat(path, { bigint: true });
  if (details.isSymbolicLink()) return;
  if (!details.isDirectory()) return;
  for (const name of await readdir(path)) {
    await captureReadOnlyDirectoryAuthorities(join(path, name), authorities);
  }
  if ((details.mode & 0o200n) !== 0n) return;
  const canonicalPath = join(realpathSync(dirname(path)), basename(path));
  if (realpathSync(path) !== canonicalPath) {
    throw new Error(`Runtime snapshot directory changed while cleanup authority was recorded: ${path}`);
  }
  authorities.push({ path, dev: details.dev, ino: details.ino });
}

async function loadImmutableDesktopModules() {
  const moduleUrl = (path) => pathToFileURL(join(desktopDirectory, path)).href;
  ({ CodexCredentialAdapter } = await import(moduleUrl("main/credentials/codex-credential-adapter.mjs")));
  ({ CodexModelCatalogAdapter } = await import(moduleUrl("main/models/codex-model-catalog-adapter.mjs")));
  ({ startModelCatalogRefreshServer } = await import(moduleUrl("main/models/model-catalog-refresh-server.mjs")));
  ({ ModelCatalogService } = await import(moduleUrl("main/models/model-catalog-service.mjs")));
  ({ GraphCompleteRuntimeService } = await import(moduleUrl("main/services/graphcomplete-runtime.mjs")));
  ({ RelayerAppServerService } = await import(moduleUrl("main/services/relayer-app-server.mjs")));
  ({ createWindowFactory } = await import(moduleUrl("main/window.mjs")));
  ({ redactTraceData: redactRuntimeTraceData } = await import(pathToFileURL(join(
    dirname(fileURLToPath(harnessHostModuleUrl)),
    "trace.js",
  )).href));
}

async function verifyRuntimeArtifacts(expectedArtifacts) {
  const actualArtifacts = await runtimeArtifactInventory();
  if (JSON.stringify(actualArtifacts) !== JSON.stringify(expectedArtifacts)) {
    throw new Error("Executed runtime artifacts changed during Ask-profile evidence capture.");
  }
}

async function verifySourceRuntimeArtifacts(expectedArtifacts) {
  const actualArtifacts = await runtimeArtifactInventory(sourceRuntimeArtifactSpecs);
  if (JSON.stringify(actualArtifacts) !== JSON.stringify(expectedArtifacts)) {
    throw new Error("Original runtime source artifacts changed during Ask-profile evidence capture.");
  }
}

async function publishEvidence(
  manifestText,
  manifestChecksum,
  expectedArtifacts,
  expectedReadme,
  expectedSourceRuntimeArtifacts,
  expectedRuntimeArtifacts,
) {
  const backup = `${publishedDirectory}.previous-${process.pid}`;
  let oldMoved = false;
  let newMoved = false;
  try {
    ensureActive();
    await writeFile(join(outputDirectory, "README.md"), expectedReadme);
    ensureActive();
    await verifyStagedEvidence(manifestText, manifestChecksum, expectedArtifacts, expectedReadme);
    ensureActive();
    await verifyRuntimeArtifacts(expectedRuntimeArtifacts);
    ensureActive();
    await verifySourceRuntimeArtifacts(expectedSourceRuntimeArtifacts);
    ensureActive();
    verifyExecutedBootstrapControls();
    ensureActive();
    verifySourceRevision();
    ensureActive();
    await rename(publishedDirectory, backup);
    oldMoved = true;
    ensureActive();
    await rename(outputDirectory, publishedDirectory);
    newMoved = true;
    ensureActive();
    publicationCommitted = true;
  } catch (error) {
    if (newMoved) await rename(publishedDirectory, outputDirectory);
    if (oldMoved) await rename(backup, publishedDirectory);
    throw error;
  }
  const backupRemoval = rm(backup, { recursive: true, force: true });
  await Promise.race([backupRemoval, terminationRequested]);
  ensureActive();
  await backupRemoval;
}

async function verifyStagedEvidence(manifestText, manifestChecksum, expectedArtifacts, expectedReadme) {
  const actualArtifacts = await artifactInventory(outputDirectory);
  if (JSON.stringify(actualArtifacts) !== JSON.stringify(expectedArtifacts)) {
    throw new Error("Staged Ask-profile artifacts changed after manifest inventory.");
  }
  const [actualManifest, actualChecksum, actualReadme] = await Promise.all([
    readFile(join(outputDirectory, "manifest.json"), "utf8"),
    readFile(join(outputDirectory, "manifest.sha256"), "utf8"),
    readFile(join(outputDirectory, "README.md"), "utf8"),
  ]);
  if (actualManifest !== manifestText
    || actualChecksum !== `${manifestChecksum}  manifest.json\n`
    || actualReadme !== expectedReadme) {
    throw new Error("Staged Ask-profile README, manifest, or checksum changed before publication.");
  }
}

function verifySourceRevision() {
  rejectMutableRepositoryAuthority(SOURCE_GIT_PATH, repositoryRoot);
  const currentCommit = execFileSync(SOURCE_GIT_PATH, fixedGitArguments(repositoryRoot, ["rev-parse", "HEAD"]), {
    cwd: repositoryRoot,
    env: fixedGitEnvironment(),
    encoding: "utf8",
    timeout: remainingReplayTimeout(),
  }).trim();
  const stagingRelativePath = relative(repositoryRoot, outputDirectory);
  const sourceStatus = execFileSync(SOURCE_GIT_PATH, fixedGitArguments(repositoryRoot, [
    "status", "--porcelain", "--untracked-files=all", "--", ".",
    `:(exclude,literal)${stagingRelativePath}`,
  ]), {
    cwd: repositoryRoot,
    env: fixedGitEnvironment(),
    encoding: "utf8",
    timeout: remainingReplayTimeout(),
  }).trim();
  if (currentCommit !== sourceCommit || sourceStatus !== "") {
    throw new Error(`Source changed during Ask-profile evidence capture: ${JSON.stringify({ sourceCommit, currentCommit, sourceStatus })}`);
  }
}

async function verifySourceInventoryMatchesRevision(expectedArtifacts) {
  verifySourceRevision();
  await verifyFreshBuildRelation();
  await verifyTrackedRuntimeArtifactsMatchRevision(sourceRuntimeArtifactSpecs);
  await verifyTrackedRuntimeArtifactsMatchRevision(activeRuntimeArtifactSpecs);
  return verifySourceRuntimeArtifacts(expectedArtifacts);
}

async function closeServices() {
  const errors = [];
  while (services.length > 0) {
    const service = services.pop();
    try {
      await service.close?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Evidence services did not close cleanly.");
}

function marker(name) {
  return join(markerDirectory, name);
}

function protectedPrompt(path, content, context) {
  return `First use the apply_patch tool exactly once to add the new file ${path} with entire exact content ${JSON.stringify(`${content}\n`)}. The file does not exist yet. Do not use the shell, another file, or another editing tool. Do not simulate the edit. If permission is denied or the request is cancelled, do not retry or use an alternative. For source inspection, invoke only the exact executables ${JSON.stringify(SED_PATH)} for sed and ${JSON.stringify(RG_PATH)} for ripgrep; never resolve sed or rg from PATH. Then author and submit a useful graph explaining the observed outcome. ${context}`;
}

async function markerText(path) {
  return existsSync(path) ? readFile(path, "utf8") : null;
}

async function decideAndAccept(session, threadId, interaction, selector, label, beforeDecision = async () => undefined) {
  const before = await waitForOpenApproval(session, threadId, interaction.id, label);
  await capture(`${label}-waiting`, [
    "ordinary ProductWorkspace",
    "bottom approval dock",
    "exact action, location, and session scope",
    "prior graph remains visible while waiting",
  ], before.receipt);
  await beforeDecision(before);
  await click(selector);
  const after = await waitForThread(
    session,
    threadId,
    (detail) => detail.interactions.find((item) => String(item.id) === String(interaction.id))?.completionStatus === "accepted",
    `${label} genuine graph completion`,
  );
  const resolved = after.approvals.find((receipt) => receipt.request.requestId === before.dock.requestId);
  if (!resolved?.resolution) throw new Error(`${label} did not record a terminal approval receipt.`);
  observations.push({ label, interactionId: interaction.id, dock: before.dock, receipt: resolved });
  return { before, after, resolved };
}

function normalizedTracePath(path) {
  return resolve(path)
    .replace(/^\/Users\/[^/]+(?=\/)/, "/Users/[redacted]")
    .replace(/^\/home\/[^/]+(?=\/)/, "/home/[redacted]");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function expectedFileScopeKey(path) {
  return `codex:file:v1:sha256:${createHash("sha256").update(canonicalJson({ path, kind: { type: "add" } })).digest("hex")}`;
}

async function exportTrace(interaction, threadId, label, protectedPath, expectedTraceStatus = "complete", expectedTerminalStatus, expectedContent, receipt) {
  const target = join(traceDirectory, label);
  const descriptor = await runtime.exportCandidateTrace(interaction.id, target, {
    runId: `issue-85-${label}`,
    executionId: `thread-${threadId}`,
    interactionId: String(interaction.id),
    harnessConfigurationName: "codex-basic",
    model: MODEL_ID,
  });
  if (descriptor.status !== expectedTraceStatus
    || descriptor.truncated === true
    || (expectedTraceStatus === "complete"
      && (descriptor.coverage?.modelCalls !== "full" || descriptor.coverage?.toolCalls !== "full"))) {
    throw new Error(`Trace ${label} is incomplete or truncated: ${JSON.stringify(descriptor)}`);
  }
  const eventsPath = join(target, "events.jsonl");
  const eventsText = await readFile(eventsPath, "utf8");
  const events = eventsText.trim().split("\n").map((line) => JSON.parse(line));
  try {
    const rawInspectionRoot = dirname(dirname(fileURLToPath(graphClientModuleUrl)));
    const redactedInspectionRoot = redactRuntimeTraceData(rawInspectionRoot);
    const redactedSedExecutable = redactRuntimeTraceData(SED_PATH);
    const redactedRipgrepExecutable = redactRuntimeTraceData(RG_PATH);
    const redactedGraphAuthoringLauncher = redactRuntimeTraceData(graphAuthoringLauncher);
    if (typeof redactedInspectionRoot !== "string") throw new Error("Runtime trace redactor did not preserve the inspection root as text.");
    if (typeof redactedSedExecutable !== "string") throw new Error("Runtime trace redactor did not preserve the sed executable as text.");
    if (typeof redactedRipgrepExecutable !== "string") throw new Error("Runtime trace redactor did not preserve the ripgrep executable as text.");
    if (typeof redactedGraphAuthoringLauncher !== "string") throw new Error("Runtime trace redactor did not preserve the graph-authoring launcher as text.");
    validatePinnedGraphAuthoringCommands(events, {
      allowedInspectionRoots: [redactedInspectionRoot],
      allowedInspectionRawRoots: [rawInspectionRoot],
      allowedGraphAuthoringLauncher: redactedGraphAuthoringLauncher,
      allowedGraphAuthoringLauncherSha256: createHash("sha256").update(graphAuthoringLauncher).digest("hex"),
      allowedSedExecutable: redactedSedExecutable,
      allowedSedExecutableSha256: createHash("sha256").update(SED_PATH).digest("hex"),
      allowedRipgrepExecutable: redactedRipgrepExecutable,
      allowedRipgrepExecutableSha256: createHash("sha256").update(RG_PATH).digest("hex"),
      requirePinnedGraph: expectedTraceStatus === "complete",
      requireCommandCompletions: expectedTraceStatus === "complete",
    });
  } catch (error) {
      const commands = events.filter((event) => (
        event.type === "provider.event"
        && event.data?.method === "item/started"
        && event.data?.params?.item?.type === "commandExecution"
      )).map((event) => sanitizeEvidence({
        command: event.data.params.item.command,
        commandActions: event.data.params.item.commandActions,
      }));
      const validationDetail = error instanceof Error ? error.message : String(error);
    throw new Error(`Trace ${label} used an unauthorized command (${validationDetail}): ${JSON.stringify(commands)}`, { cause: error });
  }
  const providerModelEvents = events.filter((event) => (
    event.type === "provider.event"
    && event.data?.method === "thread/settings/updated"
  ));
  if (providerModelEvents.length < 1
    || providerModelEvents.some((event) => event.data?.params?.threadSettings?.model !== MODEL_ID)) {
    throw new Error(`Trace ${label} does not report the expected provider model ${MODEL_ID}.`);
  }
  await pinValidatedBytes(eventsPath, Buffer.from(eventsText));
  if (protectedPath === undefined) {
    await pinArtifactTree(target);
    return undefined;
  }
  const expectedPath = normalizedTracePath(protectedPath);
  const providerEvents = events.filter((event) => (
    event.type === "provider.event"
    && event.data?.method === "item/started"
    && event.data?.params?.item?.type === "fileChange"
    && event.data.params.item.changes?.some((change) => (
      typeof change.path === "string" && normalizedTracePath(change.path) === expectedPath
    ))
  ));
  const providerEvent = providerEvents[0];
  const providerItemId = providerEvent?.data?.params?.item?.id;
  if (providerEvents.length !== 1 || typeof providerItemId !== "string" || providerItemId.length === 0) {
    throw new Error(`Trace ${label} does not correlate the approval to its provider file-change item.`);
  }
  const providerChanges = providerEvent.data.params.item.changes;
  const expectedAction = {
    kind: "file_change",
    action: "Apply the proposed Codex patch",
    workingDirectory: projectDirectory,
    affectedFiles: [protectedPath],
  };
  if (typeof expectedContent !== "string"
    || providerChanges.length !== 1
    || normalizedTracePath(providerChanges[0]?.path) !== expectedPath
    || JSON.stringify(providerChanges[0]?.kind) !== JSON.stringify({ type: "add" })
    || providerChanges[0]?.diff !== expectedContent
    || receipt?.request?.title !== "Apply file change"
    || receipt.request.reason !== "Codex needs approval to apply the proposed file changes."
    || JSON.stringify(receipt.request.action) !== JSON.stringify(expectedAction)
    || JSON.stringify(receipt.request.scopeKeys) !== JSON.stringify([expectedFileScopeKey(protectedPath)])
    || receipt.request.scopeDescription !== `Apply changes to ${protectedPath} in this Codex session.`) {
    throw new Error(`Trace ${label} provider change does not exactly match its normalized approval and prompt.`);
  }
  const terminalProviderEvents = events.filter((event) => (
    event.sequence > providerEvent.sequence
    && event.type === "provider.event"
    && event.data?.method === "item/completed"
    && event.data?.params?.item?.type === "fileChange"
    && event.data?.params?.item?.id === providerItemId
  ));
  const terminalProviderEvent = terminalProviderEvents[0];
  if ((expectedTerminalStatus === undefined && terminalProviderEvents.length !== 0)
    || (expectedTerminalStatus !== undefined
      && (terminalProviderEvents.length !== 1 || terminalProviderEvent?.data?.params?.item?.status !== expectedTerminalStatus))) {
    throw new Error(`Trace ${label} does not contain the terminal provider file-change item.`);
  }
  await pinArtifactTree(target);
  return {
    providerItemId,
    trace: `traces/${label}/events.jsonl`,
    sequence: providerEvent.sequence,
    ...(terminalProviderEvent === undefined ? {} : { terminalSequence: terminalProviderEvent.sequence }),
  };
}

async function failedTraceDiagnostics(interaction, threadId, label) {
  const target = join(outputDirectory, `.failed-${label}-trace`);
  const descriptor = await runtime.exportCandidateTrace(interaction.id, target, {
    runId: `issue-85-${label}-failure`,
    executionId: `thread-${threadId}`,
    interactionId: String(interaction.id),
    harnessConfigurationName: "codex-basic",
    model: MODEL_ID,
  });
  const events = (await readFile(join(target, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const relevantEvents = events.filter((event) => {
    const item = event.data?.params?.item;
    return event.type === "run.failed"
      || (event.type === "provider.event" && event.data?.method === "turn/failed")
      || (event.type === "provider.event"
        && event.data?.method === "item/completed"
        && ["commandExecution", "agentMessage"].includes(item?.type));
  });
  const commandEvents = relevantEvents.filter((event) => event.data?.params?.item?.type === "commandExecution").slice(-8);
  const messageEvents = relevantEvents.filter((event) => event.data?.params?.item?.type === "agentMessage").slice(-8);
  const terminalEvents = relevantEvents.filter((event) => !["commandExecution", "agentMessage"].includes(event.data?.params?.item?.type)).slice(-4);
  const relevant = [...commandEvents, ...messageEvents, ...terminalEvents].map((event) => {
    const item = event.data?.params?.item;
    return sanitizeEvidence({
      sequence: event.sequence,
      type: event.type,
      method: event.data?.method,
      message: event.data?.message ?? event.data?.params?.error?.message,
      item: item === undefined ? undefined : {
        type: item.type,
        status: item.status,
        exitCode: item.exitCode,
        commandActions: item.commandActions,
        aggregatedOutput: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.slice(-4_096) : item.aggregatedOutput,
        text: item.type === "agentMessage" ? item.text : undefined,
      },
    });
  });
  return { descriptor, relevant };
}

async function run() {
  const observedSourceCommit = cleanSourceRevision(SOURCE_GIT_PATH, repositoryRoot, [outputDirectory]);
  if (observedSourceCommit !== sourceCommit) {
    throw new Error(`Authenticated source revision changed before immutable runtime preparation: ${JSON.stringify({ sourceCommit, observedSourceCommit })}`);
  }
  verifyExecutedBootstrapControls();
  await prepareFreshBuiltRuntime();
  const snapshotRoot = join(dataDirectory, "runtime-snapshot");
  await prepareProviderWrapperSource(snapshotRoot);
  await prepareGraphAuthoringLauncherSource(snapshotRoot);
  await verifyFreshBuildRelation();
  await verifyTrackedRuntimeArtifactsMatchRevision(sourceRuntimeArtifactSpecs);
  const capturedSourceRuntimeArtifacts = await abortableEvidenceOperation(
    "source runtime inventory",
    () => runtimeArtifactInventory(sourceRuntimeArtifactSpecs),
    MAJOR_OPERATION_TIMEOUT_MS,
  );
  const { sourceRuntimeArtifacts, runtimeArtifacts } = await abortableEvidenceOperation(
    "immutable runtime preparation",
    () => prepareImmutableRuntime(capturedSourceRuntimeArtifacts),
    MAJOR_OPERATION_TIMEOUT_MS,
  );
  ensureActive();
  await abortableEvidenceOperation(
    "immutable desktop module loading",
    () => loadImmutableDesktopModules(),
    LOCAL_OPERATION_TIMEOUT_MS,
  );
  ensureActive();
  if (JSON.stringify(sourceRuntimeArtifacts) !== JSON.stringify(capturedSourceRuntimeArtifacts)) {
    throw new Error("Immutable runtime preparation did not retain the pre-copy source inventory authority.");
  }
  verifyExecutedBootstrapControls();
  ensureActive();
  const encoderInventory = await runMediaTool(FFMPEG_PATH, ["-hide_banner", "-encoders"]);
  ensureActive();
  if (!/(^|\s)libx264(\s|$)/m.test(`${encoderInventory.stdout}\n${encoderInventory.stderr}`)) {
    throw new Error(`The configured ffmpeg binary does not provide the required libx264 encoder: ${FFMPEG_PATH}`);
  }
  await runMediaTool(FFPROBE_PATH, ["-version"]);
  ensureActive();
  await abortableEvidenceOperation(
    "isolated Codex credential preparation",
    () => prepareIsolatedCodexHome(),
    LOCAL_OPERATION_TIMEOUT_MS,
  );
  ensureActive();
  await mkdir(projectDirectory, { recursive: true });
  ensureActive();
  await mkdir(frameDirectory, { recursive: true });
  ensureActive();
  await mkdir(traceDirectory, { recursive: true });
  ensureActive();
  await mkdir(markerDirectory, { recursive: true });
  ensureActive();
  await writeFile(join(projectDirectory, "README.md"), "# Disposable Ask-profile evidence project\n");
  ensureActive();

  registerEvidenceIpc();
  const credentials = new CodexCredentialAdapter();
  services.push(credentials);
  runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary,
    configurationPaths: [harnessConfigurationPath],
    codexBasicClientModuleUrl: graphClientModuleUrl,
    graphAuthoringLauncherPath: graphAuthoringLauncher,
    codexPathOverride: providerWrapper,
    harnessHostModuleUrl,
    candidateTrace: {
      directory: join(dataDirectory, "candidate-trace-spool"),
      policy: {
        mode: "required",
        requiredFeatures: { modelCalls: "full", toolCalls: "full" },
        includeNativeArtifacts: false,
        maxBytesPerTurn: 10 * 1024 * 1024,
        maxEventsPerTurn: 50_000,
      },
    },
  });
  const runtimeStart = runtime.start();
  services.push({
    close: async () => {
      try { await runtimeStart; } catch {}
      await runtime.close();
    },
  });
  runtimeSession = await abortableEvidenceOperation(
    "GraphComplete runtime startup",
    () => runtimeStart,
    MAJOR_OPERATION_TIMEOUT_MS,
    () => runtime.close(),
  );
  ensureActive();
  let product;
  const modelCatalog = new ModelCatalogService({
    adapters: [new CodexModelCatalogAdapter({ credentials })],
    publishSnapshot: (snapshot, options) => product.publishProviderCatalog(snapshot, options),
  });
  const refreshServer = await abortableEvidenceOperation(
    "model catalog refresh server startup",
    () => startModelCatalogRefreshServer({
      refresh: (options) => modelCatalog.beforeInference(options),
    }),
    LOCAL_OPERATION_TIMEOUT_MS,
  );
  if (terminationSignal) {
    await refreshServer.close();
    ensureActive();
  }
  services.push(refreshServer);
  product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: appServerBinary,
    webDirectory: join(desktopDirectory, "renderer"),
    permissionCatalogPath,
    runtimeSession,
    providerCatalogRefreshSession: refreshServer.session,
    defaultHarnessConfiguration: "codex-basic",
    exportProducer: {
      desktopVersion: sourceVersions.desktop,
      buildCommit: sourceCommit,
      platform: process.platform,
      architecture: process.arch,
    },
  });
  services.push(product);
  const productSession = await abortableEvidenceOperation(
    "product server startup",
    () => product.start(),
    MAJOR_OPERATION_TIMEOUT_MS,
    () => product.close(),
  );
  ensureActive();
  const [catalog] = await abortableEvidenceOperation(
    "model catalog startup",
    () => modelCatalog.startup(),
    LOCAL_OPERATION_TIMEOUT_MS,
  );
  ensureActive();
  if (catalog.provider.status !== "available") throw new Error("A connected local Codex account is required.");

  const settings = await productRequest(productSession, "/api/model-settings");
  const family = settings.families.find((candidate) => candidate.members.some((member) => (
    member.providerId === "codex" && member.modelId === MODEL_ID
  )));
  if (!family) throw new Error(`The live Codex catalog does not expose ${MODEL_ID}.`);

  const createWindow = createWindowFactory({
    BrowserWindow,
    desktopDirectory,
    getAppearance: () => "dark",
    updater: { status: () => ({ phase: "development" }) },
    onWindowCreated: (window) => { mainWindow = window; },
  });
  mainWindow = await abortableEvidenceOperation(
    "ProductWorkspace window initialization",
    () => createWindow(productSession),
    LOCAL_OPERATION_TIMEOUT_MS,
    () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.stop();
        mainWindow.destroy();
      }
    },
  );
  ensureActive();
  mainWindow.setSize(1420, 900);
  mainWindow.show();
  mainWindow.focus();
  await recordFrames();

  const project = await productRequest(productSession, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ path: projectDirectory, name: "Issue 85 Ask-profile evidence" }),
  });
  const created = await productRequest(productSession, "/api/threads", {
    method: "POST",
    body: JSON.stringify({
      title: "Live Ask-profile evidence",
      projectId: project.id,
      initialMessage: `Author and submit a small graph that states this is the baseline before any protected action. If source inspection needs ripgrep, invoke only the exact executable ${JSON.stringify(RG_PATH)}; never resolve rg from PATH.`,
      permissionProfileId: "ask",
      modelSelection: { familyId: family.id, providerId: "codex", modelId: MODEL_ID },
    }),
  });
  const threadId = created.id;
  let baseline;
  try {
    baseline = await waitForThread(
      productSession,
      threadId,
      (detail) => {
        const interaction = detail.interactions[0];
        if (interaction?.completionStatus === "accepted") return detail;
        if (["failed", "stopped"].includes(interaction?.completionStatus)) {
          throw new Error(`Baseline interaction ended ${interaction.completionStatus}: ${JSON.stringify(interaction)}`);
        }
        return false;
      },
      "baseline accepted graph",
    );
  } catch (error) {
    const detail = await threadDetail(productSession, threadId);
    const interaction = detail.interactions[0];
    let diagnostics;
    try {
      if (interaction) diagnostics = await failedTraceDiagnostics(interaction, threadId, "baseline");
    } catch (diagnosticError) {
      diagnostics = { exportError: diagnosticError.message };
    }
    throw new Error(`Baseline evidence failed. Diagnostics: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  const baselineInteraction = baseline.interactions[0];
  await exportTrace(baselineInteraction, threadId, "baseline");
  await openThread(productSession, threadId);
  const baselineCaptureState = () => mainWindow.webContents.executeJavaScript(`(() => (
    document.querySelector('#turnPickerButton')?.textContent?.trim() === 'Turn 1 of 1'
    && document.querySelectorAll('.graph-node').length > 0
    && !document.querySelector('#graphStage')?.classList.contains('hidden')
    && document.querySelector('#graphEmpty')?.classList.contains('hidden')
  ))()`);
  await capture("baseline-accepted", ["real Luna-authored graph", "ordinary ProductWorkspace"], null, baselineCaptureState);

  const oncePath = marker("approve-once.txt");
  const once = await createInteraction(productSession, threadId, protectedPrompt(oncePath, "approved-once", "State whether the protected file creation actually occurred."));
  const onceWaiting = await waitForOpenApproval(productSession, threadId, once.id, "approve-once");
  if (existsSync(oncePath)) throw new Error("Protected action executed before approve once.");
  await capture("approve-once-waiting", ["action has not executed", "Waiting status and bottom dock", "exact authority visible"], onceWaiting.receipt);
  if (existsSync(oncePath)) throw new Error("Protected action executed while Approve once remained pending.");
  await click("#approveOnce");
  const onceAccepted = await waitForThread(productSession, threadId, (detail) => (
    detail.interactions.find((item) => String(item.id) === String(once.id))?.completionStatus === "accepted"
  ), "approve-once resumed completion");
  const approveOnceContent = await markerText(oncePath);
  if (approveOnceContent !== "approved-once\n") throw new Error("Approve once did not execute the protected action.");
  const onceReceipt = onceAccepted.approvals.find((receipt) => receipt.request.requestId === onceWaiting.dock.requestId);
  if (onceReceipt?.resolution?.decision !== "approve_once" || onceReceipt.resolution.actor !== "user") {
    throw new Error(`Unexpected approve-once receipt: ${JSON.stringify(onceReceipt)}`);
  }
  observations.push({ label: "approve-once", interactionId: once.id, dock: onceWaiting.dock, receipt: onceReceipt });
  observations.at(-1).providerItemCorrelation = await exportTrace(once, threadId, "approve-once", oncePath, "complete", "completed", "approved-once\n", onceReceipt);

  await rm(oncePath);
  const deny = await createInteraction(productSession, threadId, protectedPrompt(oncePath, "approved-once", "This repeats the exact Approve-once scope and must request a new decision. Adapt to denial and still submit a useful graph."));
  const denied = await decideAndAccept(productSession, threadId, deny, "#denyApproval", "approve-once-repeat", async (repeatedWaiting) => {
    const sourceScopeKeys = JSON.stringify([...onceReceipt.request.scopeKeys].sort());
    const repeatedScopeKeys = JSON.stringify([...repeatedWaiting.receipt.request.scopeKeys].sort());
    if (sourceScopeKeys !== repeatedScopeKeys
      || onceReceipt.request.correlation.harnessSessionId !== repeatedWaiting.receipt.request.correlation.harnessSessionId) {
      throw new Error("Repeated Approve-once request did not preserve the exact live-session authority.");
    }
  });
  if (existsSync(oncePath) || denied.resolved.resolution.decision !== "deny") throw new Error("Approve once was improperly reused or the repeated action did not record denial.");
  observations.at(-1).providerItemCorrelation = await exportTrace(deny, threadId, "approve-once-repeat-denied", oncePath, "complete", "declined", "approved-once\n", denied.resolved);

  const alwaysPath = marker("approve-always.txt");
  const alwaysPrompt = protectedPrompt(alwaysPath, "exact-live-session", "Report whether the exact protected creation occurred.");
  const always = await createInteraction(productSession, threadId, alwaysPrompt);
  const alwaysResult = await decideAndAccept(productSession, threadId, always, "#approveAlways", "approve-always", async () => {
    if (existsSync(alwaysPath)) throw new Error("Protected action executed before approve always.");
  });
  if (await markerText(alwaysPath) !== "exact-live-session\n"
    || alwaysResult.resolved.resolution.decision !== "approve_always"
    || alwaysResult.resolved.resolution.outcome !== "approved"
    || alwaysResult.resolved.resolution.actor !== "user") {
    throw new Error("Approve always did not establish the expected source grant.");
  }
  observations.at(-1).providerItemCorrelation = await exportTrace(always, threadId, "approve-always", alwaysPath, "complete", "completed", "exact-live-session\n", alwaysResult.resolved);

  await rm(alwaysPath);
  const exact = await createInteraction(productSession, threadId, alwaysPrompt);
  const exactAccepted = await waitForThread(productSession, threadId, (detail) => (
    detail.interactions.find((item) => String(item.id) === String(exact.id))?.completionStatus === "accepted"
  ), "future exact request auto-resolved");
  const exactReceipt = exactAccepted.approvals.find((receipt) => String(receipt.request.correlation.interactionId) === String(exact.id));
  if (exactReceipt?.resolution?.actor !== "session_grant"
    || exactReceipt.resolution.decision !== "approve_once"
    || exactReceipt.resolution.sourceRequestId !== alwaysResult.resolved.request.requestId
    || exactReceipt.request.correlation.harnessSessionId !== alwaysResult.resolved.request.correlation.harnessSessionId
    || JSON.stringify([...exactReceipt.request.scopeKeys].sort()) !== JSON.stringify([...alwaysResult.resolved.request.scopeKeys].sort())) {
    throw new Error(`Future exact request did not consume the session grant: ${JSON.stringify(exactReceipt)}`);
  }
  if (await markerText(alwaysPath) !== "exact-live-session\n") throw new Error("Exact live-session match did not execute.");
  const approveAlwaysExactContent = await markerText(alwaysPath);
  observations.push({ label: "exact-auto-resolved", interactionId: exact.id, receipt: exactReceipt });
  observations.at(-1).providerItemCorrelation = await exportTrace(exact, threadId, "exact-auto-resolved", alwaysPath, "complete", "completed", "exact-live-session\n", exactReceipt);

  const nearPath = marker("approve-always-near.txt");
  const near = await createInteraction(productSession, threadId, protectedPrompt(nearPath, "must-not-appear", "This differs only by target path and must not inherit prior authority."));
  const nearWaiting = await waitForOpenApproval(productSession, threadId, near.id, "near-match");
  await capture("exact-grant-near-match-waiting", ["prior exact request auto-resolved", "near match still asks", "new exact scope visible"], nearWaiting.receipt);
  await click("#denyApproval");
  const nearAccepted = await waitForThread(productSession, threadId, (detail) => (
    detail.interactions.find((item) => String(item.id) === String(near.id))?.completionStatus === "accepted"
  ), "near-match denial adaptation");
  if (existsSync(nearPath)) throw new Error("Near match improperly inherited the exact session grant.");
  const nearReceipt = nearAccepted.approvals.find((receipt) => receipt.request.requestId === nearWaiting.dock.requestId);
  const sourceAction = alwaysResult.resolved.request.action;
  const nearAction = nearReceipt?.request.action;
  const { affectedFiles: sourceAffectedFiles, ...sourceActionWithoutTarget } = sourceAction ?? {};
  const { affectedFiles: nearAffectedFiles, ...nearActionWithoutTarget } = nearAction ?? {};
  const sourceScopeKeys = JSON.stringify([...(alwaysResult.resolved.request.scopeKeys ?? [])].sort());
  const nearScopeKeys = JSON.stringify([...(nearReceipt?.request.scopeKeys ?? [])].sort());
  if (nearReceipt?.resolution?.actor !== "user"
    || nearReceipt.resolution.outcome !== "denied"
    || nearReceipt.resolution.decision !== "deny"
    || nearReceipt.request.correlation.harnessSessionId !== alwaysResult.resolved.request.correlation.harnessSessionId
    || nearReceipt.request.title !== alwaysResult.resolved.request.title
    || nearReceipt.request.reason !== alwaysResult.resolved.request.reason
    || JSON.stringify(nearActionWithoutTarget) !== JSON.stringify(sourceActionWithoutTarget)
    || JSON.stringify(sourceAffectedFiles) !== JSON.stringify([alwaysPath])
    || JSON.stringify(nearAffectedFiles) !== JSON.stringify([nearPath])
    || sourceScopeKeys === nearScopeKeys) {
    throw new Error(`Near match recorded an unexpected resolution: ${JSON.stringify(nearReceipt)}`);
  }
  observations.push({ label: "near-match-denied", interactionId: near.id, dock: nearWaiting.dock, receipt: nearReceipt });
  observations.at(-1).providerItemCorrelation = await exportTrace(near, threadId, "near-match-denied", nearPath, "complete", "declined", "must-not-appear\n", nearReceipt);

  const cancelPath = marker("cancelled.txt");
  const cancelled = await createInteraction(productSession, threadId, protectedPrompt(cancelPath, "must-not-appear", "Do not retry after cancellation."));
  const cancelWaiting = await waitForOpenApproval(productSession, threadId, cancelled.id, "cancelled-provider-request");
  await capture("cancellation-waiting", ["protected action pending before explicit completion cancellation"], cancelWaiting.receipt);
  const cancelResult = await abortableEvidenceOperation("harness cancellation", async (signal) => {
    const response = await fetch(new URL(`/sessions/${threadId}/cancel`, runtimeSession.harnessUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${runtimeSession.harnessControlToken}`, "Content-Type": "application/json" },
      body: "{}",
      signal,
    });
    return { ok: response.ok, body: await response.json() };
  });
  if (!cancelResult.ok || cancelResult.body.cancelled !== true) throw new Error("The live harness completion did not cancel.");
  const cancelledDetail = await waitForThread(productSession, threadId, (detail) => {
    const interaction = detail.interactions.find((item) => String(item.id) === String(cancelled.id));
    const receipt = detail.approvals.find((item) => item.request.requestId === cancelWaiting.dock.requestId);
    return interaction?.completionStatus === "stopped" && receipt?.resolution?.outcome === "cancelled" ? detail : false;
  }, "cancelled request terminal receipt");
  const cancelReceipt = cancelledDetail.approvals.find((item) => item.request.requestId === cancelWaiting.dock.requestId);
  if (existsSync(cancelPath)
    || cancelReceipt.resolution.outcome !== "cancelled"
    || cancelReceipt.resolution.actor !== "host") {
    throw new Error(`Cancellation failed open: ${JSON.stringify(cancelReceipt)}`);
  }
  observations.push({ label: "cancelled-fail-closed", interactionId: cancelled.id, dock: cancelWaiting.dock, receipt: cancelReceipt });
  observations.at(-1).providerItemCorrelation = await exportTrace(cancelled, threadId, "cancelled-fail-closed", cancelPath, "partial", undefined, "must-not-appear\n", cancelReceipt);

  const lossPath = marker("provider-loss.txt");
  const providerLoss = await createInteraction(productSession, threadId, protectedPrompt(lossPath, "must-not-appear", "This request will lose its provider session."));
  const lossWaiting = await waitForOpenApproval(productSession, threadId, providerLoss.id, "provider-session-loss");
  await capture("provider-loss-waiting", ["protected action pending immediately before provider session loss"], lossWaiting.receipt);
  if (existsSync(lossPath)) throw new Error("Protected action executed before provider loss.");
  const providerPid = Number((await readFile(providerPidFile, "utf8")).trim());
  if (!Number.isSafeInteger(providerPid) || providerPid < 1) throw new Error(`Invalid live Codex provider PID: ${providerPid}`);
  process.kill(providerPid, "SIGKILL");
  const lossDetail = await waitForThread(productSession, threadId, (detail) => {
    const interaction = detail.interactions.find((item) => String(item.id) === String(providerLoss.id));
    const receipt = detail.approvals.find((item) => item.request.requestId === lossWaiting.dock.requestId);
    return interaction?.completionStatus === "failed" && receipt?.resolution?.outcome === "aborted" ? detail : false;
  }, "provider loss aborted receipt", 30_000);
  if (existsSync(lossPath)) throw new Error("Provider loss allowed the protected action to execute.");
  const lossReceipt = lossDetail.approvals.find((item) => item.request.requestId === lossWaiting.dock.requestId);
  if (lossReceipt?.resolution?.outcome !== "aborted" || lossReceipt.resolution.actor !== "harness") {
    throw new Error(`Provider loss recorded an unexpected authority: ${JSON.stringify(lossReceipt)}`);
  }
  observations.push({ label: "provider-loss-fail-closed", interactionId: providerLoss.id, dock: lossWaiting.dock, receipt: lossReceipt });
  observations.at(-1).providerItemCorrelation = await exportTrace(providerLoss, threadId, "provider-loss-fail-closed", lossPath, "failed", undefined, "must-not-appear\n", lossReceipt);

  await rm(alwaysPath, { force: true });
  const crossSessionThread = await productRequest(productSession, "/api/threads", {
    method: "POST",
    body: JSON.stringify({
      title: "Live Ask-profile cross-session isolation",
      projectId: project.id,
      initialMessage: "Author and submit a small baseline graph before the cross-session approval check.",
      permissionProfileId: "ask",
      modelSelection: { familyId: family.id, providerId: "codex", modelId: MODEL_ID },
    }),
  });
  const crossSessionBaseline = await waitForThread(
    productSession,
    crossSessionThread.id,
    (detail) => detail.interactions[0]?.completionStatus === "accepted",
    "cross-session baseline accepted graph",
  );
  await exportTrace(crossSessionBaseline.interactions[0], crossSessionThread.id, "cross-session-baseline");
  const crossSessionExact = await createInteraction(productSession, crossSessionThread.id, alwaysPrompt);
  const crossSessionWaiting = await waitForOpenApproval(
    productSession,
    crossSessionThread.id,
    crossSessionExact.id,
    "cross-session exact scope",
  );
  const sourceHarnessSessionId = alwaysResult.resolved.request.correlation.harnessSessionId;
  const isolatedHarnessSessionId = crossSessionWaiting.receipt.request.correlation.harnessSessionId;
  if (isolatedHarnessSessionId === sourceHarnessSessionId
    || JSON.stringify(crossSessionWaiting.receipt.request.scopeKeys) !== JSON.stringify(alwaysResult.resolved.request.scopeKeys)
    || JSON.stringify(crossSessionWaiting.receipt.request.action) !== JSON.stringify(alwaysResult.resolved.request.action)
    || existsSync(alwaysPath)) {
    throw new Error(`A new live harness session did not ask again for the exact prior grant scope: ${JSON.stringify({
      sourceHarnessSessionId,
      isolatedHarnessSessionId,
      source: alwaysResult.resolved.request,
      isolated: crossSessionWaiting.receipt.request,
    })}`);
  }
  await capture("cross-session-exact-waiting", [
    "new live harness session",
    "prior exact grant is not reused",
    "identical protected action waits for a new decision",
  ], crossSessionWaiting.receipt);
  await click("#denyApproval");
  const crossSessionDenied = await waitForThread(
    productSession,
    crossSessionThread.id,
    (detail) => detail.interactions.find((item) => String(item.id) === String(crossSessionExact.id))?.completionStatus === "accepted",
    "cross-session exact denial adaptation",
  );
  const crossSessionReceipt = crossSessionDenied.approvals.find((receipt) => (
    receipt.request.requestId === crossSessionWaiting.receipt.request.requestId
  ));
  if (crossSessionReceipt?.resolution?.actor !== "user"
    || crossSessionReceipt.resolution.decision !== "deny"
    || crossSessionReceipt.resolution.outcome !== "denied"
    || existsSync(alwaysPath)) {
    throw new Error(`Cross-session exact-scope denial failed closed: ${JSON.stringify(crossSessionReceipt)}`);
  }
  const crossSessionProviderItemCorrelation = await exportTrace(
    crossSessionExact,
    crossSessionThread.id,
    "cross-session-exact-denied",
    alwaysPath,
    "complete",
    "declined",
    "exact-live-session\n",
    crossSessionReceipt,
  );
  const crossSessionProof = {
    threadId: crossSessionThread.id,
    interactionId: crossSessionExact.id,
    sourceHarnessSessionId,
    isolatedHarnessSessionId,
    requestId: crossSessionReceipt.request.requestId,
    scopeKeys: crossSessionReceipt.request.scopeKeys,
    resolution: crossSessionReceipt.resolution,
    providerItemCorrelation: crossSessionProviderItemCorrelation,
  };

  await openThread(productSession, threadId);
  const finalDetail = await threadDetail(productSession, threadId);
  const finalCaptureState = () => mainWindow.webContents.executeJavaScript(`(() => {
    const dock = document.querySelector('#approvalDock');
    const graphEmpty = document.querySelector('#graphEmpty');
    const graphStage = document.querySelector('#graphStage');
    const history = document.querySelector('#approvalHistory');
    const historyList = document.querySelector('#approvalHistoryList');
    const historyItems = [...document.querySelectorAll('#approvalHistoryList > li')];
    const historyListStyle = historyList && getComputedStyle(historyList);
    const listRect = historyList?.getBoundingClientRect();
    const firstRect = historyItems[0]?.getBoundingClientRect();
    const valid = !dock?.classList.contains('hidden')
      && dock.classList.contains('history-only')
      && document.querySelector('#approvalHistorySummary')?.textContent?.trim() === 'Approval history (${finalDetail.approvals.length})'
      && history?.open === true
      && historyItems.length === ${finalDetail.approvals.length}
      && historyItems.every((item) => item.textContent?.trim())
      && historyList?.clientHeight === 64
      && historyList.scrollHeight > historyList.clientHeight
      && historyList.scrollTop === 0
      && historyListStyle?.overflowY === 'auto'
      && firstRect?.top >= listRect?.top
      && firstRect?.bottom <= listRect?.bottom
      && document.querySelector('#turnPickerButton')?.textContent?.trim() === 'Turn ${finalDetail.interactions.length} of ${finalDetail.interactions.length}'
      && !graphEmpty?.classList.contains('hidden')
      && graphStage?.classList.contains('hidden')
      && document.querySelectorAll('.graph-node').length === 0
      && document.querySelector('#graphEmptyMessage')?.textContent?.trim() === 'This interaction failed before producing an accepted graph.';
    if (!valid) return false;
    const dockRect = dock.getBoundingClientRect();
    return { approvalDock: {
      top: dockRect.top,
      left: dockRect.left,
      width: dockRect.width,
      height: dockRect.height,
    } };
  })()`);
  const finalCaptureProof = await capture("final-receipts", [
    "provider-loss turn has no accepted graph",
    "fixed-height approval history shows seven correlated receipts and a scrollbar",
  ], null, finalCaptureState);
  const finalDockGeometry = finalCaptureProof?.approvalDock;
  if (!finalDockGeometry) throw new Error("Final approval dock geometry is unavailable.");
  await boundedEvidenceCheck(
    "scroll final approval history",
    () => mainWindow.webContents.executeJavaScript(`(() => {
      const list = document.querySelector('#approvalHistoryList');
      if (list) list.scrollTop = list.scrollHeight;
    })()`),
    Date.now() + CAPTURE_DEADLINE_MS,
    CAPTURE_DEADLINE_MS,
  );
  const finalScrolledCaptureState = () => mainWindow.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#approvalHistoryList');
    const items = [...document.querySelectorAll('#approvalHistoryList > li')];
    const listRect = list?.getBoundingClientRect();
    const lastRect = items.at(-1)?.getBoundingClientRect();
    const dockRect = document.querySelector('#approvalDock')?.getBoundingClientRect();
    return document.querySelector('#approvalHistory')?.open === true
      && items.length === ${finalDetail.approvals.length}
      && list?.clientHeight === 64
      && list.scrollHeight > list.clientHeight
      && list.scrollTop > 0
      && dockRect?.top === ${JSON.stringify(finalDockGeometry.top)}
      && dockRect?.left === ${JSON.stringify(finalDockGeometry.left)}
      && dockRect?.width === ${JSON.stringify(finalDockGeometry.width)}
      && dockRect?.height === ${JSON.stringify(finalDockGeometry.height)}
      && lastRect?.top >= listRect?.top
      && lastRect?.bottom <= listRect?.bottom;
  })()`);
  await capture("final-receipts-scrolled", [
    "approval-history viewport remains 64 pixels tall",
    "scrolling reveals the final receipt without growing the dock",
  ], null, finalScrolledCaptureState);
  const encodedVideo = await finishRecording();
  validateApprovalPromptHoldEvidence({
    screenshots,
    holds: approvalPromptHolds,
    requiredDurationMs: APPROVAL_PROMPT_HOLD_MS,
    minimumFrames: APPROVAL_PROMPT_MIN_FRAMES,
    encodedDurationMs: encodedVideo.encodedDurationMs,
    frameIntervalMs: FRAME_INTERVAL_MS,
  });

  if (observations.length !== 7 || observations.some((observation) => !observation.providerItemCorrelation)) {
    throw new Error("Every approval receipt must correlate to one provider file-change item.");
  }
  const observedRequestIds = new Set(observations.map((observation) => observation.receipt.request.requestId));
  const finalRequestIds = new Set(finalDetail.approvals.map((approval) => approval.request.requestId));
  if (finalDetail.approvals.length !== 7
    || finalDetail.approvals.some((approval) => approval.resolution == null)
    || observedRequestIds.size !== finalRequestIds.size
    || [...finalRequestIds].some((requestId) => !observedRequestIds.has(requestId))) {
    throw new Error(`Final approval receipts do not exactly match the seven observed requests: ${JSON.stringify(finalDetail.approvals)}`);
  }
  const protectedActionChecks = {
    approveOnceContent,
    approveAlwaysExactContent,
    exactReplaySetupRemovedOnlyOwnedMarker: true,
    crossSessionExactAbsent: !existsSync(alwaysPath),
    approveOnceRepeatAbsent: !existsSync(oncePath),
    nearMatchAbsent: !existsSync(nearPath),
    cancelledAbsent: !existsSync(cancelPath),
    providerLossAbsent: !existsSync(lossPath),
  };
  await rm(markerDirectory, { recursive: true, force: true });
  await rm(frameDirectory, { recursive: true, force: true });
  const artifacts = [...validatedArtifacts.values()].sort((left, right) => left.file.localeCompare(right.file));
  const stagedArtifacts = await artifactInventory(outputDirectory);
  if (JSON.stringify(stagedArtifacts) !== JSON.stringify(artifacts)) {
    const expectedByFile = new Map(artifacts.map((artifact) => [artifact.file, artifact]));
    const actualByFile = new Map(stagedArtifacts.map((artifact) => [artifact.file, artifact]));
    const changedFiles = [...new Set([...expectedByFile.keys(), ...actualByFile.keys()])].filter((file) => (
      JSON.stringify(expectedByFile.get(file)) !== JSON.stringify(actualByFile.get(file))
    ));
    throw new Error(`Staged evidence bytes differ from hashes pinned at semantic validation time: ${JSON.stringify(changedFiles)}`);
  }
  const manifest = {
    schemaVersion: 1,
    issue: 85,
    generatedAt: new Date().toISOString(),
    source: {
      commit: sourceCommit,
      worktree: "clean",
      runtimeArtifactInventorySha256: createHash("sha256").update(JSON.stringify(sourceRuntimeArtifacts)).digest("hex"),
    },
    versions: {
      ...sourceVersions,
      electron: process.versions.electron,
      node: process.versions.node,
    },
    productClaim: "local development checkout only; no packaged or release claim",
    inference: { provider: "codex", model: MODEL_ID, paid: true, fixture: false },
    freshBuild: freshBuildRelation,
    sourceRuntimeArtifacts,
    runtimeArtifacts,
    project: { path: "<disposable-project>", disposable: true },
    correlation: {
      threadId,
      harnessConfigurationName: "codex-basic",
      permissionProfileId: "ask",
      interactions: finalDetail.interactions.map((interaction) => ({
        id: interaction.id,
        sequence: interaction.sequence,
        completionStatus: interaction.completionStatus,
        graphNodeId: interaction.graphNodeId,
        modelSelection: interaction.modelSelection,
        effectiveExecutionDigest: interaction.effectiveExecutionDigest,
      })),
    },
    screenshots,
    video: {
      file: VIDEO_FILE,
      continuousCaptureFps: RECORDING_FPS,
      frameCount,
      encodedFrameCount: encodedVideo.encodedFrameCount,
      capturedFrameSequenceSha256: encodedVideo.frameSequenceSha256,
      wallClockDurationMs: recordingFinishedAt - recordingStartedAt,
      encodedDurationMs: encodedVideo.encodedDurationMs,
      approvalPromptHoldPolicy: {
        requiredDurationMs: APPROVAL_PROMPT_HOLD_MS,
        minimumFrames: APPROVAL_PROMPT_MIN_FRAMES,
      },
      approvalPromptHolds,
    },
    observations: sanitizeEvidence(observations),
    crossSessionProof: sanitizeEvidence(crossSessionProof),
    protectedActionChecks,
    artifacts,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestChecksum = createHash("sha256").update(manifestText).digest("hex");
  await writeFile(join(outputDirectory, "manifest.json"), manifestText);
  await writeFile(join(outputDirectory, "manifest.sha256"), `${manifestChecksum}  manifest.json\n`);
  await abortableEvidenceOperation(
    "pre-publication service shutdown",
    () => closeServices(),
    MAJOR_OPERATION_TIMEOUT_MS,
  );
  ensureActive();
  await verifySourceInventoryMatchesRevision(sourceRuntimeArtifacts);
  await publishEvidence(
    manifestText,
    manifestChecksum,
    artifacts,
    publishedReadme,
    sourceRuntimeArtifacts,
    runtimeArtifacts,
  );
  ensureActive();
  process.stdout.write(`RELAYER_ASK_PROFILE_EVIDENCE ${JSON.stringify({ passed: true, model: MODEL_ID, threadId, interactions: finalDetail.interactions.length, approvals: finalDetail.approvals.length, video: VIDEO_FILE })}\n`);
  exitCode = 0;
}

function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const shutdownTimeoutMs = 30_000;
    const shutdownDeadline = Date.now() + shutdownTimeoutMs;
    const shutdownStep = (label, operation) => settleBeforeDeadline(operation, {
      label,
      deadline: shutdownDeadline,
      timeoutMs: shutdownTimeoutMs,
    });
    recording = false;
    try {
      await shutdownStep("recorder and termination shutdown", async () => {
        await recorder?.catch(() => undefined);
        await terminationClosePromise;
      });
      await shutdownStep("service shutdown", () => closeServices());
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      exitCode = 1;
    }
    try {
      const cleanupAuthorities = [
        ...freshBuildReadOnlyDirectoryAuthorities,
        ...runtimeSnapshotReadOnlyDirectoryAuthorities,
      ];
      if (cleanupAuthorities.length > 0
        && !restoreDirectoryWritesSync(cleanupAuthorities)) {
        throw new Error("Fresh build or runtime snapshot directory authority changed before cleanup.");
      }
      await shutdownStep("evidence directory cleanup", () => Promise.all([
        rm(outputDirectory, { recursive: true, force: true }),
        rm(markerDirectory, { recursive: true, force: true }),
        rm(projectDirectory, { recursive: true, force: true }),
        rm(dataDirectory, { recursive: true, force: true }),
      ]));
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      exitCode = 1;
    }
    for (const channel of ipcChannels) ipcMain.removeHandler(channel);
    cleanupComplete = true;
    clearTimeout(replayDeadlineWatchdog);
    clearTimeout(replayDeadlineEscalation);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    process.exitCode = exitCode;
    app.exit(exitCode);
  })();
  return shutdownPromise;
}

function terminateOnSignal(signal) {
  terminationSignalCount += 1;
  if (terminationSignalCount > 1) {
    ffmpegAbortController?.abort();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    process.kill(process.pid, "SIGKILL");
    return;
  }
  terminationSignal = signal;
  resolveTerminationRequest();
  recording = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.stop();
    mainWindow.destroy();
  }
  ffmpegAbortController?.abort();
  exitCode = signal === "SIGINT" ? 130 : 143;
  terminationClosePromise = closeServices().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    exitCode = 1;
  });
  if (publicationCommitted) void shutdown();
}

process.on("SIGINT", () => terminateOnSignal("SIGINT"));
process.on("SIGTERM", () => terminateOnSignal("SIGTERM"));
app.on("before-quit", (event) => {
  if (cleanupComplete) return;
  event.preventDefault();
  terminateOnSignal("SIGTERM");
});

process.stdout.write(`Starting paid Ask-profile evidence capture with ${MODEL_ID}...\n`);
void app.whenReady().then(run).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
}).finally(shutdown);
