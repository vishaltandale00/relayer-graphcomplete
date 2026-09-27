import { accessSync, constants, lstatSync, mkdirSync, readlinkSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { nativeBinaryName } from "../shared/target.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const remedy = "Run npm run eval-app:prepare, then restart Eval after compiled source or dependency changes.";

function owned(root, path) {
  const suffix = relative(realpathSync(root), realpathSync(path));
  if (suffix === ".." || suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(suffix)) {
    throw new Error(`Eval artifact is outside this checkout: ${path}. ${remedy}`);
  }
}

function targetPath(root, environment) {
  if (environment.CARGO_BUILD_TARGET) throw new Error("Unset CARGO_BUILD_TARGET: Eval requires the native host target/debug layout.");
  const target = join(root, "target");
  if ([environment.CARGO_TARGET_DIR, environment.CARGO_BUILD_TARGET_DIR].some((value) => value && resolve(root, value) !== target)) {
    throw new Error(`Unset CARGO_TARGET_DIR and CARGO_BUILD_TARGET_DIR: Eval uses this checkout's ${target}. ${remedy}`);
  }
  return target;
}

function requirePrivateDebug(target) {
  const debug = lstatSync(join(target, "debug"), { throwIfNoEntry: false });
  if (debug && !debug.isDirectory()) throw new Error(`Eval target/debug must be a private directory. ${remedy}`);
}

function requireFile(path, executable = false) {
  try {
    if (!statSync(path).isFile()) throw new Error("not a regular file");
    accessSync(path, executable ? constants.X_OK : constants.R_OK);
  } catch {
    throw new Error(`Eval artifact missing or inaccessible: ${path}. ${remedy}`);
  }
  return path;
}

export function evalRuntimeBinaries(root = repositoryRoot, environment = process.env) {
  root = resolve(root);
  const names = { graphServerBinary: ["RELAYER_GRAPH_SERVER_BIN", "relayer-graph-server"], appServerBinary: ["RELAYER_APP_SERVER_BINARY", "relayer-app-server"] };
  return Object.fromEntries(Object.entries(names).map(([key, [override, binary]]) => {
    if (environment[override]) return [key, requireFile(resolve(root, environment[override]), true)];
    const target = targetPath(root, environment);
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Eval target must be a private directory: ${target} is a symlink. ${remedy}`);
    }
    requirePrivateDebug(target);
    const path = requireFile(join(target, "debug", nativeBinaryName(binary)), true);
    owned(root, path);
    return [key, path];
  }));
}

export function requireEvalArtifacts(root = repositoryRoot, environment = process.env) {
  const binaries = evalRuntimeBinaries(root, environment);
  // Recursive Complete imports root dist; agent programs import the generated bundle.
  for (const artifact of ["dist/index.js", ...["graph-client", "visual-assets", "harness-host", "eval-runner"].map((name) => `packages/${name}/dist/index.js`), "packages/graph-client/agent-resource/index.js", "desktop/renderer/vendor/marked.umd.js", "desktop/renderer/vendor/lucide.min.js"]) {
    requireFile(join(root, artifact));
    owned(root, join(root, artifact));
  }
  return binaries;
}

export function prepareEval(root = repositoryRoot, environment = process.env, run = spawnSync) {
  root = resolve(root);
  const target = targetPath(root, environment);
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    console.log(`Replacing checkout target symlink (${readlinkSync(target)}) with a private directory; its destination is untouched.`);
    unlinkSync(target);
  }
  mkdirSync(target, { recursive: true });
  owned(root, target);
  // Cargo must never follow an escaping debug directory when writing binaries.
  requirePrivateDebug(target);
  for (const binary of ["relayer-graph-server", "relayer-app-server"]) {
    const path = join(target, "debug", nativeBinaryName(binary));
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) owned(root, path);
  }
  const buildEnvironment = { ...environment, CARGO_TARGET_DIR: target, CARGO_BUILD_BUILD_DIR: target };
  const result = run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: root, env: buildEnvironment, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Eval preparation failed (${result.signal ?? result.status}); build output is above.`);
  const binaries = requireEvalArtifacts(root, { CARGO_TARGET_DIR: target });
  // Ask Cargo where it actually built: global build.target can redirect outputs.
  // This incremental invocation must not mistake older target/debug files for success.
  const report = run("cargo", ["build", "-p", "relayer-app-server", "-p", "relayer-graph-server", "--message-format=json"], { cwd: root, env: buildEnvironment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
  if (report.error) throw report.error;
  if (report.status !== 0) throw new Error(`Eval artifact verification failed (${report.signal ?? report.status}).`);
  const emitted = new Set(report.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((record) => record.reason === "compiler-artifact" && record.executable).map((record) => resolve(root, record.executable)));
  for (const binary of Object.values(binaries)) {
    if (!emitted.has(binary)) throw new Error(`Cargo did not report ${binary}. Remove Cargo build.target configuration; Eval requires native target/debug outputs.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === "prepare") prepareEval();
    else requireEvalArtifacts();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
