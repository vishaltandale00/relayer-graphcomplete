import assert from "node:assert/strict";
import { execFile, spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { buildDevelopmentDesktop } from "../desktop/packaging/build-development.mjs";
import { desktopTargetFromEnvironment } from "../desktop/shared/target.mjs";
import {
  createLadybugCargoEnvironment,
  loadLadybugSourceManifest,
  sha256File,
} from "./prepare-ladybug-source.mjs";

const execFileAsync = promisify(execFile);

export function parseDynamicLibraries(output) {
  return String(output)
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter(Boolean);
}

export function verifySystemOnlyDynamicLibraries(libraries) {
  const forbidden = libraries.filter(
    (library) => !library.startsWith("/usr/lib/") && !library.startsWith("/System/Library/"),
  );
  if (forbidden.length > 0) {
    throw new Error(`packaged graph server imports non-system dynamic libraries: ${forbidden.join(", ")}`);
  }
  return libraries;
}

export function parseMinimumMacOSVersion(output) {
  const match = String(output).match(/\bminos\s+([0-9]+(?:\.[0-9]+){1,2})\b/u);
  if (!match) throw new Error("packaged graph server omits LC_BUILD_VERSION minos");
  return match[1];
}

export function verifyNoRuntimePaths(output) {
  if (/^\s*cmd LC_RPATH\s*$/mu.test(String(output))) {
    throw new Error("packaged graph server contains a forbidden LC_RPATH load command");
  }
}

export function parseLadybugLockContention(output) {
  const match = String(output).match(/Could not set lock on file[^\r\n]*/u);
  if (!match || !/(?:Resource temporarily unavailable|Lock is held by PID \d+)/u.test(match[0])) {
    throw new Error(`failure was not Ladybug lock contention: ${output}`);
  }
  return match[0];
}

export function npmEnvironmentForDesktopTarget(environment, target) {
  return {
    ...environment,
    npm_config_os: target.platform,
    npm_config_cpu: target.architecture,
  };
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  return options;
}

async function findApplications(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith(".app")) output.push(path);
    else await findApplications(path, output);
  }
  return output;
}

async function packagedApplicationBuiltAfter(directory, startedAt) {
  const candidates = await findApplications(directory);
  const current = [];
  for (const path of candidates) {
    if ((await stat(path)).mtimeMs >= startedAt) current.push(path);
  }
  if (current.length !== 1) {
    throw new Error(`expected one newly packaged application, found ${current.length}`);
  }
  return current[0];
}

async function removeQualificationCheckout({ checkout, qualificationRoot, checkoutAdded }) {
  if (!checkoutAdded) {
    await rm(qualificationRoot, { recursive: true, force: true });
    return;
  }
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", checkout]);
    await rm(qualificationRoot, { recursive: true, force: true });
  } catch (error) {
    await rm(qualificationRoot, { recursive: true, force: true });
    await execFileAsync("git", ["worktree", "prune"]);
    throw new Error(`qualification worktree cleanup failed: ${error.message}`, { cause: error });
  }
}

async function nextJsonLine(iterator, label) {
  const result = await iterator.next();
  if (result.done) throw new Error(`${label} exited before its expected JSON line`);
  try {
    return JSON.parse(result.value);
  } catch (error) {
    throw new Error(`${label} emitted invalid JSON: ${error.message}`);
  }
}

function observeExit(child) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    child.once("error", (error) => settle({ error }));
    child.once("exit", (code, signal) => settle({ code, signal }));
  });
}

function timeoutAfter(timeout, label) {
  let timer;
  return {
    promise: new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
    }),
    clear: () => clearTimeout(timer),
  };
}

async function waitForExit(exit, label, timeout = 10_000) {
  const bounded = timeoutAfter(timeout, label);
  try {
    const result = await Promise.race([exit, bounded.promise]);
    if (result.error) throw result.error;
    if (result.code !== 0) {
      throw new Error(`${label} failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code}`}`);
    }
    return result;
  } finally {
    bounded.clear();
  }
}

async function nextJsonLineBounded(iterator, child, exit, label, timeout = 10_000) {
  const bounded = timeoutAfter(timeout, `${label} JSON line`);
  try {
    return await Promise.race([
      nextJsonLine(iterator, label),
      exit.then((result) => {
        if (result.error) throw result.error;
        throw new Error(
          `${label} exited before its expected JSON line (${result.signal ? `signal ${result.signal}` : `exit code ${result.code}`})`,
        );
      }),
      bounded.promise,
    ]);
  } catch (error) {
    if (!child.killed && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.race([exit, new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
    throw error;
  } finally {
    bounded.clear();
  }
}

async function cleanupChild(child, exit, label) {
  if (!child || !exit) return;
  if (child.exitCode === null && child.signalCode === null && !child.killed) {
    if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    try {
      await waitForExit(exit, label, 2_000);
      return;
    } catch {
      child.kill("SIGKILL");
    }
  }
  const bounded = timeoutAfter(2_000, `${label} cleanup`);
  try {
    await Promise.race([exit, bounded.promise]);
  } finally {
    bounded.clear();
  }
}

function resolveContainedFile(root, path, label) {
  if (isAbsolute(path)) throw new Error(`${label} must be relative to the prepared source root`);
  const resolved = resolve(root, path);
  const fromRoot = relative(root, resolved);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes the prepared source root`);
  }
  return resolved;
}

export async function validatePreparedLadybugSource({ sourceOutput, manifest, target }) {
  const root = resolve(sourceOutput);
  const sourceReceiptPath = resolve(root, "source-receipt.json");
  const cargoEnvironmentPath = resolve(root, "cargo-build-env.json");
  const sourceReceipt = JSON.parse(await readFile(sourceReceiptPath, "utf8"));
  const cargoEnvironment = JSON.parse(await readFile(cargoEnvironmentPath, "utf8"));
  const expectedEnvironment = createLadybugCargoEnvironment({
    manifest,
    outputDirectory: root,
    target,
  });
  assert.equal(cargoEnvironment.schemaVersion, 1, "unsupported Ladybug Cargo environment receipt");
  assert.equal(cargoEnvironment.target, target, "Ladybug Cargo environment targets the wrong runtime");
  assert.deepEqual(
    cargoEnvironment.cargoArguments,
    ["build", "--locked", "--offline"],
    "Ladybug Cargo arguments must be locked and offline",
  );
  assert.deepEqual(
    cargoEnvironment.environment,
    expectedEnvironment,
    "Ladybug Cargo environment differs from the recomputed pinned paths",
  );
  assert.deepEqual(
    cargoEnvironment.environmentMustBeUnset,
    manifest.build.environmentMustBeUnset,
    "Ladybug ambient-override rejection list differs from the source manifest",
  );
  assert.equal(cargoEnvironment.requiredRuntimeRpath, null, "Ladybug must not require a runtime rpath");

  const suffix = target === "x86_64-pc-windows-msvc" ? ".lib" : ".a";
  const expectedFiles = ["libssl", "libcrypto"].map(
    (name) => `openssl-prefix/lib/${name}${suffix}`,
  );
  assert.deepEqual(
    cargoEnvironment.artifacts.map(({ file }) => file),
    expectedFiles,
    "Ladybug OpenSSL artifact list differs from the pinned static libraries",
  );
  for (const artifact of cargoEnvironment.artifacts) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/u, `${artifact.file} has no SHA-256`);
    const path = resolveContainedFile(root, artifact.file, "OpenSSL artifact");
    assert.equal(await sha256File(path), artifact.sha256, `${artifact.file} differs from its prepared digest`);
  }

  return {
    sourceReceipt,
    cargoEnvironment,
    preparedReceiptSha256: {
      "source-receipt.json": await sha256File(sourceReceiptPath),
      "cargo-build-env.json": await sha256File(cargoEnvironmentPath),
    },
  };
}

export async function provePackagedLadybugLifecycle(
  executable,
  { execute = execFileAsync, spawn = spawnProcess } = {},
) {
  const profile = await mkdtemp(join(tmpdir(), "relayer-ladybug-packaged-"));
  const database = join(profile, "ladybug");
  const args = ["--database", database, "--ladybug-qualification"];
  const bounded = { timeout: 5_000, killSignal: "SIGKILL" };
  let holder;
  let holderExit;
  let holderLines;
  try {
    const created = JSON.parse((await execute(executable, args, bounded)).stdout.trim());
    if (created.state !== "created" || created.ready !== true) {
      throw new Error("packaged graph server did not create the clean Ladybug profile");
    }

    holder = spawn(executable, [...args, "--ladybug-qualification-hold"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    holderExit = observeExit(holder);
    holderLines = createInterface({ input: holder.stdout });
    const holderIterator = holderLines[Symbol.asyncIterator]();
    const held = await nextJsonLineBounded(
      holderIterator,
      holder,
      holderExit,
      "packaged Ladybug holder",
    );
    if (held.state !== "reopened" || held.ready !== true) {
      throw new Error("packaged graph server did not reopen and hold the Ladybug profile");
    }
    let lockFailure = "";
    try {
      await execute(executable, args, bounded);
    } catch (error) {
      if (error.killed || error.code === "ETIMEDOUT" || error.signal === "SIGKILL") {
        throw new Error("lock-contended packaged Ladybug open did not fail within five seconds");
      }
      lockFailure = `${error.stderr || ""}\n${error.message || ""}`.trim();
    }
    if (!lockFailure) throw new Error("a second packaged graph server opened the locked Ladybug profile");
    const lockContention = parseLadybugLockContention(lockFailure);

    holder.stdin.end();
    const [shutdown] = await Promise.all([
      nextJsonLineBounded(
        holderIterator,
        holder,
        holderExit,
        "packaged Ladybug holder shutdown",
      ),
      waitForExit(holderExit, "packaged Ladybug holder"),
    ]);
    if (shutdown.shutdown !== "clean") {
      throw new Error("packaged graph server did not report clean Ladybug shutdown");
    }
    const reopened = JSON.parse((await execute(executable, args, bounded)).stdout.trim());
    if (reopened.state !== "reopened" || reopened.ready !== true) {
      throw new Error("packaged graph server did not reopen after clean holder shutdown");
    }
    return {
      cleanProfileCreated: true,
      lockContentionRejected: true,
      cleanShutdown: true,
      restartReopenedPersistedMarker: true,
      storageVersion: reopened.storageVersion,
      lockFailure: lockContention,
    };
  } finally {
    holderLines?.close();
    await cleanupChild(holder, holderExit, "packaged Ladybug holder");
    await rm(profile, { recursive: true, force: true });
  }
}

export async function captureLadybugPackagedLifecycle({
  sourceOutput,
  sourceCommit,
  environment = process.env,
  buildDesktop = buildDevelopmentDesktop,
} = {}) {
  if (!sourceOutput) throw new Error("Ladybug packaged capture requires a prepared source directory");
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit || "")) {
    throw new Error("Ladybug packaged capture requires an exact 40-character source commit");
  }
  await execFileAsync("git", ["cat-file", "-e", `${sourceCommit}^{commit}`]);
  const target = desktopTargetFromEnvironment(environment);
  if (target.platform !== "darwin") {
    throw new Error("the local #261 packaged Ladybug proof supports only macOS targets");
  }
  const manifest = await loadLadybugSourceManifest();
  const {
    sourceReceipt,
    cargoEnvironment: sourceEnvironment,
    preparedReceiptSha256,
  } = await validatePreparedLadybugSource({
    sourceOutput,
    manifest,
    target: target.rustTarget,
  });
  if (manifest.rustBinding.version !== "0.18.0" || manifest.extensions.length !== 0) {
    throw new Error("Ladybug source manifest is not the exact extension-free 0.18.0 contract");
  }
  if (
    sourceReceipt.sources?.find((source) => source.id === "rust-binding")?.sha256 !== manifest.rustBinding.sha256
    || sourceReceipt.sources?.find((source) => source.id === "openssl")?.sha256 !== manifest.openssl.sha256
    || sourceReceipt.rustBinding?.version !== manifest.rustBinding.version
    || sourceReceipt.rustBinding?.patched !== false
    || sourceReceipt.rustBinding?.buildScriptSha256 !== manifest.rustBinding.buildScriptSha256
    || sourceReceipt.core?.embeddedTreeSha256 !== manifest.core.embeddedTreeSha256
    || sourceReceipt.openssl?.version !== manifest.openssl.version
    || sourceReceipt.openssl?.sha256 !== manifest.openssl.sha256
    || sourceReceipt.extensions?.length !== 0
  ) {
    throw new Error("Ladybug source receipt does not match the pinned unmodified source manifest");
  }
  if (environment.RUSTFLAGS || environment.CARGO_ENCODED_RUSTFLAGS) {
    throw new Error("the packaged Ladybug proof rejects ambient Rust compiler flags");
  }
  const buildEnvironment = {
    ...environment,
    ...sourceEnvironment.environment,
    RELAYER_LADYBUG_QUALIFICATION: "1",
    RELAYER_DESKTOP_TARGET: target.key,
  };
  for (const name of manifest.build.environmentMustBeUnset) delete buildEnvironment[name];
  buildEnvironment.LBUG_BUILD_FROM_SOURCE = "1";
  const qualificationRoot = await mkdtemp(join(tmpdir(), "relayer-ladybug-clean-build-"));
  const checkout = join(qualificationRoot, "source");
  const cargoTarget = join(qualificationRoot, "cargo-target");
  let checkoutAdded = false;
  let primaryError;
  try {
    await execFileAsync("git", ["worktree", "add", "--detach", checkout, sourceCommit]);
    checkoutAdded = true;
    const { stdout: checkoutStatus } = await execFileAsync("git", ["status", "--porcelain"], { cwd: checkout });
    if (checkoutStatus !== "") throw new Error("detached qualification checkout is not clean");
    for (const path of [
      "scripts/capture-ladybug-packaged-lifecycle.mjs",
      "scripts/prepare-ladybug-source.mjs",
      "vendor/ladybug/source-build-manifest.json",
    ]) {
      const { stdout: committed } = await execFileAsync("git", ["show", `${sourceCommit}:${path}`], {
        encoding: "buffer",
        maxBuffer: 10 * 1024 * 1024,
      });
      assert.equal(
        createHash("sha256").update(await readFile(resolve(path))).digest("hex"),
        createHash("sha256").update(committed).digest("hex"),
        `${path} differs from the exact source commit`,
      );
    }
    await execFileAsync("npm", ["ci", "--ignore-scripts", "--offline"], {
      cwd: checkout,
      env: npmEnvironmentForDesktopTarget(environment, target),
      maxBuffer: 10 * 1024 * 1024,
    });
    await execFileAsync("npm", ["run", "prepare:renderer"], { cwd: checkout, maxBuffer: 10 * 1024 * 1024 });
    await execFileAsync("npm", ["run", "build:packages"], { cwd: checkout, maxBuffer: 10 * 1024 * 1024 });
    const startedAt = Date.now() - 1_000;
    await buildDesktop({
      environment: {
        ...buildEnvironment,
        CARGO_TARGET_DIR: cargoTarget,
        RELAYER_CARGO_TARGET_DIR: cargoTarget,
      },
      repositoryRoot: checkout,
      dependencyRoot: checkout,
    });
    const appPath = await packagedApplicationBuiltAfter(join(checkout, "desktop", "dist"), startedAt);
  const executable = join(appPath, "Contents", "Resources", "bin", "relayer-graph-server");
  const binarySha256 = createHash("sha256").update(await readFile(executable)).digest("hex");
  const libraries = parseDynamicLibraries((await execFileAsync("/usr/bin/otool", ["-L", executable])).stdout);
  verifySystemOnlyDynamicLibraries(libraries);
  const loadCommands = (await execFileAsync("/usr/bin/otool", ["-l", executable])).stdout;
  verifyNoRuntimePaths(loadCommands);
  const minimumMacOSVersion = parseMinimumMacOSVersion(loadCommands);
  if (minimumMacOSVersion !== manifest.build.minimumMacOSVersion) {
    throw new Error(
      `packaged graph server minimum macOS is ${minimumMacOSVersion}, expected ${manifest.build.minimumMacOSVersion}`,
    );
  }
  const lifecycle = await provePackagedLadybugLifecycle(executable);
  const inputPaths = [
    "Cargo.lock",
    "crates/relayer-graph-server/Cargo.toml",
    "crates/relayer-graph-server/src/main.rs",
    "desktop/packaging/build-development.mjs",
    "scripts/capture-ladybug-packaged-lifecycle.mjs",
    "scripts/prepare-ladybug-source.mjs",
    "vendor/ladybug/source-build-manifest.json",
  ];
  const inputSha256 = Object.fromEntries(await Promise.all(inputPaths.map(async (path) => {
    const { stdout } = await execFileAsync("git", ["show", `${sourceCommit}:${path}`], {
      encoding: "buffer",
      maxBuffer: 10 * 1024 * 1024,
    });
    return [path, createHash("sha256").update(stdout).digest("hex")];
  })));
  const result = {
    schemaVersion: 1,
    scope: "issue-261-local-packaged-qualification",
    capturedOn: new Date().toISOString().slice(0, 10),
    sourceCommit,
    buildIsolation: "clean-detached-worktree-and-empty-cargo-target",
    dependencyIsolation: "locked-offline-npm-ci-and-generated-assets",
    target: target.key,
    rustTarget: target.rustTarget,
    hostArchitecture: process.arch,
    executionMode: process.arch === target.architecture ? "native" : "rosetta",
    application: basename(appPath),
    binary: "Contents/Resources/bin/relayer-graph-server",
    binarySha256,
    lbug: { version: manifest.rustBinding.version, extensions: manifest.extensions },
    nativeMode: manifest.build.nativeMode,
    dynamicLibraries: libraries,
    minimumMacOSVersion,
    inputSha256,
    preparedReceiptSha256,
    ...lifecycle,
    limitations: [
      `local ${target.key} ${process.arch === target.architecture ? "native" : "Rosetta"} execution only`,
      "unsigned development package",
      "not release-ready licensing evidence",
    ],
  };
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await removeQualificationCheckout({ checkout, qualificationRoot, checkoutAdded });
    } catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], "qualification capture and cleanup failed");
      throw cleanupError;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const options = parseArguments(process.argv.slice(2));
  if (!options["source-output"] || !options["source-commit"]) {
    throw new Error(
      "usage: capture-ladybug-packaged-lifecycle.mjs --source-output <prepared-directory> --source-commit <40-hex>",
    );
  }
  if (options.application) {
    throw new Error("packaged Ladybug evidence must build a fresh application; --application is not supported");
  }
  console.log(JSON.stringify(await captureLadybugPackagedLifecycle({
    sourceOutput: options["source-output"],
    sourceCommit: options["source-commit"],
  }), null, 2));
}
