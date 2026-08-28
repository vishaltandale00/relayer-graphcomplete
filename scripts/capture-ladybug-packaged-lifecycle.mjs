import assert from "node:assert/strict";
import { execFile, spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildDevelopmentDesktop } from "../desktop/packaging/build-development.mjs";
import { desktopTargetFromEnvironment } from "../desktop/shared/target.mjs";
import {
  createLadybugCargoEnvironment,
  digestLadybugSourceTree,
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

export function parseMachOArchitectures(output) {
  const architectures = String(output).trim().split(/\s+/u).filter(Boolean);
  if (architectures.length === 0) throw new Error("packaged graph server has no Mach-O architecture");
  return architectures;
}

function requireBufferRange(bytes, offset, length, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.length) {
    throw new Error(`packaged graph server has an invalid PE ${label}`);
  }
}

function peCString(bytes, offset, maximumLength) {
  requireBufferRange(bytes, offset, 1, "import name");
  const end = bytes.indexOf(0, offset);
  if (end === -1 || end >= offset + maximumLength) {
    throw new Error("packaged graph server has an unterminated PE import name");
  }
  return bytes.toString("ascii", offset, end);
}

export function inspectPortableExecutable(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error("PE inspection requires executable bytes");
  requireBufferRange(bytes, 0, 0x40, "DOS header");
  if (bytes.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("packaged graph server is not a PE executable");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  requireBufferRange(bytes, peOffset, 24, "COFF header");
  if (bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error("packaged graph server has no PE signature");
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  const architecture = new Map([
    [0x8664, "x86_64"],
    [0xaa64, "arm64"],
  ]).get(machine);
  if (!architecture) throw new Error(`unsupported packaged PE machine: 0x${machine.toString(16)}`);
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20);
  const optionalHeader = peOffset + 24;
  requireBufferRange(bytes, optionalHeader, optionalHeaderSize, "optional header");
  const magic = bytes.readUInt16LE(optionalHeader);
  if (magic !== 0x20b) throw new Error(`unsupported packaged PE optional header: 0x${magic.toString(16)}`);
  const dataDirectoryOffset = 112;
  if (optionalHeaderSize < dataDirectoryOffset + 16) {
    throw new Error("packaged graph server omits the PE import directory");
  }
  const numberOfDataDirectories = bytes.readUInt32LE(optionalHeader + dataDirectoryOffset - 4);
  const dataDirectory = (index) => {
    if (numberOfDataDirectories <= index || optionalHeaderSize < dataDirectoryOffset + (index + 1) * 8) {
      return { rva: 0, size: 0 };
    }
    return {
      rva: bytes.readUInt32LE(optionalHeader + dataDirectoryOffset + index * 8),
      size: bytes.readUInt32LE(optionalHeader + dataDirectoryOffset + index * 8 + 4),
    };
  };
  const sizeOfHeaders = bytes.readUInt32LE(optionalHeader + 60);
  const sectionTable = optionalHeader + optionalHeaderSize;
  requireBufferRange(bytes, sectionTable, sectionCount * 40, "section table");
  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const offset = sectionTable + index * 40;
    return {
      virtualSize: bytes.readUInt32LE(offset + 8),
      virtualAddress: bytes.readUInt32LE(offset + 12),
      rawSize: bytes.readUInt32LE(offset + 16),
      rawOffset: bytes.readUInt32LE(offset + 20),
    };
  });
  for (const section of sections) {
    if (section.rawSize > 0) {
      requireBufferRange(bytes, section.rawOffset, section.rawSize, "section raw data");
    }
  }
  const fileRangeForRva = (rva, label) => {
    if (rva < sizeOfHeaders) {
      requireBufferRange(bytes, rva, 1, label);
      return { offset: rva, maximumLength: Math.min(sizeOfHeaders, bytes.length) - rva };
    }
    const section = sections.find(({ virtualAddress, virtualSize, rawSize }) => (
      rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)
    ));
    if (!section) throw new Error(`packaged graph server has an unmapped PE ${label}`);
    const delta = rva - section.virtualAddress;
    if (delta >= section.rawSize) {
      throw new Error(`packaged graph server maps PE ${label} into a virtual-only section range`);
    }
    const offset = section.rawOffset + delta;
    requireBufferRange(bytes, offset, 1, label);
    return { offset, maximumLength: section.rawSize - delta };
  };
  const imports = [];
  const parseImports = ({ rva, size }, { descriptorSize, label, nameField, validateDescriptor }) => {
    if (rva === 0 && size === 0) return;
    if (rva === 0 || size < descriptorSize) throw new Error(`packaged graph server has an invalid PE ${label}`);
    const { offset: importOffset, maximumLength } = fileRangeForRva(rva, label);
    if (size > maximumLength) throw new Error(`packaged graph server has an oversized PE ${label}`);
    const maximumDescriptors = Math.floor(size / descriptorSize);
    let terminated = false;
    for (let index = 0; index < maximumDescriptors; index += 1) {
      const descriptor = importOffset + index * descriptorSize;
      requireBufferRange(bytes, descriptor, descriptorSize, `${label} descriptor`);
      const fields = Array.from(
        { length: descriptorSize / 4 },
        (_, field) => bytes.readUInt32LE(descriptor + field * 4),
      );
      if (fields.every((value) => value === 0)) {
        terminated = true;
        break;
      }
      validateDescriptor?.(fields);
      if (fields[nameField] === 0) throw new Error(`packaged graph server has a nameless PE ${label} descriptor`);
      const name = fileRangeForRva(fields[nameField], `${label} name`);
      imports.push(peCString(bytes, name.offset, name.maximumLength));
    }
    if (!terminated) throw new Error(`packaged graph server has an unterminated PE ${label}`);
  };
  parseImports(dataDirectory(1), {
    descriptorSize: 20,
    label: "import directory",
    nameField: 3,
  });
  parseImports(dataDirectory(13), {
    descriptorSize: 32,
    label: "delay-import directory",
    nameField: 1,
    validateDescriptor: (fields) => {
      if ((fields[0] & 1) !== 1) {
        throw new Error("packaged graph server uses unsupported VA-based PE delay imports");
      }
    },
  });
  return { architecture, imports };
}

export function verifyNoBundledWindowsNativeLibraries(libraries) {
  const forbidden = libraries.filter((library) => {
    const name = String(library).split(/[\\/]/u).at(-1);
    return (
      /^(?:lib)?(?:lbug|ladybug)(?:[-._].*)?\.dll$/iu.test(name)
      || /^lib(?:ssl|crypto)(?:[-._].*)?\.dll$/iu.test(name)
    );
  });
  if (forbidden.length > 0) {
    throw new Error(`packaged graph server imports forbidden native libraries: ${forbidden.join(", ")}`);
  }
  return libraries;
}

export function parseLadybugLockContention(output) {
  const match = String(output).match(/Could not set lock on file[^\r\n]*/u);
  if (!match || !/(?:Resource temporarily unavailable|Lock is held by PID \d+|\(Error: 33\))/u.test(match[0])) {
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

export function qualificationLifecycleTimeout(target, hostArchitecture = process.arch) {
  void target;
  void hostArchitecture;
  return 15_000;
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

export async function packagedApplicationBuiltAfter(directory, startedAt, target) {
  const candidates = target.platform === "win32"
    ? [join(directory, "win-unpacked")]
    : await findApplications(directory);
  const current = [];
  for (const path of candidates) {
    try {
      if ((await stat(path)).mtimeMs >= startedAt) current.push(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
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

  const ladybugSourceTreeSha256 = await digestLadybugSourceTree(
    cargoEnvironment.environment.LBUG_SOURCE_DIR,
  );
  assert.equal(
    ladybugSourceTreeSha256,
    manifest.core.embeddedTreeSha256,
    "prepared Ladybug core differs from the reviewed source tree immediately before compilation",
  );

  return {
    sourceReceipt,
    cargoEnvironment,
    preparedReceiptSha256: {
      "source-receipt.json": await sha256File(sourceReceiptPath),
      "cargo-build-env.json": await sha256File(cargoEnvironmentPath),
    },
    preparedSourceSha256: {
      ladybugCoreTree: ladybugSourceTreeSha256,
    },
  };
}

export async function provePackagedLadybugLifecycle(
  executable,
  { execute = execFileAsync, spawn = spawnProcess, commandTimeout = 5_000 } = {},
) {
  const profile = await mkdtemp(join(tmpdir(), "relayer-ladybug-packaged-"));
  const database = join(profile, "ladybug");
  const args = ["--database", database, "--ladybug-qualification"];
  const bounded = { timeout: commandTimeout, killSignal: "SIGKILL" };
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
        throw new Error(`lock-contended packaged Ladybug open did not fail within ${commandTimeout}ms`);
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
  if (target.platform !== "darwin" && target.platform !== "win32") {
    throw new Error("the #261 packaged Ladybug proof supports only macOS and Windows targets");
  }
  if (target.platform === "win32" && (process.platform !== "win32" || process.arch !== "x64")) {
    throw new Error("the windows-x64 Ladybug proof requires native win32 x64 execution");
  }
  const manifest = await loadLadybugSourceManifest();
  if (manifest.rustBinding.version !== "0.18.0" || manifest.extensions.length !== 0) {
    throw new Error("Ladybug source manifest is not the exact extension-free 0.18.0 contract");
  }
  if (environment.RUSTFLAGS || environment.CARGO_ENCODED_RUSTFLAGS) {
    throw new Error("the packaged Ladybug proof rejects ambient Rust compiler flags");
  }
  const qualificationRoot = await mkdtemp(join(tmpdir(), "relayer-ladybug-clean-build-"));
  const preparedSource = join(qualificationRoot, "prepared-source");
  let sourceReceipt;
  let sourceEnvironment;
  let preparedReceiptSha256;
  let preparedSourceSha256;
  try {
    await cp(resolve(sourceOutput), preparedSource, { recursive: true, errorOnExist: true, force: false });
    const copiedCargoEnvironmentPath = join(preparedSource, "cargo-build-env.json");
    const copiedCargoEnvironment = JSON.parse(await readFile(copiedCargoEnvironmentPath, "utf8"));
    copiedCargoEnvironment.environment = createLadybugCargoEnvironment({
      manifest,
      outputDirectory: preparedSource,
      target: target.rustTarget,
    });
    await writeFile(copiedCargoEnvironmentPath, `${JSON.stringify(copiedCargoEnvironment, null, 2)}\n`);
    ({
      sourceReceipt,
      cargoEnvironment: sourceEnvironment,
      preparedReceiptSha256,
      preparedSourceSha256,
    } = await validatePreparedLadybugSource({
      sourceOutput: preparedSource,
      manifest,
      target: target.rustTarget,
    }));
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
  } catch (error) {
    await rm(qualificationRoot, { recursive: true, force: true });
    throw error;
  }
  const buildEnvironment = {
    ...environment,
    ...sourceEnvironment.environment,
    RELAYER_LADYBUG_QUALIFICATION: "1",
    RELAYER_DESKTOP_TARGET: target.key,
  };
  for (const name of manifest.build.environmentMustBeUnset) delete buildEnvironment[name];
  buildEnvironment.LBUG_BUILD_FROM_SOURCE = "1";
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
      ".gitattributes",
      "desktop/packaging/build-development.mjs",
      "desktop/shared/target.mjs",
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
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    await execFileAsync(npmCommand, ["ci", "--ignore-scripts", "--offline"], {
      cwd: checkout,
      env: npmEnvironmentForDesktopTarget(environment, target),
      maxBuffer: 10 * 1024 * 1024,
    });
    await execFileAsync(npmCommand, ["run", "prepare:renderer"], { cwd: checkout, maxBuffer: 10 * 1024 * 1024 });
    await execFileAsync(npmCommand, ["run", "build:packages"], { cwd: checkout, maxBuffer: 10 * 1024 * 1024 });
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
    const appPath = await packagedApplicationBuiltAfter(
      join(checkout, "desktop", "dist"),
      startedAt,
      target,
    );
  const binary = target.platform === "win32"
    ? "resources/bin/relayer-graph-server.exe"
    : "Contents/Resources/bin/relayer-graph-server";
  const executable = join(appPath, ...binary.split("/"));
  const binarySha256 = createHash("sha256").update(await readFile(executable)).digest("hex");
  let binaryArchitectures;
  let libraries;
  let minimumMacOSVersion = null;
  if (target.platform === "win32") {
    const inspected = inspectPortableExecutable(await readFile(executable));
    binaryArchitectures = [inspected.architecture];
    libraries = verifyNoBundledWindowsNativeLibraries(inspected.imports);
  } else {
    binaryArchitectures = parseMachOArchitectures(
      (await execFileAsync("/usr/bin/lipo", ["-archs", executable])).stdout,
    );
    libraries = parseDynamicLibraries((await execFileAsync("/usr/bin/otool", ["-L", executable])).stdout);
    verifySystemOnlyDynamicLibraries(libraries);
    const loadCommands = (await execFileAsync("/usr/bin/otool", ["-l", executable])).stdout;
    verifyNoRuntimePaths(loadCommands);
    minimumMacOSVersion = parseMinimumMacOSVersion(loadCommands);
    if (minimumMacOSVersion !== manifest.build.minimumMacOSVersion) {
      throw new Error(
        `packaged graph server minimum macOS is ${minimumMacOSVersion}, expected ${manifest.build.minimumMacOSVersion}`,
      );
    }
  }
  const expectedArchitecture = target.architecture === "x64" ? "x86_64" : target.architecture;
  assert.deepEqual(
    binaryArchitectures,
    [expectedArchitecture],
    `packaged graph server architecture differs from ${target.key}`,
  );
  const lifecycleTimeoutMs = qualificationLifecycleTimeout(target);
  const lifecycle = await provePackagedLadybugLifecycle(executable, { commandTimeout: lifecycleTimeoutMs });
  const inputPaths = [
    ".gitattributes",
    "Cargo.lock",
    "crates/relayer-graph-server/Cargo.toml",
    "crates/relayer-graph-server/src/main.rs",
    "desktop/packaging/build-development.mjs",
    "desktop/shared/target.mjs",
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
    scope: environment.CI === "true"
      ? "issue-261-hosted-packaged-qualification"
      : "issue-261-local-packaged-qualification",
    capturedOn: new Date().toISOString().slice(0, 10),
    sourceCommit,
    buildIsolation: "clean-detached-worktree-and-empty-cargo-target",
    dependencyIsolation: "locked-offline-npm-ci-and-generated-assets",
    target: target.key,
    rustTarget: target.rustTarget,
    hostArchitecture: process.arch,
    executionMode: process.arch === target.architecture ? "native" : "rosetta",
    application: basename(appPath),
    binary,
    binarySha256,
    binaryArchitectures,
    lbug: { version: manifest.rustBinding.version, extensions: manifest.extensions },
    nativeMode: manifest.build.nativeMode,
    dynamicLibraries: libraries,
    ...(minimumMacOSVersion ? { minimumMacOSVersion } : {}),
    inputSha256,
    preparedReceiptSha256,
    preparedSourceSha256,
    lifecycleTimeoutMs,
    ...lifecycle,
    limitations: [
      `${environment.CI === "true" ? "hosted" : "local"} ${target.key} ${process.arch === target.architecture ? "native" : "Rosetta"} execution only`,
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (!options["source-output"] || !options["source-commit"]) {
    throw new Error(
      "usage: capture-ladybug-packaged-lifecycle.mjs --source-output <prepared-directory> "
      + "--source-commit <40-hex> [--receipt-output <path>]",
    );
  }
  if (options.application) {
    throw new Error("packaged Ladybug evidence must build a fresh application; --application is not supported");
  }
  const receipt = await captureLadybugPackagedLifecycle({
    sourceOutput: options["source-output"],
    sourceCommit: options["source-commit"],
  });
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
  if (options["receipt-output"]) await writeFile(resolve(options["receipt-output"]), receiptJson);
  console.log(receiptJson.trimEnd());
}
