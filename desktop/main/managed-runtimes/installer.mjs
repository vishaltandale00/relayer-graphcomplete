import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
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
import { resolveManagedRuntimeRecipe } from "./recipes.mjs";

const REGISTRY = "https://registry.npmjs.org";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const RUNTIME_IDS = new Set(MANAGED_RUNTIME_IDS);
const INSTALLATION_OWNERSHIP_RECEIPT = ".relayer-managed-runtime.json";

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

function safePrimeArchivePath(path, entry) {
  if (typeof path !== "string" || path.includes("\\") || path.startsWith("/") || path.includes("\0")) return false;
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized.split("/").includes("..")) return false;
  if (entry?.type === "SymbolicLink") {
    const target = entry.linkpath;
    if (typeof target !== "string" || target.startsWith("/") || target.includes("\\") || target.split("/").includes("..")) return false;
  }
  return true;
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
  if (context.artifact.kind === "wheel") {
    await copyFile(tarball, join(destination, context.artifact.filename));
    return;
  }
  if (context.runtimeId === "prime") {
    let unsafeEntry = null;
    await extractTar({
      file: tarball,
      cwd: destination,
      strip: 1,
      strict: true,
      preservePaths: false,
      filter: (path, entry) => {
        const allowed = safePrimeArchivePath(path, entry) && new Set(["File", "OldFile", "Directory", "SymbolicLink"]).has(entry?.type);
        if (!allowed) unsafeEntry = path;
        return allowed;
      },
    });
    if (unsafeEntry !== null) throw new Error("Prime artifact contains an unsafe archive entry.");
    return;
  }
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
  const usesSha256 = typeof artifact.sha256 === "string";
  const expected = usesSha256 ? Buffer.from(artifact.sha256, "hex") : sha512Integrity(artifact.integrity).digest;
  const hash = createHash(usesSha256 ? "sha256" : "sha512");
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
  if (Number.isSafeInteger(artifact.size) && bytes !== artifact.size) {
    throw new Error(`Byte length verification failed for ${artifact.package}.`);
  }
  const actual = hash.digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(`${usesSha256 ? "SHA-256" : "SHA-512"} integrity verification failed for ${artifact.package}.`);
  }
}

async function regularFile(path, label) {
  const details = await stat(path).catch(() => null);
  if (!details?.isFile()) throw new Error(`${label} is missing from the managed runtime.`);
}

function pathIsConfined(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot !== "" && fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function ownedRealDirectory(managedRoot, path, label) {
  const details = await lstat(path).catch(() => null);
  if (!details?.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} is not an owned directory.`);
  }
  const [resolvedRoot, resolvedPath] = await Promise.all([realpath(managedRoot), realpath(path)]);
  const lexicalPath = resolve(path);
  const fromLexicalRoot = relative(resolve(managedRoot), lexicalPath);
  if (!pathIsConfined(resolve(managedRoot), lexicalPath)
    || resolvedPath !== resolve(resolvedRoot, fromLexicalRoot)) {
    throw new Error(`${label} escapes the managed runtime root.`);
  }
  return resolvedPath;
}

async function confinedRealFile(installationRoot, path, label) {
  const details = await stat(path).catch(() => null);
  if (!details?.isFile()) throw new Error(`${label} is missing from the managed runtime.`);
  const resolvedPath = await realpath(path);
  if (!pathIsConfined(installationRoot, resolvedPath)) {
    throw new Error(`${label} entrypoint escapes its managed installation.`);
  }
}

async function readActive(base) {
  try {
    const receipt = JSON.parse(await readFile(join(base, "active.json"), "utf8"));
    if (![1, 2].includes(receipt?.schemaVersion) || typeof receipt.installation !== "string" || !/^[a-f0-9-]{36}$/.test(receipt.installation)) {
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

function validateReceiptArtifacts(receipt, runtimeId, { allowCodeOwnedHttps = false } = {}) {
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) {
    throw new Error(`${runtimeId} managed runtime receipt is invalid.`);
  }
  for (const artifact of receipt.artifacts) {
    requiredString(artifact?.package, "Managed runtime receipt package");
    if (runtimeId === "prime") requiredString(artifact?.version, "Managed runtime receipt package version");
    else validateVersion(artifact?.version, "Managed runtime receipt package version");
    if (typeof artifact?.sha256 === "string") {
      if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
        throw new Error("Managed runtime recipe artifact SHA-256 identity is invalid.");
      }
    } else sha512Integrity(artifact?.integrity);
    const tarball = new URL(requiredString(artifact?.tarball, "Managed runtime receipt tarball"));
    if (tarball.protocol !== "https:" || (!allowCodeOwnedHttps && tarball.hostname !== "registry.npmjs.org")) {
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
  const privateStateRoot = join(base, "private-state", receipt.installation);
  return Object.freeze({
    runtimeId: receipt.runtimeId,
    ...(receipt.recipeId ? { recipeId: receipt.recipeId, recipeDigest: receipt.recipeDigest } : {}),
    version: receipt.version,
    target: receipt.target,
    installationRoot,
    privateStateRoot,
    executable: confinedInstallationPath(installationRoot, receipt.executableRelativePath, "Managed runtime executable path"),
    ...(receipt.moduleRelativePath ? {
      modulePath: confinedInstallationPath(installationRoot, receipt.moduleRelativePath, "Managed runtime module path"),
    } : {}),
    receipt: Object.freeze({ ...receipt }),
  });
}

async function writeInstallationOwnershipReceipt(directory, { runtimeId, target, installation }) {
  await writeFile(join(directory, INSTALLATION_OWNERSHIP_RECEIPT), `${JSON.stringify({
    schemaVersion: 1,
    runtimeId,
    target,
    installation,
    ownedPath: posix.join(runtimeId, target, "installations", installation),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function hasInstallationOwnershipReceipt(directory, { runtimeId, target, installation }) {
  let receipt;
  try {
    const receiptPath = join(directory, INSTALLATION_OWNERSHIP_RECEIPT);
    const details = await lstat(receiptPath);
    if (!details.isFile() || details.isSymbolicLink()) return false;
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
  return receipt?.schemaVersion === 1
    && receipt.runtimeId === runtimeId
    && receipt.target === target
    && receipt.installation === installation
    && receipt.ownedPath === posix.join(runtimeId, target, "installations", installation);
}

async function createPrivateStateRoot(base, installation) {
  const parent = join(base, "private-state");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentDetails = await lstat(parent);
  if (!parentDetails.isDirectory() || parentDetails.isSymbolicLink()) {
    throw new Error("Managed runtime private-state root is not an owned directory.");
  }
  const directory = join(parent, installation);
  await mkdir(directory, { mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Managed runtime private state is not an owned directory.");
  }
  return directory;
}

async function removeRecordedGeneration(base, installation) {
  await rm(join(base, "installations", installation), { recursive: true, force: true });
  await rm(join(base, "private-state", installation), { recursive: true, force: true });
}

function publicInstallationDescriptor(result) {
  const { receipt, ...descriptor } = result;
  return Object.freeze({
    ...descriptor,
    installation: receipt.installation,
  });
}

function managedSegment(value, label) {
  const segment = requiredString(value, label);
  if (segment === "." || segment === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) {
    throw new Error(`${label} is invalid.`);
  }
  return segment;
}

function sameExactRecipeReceipt(receipt, recipe, { checkOwnership = true } = {}) {
  if (receipt?.schemaVersion === 1) {
    return ["codex", "claude"].includes(recipe.runtimeId) && sameArtifacts(receipt, recipe);
  }
  const expectedOwnedPaths = receipt?.installation
    ? [
      posix.join(recipe.runtimeId, recipe.target, "installations", receipt.installation),
      posix.join(recipe.runtimeId, recipe.target, "private-state", receipt.installation),
    ]
    : [];
  return receipt?.schemaVersion === 2
    && receipt.recipeId === recipe.recipeId
    && receipt.recipeDigest === recipe.recipeDigest
    && receipt.recipeSchemaVersion === recipe.schemaVersion
    && receipt.assembler === recipe.assembler
    && receipt.readinessContractVersion === recipe.readinessContractVersion
    && receipt.executableRelativePath === recipe.executableRelativePath
    && receipt.moduleRelativePath === recipe.moduleRelativePath
    && (!checkOwnership || JSON.stringify(receipt.ownedPaths) === JSON.stringify(expectedOwnedPaths))
    && sameArtifacts(receipt, recipe);
}

function validateResolvedRecipe(recipe, recipeId, targetKey) {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)
    || recipe.schemaVersion !== 1 || recipe.recipeId !== recipeId
    || typeof recipe.runtimeId !== "string" || recipe.runtimeId.trim() === ""
    || recipe.target !== targetKey || !semver.valid(recipe.version)
    || typeof recipe.recipeDigest !== "string" || !/^[a-f0-9]{64}$/.test(recipe.recipeDigest)
    || typeof recipe.assembler !== "string" || recipe.assembler.trim() === ""
    || !Number.isInteger(recipe.readinessContractVersion) || recipe.readinessContractVersion < 1
    || !Array.isArray(recipe.artifacts) || recipe.artifacts.length === 0) {
    throw new Error(`Managed runtime recipe ${recipeId} is invalid.`);
  }
  const { recipeDigest, ...lockedRecipe } = recipe;
  const actualDigest = createHash("sha256").update(JSON.stringify(lockedRecipe)).digest("hex");
  if (actualDigest !== recipeDigest) {
    throw new Error(`Managed runtime recipe digest does not match ${recipeId}.`);
  }
  managedSegment(recipe.runtimeId, "Managed runtime recipe identity");
  confinedInstallationPath("/managed-installation", recipe.executableRelativePath, "Managed runtime recipe executable path");
  if (recipe.moduleRelativePath) {
    confinedInstallationPath("/managed-installation", recipe.moduleRelativePath, "Managed runtime recipe module path");
  }
  const artifactKeys = new Set();
  for (const artifact of recipe.artifacts) {
    if (artifact?.kind === "sdist" || artifact?.sourceBuild === true) {
      throw new Error("Managed runtime recipes cannot contain source distributions or source builds.");
    }
    managedSegment(artifact?.role, "Managed runtime recipe artifact role");
    const artifactKey = requiredString(artifact?.artifactId || artifact?.role, "Managed runtime recipe artifact identity");
    if (artifactKeys.has(artifactKey)) throw new Error("Managed runtime recipe artifact identities must be unique.");
    artifactKeys.add(artifactKey);
    requiredString(artifact?.package, "Managed runtime recipe artifact package");
    requiredString(artifact?.version, "Managed runtime recipe artifact version");
    const tarball = new URL(requiredString(artifact?.tarball, "Managed runtime recipe artifact URL"));
    if (tarball.protocol !== "https:") throw new Error("Managed runtime recipe artifact URL is invalid.");
    if (typeof artifact?.sha256 === "string") {
      if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
        throw new Error("Managed runtime recipe artifact SHA-256 identity is invalid.");
      }
    } else sha512Integrity(artifact?.integrity);
  }
  if (recipe.runtimeId === "prime") {
    const contract = recipe.runtimeContract;
    const javascript = contract?.javascript;
    const python = contract?.python;
    const client = python?.client;
    if (!contract || typeof contract !== "object" || Array.isArray(contract)
      || typeof contract.primeSourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(contract.primeSourceCommit)
      || typeof javascript?.dependencyClosureSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(javascript.dependencyClosureSha256)
      || typeof javascript?.repositoryDependencyClosureSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(javascript.repositoryDependencyClosureSha256)
      || !Array.isArray(javascript?.packages) || javascript.packages.length === 0
      || javascript.packages.some((entry) => (
        typeof entry?.name !== "string" || entry.name.trim() === ""
        || !semver.valid(entry?.version)
        || typeof entry?.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.archiveSha256)
        || typeof entry?.treeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.treeSha256)
      ))
      || new Set(javascript.packages.map(({ name }) => name)).size !== javascript.packages.length
      || (contract.primeBridgeCommit !== undefined
        && (typeof contract.primeBridgeCommit !== "string" || !/^[a-f0-9]{40}$/.test(contract.primeBridgeCommit)))
      || !semver.valid(contract.uv?.version) || !artifactKeys.has(contract.uv?.artifactId)
      || typeof contract.uv?.executableRelativePath !== "string" || contract.uv.executableRelativePath.trim() === ""
      || !semver.valid(python?.version) || !artifactKeys.has(python?.artifactId) || python?.onlyBinary !== true
      || typeof python?.executableRelativePath !== "string" || python.executableRelativePath.trim() === ""
      || !Array.isArray(python?.wheelArtifactIds) || python.wheelArtifactIds.length === 0
      || python.wheelArtifactIds.some((artifactId) => !artifactKeys.has(artifactId))
      || typeof client?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(client.sha256)
      || (client?.artifactId !== undefined && !artifactKeys.has(client.artifactId))
      || typeof client?.installRule !== "string" || client.installRule.trim() === "") {
      throw new Error("Prime managed runtime recipe requires an exact Python runtime contract.");
    }
    const artifactsById = new Map(recipe.artifacts.map((artifact) => [recipeArtifactKey(artifact), artifact]));
    if (python.wheelArtifactIds.some((artifactId) => artifactsById.get(artifactId)?.kind !== "wheel")) {
      throw new Error("Prime managed runtime Python closure must contain only locked wheels.");
    }
  }
  return recipe;
}

function recipeArtifactKey(artifact) {
  return artifact.artifactId || artifact.role;
}

function managedAssemblyContext(staging, installationRoot, recipe, signal) {
  const pythonContract = recipe.runtimeContract?.python;
  const tools = pythonContract ? Object.freeze({
    uv: confinedInstallationPath(installationRoot, recipe.runtimeContract.uv.executableRelativePath, "Managed uv executable path"),
    python: confinedInstallationPath(installationRoot, pythonContract.executableRelativePath, "Managed Python executable path"),
  }) : Object.freeze({});
  return Object.freeze({
    recipe,
    installationRoot,
    artifactRoots: Object.freeze(Object.fromEntries(recipe.artifacts.map((artifact) => (
      [recipeArtifactKey(artifact), join(installationRoot, artifact.role)]
    )))),
    tools,
    environment: Object.freeze({
      PATH: "",
      UV_NO_CONFIG: "1",
      UV_NO_MODIFY_PATH: "1",
      TMPDIR: join(staging, "tmp"),
      UV_CACHE_DIR: join(staging, "uv-cache"),
      UV_PYTHON_INSTALL_DIR: join(installationRoot, "python"),
      UV_TOOL_DIR: join(installationRoot, "uv-tools"),
      UV_TOOL_BIN_DIR: join(installationRoot, "uv-bin"),
      XDG_CACHE_HOME: join(staging, "xdg-cache"),
      XDG_CONFIG_HOME: join(staging, "xdg-config"),
      XDG_DATA_HOME: join(staging, "xdg-data"),
    }),
    signal,
  });
}

export function createManagedRuntimeInstaller({
  root,
  platform = process.platform,
  architecture = process.arch,
  fetch = globalThis.fetch,
  downloadArtifactFile = downloadArtifact,
  extract = defaultExtract,
  spawnProcess,
  probes = {},
  resolveRecipe = resolveManagedRuntimeRecipe,
  assembleRecipe = async () => {},
  testOnlyLegacyMinimumVersionResolution = false,
  removeDirectory = rm,
  removeInactiveInstallation = (path) => removeDirectory(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  removeAbandonedStaging = (path) => removeDirectory(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  readPruneDirectory = (path) => readdir(path, { withFileTypes: true }),
  readPendingUpdateDirectory = (path) => readdir(path, { withFileTypes: true }),
} = {}) {
  const target = managedRuntimeTarget({ platform, architecture });
  if (typeof root !== "string" || root.trim() === "") throw new Error("Managed runtime root is required.");
  if (typeof fetch !== "function" || typeof downloadArtifactFile !== "function" || typeof extract !== "function"
    || typeof removeDirectory !== "function" || typeof removeInactiveInstallation !== "function"
    || typeof removeAbandonedStaging !== "function" || typeof readPruneDirectory !== "function"
    || typeof resolveRecipe !== "function" || typeof assembleRecipe !== "function"
    || typeof readPendingUpdateDirectory !== "function") {
    throw new Error("Managed runtime installer dependencies are invalid.");
  }
  const effectiveProbes = { ...createDefaultRuntimeProbes({ spawnProcess }), ...probes };
  const legacyMinimumVersionResolution = testOnlyLegacyMinimumVersionResolution && process.env.NODE_ENV === "test";
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
    const resolved = operation.recipe || (runtimeId === "claude"
      ? await resolveClaude(fetch, target, signal)
      : await resolveCodex(fetch, target, signal));
    if (operation.recipe ? resolved.version !== operation.minimumVersion : !semver.gte(resolved.version, operation.minimumVersion)) {
      throw new Error(`${runtimeId} latest ${resolved.version} is below required ${operation.minimumVersion}.`);
    }
    operation.resolvedVersion = resolved.version;
    const base = join(root, runtimeId, target.key);
    const previous = await readActive(base);
    if (operation.recipe ? sameExactRecipeReceipt(previous, resolved) : sameArtifacts(previous, resolved)) {
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
        await downloadArtifactFile(fetch, artifact, tarball, signal);
        const destination = join(stagedInstallation, artifact.role);
        await extract(tarball, destination, { runtimeId, artifact, target });
      }
      await assembleRecipe(managedAssemblyContext(staging, stagedInstallation, resolved, signal));
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
      await writeInstallationOwnershipReceipt(stagedInstallation, {
        runtimeId,
        target: target.key,
        installation,
      });
      await mkdir(join(base, "installations"), { recursive: true });
      await rename(stagedInstallation, finalInstallation);
      moved = true;
      await createPrivateStateRoot(base, installation);
      const receipt = {
        schemaVersion: operation.recipe ? 2 : 1,
        runtimeId,
        ...(operation.recipe ? {
          recipeId: operation.recipe.recipeId,
          recipeDigest: operation.recipe.recipeDigest,
          recipeSchemaVersion: operation.recipe.schemaVersion,
          assembler: operation.recipe.assembler,
          readinessContractVersion: operation.recipe.readinessContractVersion,
        } : {}),
        version: resolved.version,
        runtimeVersion: probedVersion,
        target: target.key,
        installation,
        ownedPaths: [
          posix.join(runtimeId, target.key, "installations", installation),
          posix.join(runtimeId, target.key, "private-state", installation),
        ],
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
      if (moved && !activated) await removeRecordedGeneration(base, installation);
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
        ![1, 2].includes(receipt?.schemaVersion)
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
    const resolved = operation.recipe || (runtimeId === "claude"
      ? await resolveClaude(fetch, target, signal)
      : await resolveCodex(fetch, target, signal));
    if (operation.recipe ? resolved.version !== operation.minimumVersion : !semver.gte(resolved.version, operation.minimumVersion)) {
      throw new Error(`${runtimeId} latest ${resolved.version} is below required ${operation.minimumVersion}.`);
    }
    operation.resolvedVersion = resolved.version;
    const base = join(root, runtimeId, target.key);
    const active = await readActive(base);
    const priorPending = await readPending(appVersion, runtimeId);

    if (operation.recipe ? sameExactRecipeReceipt(priorPending, resolved) : sameArtifacts(priorPending, resolved)) {
      try {
        const existing = await probeReceipt(base, priorPending, operation.minimumVersion, signal);
        return Object.freeze({ ...existing, appVersion });
      } catch {
        // Replace corrupt pending state below without changing active state.
      }
    }

    if (operation.recipe ? sameExactRecipeReceipt(active, resolved) : sameArtifacts(active, resolved)) {
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
          await removeRecordedGeneration(base, priorPending.installation);
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
        await downloadArtifactFile(fetch, artifact, tarball, signal);
        await extract(tarball, join(stagedInstallation, artifact.role), { runtimeId, artifact, target });
      }
      await assembleRecipe(managedAssemblyContext(staging, stagedInstallation, resolved, signal));
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
      await writeInstallationOwnershipReceipt(stagedInstallation, {
        runtimeId,
        target: target.key,
        installation,
      });
      await mkdir(join(base, "installations"), { recursive: true });
      await rename(stagedInstallation, finalInstallation);
      moved = true;
      await createPrivateStateRoot(base, installation);
      const receipt = {
        schemaVersion: operation.recipe ? 2 : 1,
        appVersion,
        minimumVersion: operation.minimumVersion,
        pendingOwnsInstallation: true,
        runtimeId,
        ...(operation.recipe ? {
          recipeId: operation.recipe.recipeId,
          recipeDigest: operation.recipe.recipeDigest,
          recipeSchemaVersion: operation.recipe.schemaVersion,
          assembler: operation.recipe.assembler,
          readinessContractVersion: operation.recipe.readinessContractVersion,
        } : {}),
        version: resolved.version,
        runtimeVersion: probedVersion,
        target: target.key,
        installation,
        ownedPaths: [
          posix.join(runtimeId, target.key, "installations", installation),
          posix.join(runtimeId, target.key, "private-state", installation),
        ],
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
        await removeRecordedGeneration(base, priorPending.installation);
      }
      return Object.freeze({ ...installedResult(base, receipt), appVersion });
    } finally {
      if (moved && !pendingCommitted) await removeRecordedGeneration(base, installation);
      await rm(staging, { recursive: true, force: true });
    }
  }

  async function stageActivatedRuntime(appVersion, runtimeId, minimumVersion, result, recipe = null) {
    if (recipe && result.recipeId !== recipe.recipeId) {
      throw new Error(`${runtimeId} runtime does not match requested recipe ${recipe.recipeId}.`);
    }
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
      await removeRecordedGeneration(base, priorPending.installation);
    }
    return Object.freeze({ ...result, appVersion });
  }

  function stageRuntime(appVersion, runtimeId, minimumVersion, recipe = null) {
    const connecting = operations.get(runtimeId);
    if (connecting) {
      if (recipe && connecting.recipe?.recipeId !== recipe.recipeId) {
        return connecting.promise.then(() => stageRuntime(appVersion, runtimeId, minimumVersion, recipe));
      }
      if (!recipe && semver.gt(minimumVersion, connecting.minimumVersion)) connecting.minimumVersion = minimumVersion;
      return connecting.promise.then((result) => (
        stageActivatedRuntime(appVersion, runtimeId, minimumVersion, result, recipe)
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
      recipe,
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
      if (requirement.recipeId !== undefined) {
        const recipe = validateResolvedRecipe(resolveRecipe(requirement.recipeId, target.key), requirement.recipeId, target.key);
        if (recipe.runtimeId !== requirement.runtimeId) {
          throw new Error(`Managed runtime recipe ${requirement.recipeId} does not belong to ${requirement.runtimeId}.`);
        }
        return Object.freeze({ runtimeId: requirement.runtimeId, recipeId: recipe.recipeId, minimumVersion: recipe.version, recipe });
      }
      if (!legacyMinimumVersionResolution) {
        throw new Error("App update runtime requirements must name an exact recipe identity.");
      }
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
    const settled = await Promise.allSettled(normalized.map(({ runtimeId, minimumVersion, recipe }) => (
      stageRuntime(appVersion, runtimeId, minimumVersion, recipe)
    )));
    const staged = [];
    const failures = [];
    settled.forEach((result, index) => {
      const runtimeId = normalized[index].runtimeId;
      if (result.status === "fulfilled") {
        staged.push(normalized[index].recipe ? publicInstallationDescriptor(result.value) : result.value);
      }
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
    if (receipt.schemaVersion === 2) {
      let recipe;
      try {
        recipe = validateResolvedRecipe(resolveRecipe(receipt.recipeId, target.key), receipt.recipeId, target.key);
      } catch {
        throw new Error(`${runtimeId} pending managed runtime recipe is invalid.`);
      }
      if (recipe.runtimeId !== runtimeId || !sameExactRecipeReceipt(receipt, recipe)) {
        throw new Error(`${runtimeId} pending managed runtime recipe is invalid.`);
      }
    }
    validateReceiptArtifacts(receipt, runtimeId, { allowCodeOwnedHttps: receipt.schemaVersion === 2 });
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
      await removeRecordedGeneration(base, previous.installation);
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
        await removeRecordedGeneration(base, receipt.installation);
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
        const activatedRuntime = await activatePendingRuntime(appVersion, runtimeId, operation.controller.signal);
        activated.push(activatedRuntime.receipt.schemaVersion === 2
          ? publicInstallationDescriptor(activatedRuntime)
          : activatedRuntime);
      } catch (error) {
        failures.push(Object.freeze({ runtimeId, error }));
        await discardFailedPending(appVersion, runtimeId).catch(() => undefined);
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
    const removed = [];
    const failures = [];
    const stagingRoot = join(root, ".staging");
    const stagingEntries = await readPruneDirectory(stagingRoot).catch((error) => {
      if (error?.code === "ENOENT") return [];
      failures.push(Object.freeze({ runtimeId: null, installation: null, staging: null, error }));
      return [];
    });
    const stagingName = /^(claude|codex|prime)(?:-update)?-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
    for (const entry of stagingEntries) {
      const match = entry.isDirectory() ? entry.name.match(stagingName) : null;
      if (!match) continue;
      try {
        await removeAbandonedStaging(join(stagingRoot, entry.name));
        removed.push(Object.freeze({ runtimeId: match[1], staging: entry.name }));
      } catch (error) {
        failures.push(Object.freeze({ runtimeId: match[1], installation: null, staging: entry.name, error }));
      }
    }
    const retained = new Map(MANAGED_RUNTIME_IDS.map((runtimeId) => [runtimeId, new Set()]));
    const unsafeRuntimeIds = new Set();
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
          const installationPath = join(installations, entry.name);
          if (!await hasInstallationOwnershipReceipt(installationPath, {
            runtimeId,
            target: target.key,
            installation: entry.name,
          })) continue;
          await removeInactiveInstallation(installationPath);
          await removeInactiveInstallation(join(root, runtimeId, target.key, "private-state", entry.name));
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

  async function validateInstalledRecipe(recipeId) {
    const recipe = validateResolvedRecipe(resolveRecipe(recipeId, target.key), recipeId, target.key);
    const base = join(root, recipe.runtimeId, target.key);
    const receipt = await readActive(base);
    if (!receipt || receipt.runtimeId !== recipe.runtimeId || receipt.target !== target.key) {
      throw new Error(`${recipe.runtimeId} managed runtime is not installed.`);
    }
    const exactLegacy = receipt.schemaVersion === 1
      && ["codex", "claude"].includes(recipe.runtimeId)
      && receipt.version === recipe.version
      && sameArtifacts(receipt, recipe);
    const exactCurrent = sameExactRecipeReceipt(receipt, recipe, { checkOwnership: false });
    if (!exactLegacy && !exactCurrent) {
      throw new Error(`${recipe.runtimeId} managed runtime does not match requested recipe ${recipe.recipeId}.`);
    }
    const requiresOwnedLayout = receipt.schemaVersion === 2 && exactCurrent;
    if (requiresOwnedLayout) {
      const expectedOwnedPaths = [
        posix.join(recipe.runtimeId, target.key, "installations", receipt.installation),
        posix.join(recipe.runtimeId, target.key, "private-state", receipt.installation),
      ];
      if (JSON.stringify(receipt.ownedPaths) !== JSON.stringify(expectedOwnedPaths)) {
        throw new Error(`${recipe.runtimeId} managed runtime ownership receipt is invalid.`);
      }
    }
    validateReceiptArtifacts(receipt, recipe.runtimeId, { allowCodeOwnedHttps: exactCurrent });
    const result = installedResult(base, receipt);
    const installationRoot = await ownedRealDirectory(root, result.installationRoot, "Managed runtime installation");
    if (requiresOwnedLayout) {
      if (!await hasInstallationOwnershipReceipt(result.installationRoot, {
        runtimeId: recipe.runtimeId,
        target: target.key,
        installation: receipt.installation,
      })) {
        throw new Error(`${recipe.runtimeId} managed runtime installation ownership marker is invalid.`);
      }
      await ownedRealDirectory(root, result.privateStateRoot, "Managed runtime private state");
    }
    await confinedRealFile(installationRoot, result.executable, "Managed runtime executable");
    if (result.modulePath) await confinedRealFile(installationRoot, result.modulePath, "Managed runtime module");
    return publicInstallationDescriptor(Object.freeze({
      ...result,
      recipeId: recipe.recipeId,
      recipeDigest: recipe.recipeDigest,
    }));
  }

  const installedRecipe = (recipeId) => validateInstalledRecipe(recipeId);

  function prepare(recipeId) {
    let recipe;
    try { recipe = validateResolvedRecipe(resolveRecipe(recipeId, target.key), recipeId, target.key); } catch (error) { return Promise.reject(error); }
    let operation = operations.get(recipe.runtimeId);
    if (operation) {
      if (operation.recipe?.recipeId !== recipe.recipeId) {
        return operation.promise.then(() => prepare(recipeId));
      }
      return operation.promise.then((result) => publicInstallationDescriptor(result));
    }
    operation = {
      controller: new AbortController(),
      minimumVersion: recipe.version,
      resolvedVersion: recipe.version,
      recipe,
      promise: null,
    };
    operation.promise = install(recipe.runtimeId, operation).finally(() => {
      if (operations.get(recipe.runtimeId) === operation) operations.delete(recipe.runtimeId);
    });
    operations.set(recipe.runtimeId, operation);
    return operation.promise.then((result) => publicInstallationDescriptor(result));
  }

  return Object.freeze({
    prepare,
    validate: (recipeId) => validateInstalledRecipe(recipeId),
    installed: (runtimeOrRecipeId, minimumVersion) => minimumVersion === undefined
      ? installedRecipe(runtimeOrRecipeId)
      : legacyMinimumVersionResolution
        ? installed(runtimeOrRecipeId, minimumVersion)
        : Promise.reject(new Error("Managed runtime lookup requires an exact recipe identity.")),
    ...(legacyMinimumVersionResolution ? { ensure } : {}),
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
