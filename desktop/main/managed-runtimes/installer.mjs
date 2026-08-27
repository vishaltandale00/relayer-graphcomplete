import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import semver from "semver";
import { x as extractTar } from "tar";

import { managedRuntimeTarget, MANAGED_RUNTIME_IDS } from "./catalog.mjs";
import { createDefaultRuntimeProbes } from "./probes.mjs";

const REGISTRY = "https://registry.npmjs.org";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const RUNTIME_IDS = new Set(MANAGED_RUNTIME_IDS);

function packageUrl(packageName, selector) {
  return `${REGISTRY}/${packageName.replace("/", "%2f")}/${selector}`;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is missing.`);
  return value.trim();
}

function validateVersion(value, label) {
  const version = requiredString(value, label);
  if (!semver.valid(version)) throw new Error(`${label} is invalid.`);
  return version;
}

function sha512Integrity(value) {
  const token = requiredString(value, "npm artifact integrity")
    .split(/\s+/)
    .find((candidate) => candidate.startsWith("sha512-"));
  if (!token) throw new Error("npm artifact is missing SHA-512 integrity.");
  const encoded = token.slice("sha512-".length);
  const digest = Buffer.from(encoded, "base64");
  if (digest.length !== 64 || digest.toString("base64") !== encoded) {
    throw new Error("npm artifact SHA-512 integrity is invalid.");
  }
  return { value: token, digest };
}

function artifactFromMetadata(metadata, { expectedName, expectedVersion, role }) {
  if (metadata?.name !== expectedName || metadata?.version !== expectedVersion) {
    throw new Error(`npm metadata does not match ${expectedName}@${expectedVersion}.`);
  }
  const tarball = requiredString(metadata?.dist?.tarball, "npm artifact tarball");
  const url = new URL(tarball);
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") {
    throw new Error("npm artifact tarball must use the official HTTPS registry.");
  }
  return Object.freeze({
    role,
    package: expectedName,
    version: expectedVersion,
    tarball,
    integrity: sha512Integrity(metadata?.dist?.integrity).value,
  });
}

async function registryMetadata(fetch, packageName, selector, signal) {
  const response = await fetch(packageUrl(packageName, selector), { signal, headers: { accept: "application/json" } });
  if (!response?.ok) throw new Error(`Unable to resolve ${packageName}@${selector} from npm.`);
  const metadata = await response.json();
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`npm returned malformed metadata for ${packageName}@${selector}.`);
  }
  return metadata;
}

async function resolveClaude(fetch, target, signal) {
  const rootPackage = "@anthropic-ai/claude-agent-sdk";
  const root = await registryMetadata(fetch, rootPackage, "latest", signal);
  const version = validateVersion(root.version, "Claude latest version");
  if (root.name !== rootPackage) throw new Error("Claude latest metadata has the wrong package identity.");
  if (root.optionalDependencies?.[target.claudePackage] !== version) {
    throw new Error("Claude latest does not declare an exact matching platform runtime.");
  }
  const platform = await registryMetadata(fetch, target.claudePackage, version, signal);
  return Object.freeze({
    version,
    executableRelativePath: join("native", target.claudeExecutable),
    moduleRelativePath: join("sdk", "sdk.mjs"),
    artifacts: Object.freeze([
      artifactFromMetadata(root, { expectedName: rootPackage, expectedVersion: version, role: "sdk" }),
      artifactFromMetadata(platform, { expectedName: target.claudePackage, expectedVersion: version, role: "native" }),
    ]),
  });
}

async function resolveCodex(fetch, target, signal) {
  const rootPackage = "@openai/codex";
  const root = await registryMetadata(fetch, rootPackage, "latest", signal);
  const version = validateVersion(root.version, "Codex latest version");
  if (root.name !== rootPackage) throw new Error("Codex latest metadata has the wrong package identity.");
  const alias = requiredString(root.optionalDependencies?.[target.codexAlias], "Codex platform alias");
  const match = alias.match(/^npm:(@openai\/codex)@(.+)$/);
  if (!match || match[2] !== `${version}-${target.codexSuffix}`) {
    throw new Error("Codex latest does not declare the expected platform artifact.");
  }
  const platform = await registryMetadata(fetch, match[1], match[2], signal);
  return Object.freeze({
    version,
    executableRelativePath: join("native", "vendor", target.codexVendor, "bin", target.codexExecutable),
    moduleRelativePath: null,
    artifacts: Object.freeze([
      artifactFromMetadata(platform, { expectedName: match[1], expectedVersion: match[2], role: "native" }),
    ]),
  });
}

function safeArchivePath(path) {
  if (typeof path !== "string" || path.includes("\\") || path.startsWith("/") || path.includes("\0")) return null;
  const normalized = posix.normalize(path);
  if (normalized !== path || !normalized.startsWith("package/") || normalized.split("/").includes("..")) return null;
  return normalized;
}

function archiveEntryAllowed(runtimeId, artifact, target, path, entry) {
  const normalized = safeArchivePath(path);
  if (!normalized || !new Set(["File", "OldFile", "Directory"]).has(entry?.type)) return false;
  if (artifact.role === "sdk") return runtimeId === "claude";
  if (runtimeId === "claude") {
    return new Set([
      "package/package.json",
      "package/LICENSE.md",
      "package/README.md",
      `package/${target.claudeExecutable}`,
    ]).has(normalized);
  }
  return normalized === "package/package.json"
    || normalized === "package/README.md"
    || normalized.startsWith(`package/vendor/${target.codexVendor}/`);
}

async function defaultExtract(tarball, destination, context) {
  await mkdir(destination, { recursive: true });
  let unsafeEntry = null;
  await extractTar({
    file: tarball,
    cwd: destination,
    strip: 1,
    strict: true,
    preservePaths: false,
    filter: (path, entry) => {
      const allowed = archiveEntryAllowed(context.runtimeId, context.artifact, context.target, path, entry);
      if (!allowed && (
        safeArchivePath(path) === null
        || !new Set(["File", "OldFile", "Directory"]).has(entry?.type)
      )) {
        unsafeEntry = path;
      }
      return allowed;
    },
  });
  if (unsafeEntry !== null) throw new Error("npm artifact contains an unsafe archive entry.");
}

async function downloadArtifact(fetch, artifact, destination, signal) {
  const response = await fetch(artifact.tarball, { signal });
  if (!response?.ok || !response.body) throw new Error(`Unable to download ${artifact.package}.`);
  const expected = sha512Integrity(artifact.integrity).digest;
  const hash = createHash("sha512");
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) return callback(new Error("Managed runtime artifact is too large."));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(response.body, verifier, createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal });
  const actual = hash.digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(`SHA-512 integrity verification failed for ${artifact.package}.`);
  }
}

async function regularFile(path, label) {
  const details = await stat(path).catch(() => null);
  if (!details?.isFile()) throw new Error(`${label} is missing from the managed runtime.`);
}

async function readActive(base) {
  try {
    const receipt = JSON.parse(await readFile(join(base, "active.json"), "utf8"));
    if (receipt?.schemaVersion !== 1 || typeof receipt.installation !== "string" || !/^[a-f0-9-]{36}$/.test(receipt.installation)) {
      return null;
    }
    return receipt;
  } catch {
    return null;
  }
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function sameArtifacts(receipt, resolved) {
  return receipt?.version === resolved.version
    && JSON.stringify(receipt.artifacts) === JSON.stringify(resolved.artifacts);
}

function validateReceiptArtifacts(receipt, runtimeId) {
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) {
    throw new Error(`${runtimeId} managed runtime receipt is invalid.`);
  }
  for (const artifact of receipt.artifacts) {
    requiredString(artifact?.package, "Managed runtime receipt package");
    validateVersion(artifact?.version, "Managed runtime receipt package version");
    sha512Integrity(artifact?.integrity);
    const tarball = new URL(requiredString(artifact?.tarball, "Managed runtime receipt tarball"));
    if (tarball.protocol !== "https:" || tarball.hostname !== "registry.npmjs.org") {
      throw new Error("Managed runtime receipt tarball is invalid.");
    }
  }
}

function compatibleProbeVersion({ runtimeId, packageVersion, probedVersion, minimumVersion, expectedRuntimeVersion }) {
  if (!semver.gte(packageVersion, minimumVersion) || !semver.gte(probedVersion, minimumVersion)) return false;
  if (runtimeId === "codex" && !semver.eq(probedVersion, packageVersion)) return false;
  if (expectedRuntimeVersion && !semver.eq(probedVersion, expectedRuntimeVersion)) return false;
  return true;
}

function confinedInstallationPath(installationRoot, value, label) {
  const path = requiredString(value, label);
  if (path.includes("\0") || isAbsolute(path)) throw new Error(`${label} is invalid.`);
  const resolved = resolve(installationRoot, path);
  const fromRoot = relative(installationRoot, resolved);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes the managed installation.`);
  }
  return resolved;
}

function installedResult(base, receipt) {
  const installationRoot = join(base, "installations", receipt.installation);
  return Object.freeze({
    runtimeId: receipt.runtimeId,
    version: receipt.version,
    target: receipt.target,
    executable: confinedInstallationPath(installationRoot, receipt.executableRelativePath, "Managed runtime executable path"),
    ...(receipt.moduleRelativePath ? {
      modulePath: confinedInstallationPath(installationRoot, receipt.moduleRelativePath, "Managed runtime module path"),
    } : {}),
    receipt: Object.freeze({ ...receipt }),
  });
}

export function createManagedRuntimeInstaller({
  root,
  platform = process.platform,
  architecture = process.arch,
  fetch = globalThis.fetch,
  extract = defaultExtract,
  spawnProcess,
  probes = {},
  removeInactiveInstallation = (path) => rm(path, { recursive: true, force: true }),
  readPruneDirectory = (path) => readdir(path, { withFileTypes: true }),
  readPendingUpdateDirectory = (path) => readdir(path, { withFileTypes: true }),
} = {}) {
  const target = managedRuntimeTarget({ platform, architecture });
  if (typeof root !== "string" || root.trim() === "") throw new Error("Managed runtime root is required.");
  if (typeof fetch !== "function" || typeof extract !== "function"
    || typeof removeInactiveInstallation !== "function" || typeof readPruneDirectory !== "function"
    || typeof readPendingUpdateDirectory !== "function") {
    throw new Error("Managed runtime installer dependencies are invalid.");
  }
  const effectiveProbes = { ...createDefaultRuntimeProbes({ spawnProcess }), ...probes };
  const operations = new Map();
  const pendingOperations = new Map();
  const activationOperations = new Map();

  async function installed(runtimeId, minimumVersion) {
    if (!RUNTIME_IDS.has(runtimeId)) throw new Error(`Unknown managed runtime: ${runtimeId}.`);
    const required = validateVersion(minimumVersion, `${runtimeId} minimum version`);
    const base = join(root, runtimeId, target.key);
    const receipt = await readActive(base);
    if (!receipt || receipt.runtimeId !== runtimeId || receipt.target !== target.key) {
      throw new Error(`${runtimeId} managed runtime is not installed.`);
    }
    const version = validateVersion(receipt.version, `${runtimeId} installed version`);
    if (!semver.gte(version, required)) {
      throw new Error(`${runtimeId} installed ${version} is below required ${required}.`);
    }
    validateReceiptArtifacts(receipt, runtimeId);
    const result = installedResult(base, receipt);
    await regularFile(result.executable, "Managed runtime executable");
    if (result.modulePath) await regularFile(result.modulePath, "Managed runtime module");
    const probe = await effectiveProbes[runtimeId]({ ...result, signal: undefined });
    const probedVersion = validateVersion(probe?.version, `${runtimeId} probe version`);
    if (!compatibleProbeVersion({
      runtimeId,
      packageVersion: version,
      probedVersion,
      minimumVersion: required,
      expectedRuntimeVersion: receipt.runtimeVersion,
    })) {
      throw new Error(`${runtimeId} probe reported an incompatible version.`);
    }
    return result;
  }

  async function install(runtimeId, operation) {
    const signal = operation.controller.signal;
    const resolved = runtimeId === "claude"
      ? await resolveClaude(fetch, target, signal)
      : await resolveCodex(fetch, target, signal);
    if (!semver.gte(resolved.version, operation.minimumVersion)) {
      throw new Error(`${runtimeId} latest ${resolved.version} is below required ${operation.minimumVersion}.`);
    }
    operation.resolvedVersion = resolved.version;
    const base = join(root, runtimeId, target.key);
    const previous = await readActive(base);
    if (sameArtifacts(previous, resolved)) {
      try {
        return await probeReceipt(base, previous, operation.minimumVersion, signal);
      } catch {
        // Reinstall latest below without disturbing the active pointer.
      }
    }

    const staging = join(root, ".staging", `${runtimeId}-${randomUUID()}`);
    const stagedInstallation = join(staging, "installation");
    const installation = randomUUID();
    const finalInstallation = join(base, "installations", installation);
    let moved = false;
    let activated = false;
    try {
      await mkdir(join(staging, "downloads"), { recursive: true });
      for (const [index, artifact] of resolved.artifacts.entries()) {
        signal.throwIfAborted();
        const tarball = join(staging, "downloads", `${index}.tgz`);
        await downloadArtifact(fetch, artifact, tarball, signal);
        const destination = join(stagedInstallation, artifact.role);
        await extract(tarball, destination, { runtimeId, artifact, target });
      }
      const executable = join(stagedInstallation, resolved.executableRelativePath);
      await regularFile(executable, "Managed runtime executable");
      if (platform !== "win32") await chmod(executable, 0o755);
      if (resolved.moduleRelativePath) await regularFile(join(stagedInstallation, resolved.moduleRelativePath), "Managed runtime module");
      const probe = await effectiveProbes[runtimeId]({
        runtimeId,
        version: resolved.version,
        target: target.key,
        executable,
        ...(resolved.moduleRelativePath ? { modulePath: join(stagedInstallation, resolved.moduleRelativePath) } : {}),
        signal,
      });
      const probedVersion = validateVersion(probe?.version, `${runtimeId} probe version`);
      if (!compatibleProbeVersion({
        runtimeId,
        packageVersion: resolved.version,
        probedVersion,
        minimumVersion: operation.minimumVersion,
      })) {
        throw new Error(`${runtimeId} probe reported an incompatible version.`);
      }
      signal.throwIfAborted();
      await mkdir(join(base, "installations"), { recursive: true });
      await rename(stagedInstallation, finalInstallation);
      moved = true;
      const receipt = {
        schemaVersion: 1,
        runtimeId,
        version: resolved.version,
        runtimeVersion: probedVersion,
        target: target.key,
        installation,
        executableRelativePath: resolved.executableRelativePath,
        moduleRelativePath: resolved.moduleRelativePath,
        artifacts: resolved.artifacts,
      };
      const temporaryReceipt = join(base, `active.${randomUUID()}.tmp`);
      await writeFile(temporaryReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try {
        signal.throwIfAborted();
        await rename(temporaryReceipt, join(base, "active.json"));
      } finally {
        await rm(temporaryReceipt, { force: true });
      }
      activated = true;
      // Provider adapters are process-scoped and may still hold the previously
      // returned absolute paths. Keep that inactive generation readable after
      // a Connect-triggered upgrade; active.json remains the sole active
      // generation, so all newly created adapters receive this installation.
      return installedResult(base, receipt);
    } finally {
      if (moved && !activated) await rm(finalInstallation, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  }

  function pendingPath(appVersion, runtimeId) {
    return join(root, ".pending-app-updates", appVersion, `${runtimeId}-${target.key}.json`);
  }

  async function readPending(appVersion, runtimeId) {
    try {
      const receipt = JSON.parse(await readFile(pendingPath(appVersion, runtimeId), "utf8"));
      if (
        receipt?.schemaVersion !== 1
        || receipt.appVersion !== appVersion
        || receipt.runtimeId !== runtimeId
        || receipt.target !== target.key
        || typeof receipt.installation !== "string"
        || !/^[a-f0-9-]{36}$/.test(receipt.installation)
      ) return null;
      return receipt;
    } catch {
      return null;
    }
  }

  async function probeReceipt(base, receipt, minimumVersion, signal) {
    const result = installedResult(base, receipt);
    await regularFile(result.executable, "Managed runtime executable");
    if (result.modulePath) await regularFile(result.modulePath, "Managed runtime module");
    const probe = await effectiveProbes[receipt.runtimeId]({ ...result, signal });
    const version = validateVersion(probe?.version, `${receipt.runtimeId} probe version`);
    if (!compatibleProbeVersion({
      runtimeId: receipt.runtimeId,
      packageVersion: receipt.version,
      probedVersion: version,
      minimumVersion,
      expectedRuntimeVersion: receipt.runtimeVersion,
    })) {
      throw new Error(`${receipt.runtimeId} probe reported an incompatible version.`);
    }
    return result;
  }

  async function stageOne(appVersion, runtimeId, operation) {
    const signal = operation.controller.signal;
    const resolved = runtimeId === "claude"
      ? await resolveClaude(fetch, target, signal)
      : await resolveCodex(fetch, target, signal);
    if (!semver.gte(resolved.version, operation.minimumVersion)) {
      throw new Error(`${runtimeId} latest ${resolved.version} is below required ${operation.minimumVersion}.`);
    }
    operation.resolvedVersion = resolved.version;
    const base = join(root, runtimeId, target.key);
    const active = await readActive(base);
    const priorPending = await readPending(appVersion, runtimeId);

    if (sameArtifacts(priorPending, resolved)) {
      try {
        const existing = await probeReceipt(base, priorPending, operation.minimumVersion, signal);
        return Object.freeze({ ...existing, appVersion });
      } catch {
        // Replace corrupt pending state below without changing active state.
      }
    }

    if (sameArtifacts(active, resolved)) {
      try {
        const existing = await probeReceipt(base, active, operation.minimumVersion, signal);
        const receipt = {
          ...active,
          appVersion,
          minimumVersion: operation.minimumVersion,
          pendingOwnsInstallation: false,
        };
        await atomicWriteJson(pendingPath(appVersion, runtimeId), receipt);
        if (
          priorPending?.pendingOwnsInstallation === true
          && priorPending.installation !== active.installation
        ) {
          await rm(join(base, "installations", priorPending.installation), { recursive: true, force: true });
        }
        return Object.freeze({ ...existing, appVersion });
      } catch {
        // A corrupt active runtime must remain untouched while replacement stages.
      }
    }

    const staging = join(root, ".staging", `${runtimeId}-update-${randomUUID()}`);
    const stagedInstallation = join(staging, "installation");
    const installation = randomUUID();
    const finalInstallation = join(base, "installations", installation);
    let moved = false;
    let pendingCommitted = false;
    try {
      await mkdir(join(staging, "downloads"), { recursive: true });
      for (const [index, artifact] of resolved.artifacts.entries()) {
        signal.throwIfAborted();
        const tarball = join(staging, "downloads", `${index}.tgz`);
        await downloadArtifact(fetch, artifact, tarball, signal);
        await extract(tarball, join(stagedInstallation, artifact.role), { runtimeId, artifact, target });
      }
      const executable = join(stagedInstallation, resolved.executableRelativePath);
      await regularFile(executable, "Managed runtime executable");
      if (platform !== "win32") await chmod(executable, 0o755);
      if (resolved.moduleRelativePath) {
        await regularFile(join(stagedInstallation, resolved.moduleRelativePath), "Managed runtime module");
      }
      const probe = await effectiveProbes[runtimeId]({
        runtimeId,
        version: resolved.version,
        target: target.key,
        executable,
        ...(resolved.moduleRelativePath ? { modulePath: join(stagedInstallation, resolved.moduleRelativePath) } : {}),
        signal,
      });
      const probedVersion = validateVersion(probe?.version, `${runtimeId} probe version`);
      if (!compatibleProbeVersion({
        runtimeId,
        packageVersion: resolved.version,
        probedVersion,
        minimumVersion: operation.minimumVersion,
      })) {
        throw new Error(`${runtimeId} probe reported an incompatible version.`);
      }
      signal.throwIfAborted();
      await mkdir(join(base, "installations"), { recursive: true });
      await rename(stagedInstallation, finalInstallation);
      moved = true;
      const receipt = {
        schemaVersion: 1,
        appVersion,
        minimumVersion: operation.minimumVersion,
        pendingOwnsInstallation: true,
        runtimeId,
        version: resolved.version,
        runtimeVersion: probedVersion,
        target: target.key,
        installation,
        executableRelativePath: resolved.executableRelativePath,
        moduleRelativePath: resolved.moduleRelativePath,
        artifacts: resolved.artifacts,
      };
      await atomicWriteJson(pendingPath(appVersion, runtimeId), receipt);
      pendingCommitted = true;
      if (
        priorPending?.pendingOwnsInstallation === true
        && priorPending.installation !== installation
        && priorPending.installation !== active?.installation
      ) {
        await rm(join(base, "installations", priorPending.installation), { recursive: true, force: true });
      }
      return Object.freeze({ ...installedResult(base, receipt), appVersion });
    } finally {
      if (moved && !pendingCommitted) await rm(finalInstallation, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  }

  async function stageActivatedRuntime(appVersion, runtimeId, minimumVersion, result) {
    if (!semver.gte(result.version, minimumVersion)) {
      throw new Error(`${runtimeId} runtime is below required ${minimumVersion}.`);
    }
    const base = join(root, runtimeId, target.key);
    const active = await readActive(base);
    if (!active || active.installation !== result.receipt.installation) {
      throw new Error(`${runtimeId} managed runtime changed before update staging.`);
    }
    const priorPending = await readPending(appVersion, runtimeId);
    await atomicWriteJson(pendingPath(appVersion, runtimeId), {
      ...active,
      appVersion,
      minimumVersion,
      pendingOwnsInstallation: false,
    });
    if (priorPending?.pendingOwnsInstallation === true && priorPending.installation !== active.installation) {
      await rm(join(base, "installations", priorPending.installation), { recursive: true, force: true });
    }
    return Object.freeze({ ...result, appVersion });
  }

  function stageRuntime(appVersion, runtimeId, minimumVersion) {
    const connecting = operations.get(runtimeId);
    if (connecting) {
      if (semver.gt(minimumVersion, connecting.minimumVersion)) connecting.minimumVersion = minimumVersion;
      return connecting.promise.then((result) => (
        stageActivatedRuntime(appVersion, runtimeId, minimumVersion, result)
      ));
    }
    const key = `${appVersion}:${runtimeId}`;
    let operation = pendingOperations.get(key);
    if (operation) {
      if (semver.gt(minimumVersion, operation.minimumVersion)) operation.minimumVersion = minimumVersion;
      return operation.promise;
    }
    operation = {
      controller: new AbortController(),
      minimumVersion,
      resolvedVersion: null,
      promise: null,
    };
    operation.promise = stageOne(appVersion, runtimeId, operation).finally(() => {
      if (pendingOperations.get(key) === operation) pendingOperations.delete(key);
    });
    pendingOperations.set(key, operation);
    return operation.promise;
  }

  async function stageForAppUpdate(appVersionValue, requirements) {
    const appVersion = validateVersion(appVersionValue, "incoming app version");
    if (!Array.isArray(requirements) || requirements.length === 0) {
      throw new Error("App update runtime requirements are required.");
    }
    const normalized = requirements.map((requirement) => {
      if (!RUNTIME_IDS.has(requirement?.runtimeId)) throw new Error(`Unknown managed runtime: ${requirement?.runtimeId}.`);
      return Object.freeze({
        runtimeId: requirement.runtimeId,
        minimumVersion: validateVersion(requirement.minimumVersion, `${requirement.runtimeId} minimum version`),
      });
    });
    if (new Set(normalized.map(({ runtimeId }) => runtimeId)).size !== normalized.length) {
      throw new Error("App update runtime requirements contain a duplicate runtime.");
    }
    const pendingRoot = join(root, ".pending-app-updates");
    const superseded = await readdir(pendingRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of superseded) {
      if (!entry.isDirectory() || entry.name === appVersion || !semver.valid(entry.name)) continue;
      for (const runtimeId of MANAGED_RUNTIME_IDS) {
        await discardFailedPending(entry.name, runtimeId);
      }
      await rm(join(pendingRoot, entry.name), { recursive: true, force: true });
    }
    const settled = await Promise.allSettled(normalized.map(({ runtimeId, minimumVersion }) => (
      stageRuntime(appVersion, runtimeId, minimumVersion)
    )));
    const staged = [];
    const failures = [];
    settled.forEach((result, index) => {
      const runtimeId = normalized[index].runtimeId;
      if (result.status === "fulfilled") staged.push(result.value);
      else failures.push(Object.freeze({ runtimeId, error: result.reason }));
    });
    return Object.freeze({ appVersion, staged: Object.freeze(staged), failures: Object.freeze(failures) });
  }

  async function activatePendingRuntime(appVersion, runtimeId, signal, { retainPrevious = false } = {}) {
    const path = pendingPath(appVersion, runtimeId);
    const receipt = await readPending(appVersion, runtimeId);
    if (!receipt) throw new Error(`${runtimeId} pending runtime receipt is invalid.`);
    const minimumVersion = validateVersion(receipt.minimumVersion, `${runtimeId} pending minimum version`);
    const version = validateVersion(receipt.version, `${runtimeId} pending version`);
    if (!semver.gte(version, minimumVersion)) {
      throw new Error(`${runtimeId} pending ${version} is below required ${minimumVersion}.`);
    }
    validateReceiptArtifacts(receipt, runtimeId);
    const base = join(root, runtimeId, target.key);
    const previous = await readActive(base);
    if (previous?.version && semver.valid(previous.version) && semver.gt(previous.version, version)) {
      throw new Error(`${runtimeId} pending ${version} would downgrade active ${previous.version}.`);
    }
    const result = await probeReceipt(base, receipt, minimumVersion, signal);
    const {
      appVersion: _appVersion,
      minimumVersion: _minimumVersion,
      pendingOwnsInstallation: _pendingOwnsInstallation,
      ...activeReceipt
    } = receipt;
    signal?.throwIfAborted();
    await atomicWriteJson(join(base, "active.json"), activeReceipt);
    await rm(path, { force: true });
    if (!retainPrevious && previous?.installation && previous.installation !== receipt.installation) {
      await rm(join(base, "installations", previous.installation), { recursive: true, force: true });
    }
    return Object.freeze({ ...result, receipt: Object.freeze({ ...activeReceipt }) });
  }

  async function discardFailedPending(appVersion, runtimeId) {
    const receipt = await readPending(appVersion, runtimeId);
    await rm(pendingPath(appVersion, runtimeId), { force: true });
    if (receipt?.pendingOwnsInstallation === true) {
      const base = join(root, runtimeId, target.key);
      const active = await readActive(base);
      if (receipt.installation !== active?.installation) {
        await rm(join(base, "installations", receipt.installation), { recursive: true, force: true });
      }
    }
  }

  async function runPendingAppUpdateActivation(appVersion, operation) {
    const directory = join(root, ".pending-app-updates", appVersion);
    let entries;
    try {
      entries = await readPendingUpdateDirectory(directory);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return Object.freeze({ appVersion, activated: Object.freeze([]), failures: Object.freeze([]) });
      }
      return Object.freeze({
        appVersion,
        activated: Object.freeze([]),
        failures: Object.freeze([Object.freeze({ runtimeId: null, error })]),
      });
    }
    const runtimeIds = MANAGED_RUNTIME_IDS.filter((runtimeId) => entries.some((entry) => (
      entry.isFile() && entry.name === `${runtimeId}-${target.key}.json`
    )));
    operation.runtimeIds = runtimeIds;
    const activated = [];
    const failures = [];
    for (const runtimeId of runtimeIds) {
      try {
        operation.controller.signal.throwIfAborted();
        activated.push(await activatePendingRuntime(appVersion, runtimeId, operation.controller.signal));
      } catch (error) {
        failures.push(Object.freeze({ runtimeId, error }));
      }
    }
    await rm(directory, { recursive: false }).catch(() => undefined);
    return Object.freeze({
      appVersion,
      activated: Object.freeze(activated),
      failures: Object.freeze(failures),
    });
  }

  function activatePendingAppUpdate(appVersionValue) {
    let appVersion;
    try { appVersion = validateVersion(appVersionValue, "installed app version"); } catch (error) { return Promise.reject(error); }
    const existing = activationOperations.get(appVersion);
    if (existing) return existing.promise;
    const operation = { controller: new AbortController(), runtimeIds: [], promise: null };
    operation.promise = runPendingAppUpdateActivation(appVersion, operation).finally(() => {
      if (activationOperations.get(appVersion) === operation) activationOperations.delete(appVersion);
    });
    activationOperations.set(appVersion, operation);
    return operation.promise;
  }

  async function pruneInactiveInstallations() {
    if (operations.size || pendingOperations.size || activationOperations.size) {
      throw new Error("Managed runtime installations cannot be pruned while an operation is active.");
    }
    const retained = new Map(MANAGED_RUNTIME_IDS.map((runtimeId) => [runtimeId, new Set()]));
    const unsafeRuntimeIds = new Set();
    const failures = [];
    for (const runtimeId of MANAGED_RUNTIME_IDS) {
      const base = join(root, runtimeId, target.key);
      const active = await readActive(base);
      if (!active) {
        try {
          await stat(join(base, "active.json"));
          unsafeRuntimeIds.add(runtimeId);
          failures.push(Object.freeze({
            runtimeId,
            installation: null,
            error: new Error(`${runtimeId} active runtime receipt is invalid.`),
          }));
        } catch (error) {
          if (error?.code !== "ENOENT") {
            unsafeRuntimeIds.add(runtimeId);
            failures.push(Object.freeze({ runtimeId, installation: null, error }));
          }
        }
      }
      if (active?.installation) retained.get(runtimeId).add(active.installation);
    }
    const pendingRoot = join(root, ".pending-app-updates");
    const appVersions = await readPruneDirectory(pendingRoot).catch((error) => {
      if (error?.code === "ENOENT") return [];
      for (const runtimeId of MANAGED_RUNTIME_IDS) unsafeRuntimeIds.add(runtimeId);
      failures.push(Object.freeze({ runtimeId: null, installation: null, error }));
      return [];
    });
    for (const entry of appVersions) {
      if (!entry.isDirectory() || !semver.valid(entry.name)) continue;
      for (const runtimeId of MANAGED_RUNTIME_IDS) {
        const pending = await readPending(entry.name, runtimeId);
        if (pending?.installation) retained.get(runtimeId).add(pending.installation);
      }
    }
    const removed = [];
    for (const runtimeId of MANAGED_RUNTIME_IDS) {
      if (unsafeRuntimeIds.has(runtimeId)) continue;
      const installations = join(root, runtimeId, target.key, "installations");
      const entries = await readPruneDirectory(installations).catch((error) => {
        if (error?.code === "ENOENT") return [];
        unsafeRuntimeIds.add(runtimeId);
        failures.push(Object.freeze({ runtimeId, installation: null, error }));
        return [];
      });
      for (const entry of entries) {
        if (!entry.isDirectory() || retained.get(runtimeId).has(entry.name)) continue;
        try {
          await removeInactiveInstallation(join(installations, entry.name));
          removed.push(Object.freeze({ runtimeId, installation: entry.name }));
        } catch (error) {
          failures.push(Object.freeze({ runtimeId, installation: entry.name, error }));
        }
      }
    }
    return Object.freeze({ removed: Object.freeze(removed), failures: Object.freeze(failures) });
  }

  function ensure(runtimeId, minimumVersion) {
    if (!RUNTIME_IDS.has(runtimeId)) return Promise.reject(new Error(`Unknown managed runtime: ${runtimeId}.`));
    let required;
    try { required = validateVersion(minimumVersion, `${runtimeId} minimum version`); } catch (error) { return Promise.reject(error); }
    let operation = operations.get(runtimeId);
    if (operation) {
      if (semver.gt(required, operation.minimumVersion)) operation.minimumVersion = required;
      if (operation.resolvedVersion && !semver.gte(operation.resolvedVersion, required)) {
        return Promise.reject(new Error(`${runtimeId} latest ${operation.resolvedVersion} is below required ${required}.`));
      }
      return operation.promise.then((result) => {
        if (!semver.gte(result.version, required)) throw new Error(`${runtimeId} runtime is below required ${required}.`);
        return result;
      });
    }
    const stagedEntry = [...pendingOperations.entries()].find(([key]) => key.endsWith(`:${runtimeId}`));
    if (stagedEntry) {
      const [key, stagedOperation] = stagedEntry;
      if (semver.gt(required, stagedOperation.minimumVersion)) stagedOperation.minimumVersion = required;
      const appVersion = key.slice(0, key.indexOf(":"));
      operation = {
        controller: stagedOperation.controller,
        minimumVersion: required,
        resolvedVersion: stagedOperation.resolvedVersion,
        promise: null,
      };
      operation.promise = stagedOperation.promise.then(async (result) => {
        if (!semver.gte(result.version, required)) {
          throw new Error(`${runtimeId} runtime is below required ${required}.`);
        }
        return activatePendingRuntime(appVersion, runtimeId, stagedOperation.controller.signal, { retainPrevious: true });
      }).finally(() => {
        if (operations.get(runtimeId) === operation) operations.delete(runtimeId);
      });
      operations.set(runtimeId, operation);
      return operation.promise;
    }
    operation = { controller: new AbortController(), minimumVersion: required, resolvedVersion: null, promise: null };
    operation.promise = install(runtimeId, operation).finally(() => {
      if (operations.get(runtimeId) === operation) operations.delete(runtimeId);
    });
    operations.set(runtimeId, operation);
    return operation.promise;
  }

  return Object.freeze({
    ensure,
    installed,
    stageForAppUpdate,
    activatePendingAppUpdate,
    pruneInactiveInstallations,
    activeOperations: () => Object.freeze([...new Set([
      ...operations.keys(),
      ...[...pendingOperations.keys()].map((key) => key.slice(key.indexOf(":") + 1)),
      ...[...activationOperations.values()].flatMap(({ runtimeIds }) => (
        runtimeIds.length ? runtimeIds : ["app-update-activation"]
      )),
    ])]),
    async cancelAll(reason = new DOMException("Managed runtime installation was cancelled.", "AbortError")) {
      const active = [...operations.values(), ...pendingOperations.values(), ...activationOperations.values()];
      for (const operation of active) operation.controller.abort(reason);
      await Promise.allSettled(active.map(({ promise }) => promise));
    },
  });
}
