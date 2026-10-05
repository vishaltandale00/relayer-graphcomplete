import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildReleaseRustServers } from "./build-native-release.mjs";
import { loadDesktopReleaseContract } from "./contract.mjs";
import { writeWindowsNativeHandoff } from "./windows-native-handoff.mjs";
import { WINDOWS_NATIVE_PROFILE, windowsNativeIdentity } from "./windows-native-identity.mjs";
import { installWindowsNative, restoreWindowsNative, sealWindowsNative, validateWindowsNativePayload, windowsNativeArtifactName, windowsNativeProducer } from "./windows-native-cache.mjs";
import { preparePinnedLadybugForPackaging, requireLadybugDistributionLicenseReady } from "../packaging/pinned-ladybug-build.mjs";
import { timedStage } from "../packaging/build-cache.mjs";
import { npmCommandForPlatform, provePackagedLadybugLifecycle } from "../../scripts/capture-ladybug-packaged-lifecycle.mjs";

const captureDefault = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const target = { targetKey: "windows-x64", rustTarget: WINDOWS_NATIVE_PROFILE.target };
const outputDirectory = root => join(root, "target", target.rustTarget, "release");

async function run(command, args, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolvePromise() : reject(Error(`${command} failed: ${signal || code}`)));
  });
}

export async function windowsCompilerEnvironment(environment, { capture = captureDefault, report = console.log } = {}) {
  const result = { ...environment, CARGO_INCREMENTAL: "0" };
  if (!environment.SCCACHE_PATH) return result;
  try {
    const version = await capture(environment.SCCACHE_PATH, ["--version"], { timeout: 10_000 });
    if (!/^sccache 0\.18\.0\s*$/u.test(version.stdout.trim())) throw Error("unreviewed sccache version");
    const compilerEnvironment = { ...result, SCCACHE_DIR: join(environment.RUNNER_TEMP, "rwc"), SCCACHE_GHA_ENABLED: "false", SCCACHE_CACHE_SIZE: "2G", SCCACHE_IGNORE_SERVER_IO_ERROR: "1" };
    await capture(environment.SCCACHE_PATH, ["--start-server"], { env: compilerEnvironment, timeout: 15_000 });
    report("Windows compiler cache: pinned local sccache enabled");
    return { ...compilerEnvironment, RUSTC_WRAPPER: environment.SCCACHE_PATH, CMAKE_C_COMPILER_LAUNCHER: environment.SCCACHE_PATH, CMAKE_CXX_COMPILER_LAUNCHER: environment.SCCACHE_PATH };
  } catch (error) {
    report(`Windows compiler cache unavailable: ${error.message}; use direct compilers`);
    return result;
  }
}

async function verifyCleanSource(root, sourceCommit) {
  assert.equal((await captureDefault("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(), sourceCommit);
  assert.equal((await captureDefault("git", ["status", "--porcelain"], { cwd: root })).stdout.trim(), "", "native source must be clean");
}

export async function planWindowsNative({ repositoryRoot, environment = process.env, identify = windowsNativeIdentity, report = console.log }) {
  const producer = windowsNativeProducer(environment);
  const root = resolve(repositoryRoot);
  await verifyCleanSource(root, producer.sourceCommit);
  let identity;
  try {
    identity = { ...await identify({ repositoryRoot: root, environment }), cacheEligible: true };
  } catch (error) {
    // Optional identity discovery cannot make a source build unavailable. A
    // run-specific namespace permits only this same-run handoff, never reuse.
    const runtime = hash(JSON.stringify({ scope: "uncached-same-run", producer, profile: WINDOWS_NATIVE_PROFILE }));
    identity = { runtime, native: runtime, dependency: runtime, profile: WINDOWS_NATIVE_PROFILE, cacheEligible: false };
    report(`Windows cache identity unavailable: ${error.message}; fresh same-run native build`);
  }
  return { identity, producer };
}

export async function restoreWindowsNativePlan({ plan, repositoryRoot, environment = process.env, restore = restoreWindowsNative, ...verification }) {
  if (!plan.identity.cacheEligible || environment.RELAYER_WINDOWS_NATIVE_CACHE === "0") return null;
  const directory = join(environment.RUNNER_TEMP, "windows-native-restored");
  const bundle = await restore({ identity: plan.identity.runtime, directory, environment, ...verification });
  return bundle;
}

export async function qualifyWindowsNative({ plan, restoredBundle = null, repositoryRoot, environment = process.env, execute = run,
  buildNative = buildReleaseRustServers, lifecycle = provePackagedLadybugLifecycle, requireLicense = requireLadybugDistributionLicenseReady,
  capture = captureDefault, verifySource = verifyCleanSource, validatePayload = validateWindowsNativePayload, seal = sealWindowsNative, prepareLadybug = preparePinnedLadybugForPackaging }) {
  const root = resolve(repositoryRoot);
  const producer = windowsNativeProducer(environment);
  assert.deepEqual(plan.producer, producer);
  await verifySource(root, producer.sourceCommit);
  await requireLicense();
  const directory = outputDirectory(root);
  if (restoredBundle) {
    try {
      assert.equal(restoredBundle.manifest.identity, plan.identity.runtime, "restored native identity differs from current inputs");
      await installWindowsNative(restoredBundle, directory, { capture });
    }
    catch (error) { console.log(`Windows native cache installation rejected: ${error.message}; compile once`); restoredBundle = null; }
  }
  const buildMode = restoredBundle ? "verified-native-artifact" : "fresh-cargo-release-build";
  let compilerCacheEnabled = false;
  if (!restoredBundle) {
    // An empty Cargo target avoids accidental runner-local output reuse. Object
    // cache acceleration remains explicitly distinct from cold compiler proof.
    await rm(join(root, "target", target.rustTarget), { recursive: true, force: true });
    const compileEnvironment = await windowsCompilerEnvironment(environment, { capture });
    compilerCacheEnabled = Boolean(compileEnvironment.RUSTC_WRAPPER);
    const nativeCache = plan.identity.cacheEligible ? { root: join(environment.RUNNER_TEMP, "rwn"), native: plan.identity.native } : undefined;
    await timedStage("Windows release native compilation", () => buildNative({ contract: { ...target, sourceCommit: producer.sourceCommit }, repositoryRoot: root,
      environment: compileEnvironment, execute: (command, args, options) => command === "cargo" && args[0] === "build"
        ? timedStage("Windows Cargo release", () => execute(command, args, options), environment) : execute(command, args, options),
      prepareLadybug: options => prepareLadybug({ ...options, cache: nativeCache }) }), environment);
  }
  const debugIds = await validatePayload(directory, { capture, exactInventory: false });
  const binarySha256 = Object.fromEntries(await Promise.all(["relayer-app-server.exe", "relayer-graph-server.exe"].map(async name => [name, hash(await readFile(join(directory, name)))])));
  const npm = npmCommandForPlatform();
  for (const script of ["prepare:renderer", "build:packages"]) await execute(npm.executable, [...npm.prefixArgs, "run", script], { cwd: root, env: environment });
  // Fresh unsigned assembly invokes the real afterPack inventory, license and
  // x64/static-link gates while consuming the actual release-profile binaries.
  const unsignedEnvironment = { ...environment, RELAYER_DESKTOP_TARGET: "windows-x64", RELAYER_DESKTOP_SOURCE_COMMIT: producer.sourceCommit, RELAYER_DESKTOP_RELEASE: "0" };
  await timedStage("Windows unsigned qualification assembly", () => execute(process.execPath, [join(root, "node_modules/electron-builder/out/cli/cli.js"), "--config", "desktop/packaging/electron-builder.mjs", "--dir", "--win", "--x64", "--publish", "never"], { cwd: root, env: unsignedEnvironment }), environment);
  const application = join(root, "desktop/dist/win-unpacked");
  for (const [name, sha256] of Object.entries(binarySha256)) {
    assert.equal(hash(await readFile(join(application, "resources/bin", name))), sha256, "qualification packaged a different Rust executable");
    assert.equal(hash(await readFile(join(directory, name))), sha256, "qualification changed original native output");
  }
  const observed = await lifecycle(join(application, "resources/bin/relayer-graph-server.exe"), { commandTimeout: 15000 });
  assert.equal(observed.storageVersion, 42, "unexpected packaged Ladybug storage version");
  const qualification = { scope: "windows-release-profile-packaged-lifecycle/v1", sourceCommit: producer.sourceCommit, profile: WINDOWS_NATIVE_PROFILE,
    buildMode, cacheEligible: plan.identity.cacheEligible, compilerCacheEnabled, compilerCacheRequested: Boolean(environment.SCCACHE_PATH), binarySha256, debugIds, lifecycleTimeoutMs: 15000, ...observed,
    limitations: ["unsigned Windows x64 native release inputs", "fresh packaged graph-server lifecycle only", "installer, signing, telemetry and VM acceptance remain separate"] };
  await verifySource(root, producer.sourceCommit);
  const bundleDirectory = join(environment.RUNNER_TEMP, "windows-qualified-native");
  const bundle = await seal({ directory: bundleDirectory, outputDirectory: directory, identity: plan.identity.runtime, producer, qualification,
    origin: restoredBundle ? { artifactId: restoredBundle.artifactId, artifactDigest: restoredBundle.artifactDigest, producer: restoredBundle.manifest.producer } : null, capture });
  await writeFile(join(environment.RUNNER_TEMP, "windows-release-qualification.json"), `${JSON.stringify(qualification, null, 2)}\n`);
  console.log(JSON.stringify(qualification, null, 2));
  return { ...bundle, artifactName: windowsNativeArtifactName(plan.identity.runtime, producer) };
}

export async function adoptQualifiedWindowsNative({ repositoryRoot, environment = process.env, expectedIdentity, receiptPath, restore = restoreWindowsNative,
  loadContract = loadDesktopReleaseContract, capture = captureDefault }) {
  if (environment.GITHUB_REPOSITORY !== "vishaltandale00/relayer-graphcomplete" || environment.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || environment.GITHUB_REF !== "refs/heads/main" || environment.GITHUB_JOB !== "package") throw Error("native adoption requires protected manual-main package job");
  const expected = { runId: Number(environment.GITHUB_RUN_ID), runAttempt: Number(environment.GITHUB_RUN_ATTEMPT), sourceCommit: environment.GITHUB_SHA };
  const contract = await loadContract({ environment: { ...environment, RELAYER_DESKTOP_RELEASE: "1", RELAYER_DESKTOP_CHANNEL: "preview" }, desktopRoot: join(repositoryRoot, "desktop") });
  assert.equal(contract.sourceCommit, expected.sourceCommit);
  const bundle = await restore({ identity: expectedIdentity, expected, directory: join(environment.RUNNER_TEMP, "windows-native-adopted"), environment, capture });
  if (!bundle) throw Error("required qualified native handoff unavailable");
  await installWindowsNative(bundle, outputDirectory(repositoryRoot), { capture });
  await rm(receiptPath, { force: true });
  await writeWindowsNativeHandoff({ contract, environment, repositoryRoot, receiptPath });
  return bundle;
}

async function cli() {
  const root = resolve(import.meta.dirname, "../..");
  const env = process.env;
  const [mode] = process.argv.slice(2);
  const planPath = join(env.RUNNER_TEMP, "windows-native-plan.json");
  const restorePath = join(env.RUNNER_TEMP, "windows-native-restore.json");
  const output = async values => { if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n"); };
  if (mode === "plan") {
    const plan = await planWindowsNative({ repositoryRoot: root, environment: env });
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    await output({ identity: plan.identity.runtime, native_identity: plan.identity.native, dependency_identity: plan.identity.dependency, cache_eligible: plan.identity.cacheEligible });
  } else if (mode === "restore") {
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    const bundle = await restoreWindowsNativePlan({ plan, repositoryRoot: root, environment: env });
    await writeFile(restorePath, `${JSON.stringify(bundle)}\n`);
    await output({ hit: Boolean(bundle) });
  } else if (mode === "qualify") {
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    const restoredBundle = JSON.parse(await readFile(restorePath, "utf8"));
    const bundle = await qualifyWindowsNative({ plan, restoredBundle, repositoryRoot: root, environment: env });
    await output({ artifact_name: bundle.artifactName, artifact_directory: bundle.directory });
  } else if (mode === "adopt") {
    await adoptQualifiedWindowsNative({ repositoryRoot: root, environment: env, expectedIdentity: env.RELAYER_WINDOWS_NATIVE_IDENTITY, receiptPath: join(env.RUNNER_TEMP, "windows-release-native.json") });
  } else throw Error("Usage: windows-native-build.mjs plan|restore|qualify|adopt");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
